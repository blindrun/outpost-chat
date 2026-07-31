import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { prisma } from "../plugins/db.js";
import {
  generateTotpSecret,
  totpQrCodeDataUrl,
  verifyTotpCode,
  generateBackupCodes,
  signWebauthnRegChallenge,
  verifyWebauthnRegChallenge,
  getRpConfig,
} from "../util/mfa.js";

const totpConfirmSchema = z.object({ code: z.string().min(6).max(6) });
const passwordSchema = z.object({ password: z.string() });
const webauthnRegisterOptionsSchema = z.object({});
const webauthnRegisterVerifySchema = z.object({
  challengeToken: z.string(),
  response: z.any(),
  nickname: z.string().min(1).max(64),
});

export async function mfaRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/mfa/status", async (req) => {
    const { sub: userId } = req.user as { sub: string };
    const [user, webauthnCredentials] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabled: true, backupCodes: true } }),
      prisma.webauthnCredential.findMany({
        where: { userId },
        select: { id: true, nickname: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      totpEnabled: user.totpEnabled,
      backupCodesRemaining: user.backupCodes.length,
      webauthnCredentials,
    };
  });

  // Generates a fresh secret and stores it unconfirmed (totpEnabled stays
  // false) — calling this again before confirming just overwrites the
  // pending secret, no cleanup needed if the user abandons setup partway.
  app.post("/mfa/totp/setup", async (req) => {
    const { sub: userId } = req.user as { sub: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: userId }, data: { totpSecret: secret } });
    const qrCodeDataUrl = await totpQrCodeDataUrl(user.username, secret);
    return { secret, qrCodeDataUrl };
  });

  app.post("/mfa/totp/confirm", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = totpConfirmSchema.parse(req.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecret) {
      return reply.status(400).send({ error: "call POST /mfa/totp/setup first" });
    }
    if (!(await verifyTotpCode(user.totpSecret, body.code))) {
      return reply.status(400).send({ error: "invalid code" });
    }

    const { plaintext, hashed } = await generateBackupCodes();
    await prisma.user.update({ where: { id: userId }, data: { totpEnabled: true, backupCodes: hashed } });
    // The one and only time these are readable — only bcrypt hashes are
    // kept from here on, same as a password.
    return { backupCodes: plaintext };
  });

  app.post("/mfa/totp/disable", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = passwordSchema.parse(req.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      return reply.status(401).send({ error: "incorrect password" });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null, backupCodes: [] },
    });
    return reply.status(204).send();
  });

  // Invalidates every existing backup code and issues a fresh set — for
  // when the user has used most of them up, or suspects the old list leaked.
  app.post("/mfa/backup-codes/regenerate", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = passwordSchema.parse(req.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabled) return reply.status(400).send({ error: "TOTP is not enabled" });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      return reply.status(401).send({ error: "incorrect password" });
    }

    const { plaintext, hashed } = await generateBackupCodes();
    await prisma.user.update({ where: { id: userId }, data: { backupCodes: hashed } });
    return { backupCodes: plaintext };
  });

  app.post("/mfa/webauthn/register/options", async (req) => {
    const { sub: userId } = req.user as { sub: string };
    webauthnRegisterOptionsSchema.parse(req.body ?? {});
    const [user, existing] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      prisma.webauthnCredential.findMany({ where: { userId } }),
    ]);

    const { rpID } = getRpConfig(req);
    const options = await generateRegistrationOptions({
      rpName: "Outpost",
      rpID,
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      userDisplayName: user.username,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });

    return { options, challengeToken: signWebauthnRegChallenge(app, userId, options.challenge) };
  });

  app.post("/mfa/webauthn/register/verify", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = webauthnRegisterVerifySchema.parse(req.body);

    let challenge: string;
    try {
      const decoded = verifyWebauthnRegChallenge(app, body.challengeToken);
      if (decoded.userId !== userId) throw new Error("token belongs to a different user");
      challenge = decoded.challenge;
    } catch {
      return reply.status(401).send({ error: "invalid or expired registration session — please try again" });
    }

    const { rpID, origin } = getRpConfig(req);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch {
      return reply.status(400).send({ error: "security key registration failed" });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return reply.status(400).send({ error: "security key registration failed" });
    }

    const { credential } = verification.registrationInfo;
    const created = await prisma.webauthnCredential.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        nickname: body.nickname,
      },
    });
    return reply.status(201).send({ id: created.id, nickname: created.nickname, createdAt: created.createdAt });
  });

  // Same re-auth requirement as TOTP disable / password change — removing a
  // security key is a self-service security action, not a routine one.
  app.delete("/mfa/webauthn/:credentialId", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { credentialId } = req.params as { credentialId: string };
    const body = passwordSchema.parse(req.body);

    const [user, credential] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      prisma.webauthnCredential.findUnique({ where: { id: credentialId } }),
    ]);
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      return reply.status(401).send({ error: "incorrect password" });
    }
    if (!credential || credential.userId !== userId) {
      return reply.status(404).send({ error: "security key not found" });
    }

    await prisma.webauthnCredential.delete({ where: { id: credentialId } });
    return reply.status(204).send();
  });
}
