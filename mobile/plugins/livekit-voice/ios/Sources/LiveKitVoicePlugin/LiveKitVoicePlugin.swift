import Foundation
import Capacitor

/**
 * Native LiveKit voice bridge for Outpost's iOS app -- routes voice through
 * LiveKit's Swift SDK instead of WKWebView's WebRTC, specifically for real
 * background-audio support. See the iOS voice plan's Context section for
 * why the WebView path alone isn't enough, and LiveKitVoice.swift for the
 * actual Room/RoomDelegate wiring this class bridges to Capacitor's
 * callback-based plugin call API.
 */
@objc(LiveKitVoicePlugin)
public class LiveKitVoicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveKitVoicePlugin"
    public let jsName = "LiveKitVoice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMicrophoneEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRemoteAudioMuted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "localIdentity", returnType: CAPPluginReturnPromise)
    ]
    private let implementation = LiveKitVoice()

    public override func load() {
        implementation.delegate = self
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), let token = call.getString("token") else {
            call.reject("url and token are required")
            return
        }
        Task {
            do {
                try await implementation.connect(url: url, token: token)
                call.resolve()
            } catch {
                call.reject("Failed to connect: \(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        Task {
            await implementation.disconnect()
            call.resolve()
        }
    }

    @objc func setMicrophoneEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        Task {
            do {
                try await implementation.setMicrophoneEnabled(enabled)
                call.resolve()
            } catch {
                call.reject("Failed to set microphone state: \(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func setRemoteAudioMuted(_ call: CAPPluginCall) {
        let muted = call.getBool("muted") ?? false
        Task {
            await implementation.setRemoteAudioMuted(muted)
            call.resolve()
        }
    }

    @objc func localIdentity(_ call: CAPPluginCall) {
        call.resolve(["identity": implementation.localIdentity()])
    }
}

extension LiveKitVoicePlugin: LiveKitVoiceDelegate {
    func liveKitVoice(_ voice: LiveKitVoice, participantsDidChange participants: [VoiceParticipant]) {
        notifyListeners("participantsChanged", data: [
            "participants": participants.map { [
                "identity": $0.identity,
                "name": $0.name,
                "isLocal": $0.isLocal
            ] }
        ])
    }

    func liveKitVoice(_ voice: LiveKitVoice, speakingDidChange identities: [String]) {
        notifyListeners("speakingChanged", data: ["identities": identities])
    }

    func liveKitVoiceDidDisconnect(_ voice: LiveKitVoice) {
        notifyListeners("disconnected", data: [:])
    }
}
