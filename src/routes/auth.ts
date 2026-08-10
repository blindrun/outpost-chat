import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { prisma } from "../plugins/db.js";
import { minioClient, BUCKET, PUBLIC_URL } from "../plugins/storage.js";
import { disconnectUser } from "../gateway/rooms.js";
import { EVERYONE_ROLE_NAME, DEFAULT_EVERYONE_PERMISSIONS } from "../util/permissions.js";
import { isInviteValid } from "../util/invites.js";
import { postSystemMessage } from "../util/bot.js";
import { consumeClaimCode } from "../util/claim.js";
import { verifyTurnstileToken } from "../util/turnstile.js";
import { mailConfigured, sendPasswordResetEmail } from "../util/mail.js";
import {
  verifyTotpCode,
  findMatchingBackupCode,
  signMfaPendingToken,
  verifyMfaPendingToken,
  getRpConfig,
} from "../util/mfa.js";

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.string().email(),
  password: z.string().min(8),
  inviteCode: z.string().optional(),
  claimCode: z.string().optional(),
  turnstileToken: z.string().optional(),
});

// "login" accepts either an email or a username — the login form only has
// one identity field, and forcing an email address there was a real
// avoidable gap (most people's muscle memory types their username first).
const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string(),
});

const updateProfileSchema = z.object({
  username: z.string().min(3).max(32).optional(),
  email: z.string().email().optional(),
  bio: z.string().max(240).nullable().optional(),
});

const updatePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

// Base64 SPKI of an ECDH P-256 public key. 91 raw bytes, so ~124 base64
// characters — the bound is a sanity check against junk, not a security
// control (the server never uses this key for anything, it only republishes
// it, and a malformed one simply fails to import on the recipient's side).
const publicKeySchema = z.object({
  publicKey: z.string().min(40).max(400),
});

