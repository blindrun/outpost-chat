# Changelog

## v0.3.1 — 2026-08-04

- **Fixed the message avatar drifting away from the username on longer messages.** The avatar's wrapping button kept Chromium's default content-centering behavior even though it was set to `display: block`, so the avatar sank further from the username line the taller a message's (stretched) row got instead of staying pinned near the top. Confirmed in an isolated test harness before shipping — offset went from growing with message length to a constant, intentional 2px nudge regardless of message length.

## v0.3.0 — 2026-08-03

- **Import an existing Discord server.** New owner-only Import tab in Instance Settings: point it at a Discord server via a bot token you create yourself, and it recreates the channels, roles, and custom emoji here — with an opt-in (off by default) full message history backfill, attributed to one per-author webhook identity rather than a single generic import account. Meant to be run once, early, before real content accumulates — see the in-app instructions for the Discord-side bot setup and known limitations (no category concept, coarse permission mapping, not a merge/sync tool).
- The Friends list now shows the same green "unread" dot as the DM sidebar when a friend has sent you a message you haven't opened yet — previously that only showed in the sidebar, not in the Friends list itself.
- **A first-login tutorial for new members.** Registering on an already-set-up instance now shows a short, skippable 4-card walkthrough covering push-to-talk vs. voice-activity mode, @mentions and custom emoji, message reply/edit/thread, and where to find Friends/DMs — the admin-focused tour the very first owner already got (Invites, Roles, the built-in bot, Webhooks) stays owner-only and unchanged. Shown once, right after registration; logging back in afterward skips straight to the app.

## v0.2.21 — 2026-08-03

