# Export compliance

`ITSAppUsesNonExemptEncryption` is set to `false` in `Info.plist`. That value
was added at v0.3.3 to clear an ITMS-90683 rejection, **before v0.4.0 shipped
end to end encrypted direct messages**. It therefore described an app that no
longer exists, and it was re-examined on 2026-08-17.

This is a regulatory declaration made by the developer, not by a tool. What
follows is the evidence and the reasoning. Confirm it before you rely on it.

## What the app actually does

Established by reading the source, not by assumption.

- The E2EE implementation is `web/src/crypto/`, and it calls **only the
  platform Web Crypto API** (`crypto.subtle`). Inside the iOS app that is
  WebKit's implementation, which is Apple's own.
- Algorithms are **ECDH on P-256, HKDF, AES-GCM and SHA-256**. All standard and
  published. Nothing proprietary, nothing invented here.
- The web client bundles **no cryptography libraries at all**. Checked against
  `web/package.json` for the usual suspects. There are none.
- `bcryptjs`, `otplib` and `@simplewebauthn/server` are **server** dependencies.
  The iOS app is a Capacitor wrapper around the web client, so none of them
  ship inside the binary.
- Transport is ordinary HTTPS.

So the app uses encryption, and every bit of it is standard and comes from the
operating system.

## Why `false` is defensible, and the one thing that makes it so

The strongest position is not "it is only OS crypto". E2EE messaging is a core
product feature rather than ancillary cryptography, and that argument gets
strained.

The clean route is that **Outpost's source is public under the MIT license at
`https://github.com/blindrun/outpost-chat`**.

Under **EAR 15 CFR 742.15(b)**, publicly available encryption source code, and
the object code compiled from it, is **not subject to the EAR** once a one time
email notification is sent to BIS and the NSA giving the URL. That is what
makes the encryption exempt, and therefore what makes
`ITSAppUsesNonExemptEncryption = false` an honest answer rather than a
leftover.

**The notification has not been sent.** Until it is, the exemption being relied
on is not in place. It is one email.

Useful detail: because the code is posted at a URL rather than mailed as a
copy, you only re-notify if **the location changes**. Ordinary updates to the
code at the same URL need no further notice.

## Send this

To: `crypt@bis.doc.gov`
Cc: `enc@nsa.gov`
Subject: `Notification of publicly available encryption source code - Outpost`

> This email provides notification under 15 CFR 742.15(b) of publicly
> available encryption source code.
>
> Product name: Outpost
> Internet location: https://github.com/blindrun/outpost-chat
> License: MIT
>
> The software provides end to end encrypted direct messaging between users.
> Cryptographic functionality is implemented entirely through the platform Web
> Crypto API using ECDH on P-256 for key agreement, HKDF for key derivation,
> AES-GCM for message encryption and SHA-256 for hashing. No cryptographic
> libraries are bundled and no proprietary cryptography is implemented.
>
> Name: <your name>
> Email: support@outpost-chat.com

Keep the sent copy. It is the evidence behind the declaration.

## If you would rather not rely on this

The alternative is to answer the export questions in App Store Connect at
submission time instead of hardcoding the key. Remove
`ITSAppUsesNonExemptEncryption` from `Info.plist` and App Store Connect will
ask on every build. That trades a one time email for a recurring manual
question, and it re-opens the ITMS-90683 friction that adding the key closed.

Sources: [15 CFR 742.15](https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-742/section-742.15),
[BIS, encryption items not subject to the EAR](https://www.bis.gov/learn-support/encryption-controls/encryption-items-not-subject-to-ear),
[EFF explainer](https://www.eff.org/deeplinks/2019/08/us-export-controls-and-published-encryption-source-code-explained)