// Deleting an account is irreversible, so it re-proves identity the same way
// every other destructive self-service action here does (password, plus the
// second factor when one is enabled) rather than trusting the session token
// alone. `username` is the client's typed-confirmation field — checked
// server-side too so the guard isn't purely cosmetic.
const deleteAccountSchema = z.object({
  password: z.string(),
  username: z.string(),
  code: z.string().min(6).max(11).optional(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const mfaVerifyCodeSchema = z.object({
  mfaToken: z.string(),
  code: z.string().min(6).max(11),
});

const mfaWebauthnOptionsSchema = z.object({
  mfaToken: z.string(),
});

const mfaWebauthnVerifySchema = z.object({
  mfaToken: z.string(),
  response: z.any(),
});

export function toPublicUser(user: {
  id: string;
  username: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  isOwner: boolean;
}) {
  return { id: user.id, username: user.username, email: user.email, avatarUrl: user.avatarUrl, bio: user.bio, isOwner: user.isOwner };
}

export async function authRoutes(app: FastifyInstance) {
  // Registration. The very first user on a fresh instance becomes its owner
  // and never needs an invite code — that same moment is also when we
  // bootstrap the instance itself (InstanceSettings singleton row, a default
  // "general" channel, the @everyone role). Every subsequent registrant is
  // gated by InstanceSettings.requireInviteToRegister, same as any other
  // self-hosted app's "invite-only" toggle.
  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: body.email }, { username: body.username }] },
    });
    if (existing) {
      return reply.status(409).send({ error: "username or email already taken" });
    }

    // Turnstile only guards real public sign-up, not the very first
    // (owner-bootstrap) account — that one's gated by a claim code the
    // self-hoster reads off their own server console, not something a bot
    // could ever reach.
    const isFirstUser = (await prisma.user.count()) === 0;
    if (!isFirstUser && !(await verifyTurnstileToken(body.turnstileToken, req.ip))) {
      return reply.status(400).send({ error: "captcha verification failed" });
    }

    try {
      const { user, botSettings } = await prisma.$transaction(async (tx) => {
        const userCount = await tx.user.count();
        const passwordHash = await bcrypt.hash(body.password, 12);

        if (userCount === 0) {
          if (!(await consumeClaimCode(body.claimCode, tx))) {
            throw new Error("CLAIM_CODE_INVALID");
          }
          const created = await tx.user.create({
            data: { username: body.username, email: body.email, passwordHash, isOwner: true },
          });
          await tx.instanceSettings.upsert({
            where: { id: "singleton" },
            create: {},
            update: {},
          });
          await tx.botSettings.upsert({
            where: { id: "singleton" },
            create: {},
            update: {},
          });
          await tx.channel.create({ data: { name: "general", type: "TEXT" } });
          const everyoneRole = await tx.role.create({
            data: { name: EVERYONE_ROLE_NAME, permissions: DEFAULT_EVERYONE_PERMISSIONS },
          });
          await tx.userRole.create({ data: { userId: created.id, roleId: everyoneRole.id } });
          return { user: created, botSettings: null };
        }

        const settings = await tx.instanceSettings.upsert({
          where: { id: "singleton" },
          create: {},
          update: {},
        });
        if (settings.requireInviteToRegister) {
          if (!body.inviteCode) {
            throw new Error("INVITE_REQUIRED");
          }
          const invite = await tx.invite.findUnique({ where: { code: body.inviteCode } });
          if (!invite || !isInviteValid(invite)) {
            throw new Error("INVITE_INVALID");
          }
          await tx.invite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } });
        }

        const created = await tx.user.create({
          data: { username: body.username, email: body.email, passwordHash },
        });
        const everyoneRole = await tx.role.findFirst({ where: { name: EVERYONE_ROLE_NAME } });
        if (everyoneRole) {
          await tx.userRole.create({ data: { userId: created.id, roleId: everyoneRole.id } });
        }

        const bot = await tx.botSettings.upsert({ where: { id: "singleton" }, create: {}, update: {} });
        if (bot.autoRoleEnabled && bot.autoRoleId && bot.autoRoleId !== everyoneRole?.id) {
          const autoRole = await tx.role.findUnique({ where: { id: bot.autoRoleId } });
          if (autoRole) {
            await tx.userRole.create({ data: { userId: created.id, roleId: autoRole.id } });
          }
        }

        return { user: created, botSettings: bot };
      });

      // Deliberately outside the transaction — posting the welcome message
      // broadcasts over the live gateway, which isn't transactional and
      // shouldn't block/rollback registration if it fails.
      if (botSettings?.welcomeEnabled && botSettings.welcomeChannelId) {
        await postSystemMessage(
          botSettings.welcomeChannelId,
          botSettings.welcomeMessage.replaceAll("{user}", user.username),
        );
      }

      const token = app.jwt.sign({ sub: user.id, username: user.username });
      return reply.status(201).send({ token, user: toPublicUser(user) });
    } catch (err) {
      if (err instanceof Error && (err.message === "INVITE_REQUIRED" || err.message === "INVITE_INVALID")) {
        return reply.status(403).send({ error: "a valid invite code is required to register on this instance" });
      }
      if (err instanceof Error && err.message === "CLAIM_CODE_INVALID") {
        return reply
          .status(403)
          .send({ error: "invalid or missing claim code — check the server console output for this instance" });
      }
      throw err;
    }
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({ where: { OR: [{ email: body.login }, { username: body.login }] } });
    if (!user || user.isBot) {
      return reply.status(401).send({ error: "invalid credentials" });
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "invalid credentials" });
    }

    if (user.banned) {
      return reply.status(403).send({ error: "this account has been banned" });
    }

    const webauthnCredentials = await prisma.webauthnCredential.findMany({
      where: { userId: user.id },
      select: { id: true, nickname: true },
    });
    if (user.totpEnabled || webauthnCredentials.length > 0) {
      // Password checked out, but the account has a second factor — hold
      // off on the real session token until POST /auth/mfa/verify-code or
      // the webauthn options/verify pair succeeds.
      return reply.send({
        mfaRequired: true,
        mfaToken: signMfaPendingToken(app, user.id),
        totpEnabled: user.totpEnabled,
        webauthnCredentials,
      });
    }

    const token = app.jwt.sign({ sub: user.id, username: user.username });
    return reply.send({ token, user: toPublicUser(user) });
  });

  // Self-service password recovery — off by default (InstanceSettings.
  // smtpEnabled), since most self-hosted instances have no mail server to
  // send from; the owner-triggered POST /moderation/:userId/reset-password
  // is what covers account recovery until a self-hoster configures one.
  // Always responds the same way whether or not the email matched a real
  // account (only the presence/absence of a sent email would leak that
  // otherwise) — the response never distinguishes "no such account" from
  // "email sent", only "this server doesn't have email set up at all",
  // which is public instance capability info, not anything about a
  // specific user.
  app.post(
    "/auth/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = forgotPasswordSchema.parse(req.body);
      const settings = await prisma.instanceSettings.upsert({ where: { id: "singleton" }, create: {}, update: {} });
      if (!mailConfigured(settings)) {
        return reply.status(503).send({ error: "password reset by email isn't set up on this server" });
      }

      const user = await prisma.user.findUnique({ where: { email: body.email } });
      if (user && !user.isBot) {
        const rawToken = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        // One live token per account — a fresh request supersedes any
        // earlier unused one rather than leaving multiple valid links
        // outstanding.
        await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
        await prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
        });
        const { origin } = getRpConfig(req);
        const resetUrl = `${origin}/?reset=${rawToken}`;
        try {
          await sendPasswordResetEmail(settings, user.email, resetUrl);
        } catch (err) {
          req.log.error(err, "failed to send password reset email");
        }
      }
      return { ok: true };
    },
  );

  app.post(
    "/auth/reset-password",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = resetPasswordSchema.parse(req.body);
      const tokenHash = createHash("sha256").update(body.token).digest("hex");
      const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
      if (!record || record.expiresAt < new Date()) {
        if (record) await prisma.passwordResetToken.delete({ where: { id: record.id } }).catch(() => {});
        return reply.status(400).send({ error: "this reset link is invalid or has expired" });
      }

      const passwordHash = await bcrypt.hash(body.newPassword, 12);
      await prisma.user.update({ where: { id: record.userId }, data: { passwordHash } });
      // Same "one live token" rule as issuance — using it invalidates any
      // other outstanding token for the account too.
      await prisma.passwordResetToken.deleteMany({ where: { userId: record.userId } });
      return { ok: true };
    },
  );

  // Second step of login for an MFA-enabled account — a 6-digit TOTP code
  // or one of the account's unused backup codes, either is accepted here.
  app.post(
    "/auth/mfa/verify-code",
    // A 6-digit TOTP code only has 1,000,000 possibilities — without this,
    // the whole point of a second factor (something the attacker doesn't
    // already have) evaporates the moment they've captured a valid
    // mfaToken, since guessing is otherwise cheap and fast.
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
    const body = mfaVerifyCodeSchema.parse(req.body);

    let userId: string;
    try {
      ({ userId } = verifyMfaPendingToken(app, body.mfaToken));
    } catch {
      return reply.status(401).send({ error: "invalid or expired login session — please log in again" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(401).send({ error: "invalid credentials" });
    if (user.banned) return reply.status(403).send({ error: "this account has been banned" });

    let ok = false;
    if (user.totpEnabled && user.totpSecret) {
      ok = await verifyTotpCode(user.totpSecret, body.code);
    }
    if (!ok && user.backupCodes.length > 0) {
      const idx = await findMatchingBackupCode(user.backupCodes, body.code);
      if (idx >= 0) {
        ok = true;
        const remaining = [...user.backupCodes];
        remaining.splice(idx, 1);
        await prisma.user.update({ where: { id: user.id }, data: { backupCodes: remaining } });
      }
    }
    if (!ok) return reply.status(401).send({ error: "invalid code" });

    const token = app.jwt.sign({ sub: user.id, username: user.username });
    return reply.send({ token, user: toPublicUser(user) });
  });

  // WebAuthn as the second factor — options then verify, same two-step
  // shape as the management endpoints in routes/mfa.ts, but scoped to the
  // mfa-pending token instead of a real session (the user isn't logged in
  // yet). No server-side challenge store: the challenge rides inside a
  // freshly re-signed mfa-pending token that the client echoes back.
  app.post("/auth/mfa/webauthn/options", async (req, reply) => {
    const body = mfaWebauthnOptionsSchema.parse(req.body);

    let userId: string;
    try {
      ({ userId } = verifyMfaPendingToken(app, body.mfaToken));
    } catch {
      return reply.status(401).send({ error: "invalid or expired login session — please log in again" });
    }

    const credentials = await prisma.webauthnCredential.findMany({ where: { userId } });
    if (credentials.length === 0) {
      return reply.status(400).send({ error: "no security keys registered on this account" });
    }

    const { rpID } = getRpConfig(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      userVerification: "preferred",
    });

    return reply.send({ options, mfaToken: signMfaPendingToken(app, userId, options.challenge) });
  });

  app.post("/auth/mfa/webauthn/verify", async (req, reply) => {
    const body = mfaWebauthnVerifySchema.parse(req.body);

    let userId: string;
    let challenge: string | undefined;
    try {
      ({ userId, webauthnChallenge: challenge } = verifyMfaPendingToken(app, body.mfaToken));
    } catch {
      return reply.status(401).send({ error: "invalid or expired login session — please log in again" });
    }
    if (!challenge) {
      return reply.status(400).send({ error: "no active security-key challenge — request options first" });
    }

    const credentialId = body.response?.id;
    const stored = credentialId
      ? await prisma.webauthnCredential.findFirst({ where: { userId, credentialId } })
      : null;
    if (!stored) return reply.status(401).send({ error: "unrecognized security key" });

    const { rpID, origin } = getRpConfig(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch {
      return reply.status(401).send({ error: "security key verification failed" });
    }
    if (!verification.verified) {
      return reply.status(401).send({ error: "security key verification failed" });
    }

    await prisma.webauthnCredential.update({
      where: { id: stored.id },
      data: { counter: verification.authenticationInfo.newCounter },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.banned) return reply.status(403).send({ error: "this account has been banned" });

    const token = app.jwt.sign({ sub: user.id, username: user.username });
    return reply.send({ token, user: toPublicUser(user) });
  });

  app.get("/auth/me", { onRequest: [app.authenticate] }, async (req) => {
    const { sub } = req.user as { sub: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sub } });
    return toPublicUser(user);
  });

  // Update username/email/bio. Re-issues a JWT when the username changes, since
  // the gateway reads `username` from the token at connect time (not a live
  // DB lookup) — the client is expected to swap in the new token and
  // reconnect so live broadcasts show the new name immediately.
  app.patch("/auth/me", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = updateProfileSchema.parse(req.body ?? {});

    if (body.username || body.email) {
      const existing = await prisma.user.findFirst({
        where: {
          id: { not: userId },
          OR: [...(body.username ? [{ username: body.username }] : []), ...(body.email ? [{ email: body.email }] : [])],
        },
      });
      if (existing) return reply.status(409).send({ error: "username or email already taken" });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.username ? { username: body.username } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.bio !== undefined ? { bio: body.bio } : {}),
      },
    });

    const token = app.jwt.sign({ sub: user.id, username: user.username });
    return reply.send({ token, user: toPublicUser(user) });
  });

  app.patch("/auth/me/password", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = updatePasswordSchema.parse(req.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!valid) return reply.status(401).send({ error: "current password is incorrect" });

    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return reply.status(204).send();
  });

  // Publishes this user's DM encryption public key. Deliberately overwritable:
  // someone who loses their recovery code and sets up encryption again gets a
  // new keypair, and their contacts should see a "security key changed"
  // warning rather than this endpoint refusing and leaving them unable to use
  // encrypted DMs at all. Detecting that change is the client's job (see the
  // trust-on-first-use pinning in the DM crypto), not something the server can
  // be trusted to report about itself.
  app.put("/auth/me/public-key", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = publicKeySchema.parse(req.body);
    await prisma.user.update({ where: { id: userId }, data: { publicKey: body.publicKey } });
    return reply.status(204).send();
  });

  // Self-service account deletion. Before this, the only way out was asking
  // the instance owner to do it by hand (the delete-account URL declared to
  // Google Play pointed at outpost-chat.com's contact form) — a real gap for
  // a self-hosted app that stores an email address and a password hash.
  //
  // What's removed vs. what deliberately stays:
  //   - Removed: the User row itself (which cascades WebauthnCredential,
  //     UserRole, Warning, Friendship and DMParticipant via real FKs), every
  //     non-FK row keyed by userId (reactions, level/XP, read state,
  //     outstanding reset tokens), any invite this account minted, and the
  //     avatar image. Invites go on the same "revoke a departing member's
  //     credentials" principle that applies anywhere else — an invite is a
  //     live join credential, and one left behind keeps admitting new members
  //     on the authority of an account that no longer exists. (The owner can
  //     see and revoke every invite instance-wide, so this isn't about them
  //     being unreachable; it's about not making the owner notice.)
  //   - Kept: their messages, which lose their author link the same way a
  //     deleted bot's already do (Message.authorId is a plain string, no FK)
  //     and render as "Deleted User". Deleting them instead would punch holes
  //     through every conversation they took part in, including other
  //     people's replies and quotes. Also kept: their non-avatar uploads,
  //     which are the attachments on exactly those messages, and their
  //     ModerationLogEntry rows, which have no FK precisely so the audit
  //     trail survives a deleted account.
  app.delete(
    "/auth/me",
    { onRequest: [app.authenticate], config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const { sub: userId } = req.user as { sub: string };
      const body = deleteAccountSchema.parse(req.body);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

      // The owner is the instance's only un-droppable role — there's no
      // ownership-transfer mechanism in this app, so letting them delete
      // themselves would strand the instance with no one able to reach
      // Instance Settings, reset a password, or claim it back (the claim
      // code is consumed at first registration and never reissued).
      if (user.isOwner) {
        return reply.status(400).send({
          error: "the instance owner can't delete their own account — an owner-less instance can't be administered",
        });
      }

      const valid = await bcrypt.compare(body.password, user.passwordHash);
      if (!valid) return reply.status(401).send({ error: "password is incorrect" });
      if (body.username !== user.username) {
        return reply.status(400).send({ error: "the username you typed doesn't match this account" });
      }

      // Same second-factor check as login (TOTP or a backup code) — an
      // attacker sitting on a stolen session shouldn't be able to destroy
      // the account when they couldn't have logged in to create it.
      if (user.totpEnabled) {
        if (!body.code) return reply.status(401).send({ error: "two-factor code required" });
        let ok = user.totpSecret ? await verifyTotpCode(user.totpSecret, body.code) : false;
        if (!ok && user.backupCodes.length > 0) {
          ok = (await findMatchingBackupCode(user.backupCodes, body.code)) >= 0;
        }
        if (!ok) return reply.status(401).send({ error: "invalid code" });
      }

      // Best-effort, and deliberately before the row disappears — a failure
      // here (MinIO down, object already gone) must not abort a deletion the
      // user has already fully authenticated for and can't retry halfway.
      if (user.avatarUrl?.startsWith(PUBLIC_URL)) {
        const key = user.avatarUrl.slice(PUBLIC_URL.length + 1);
        await minioClient.removeObject(BUCKET, key).catch((err) => {
          req.log.error({ err, key }, "failed to remove avatar object during account deletion");
        });
      }

      await prisma.$transaction([
        prisma.reaction.deleteMany({ where: { userId } }),
        prisma.userLevel.deleteMany({ where: { userId } }),
        prisma.channelReadState.deleteMany({ where: { userId } }),
        prisma.passwordResetToken.deleteMany({ where: { userId } }),
        prisma.invite.deleteMany({ where: { createdBy: userId } }),
        prisma.user.delete({ where: { id: userId } }),
      ]);

      // Their own other tabs/devices are still holding a JWT that now points
      // at nothing; this drops those sockets immediately instead of leaving
      // them live until the next failed request, mirroring what ban does.
      disconnectUser(userId, "account_deleted");
      return reply.status(204).send();
    },
  );
}
