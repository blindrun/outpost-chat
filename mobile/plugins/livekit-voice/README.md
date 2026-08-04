# outpost-livekit-voice

Native LiveKit voice bridge for Outpost's iOS app (background-audio-capable, unlike the WKWebView WebRTC path).

Not published to npm -- consumed as a local `file:` dependency from `mobile/package.json`, the same way
`mobile/android/` isn't a separate package either. iOS-only; there's no Android implementation because Android's
voice already works fine routed through the WebView directly (see the iOS voice plan for why iOS specifically
needs this).

## API

See `src/definitions.ts` for the full method/event contract (`connect`/`disconnect`/`setMicrophoneEnabled`/
`setRemoteAudioMuted`/`localIdentity`, plus `participantsChanged`/`speakingChanged`/`disconnected` events).
