// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OutpostLivekitVoice",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "OutpostLivekitVoice",
            targets: ["LiveKitVoicePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // The whole reason this plugin exists: LiveKit's native Swift SDK
        // has real background-audio support, unlike routing voice through
        // WKWebView's WebRTC (see the iOS voice plan's Context section).
        //
        // Pinned to our own fork (github.com/blindrun/client-sdk-swift),
        // not upstream: reproduced native voice connect hanging until the
        // SDK's own 7s join-response timeout on every network tested (home
        // Wi-Fi and cellular both), traced to WebSocket.swift explicitly
        // opting the signaling connection into Multipath TCP "handover"
        // mode (iOS-only) -- curl/Safari/the JS SDK all connect fine
        // against the same server since none of them use Multipath TCP.
        // Matches the upstream maintainer's own stated hypothesis on
        // livekit/client-sdk-swift#894 ("may depend on multipath handling
        // with certain n/w providers") and the one-line fix already
        // written -- closed unmerged for lack of reproduction from the
        // original reporter, not disproven -- in PR #895. Our fork is
        // exactly upstream 2.16.0 plus that one line
        // (multipathServiceType: .handover -> .none). Revert to a plain
        // upstream `from:` dependency if/when this lands upstream for
        // real.
        .package(url: "https://github.com/blindrun/client-sdk-swift.git", revision: "b216a205b52a4dfe0f03acfc7b1697a1c6403ac8")
    ],
    targets: [
        .target(
            name: "LiveKitVoicePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "LiveKit", package: "client-sdk-swift")
            ],
            path: "ios/Sources/LiveKitVoicePlugin")
    ]
)