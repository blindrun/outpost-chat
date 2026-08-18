# App Store metadata

Everything App Store Connect needs, except the screenshots and two secrets.

`metadata/` is laid out the way `fastlane deliver` expects, so the listing is
reviewable in a diff instead of retyped into a web form every time.

## Upload it

Run from `mobile/ios` with the same App Store Connect API key CI already uses
(`APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
`APP_STORE_CONNECT_KEY_P8_BASE64`).

Preview without sending anything with command
`fastlane deliver --verify_only`

Upload text only, no screenshots or binary, with command
`fastlane deliver --skip_screenshots --skip_binary_upload`

Upload screenshots once they exist with command
`fastlane deliver --skip_metadata --skip_binary_upload`

## The two files that are deliberately missing

`review_information/demo_user.txt` and `demo_password.txt` hold the account
Apple's reviewer signs in with. **This repository is public**, so both are in
`.gitignore`. Create them locally right before uploading, or wire them in from
CI secrets. Everything else here is safe to publish and is already public
anyway, since it is the store listing.

The reviewer account is a real account on the reference instance. Reuse
`google-play-reviewer`, which already exists for the Play submission, or make a
new one. Its password was never stored anywhere durable, so a reset may be
needed.

## Screenshots

Not here yet, and they are the one blocking item.

Apple wants **1290x2796** (6.9 inch) or **1284x2778** (6.5 inch). One is the
minimum, ten is the cap. A 6.3 inch phone screenshot is **1179x2556**, which
Apple accepts only for the optional 6.3 inch slot, so a straight phone capture
does not satisfy the required one.

Put them in `screenshots/en-US/`, named so they sort in the order you want.

**Do not reuse the existing phone screenshots.** They were taken on the real
instance and contain another person's email address in plain text, several real
members' names and profile photos, and a copyrighted image posted in a channel.
Any of those is a problem in a public store listing. Shoot new ones against a
seeded demo community with invented names.

## Status, 2026-08-17

Uploaded to App Store Connect and saved. Verified by reloading the page, not by
trusting the Save button.

- 4 screenshots on the iPhone 6.5 inch slot. Apple reuses that slot for every
  other iPhone size, so it is the only one that needs filling.
- Promotional text, description, keywords, support URL, marketing URL,
  copyright.
- App Review notes.
- **Build 32 attached**, version 1.0.

Screenshots came from `~/immich-inbox` phone captures, resized 2556x1179 to
2778x1284 with Lanczos. Two of the six were **excluded deliberately**:
`IMG_7325` shows real members' display names and profile photographs, and
`IMG_7328` shows the owner's own email address in User Settings. Neither belongs
in a public listing.
