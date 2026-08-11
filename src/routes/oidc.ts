import type { FastifyInstance, FastifyRequest } from "fastify";
import type { User } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { EVERYONE_ROLE_NAME } from "../util/permissions.js";
import { postSystemMessage } from "../util/bot.js";
import { signMfaPendingToken, getRpConfig } from "../util/mfa.js";
import { toPublicUser } from "./auth.js";
import {
  authorizeUrl,
  deriveUsername,
  exchangeCode,
  hashExchangeCode,
  issuerIsSecure,
  newPkcePair,
  oidcConfig,
  providerMetadata,
  randomToken,
  verifyIdToken,
} from "../util/oidc.js";

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
// Short by design: the client redeems this immediately on page load. A long
// window would only widen the gap in which a code sitting in a browser
// history entry is still worth something.
const EXCHANGE_CODE_TTL_MS = 2 * 60 * 1000;

const exchangeSchema = z.object({ code: z.string().min(1) });

// The URI the provider redirects back to. Must match what's registered at
// the IdP exactly, so an explicit override exists for deployments where
// this server sees a different host than the browser does (a reverse proxy
// terminating TLS, most commonly).
function callbackUri(req: FastifyRequest): string {
  const configured = process.env.OIDC_REDIRECT_URI?.trim();
  if (configured) return configured;
  return `${getRpConfig(req).origin}/auth/oidc/callback`;
}

// Errors land back on the client as a message in the URL rather than as a
// JSON body nobody will see -- at this point in the flow the user is
// looking at a browser mid-redirect, not at a fetch response.
function failureRedirect(origin: string, message: string): string {
  return `${origin}/?oidc_error=${encodeURIComponent(message)}`;
}

// The desktop app's protocol handler. A fixed constant, never assembled
// from anything the request carries -- the whole point of the two-value
// returnTarget is that no caller can aim this hand-off anywhere else.
const NATIVE_SCHEME = "outpost://auth";

function nativeUrl(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${NATIVE_SCHEME}?${query}`;
}

// Native clients get a page rather than a 302. Browsers treat a redirect to
// an unregistered custom scheme inconsistently -- several refuse to follow
// one that wasn't triggered by a user gesture -- and this way there's
// somewhere to say "you can close this tab", plus a link to click if the
// automatic hand-off didn't fire.
function nativeHandoffPage(target: string, heading: string, detail: string): string {
  const safeTarget = target.replace(/"/g, "&quot;");
  const escape = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Outpost</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a140f; color: #f7ecd9;
         display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; }
  p { color: #c9bda9; line-height: 1.5; }
  a.btn { display: inline-block; margin-top: 1rem; background: #ff8a52; color: #1a140f;
          padding: 0.6rem 1.2rem; border-radius: 6px; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>${escape(heading)}</h1>
  <p>${escape(detail)}</p>
  <a class="btn" href="${safeTarget}">Open Outpost</a>
</main>
<script>
  // Attempted immediately; the button above is the fallback for a browser
  // that won't launch a custom scheme without a click.
  location.href = ${JSON.stringify(target)};
</script>
</body>
</html>`;
}

