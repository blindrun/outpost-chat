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
        .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "2.9.0")
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