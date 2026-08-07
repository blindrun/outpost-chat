import nodemailer from "nodemailer";
import type { InstanceSettings } from "@prisma/client";

// Self-hoster-configured SMTP (see InstanceSettings in schema.prisma) — off
// by default, since most self-hosted instances have no mail infra and the
// existing owner-triggered reset-password (POST /moderation/:userId/reset-
// password) already covers account recovery without it. Only used for the
// self-service "forgot password" flow.
export function mailConfigured(
  settings: Pick<InstanceSettings, "smtpEnabled" | "smtpHost" | "smtpPort" | "smtpFromAddress">,
): boolean {
  return settings.smtpEnabled && !!settings.smtpHost && !!settings.smtpPort && !!settings.smtpFromAddress;
}

export async function sendPasswordResetEmail(settings: InstanceSettings, toEmail: string, resetUrl: string) {
  const transport = nodemailer.createTransport({
    host: settings.smtpHost!,
    port: settings.smtpPort!,
    // 465 is the one well-known implicit-TLS port; everything else (587,
    // 25, a custom relay port) is plaintext-then-STARTTLS, which nodemailer
    // negotiates on its own when the server offers it.
    secure: settings.smtpPort === 465,
    auth: settings.smtpUsername ? { user: settings.smtpUsername, pass: settings.smtpPassword ?? "" } : undefined,
  });

  await transport.sendMail({
    from: settings.smtpFromAddress!,
    to: toEmail,
    subject: `Reset your ${settings.name} password`,
    text: `Someone requested a password reset for your account on ${settings.name}.\n\nReset it here: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
    html: `<p>Someone requested a password reset for your account on <strong>${settings.name}</strong>.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
  });
}
