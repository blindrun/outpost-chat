# Flatpak / Flathub packaging

The desktop client, packaged for Flathub. Once accepted there it appears in
**Bazaar** (the app store on Bazzite), GNOME Software and KDE Discover
automatically — Flathub is the remote all three read.

This is separate from the AppImage and `.deb` that `electron-builder`
produces for GitHub Releases. Those stay as they are.

## Why the build looks unusual

Flathub builds **offline**. `npm install` cannot reach the network, so every
dependency has to be declared in `generated-sources.json` ahead of time:

```sh
# once
pip install flatpak-node-generator   # or use the flatpak-builder-tools repo

# on every release, after the lockfiles change
flatpak-node-generator npm ../electron/package-lock.json -o generated-sources.json
flatpak-node-generator npm ../web/package-lock.json -o generated-sources-web.json
```

A build that works locally and fails on Flathub's infrastructure is almost
always this: something still fetching at build time.

## Before submitting

1. **Check the runtime versions.** `runtime-version`, `base-version` and the
   node SDK extension in the manifest all rotate. Stale values are an
   automatic rejection.
2. **Pin the commit.** Replace `REPLACE_WITH_COMMIT_SHA_OF_TAG` with the real
   SHA of the release tag. Flathub requires it so a moved tag can't change
   what gets built.
3. **Host the screenshots.** The metainfo references
   `https://sonofatech.com/outpost/screenshots/*.png`; those need to exist and
   be reachable over HTTPS. The same captures serve the App Store and Play
   listings.
4. **Build and run it locally** before opening the PR.

## Submission

A pull request against the `new-pr` branch of the `flathub/flathub` repo. The
manifest, metainfo and desktop file all move into a repo named for the app ID.

## The open risk

**Voice and screen share under the sandbox are unproven.** Voice is the whole
point of this app, and the sandbox mediates both audio capture and screen
capture:

- Microphone and playback go through `--socket=pulseaudio`.
- Screen sharing goes through the xdg-desktop-portal ScreenCast portal, which
  returns a PipeWire stream — hence `--filesystem=xdg-run/pipewire-0:ro`.
  Electron's screen capture on Wayland is genuinely fiddly, and Bazzite is
  Wayland-first.

Test both on a real Bazzite VM before investing in the submission. If
sandboxed voice can't be made to work, that decides the project.