export async function oidcRoutes(app: FastifyInstance) {
  // Public: the login screen calls this before showing anything, to decide
  // whether to render an SSO button and what to call it. Deliberately says
  // nothing about the provider beyond its display name -- the issuer URL is
  // internal infrastructure on plenty of self-hosted setups.
  app.get("/auth/oidc/config", async () => {
    const config = oidcConfig();
    if (!config) return { enabled: false };
    return { enabled: true, displayName: config.displayName };
  });

  app.get(
    "/auth/oidc/start",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const config = oidcConfig();
      const origin = getRpConfig(req).origin;
      if (!config) {
        return reply.redirect(failureRedirect(origin, "single sign-on isn't configured on this server"));
      }
      if (!issuerIsSecure(config.issuer)) {
        req.log.error({ issuer: config.issuer }, "OIDC_ISSUER must be https (or localhost)");
        return reply.redirect(failureRedirect(origin, "single sign-on is misconfigured on this server"));
      }

      // Anything other than the literal "native" is treated as a web
      // sign-in, so a malformed or hostile value degrades to the safe path
      // rather than being rejected or, worse, honoured.
      const returnTarget = (req.query as { target?: string }).target === "native" ? "native" : "web";

      try {
        const metadata = await providerMetadata(config);
        const { verifier, challenge } = newPkcePair();
        const state = randomToken();
        const nonce = randomToken();
        const redirectUri = callbackUri(req);

        await prisma.oidcAuthRequest.create({
          data: {
            state,
            nonce,
            codeVerifier: verifier,
            redirectUri,
            returnOrigin: origin,
            returnTarget,
            expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
          },
        });
        // Opportunistic cleanup of expired rows. No scheduler in this app,
        // and these are only ever read by exact state match, so an
        // abandoned row is harmless until it's swept.
        await prisma.oidcAuthRequest.deleteMany({ where: { expiresAt: { lt: new Date() } } });

        return reply.redirect(authorizeUrl(metadata, config, { redirectUri, state, nonce, codeChallenge: challenge }));
      } catch (err) {
        req.log.error(err, "failed to start OIDC authorization");
        return reply.redirect(failureRedirect(origin, "couldn't reach the identity provider"));
      }
    },
  );

  app.get(
    "/auth/oidc/callback",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const query = req.query as { code?: string; state?: string; error?: string; error_description?: string };
      const fallbackOrigin = getRpConfig(req).origin;
      const config = oidcConfig();
      if (!config) return reply.redirect(failureRedirect(fallbackOrigin, "single sign-on isn't configured"));

      // The state row is consumed before anything else is checked, so a
      // replayed callback can never be processed twice even if the rest of
      // the exchange would have succeeded.
      const authRequest = query.state
        ? await prisma.oidcAuthRequest.findUnique({ where: { state: query.state } })
        : null;
      if (authRequest) {
        await prisma.oidcAuthRequest.delete({ where: { id: authRequest.id } }).catch(() => {});
      }
      const origin = authRequest?.returnOrigin ?? fallbackOrigin;
      // A callback whose state didn't match any live request has no known
      // target, and falls back to the web path -- the desktop app never
      // sees that response anyway, since it isn't what opened the browser.
      const isNative = authRequest?.returnTarget === "native";

      const fail = (message: string) =>
        isNative
          ? reply
              .type("text/html")
              .send(nativeHandoffPage(nativeUrl({ oidc_error: message }), "Sign-in didn't complete", message))
          : reply.redirect(failureRedirect(origin, message));

      const succeed = (code: string) =>
        isNative
          ? reply
              .type("text/html")
              .send(
                nativeHandoffPage(
                  nativeUrl({ oidc: code }),
                  "You're signed in",
                  "You can close this tab and go back to the Outpost app.",
                ),
              )
          : reply.redirect(`${origin}/?oidc=${encodeURIComponent(code)}`);

      if (query.error) {
        return fail(query.error_description || query.error);
      }
      if (!authRequest || authRequest.expiresAt < new Date()) {
        return fail("this sign-in attempt expired — please try again");
      }
      if (!query.code) {
        return fail("the identity provider returned no authorization code");
      }

      try {
        const metadata = await providerMetadata(config);
        const { idToken } = await exchangeCode(metadata, config, {
          code: query.code,
          redirectUri: authRequest.redirectUri,
          codeVerifier: authRequest.codeVerifier,
        });
        const claims = await verifyIdToken(idToken, config, metadata, authRequest.nonce);

        const user = await resolveUser(config, claims);
        if ("error" in user) return fail(user.error);
        if (user.record.banned) {
          return fail("this account has been banned");
        }

        const webauthnCount = await prisma.webauthnCredential.count({ where: { userId: user.record.id } });
        const rawCode = randomToken();
        await prisma.oidcExchangeCode.create({
          data: {
            codeHash: hashExchangeCode(rawCode),
            userId: user.record.id,
            mfaPending: user.record.totpEnabled || webauthnCount > 0,
            expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS),
          },
        });
        await prisma.oidcExchangeCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });

        if (user.welcome) {
          // Same placement as registration's: outside anything
          // transactional, and never allowed to break the sign-in.
          await postSystemMessage(user.welcome.channelId, user.welcome.message).catch(() => {});
        }

        return succeed(rawCode);
      } catch (err) {
        req.log.error(err, "OIDC callback failed");
        return fail((err as Error).message || "single sign-on failed");
      }
    },
  );

  // Swaps the one-time code for a real session (or an MFA challenge). POST
  // and single-use, so the credential never sits in a URL.
  app.post(
    "/auth/oidc/exchange",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = exchangeSchema.parse(req.body);
      const record = await prisma.oidcExchangeCode.findUnique({
        where: { codeHash: hashExchangeCode(body.code) },
      });
      if (record) await prisma.oidcExchangeCode.delete({ where: { id: record.id } }).catch(() => {});
      if (!record || record.expiresAt < new Date()) {
        return reply.status(400).send({ error: "this sign-in link is invalid or has expired" });
      }

      const user = await prisma.user.findUnique({ where: { id: record.userId } });
      if (!user || user.banned) {
        return reply.status(403).send({ error: "this account is no longer able to sign in" });
      }

      if (record.mfaPending) {
        const webauthnCredentials = await prisma.webauthnCredential.findMany({
          where: { userId: user.id },
          select: { id: true, nickname: true },
        });
        return reply.send({
          mfaRequired: true,
          mfaToken: signMfaPendingToken(app, user.id),
          totpEnabled: user.totpEnabled,
          webauthnCredentials,
        });
      }

      const token = app.jwt.sign({ sub: user.id, username: user.username });
      return reply.send({ token, user: toPublicUser(user) });
    },
  );
}

