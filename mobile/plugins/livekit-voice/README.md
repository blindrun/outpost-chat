# outpost-livekit-voice

Native LiveKit voice bridge for Outpost's iOS app (background-audio-capable, unlike the WKWebView WebRTC path).

Not published to npm -- consumed as a local `file:` dependency from `mobile/package.json` purely so `npx cap sync
ios` discovers it and wires `ios/Sources/LiveKitVoicePlugin` into the main app's Xcode project (via this package's
`capacitor.ios.src` field and its own `Package.swift`, which declares the actual LiveKit SDK dependency). iOS-only
-- there's no Android implementation because Android's voice already works fine routed through the WebView
directly (see the iOS voice plan for why iOS specifically needs this).

This package intentionally has **no JS/TS side** -- `web/src` doesn't depend on it at all. The
`registerPlugin('LiveKitVoice', ...)` call and the plugin's TS interface live directly in
`web/src/voice/NativeLiveKitEngine.ts` instead, calling into this plugin purely by the matching string name
(`jsName` in `LiveKitVoicePlugin.swift`). Routing the JS-side type contract through a separately-built npm
package here would mean every platform that builds `web/src` (Docker, Electron, Android too, not just iOS) picks
up a build-time dependency on this package's compiled output for a feature only iOS ever uses -- not worth it for
an in-repo plugin only this one app ever consumes.

See `ios/Sources/LiveKitVoicePlugin/LiveKitVoicePlugin.swift` for the real method/event contract
(`connect`/`disconnect`/`setMicrophoneEnabled`/`setRemoteAudioMuted`/`localIdentity`, plus
`participantsChanged`/`speakingChanged`/`disconnected` events).
