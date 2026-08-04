import Foundation
import LiveKit

struct VoiceParticipant {
    let identity: String
    let name: String
    let isLocal: Bool
}

protocol LiveKitVoiceDelegate: AnyObject {
    func liveKitVoice(_ voice: LiveKitVoice, participantsDidChange participants: [VoiceParticipant])
    func liveKitVoice(_ voice: LiveKitVoice, speakingDidChange identities: [String])
    func liveKitVoiceDidDisconnect(_ voice: LiveKitVoice)
}

// Bridges Capacitor's callback-based plugin methods (LiveKitVoicePlugin.swift)
// to LiveKit's Swift-concurrency (async/await) Room API, and LiveKit's
// RoomDelegate callbacks back out to the plugin, which forwards them to JS
// via notifyListeners. This exists specifically for background-audio
// support -- see the iOS voice plan's Context section for why routing
// through WKWebView's own WebRTC isn't enough.
//
// NOTE: RoomDelegate's exact method signatures and Participant.identity's
// exact type (String vs. a wrapped Identity type) are written against
// client-sdk-swift's public shape as of v2.9.0 to the best of available
// knowledge, but are NOT verified against a real compile (no local macOS
// toolchain -- see the iOS plan's hardware decision). Expect CI's first
// real build attempt to surface exact corrections needed here.
class LiveKitVoice: NSObject {
    weak var delegate: LiveKitVoiceDelegate?
    private var room: Room?

    func connect(url: String, token: String) async throws {
        let newRoom = Room()
        newRoom.add(delegate: self)
        room = newRoom
        try await newRoom.connect(url: url, token: token)
        emitParticipants()
    }

    func disconnect() async {
        await room?.disconnect()
        room = nil
    }

    func setMicrophoneEnabled(_ enabled: Bool) async throws {
        try await room?.localParticipant.setMicrophone(enabled: enabled)
    }

    // No confirmed 1:1 native API for "keep receiving/publishing but
    // silence local playback" -- the web engine mutes each attached
    // <audio> element directly, which has no native equivalent (see the
    // iOS plan's open question #2). Best available primitive: toggling
    // whether each remote audio publication is enabled, which stops local
    // playback without affecting what's published/subscribed for anyone
    // else in the room. Unverified -- a real spike against the SDK may
    // reveal a more direct playback-volume control instead.
    func setRemoteAudioMuted(_ muted: Bool) async {
        guard let room else { return }
        for participant in room.remoteParticipants.values {
            for publication in participant.audioTracks {
                guard let remotePublication = publication as? RemoteTrackPublication else { continue }
                try? await remotePublication.set(enabled: !muted)
            }
        }
    }

    func localIdentity() -> String {
        room?.localParticipant.identity?.stringValue ?? ""
    }

    // Participant.name is String? in the real SDK (confirmed via CI compile
    // error -- this file's earlier draft assumed non-optional String).
    private func displayName(_ name: String?, fallback: String) -> String {
        guard let name, !name.isEmpty else { return fallback }
        return name
    }

    private func emitParticipants() {
        guard let room else { return }
        let local = room.localParticipant
        let localIdentity = local.identity?.stringValue ?? ""
        var list = [
            VoiceParticipant(
                identity: localIdentity,
                name: displayName(local.name, fallback: localIdentity),
                isLocal: true
            )
        ]
        for participant in room.remoteParticipants.values {
            let identity = participant.identity?.stringValue ?? ""
            list.append(
                VoiceParticipant(
                    identity: identity,
                    name: displayName(participant.name, fallback: identity),
                    isLocal: false
                )
            )
        }
        delegate?.liveKitVoice(self, participantsDidChange: list)
    }
}

extension LiveKitVoice: RoomDelegate {
    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        emitParticipants()
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        emitParticipants()
    }

    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        let identities = participants.compactMap { $0.identity?.stringValue }
        delegate?.liveKitVoice(self, speakingDidChange: identities)
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        delegate?.liveKitVoiceDidDisconnect(self)
    }
}
