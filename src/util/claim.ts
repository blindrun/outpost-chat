import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../plugins/db.js";

// Excludes visually ambiguous characters (0/O, 1/I/L) so the code is easy
// to read off a terminal and type back in correctly.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateClaimCode(): string {
  const bytes = randomBytes(12);
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b % ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// Called once at server startup. No-ops once the instance has a real owner
// — the code only ever matters for claiming a fresh instance, same as
// TeamSpeak only ever printing its ServerAdmin token before that account
// exists.
export async function ensureClaimCode(log: { info: (msg: string) => void }) {
  const userCount = await prisma.user.count();
  if (userCount > 0) return;

  let claim = await prisma.claimCode.findUnique({ where: { id: "singleton" } });
  if (!claim) {
    claim = await prisma.claimCode.create({ data: { id: "singleton", code: generateClaimCode() } });
  }

  log.info(
    [
      "",
      "============================================================",
      "  This Outpost instance has not been claimed yet.",
      "  Claim it as the owner with this code:",
      "",
      `      ${claim.code}`,
      "",
      "  Enter it in the client when registering the first account.",
      "============================================================",
      "",
    ].join("\n"),
  );
}

// Validates + one-time-consumes the claim code inside the registration
// transaction. Returns false (never throws) on any mismatch so the caller
// can turn it into a clean 403 rather than a raw DB error leaking through.
export async function consumeClaimCode(code: string | undefined, tx: Prisma.TransactionClient): Promise<boolean> {
  if (!code) return false;
  const claim = await tx.claimCode.findUnique({ where: { id: "singleton" } });
  if (!claim || claim.code.toUpperCase() !== code.trim().toUpperCase()) return false;
  await tx.claimCode.delete({ where: { id: "singleton" } });
  return true;
}
