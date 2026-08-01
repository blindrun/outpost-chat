# Changelog

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