- **The Android app is downloadable for the first time.** A debug build (self-signed — Android will warn it's from outside the Play Store, expected for now) is attached directly to this release on the [Releases page](https://github.com/blindrun/outpost-chat/releases), the same way the desktop installers are. It's still the Capacitor wrapper around the same web client, not a from-scratch native app.
- **Fixed voice channels not working in the Android app at all.** Two separate bugs, both only reachable via real device testing (nothing in local dev or CI could catch either): the WebView never forwarded the page's microphone permission request to Android's own runtime permission system, so joining voice silently failed with no mic prompt ever appearing; fixing that surfaced a second failure (`NotReadableError`, "could not start audio source") because nothing was putting the device's audio system into communication mode, which Chromium's WebView needs to actually open the microphone. Voice channels now work end-to-end on a real device.

## Internal / infrastructure — 2026-08-03

No user-facing changes; not a tagged release.

- Fixed the Android CI workflow's manual test-build artifact: it was uploading an `.aab` (Android App Bundle), which isn't directly installable — that format only exists for Play Console to generate device-specific APKs from. Manual (`workflow_dispatch`) runs now build and upload a debug APK instead, which can actually be sideloaded onto a real device.
- Patched a Dependabot alert (`uuid` < 11.1.1, medium severity) in the mobile client's dependency tree via an npm `overrides` pin to 11.1.1. Pulled in transitively through `@capacitor/cli` → `xcode`, which only ever calls the unaffected `uuid.v4()` code path, and is dev-only tooling never shipped in the app — low real risk, patched anyway since it was free.

## v0.2.20 — 2026-08-03

- **The connected-voice details panel no longer covers the channel list.** It used to open directly over the sidebar, blocking channel navigation while connected to voice. It now floats over the main chat area instead, and can be minimized down to a slim status bar to get it fully out of the way.

## v0.2.19 — 2026-08-02

- **Fixed captcha failures on the desktop app.** Cloudflare Turnstile sitekeys are locked to specific domains, but the Windows/Mac/Linux desktop app runs its UI from a `file://` origin, which never matches — so registration always failed with "captcha verification failed" there, even though the exact same widget worked fine on the web. The captcha now renders inside an iframe pointed at the instance's own domain (a new small page the server hosts), so it always runs same-origin with the real backend no matter which client loads it.
- **Fixed push-to-talk not actually gating the mic.** Joining a voice channel in PTT mode left the mic hot until the first time you released the bind key — PTT effectively had no effect until then, and if no key was ever bound, the mic just stayed open indefinitely. It now starts silent on join, same as it always should have.

## v0.2.18 — 2026-08-02

- **The web app is actually usable on a phone now.** Previously the desktop layout just got squeezed onto a small screen — now it switches to full-screen panes (server/channel list, chat, members) below tablet width, with a hamburger button and a proper back button to move between them.
- Message actions (reply/react/edit/delete) now also open with a tap, not just a hover — there's no hover on a touchscreen.
- Fixed videos and GIFs overflowing the screen on mobile instead of scaling down to fit.
- Bumped touch target sizes on the header icons (they were sized for a mouse cursor) and fixed them rendering too dim to see clearly on mobile.
- Push-to-talk now has an on-screen hold button, for when there's no keyboard to bind a key on.
- Fixed a webhook bug: a per-message username/avatar override (for a bot posting as different personas) would silently revert to the webhook's default identity on page reload — the override was broadcast live but never actually saved.

## v0.2.17 — 2026-08-02

- **Uploads are private now.** Avatars, message attachments, and custom emoji were previously stored in a public-read bucket — anyone with a URL (leaked, guessed, or shared) could view it forever, even after it was deleted from the app. Uploads are now served through an authenticated route instead; a valid, non-banned session is required. No visible change for normal usage — existing links keep working, video seeking still works — this is entirely a server-side hardening change. Self-hosters: MinIO's own port no longer needs to be reachable from outside the host at all.

## v0.2.16 — 2026-08-02

- **Inline video playback.** Videos are now a real upload category (gated per-role, like documents/archives/code) and render as an actual playable `<video>` in chat instead of a download link. Raised the upload cap from 8MB to 25MB — 8MB was barely a couple of seconds of real video.
- **A real developer/bot API.** Instance Settings → API Bots lets an admin create bot accounts — real members with real roles and permissions, authenticated by a token instead of a password, usable against the same REST API (and gateway) any human client uses. Revoke or delete a bot at any time.
- **Owner-initiated password reset.** Before this, a member who forgot their password had no way to recover their account — not even the owner could help. Instance Settings → Members now has a "reset password" action for the owner that generates a one-time temp password to relay to the member directly.
- **A real moderation audit log.** Every ban, kick, mute, and password reset now leaves a permanent record of who did it, to whom, and when — visible to anyone with moderator permissions, under a new Audit Log tab.
- **Login/register/2FA brute-force protection.** These previously had no rate limiting at all. Now capped at 10 attempts per 10 minutes per IP.
- Fixed the full emoji picker rendering off the top of the screen for a message near the top of a channel — it now opens downward when there isn't room above.
- Moved the Friends button to the user bar at the bottom-left (next to your avatar and settings) so it's reachable everywhere, not just when the member list happens to be open.

## v0.2.15 — 2026-08-02

- Fixed the v0.2.14 Docker image crashing on startup (`webidl.util.markAsUncloneable is not a function`) — the link-preview feature's new `undici` dependency resolved to a version too new for the image's Node 20 runtime. Caught within minutes via the live instance's health check and rolled back immediately; nobody's data was affected. Pinned to a Node-20-compatible version and verified by actually booting the real production image locally before shipping this release, not just typechecking.

## v0.2.14 — 2026-08-02

- **Rich link previews.** Paste a URL in a message and it now unfurls into a preview card below the message — title, description, and image, pulled from the page's own metadata, same as Discord/Slack. URLs are also clickable now (they weren't before). Only the first link in a message gets a preview card; a link inside a code block or inline code stays plain text and doesn't fetch anything.

## v0.2.13 — 2026-08-01

- **Custom emoji as message reactions.** Following up on v0.2.12's custom server emoji, they're now usable as a reaction too, not just in message text — the reaction picker's "Server" tab, added last release for the composer, now works there as well.