type ResolvedUser =
  | { error: string }
  | { record: User; welcome?: { channelId: string; message: string } };

// Finds the account this identity belongs to, or makes one.
//
// Matching is by (issuer, subject) first and only ever falls back to email
// for the one-time link -- `sub` is the claim OIDC guarantees is stable,
// while an email address at the provider can be reassigned to a different
// person entirely.
async function resolveUser(
  config: ReturnType<typeof oidcConfig> & object,
  claims: Awaited<ReturnType<typeof verifyIdToken>>,
): Promise<ResolvedUser> {
  const existingIdentity = await prisma.oidcIdentity.findUnique({
    where: { issuer_subject: { issuer: config.issuer, subject: claims.subject } },
    include: { user: true },
  });
  if (existingIdentity) return { record: existingIdentity.user };

  // Linking an SSO identity onto an account that already exists locally.
  // Gated on email_verified because without it the provider is only
  // repeating what the person typed into it -- and an unverified address
  // matching a local account would hand over that account to whoever
  // claimed it.
  if (claims.email) {
    const byEmail = await prisma.user.findUnique({ where: { email: claims.email } });
    if (byEmail) {
      if (!claims.emailVerified) {
        return {
          error:
            "an account with that email already exists here, but your identity provider hasn't verified the address",
        };
      }
      if (byEmail.isBot) {
        return { error: "that email belongs to a bot account" };
      }
      await prisma.oidcIdentity.create({
        data: { userId: byEmail.id, issuer: config.issuer, subject: claims.subject },
      });
      return { record: byEmail };
    }
  }

  if (!config.allowSignup) {
    return { error: "this server doesn't allow new accounts to be created through single sign-on" };
  }
  if (!claims.email) {
    return { error: "your identity provider didn't share an email address, which this server requires" };
  }

  // The very first account on an instance is its owner, and that carries
  // the whole instance bootstrap (settings rows, #general, @everyone).
  // Refused here on purpose: claiming an instance is done with the claim
  // code printed on its own console, and letting the first person who can
  // authenticate at some IdP become owner instead would be a quieter way
  // in than the flow that exists to prevent exactly that.
  if ((await prisma.user.count()) === 0) {
    return {
      error: "this instance hasn't been claimed yet — create the owner account with its claim code first",
    };
  }

  const username = await deriveUsername(claims, async (candidate) => {
    return (await prisma.user.count({ where: { username: candidate } })) > 0;
  });

  const { created, welcome } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      // No passwordHash: this account has no password to check, and giving
      // it a random one would make "forgot password" look like a route back
      // in when it never could be.
      data: { username, email: claims.email!, avatarUrl: null },
    });
    await tx.oidcIdentity.create({
      data: { userId: user.id, issuer: config.issuer, subject: claims.subject },
    });

    const everyoneRole = await tx.role.findFirst({ where: { name: EVERYONE_ROLE_NAME } });
    if (everyoneRole) {
      await tx.userRole.create({ data: { userId: user.id, roleId: everyoneRole.id } });
    }
    const bot = await tx.botSettings.upsert({ where: { id: "singleton" }, create: {}, update: {} });
    if (bot.autoRoleEnabled && bot.autoRoleId && bot.autoRoleId !== everyoneRole?.id) {
      const autoRole = await tx.role.findUnique({ where: { id: bot.autoRoleId } });
      if (autoRole) {
        await tx.userRole.create({ data: { userId: user.id, roleId: autoRole.id } });
      }
    }

    return {
      created: user,
      welcome:
        bot.welcomeEnabled && bot.welcomeChannelId
          ? {
              channelId: bot.welcomeChannelId,
              message: bot.welcomeMessage.replaceAll("{user}", user.username),
            }
          : undefined,
    };
  });

  return { record: created, welcome };
}