## v0.2.12 — 2026-08-01

- **Custom server emoji.** Upload your own emoji from Instance Settings → Emoji, then use it in a message as `:name:` — it renders inline as the real image. Shows up first in the emoji picker under a new "Server" tab. Not usable as a message reaction yet, only in message text.

## v0.2.11 — 2026-08-01

- **Channel-level permission overrides.** A channel can now be restricted to specific roles — hidden from the sidebar and inaccessible (REST, live gateway events, and voice join) to anyone without one of those roles. Manage it from Instance Settings → Channels. Previously every channel was visible and joinable by anyone on the instance.
- **Login with your username**, not just your email — the login form only ever accepted an email address, which was an easy trap since usernames are what you actually see everywhere else in the app.
- The Direct Messages sidebar section is now collapsible, matching Text/Voice Channels.
- The green presence dot next to a channel/DM now means **unread**, not online — it only appears when a message has arrived since you last had that channel open, and now shows on text channels too, not just DMs.
- Hovering a message reaction now shows who reacted with it.
- Fixed blurry, badly-cropped GIF picker thumbnails — they were being upscaled from a 100px-wide source image and then force-cropped into a fixed-height box, which mangled anything not close to that exact aspect ratio (especially portrait GIFs). Thumbnails now render at their true size with no cropping.

## v0.2.10 — 2026-08-01

- Fixed Voice Channels appearing at the very bottom of the sidebar with a large empty gap above it — it now sits directly under Text Channels as expected.

## v0.2.9 — 2026-07-31

- Fixed the message composer being a single-line input that couldn't actually hold a multi-line message — Enter always sent immediately with no way to insert a line break, and pasting multi-line text (like a script) had its line breaks silently stripped. This made the v0.2.7 code-block feature unreachable in practice. Now Enter sends and **Shift+Enter** adds a line break, and the composer grows with your message as you type.

## v0.2.8 — 2026-07-31

- File-type upload permissions (below, v0.2.7) are now granted per role instead of one instance-wide switch — a role can be given permission to attach documents, archives, and/or code files independently, same as any other permission like Manage Channels. Images are unaffected either way and remain uploadable by everyone regardless of role.
- Roles can now be edited after creation (name and permissions) — previously the only way to change a role's permissions was to delete and recreate it.

## v0.2.7 — 2026-07-31

- **Code blocks in messages.** Paste a fenced ` ```code block``` ` or inline `` `code` `` and it now renders in a monospace block instead of a single run-on line — makes sharing scripts and config actually usable.
- **Non-image file attachments.** Messages can now include documents, archives, and code/script files, not just images — gated per-server (see v0.2.8 above for how). Non-image attachments show as a downloadable file chip instead of a broken image preview.
- Fixed the instance theme picker being a hard-to-read grid of buttons — now a proper dropdown.
- Fixed poor text contrast in dropdown menus across all four themes, most noticeably on the Hacker theme.
- Fixed illegible initials on the currently-selected server icon under the Hacker theme when no custom icon is set.

## v0.2.6 — 2026-07-31

- Fixed a crash on login introduced in v0.2.4 that briefly took the hosted instance down (see the v0.2.4 note below) — rolled back same day, real fix shipped here after local testing.
- Added automatic reconnection for the chat connection — a dropped connection from a deploy, your laptop sleeping, or a network blip now recovers on its own instead of leaving you stuck until a manual page reload.
- Fixed GIFs and images not triggering auto-scroll to the newest message (text and emoji already did).
- Text Channels, Voice Channels, and the member list's Online/Offline groups can now each be collapsed from their header — state is remembered.

## v0.2.4 — 2026-07-31 — caused a brief outage, do not use

This version shipped, then caused a live login crash within minutes and was rolled back the same day. Root cause: a React hook was placed after a conditional early-return, which crashed the whole app to a blank screen the moment you logged in. Anyone who had the app open when this deployed would have needed a manual reload to recover. Fixed in v0.2.6 above. We've since adopted a standing rule to test every change locally before it reaches the hosted instance, specifically to catch this class of bug before it ships.

## v0.2.3 — 2026-07-31

- Fixed the real root cause of "scrolling feels broken" reports — a page-level layout gap meant scrolling any one panel (server list, channel list, member list) could drag the others along with it. Every panel now scrolls independently, as intended.

## v0.2.2 — 2026-07-31

- Moved the Friends icon and added a member search box, both now in the member list panel's header instead of the channel sidebar.

## v0.2.1 — 2026-07-31

- You can now send a friend request or start a DM directly from someone's profile card, not just from the standalone Friends panel.

## v0.2.0 — 2026-07-31

- **Friends & direct messages.** Add friends, accept/decline requests, block/unblock, and DM anyone you're friends with — scoped to the instance you're on.
- **Two-factor authentication.** Secure your account with an authenticator app (TOTP — Google Authenticator, Authy, etc.) or a security key / platform authenticator (YubiKey, Touch ID, Windows Hello), plus one-time backup codes for account recovery.
- Fixed a crash when logging in with a backup code.
- Fixed a layout bug where the app's four main panels could grow past their intended size instead of scrolling.

## v0.1.6 — 2026-07-31

- **Threads.** Reply to a message in its own thread without cluttering the main channel — threads keep full reactions, pinning, and bot command support.
- **Screen sharing** in voice channels, shown as floating video tiles that stay visible while you keep browsing other channels.
- **Reaction roles are now per-channel** instead of one shared menu for the whole server.
- **Moderation: warn/mute system.** Automod now logs a warning instead of silently deleting a blocked message, and repeated warnings within 24 hours auto-mute the user for a set duration. Moderators can also warn, mute, and unmute manually from a member's profile.
- **Kick and Ban.** Kick disconnects someone immediately (they can rejoin); Ban is permanent and takes effect instantly, even on already-open sessions.
- **Bot protection on sign-up (Cloudflare Turnstile)**, invisible for real visitors in almost all cases. This cleared the way to open public registration on self-hosted instances that choose to.
- Channels can now be drag-and-dropped to reorder for everyone, not just locally.
- A real leaderboard panel for server leveling/XP, replacing the old text-only `!leaderboard` command.
- General visual polish — buttons across the app now have proper hover/press states.
- Automated nightly backups for the hosted instance.

## v0.1.5 — 2026-07-30

- Replaced the old "toast notification does nothing when clicked" desktop update flow with a real app menu: **About**, **Check for Updates…**, and a working **Restart Now** button once an update finishes downloading.
- Fixed GIF search not working on hosted instances even with a Giphy API key configured.

## v0.1.4 — 2026-07-30

- Fixed the Linux desktop app showing a generic fallback icon instead of the Outpost flame.

## v0.1.3 — 2026-07-30

- First release to exercise the desktop app's auto-update pipeline end-to-end.

## v0.1.0 – v0.1.2 — 2026-07-28 — first public release

The initial public release of Outpost (renamed from an early "Harmony" working title before anyone outside testing had used it). Includes:

- Accounts, channels (text + voice), and role-based permissions.
- Real-time chat with typing indicators and online presence.
- Self-hosted voice channels (LiveKit) — join, mute, push-to-talk or voice-activity detection, per-user input/output device selection.
- Message editing, deletion, and emoji reactions.
- Image attachments and avatars.
- Server invites with optional usage limits and expiry.
- Four built-in themes (Signal Fire, Cyberpunk, Hacker, Esports).
- A one-click self-hosted Docker package, plus native desktop apps for Windows, macOS, and Linux.
- A real JWT authentication vulnerability (an empty signing secret could bypass auth) found and fixed before this release ever shipped.

v0.1.1 and v0.1.2 were same-day fixes to the release pipeline itself (Linux/Windows desktop builds) — no functional changes from v0.1.0.
