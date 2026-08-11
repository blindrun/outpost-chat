// The browser/Android/desktop/Docker voice transport: LiveKit's JS SDK
// talking WebRTC directly through the page's own WebView/browser engine.
// Extracted from the previously-monolithic useVoiceSession.ts with no
// behavior change -- every comment describing *why* a piece of logic exists
// is preserved from the original rather than rewritten.
import {
  ConnectionState,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { ParticipantInfo, VoiceEngine, VoiceEngineEvents } from "./VoiceEngine";

function toInfo(p: Participant): ParticipantInfo {
  return { identity: p.identity, name: p.name || p.identity, isLocal: p instanceof LocalParticipant };
}

type Listener<K extends keyof VoiceEngineEvents> = VoiceEngineEvents[K];

export class WebLiveKitEngine implements VoiceEngine {
  readonly capabilities = { screenShare: true, vad: true };

  private room: Room | null = null;
  private deafened = false;
  // Internally untyped (TS can't correlate a generic key across a mapped
  // type when reading/writing through a single index expression) -- the
  // public on/off/emit methods below stay fully typed, so callers never see
  // this looseness.
  private listeners: Record<string, Set<(...args: never[]) => void>> = {};

  constructor(
    private audioContainer: HTMLDivElement,
    private videoContainer: HTMLDivElement,
    private outputDeviceId: string | undefined,
  ) {}

  on<K extends keyof VoiceEngineEvents>(event: K, cb: Listener<K>) {
    (this.listeners[event] ??= new Set()).add(cb as (...args: never[]) => void);
  }

  off<K extends keyof VoiceEngineEvents>(event: K, cb: Listener<K>) {
    this.listeners[event]?.delete(cb as (...args: never[]) => void);
  }

  private emit<K extends keyof VoiceEngineEvents>(event: K, ...args: Parameters<Listener<K>>) {
    this.listeners[event]?.forEach((cb) => cb(...(args as never[])));
  }

  private refreshParticipants() {
    if (!this.room) return;
    this.emit("participantsChanged", [
      toInfo(this.room.localParticipant),
      ...Array.from(this.room.remoteParticipants.values()).map(toInfo),
    ]);
  }

  async connect(url: string, token: string): Promise<void> {
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.ParticipantConnected, () => this.refreshParticipants());
    room.on(RoomEvent.ParticipantDisconnected, () => this.refreshParticipants());
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.emit("speakingChanged", new Set(speakers.map((s) => s.identity)));
    });
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Disconnected) this.emit("disconnected");
    });
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.dataset.participant = participant.identity;
          el.muted = this.deafened;
          if (this.outputDeviceId && "setSinkId" in el) {
            (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
              .setSinkId(this.outputDeviceId)
              .catch((err) => console.warn("setSinkId failed:", err));
          }
          this.audioContainer.appendChild(el);
        } else if (track.source === Track.Source.ScreenShare) {
          const el = track.attach() as HTMLVideoElement;
          el.dataset.participant = participant.identity;
          el.className = "screen-share-video";
          const wrapper = document.createElement("div");
          wrapper.className = "screen-share-tile";
          wrapper.dataset.participant = participant.identity;
          const label = document.createElement("span");
          label.className = "screen-share-label";
          label.textContent = `${participant.name || participant.identity}'s screen`;
          wrapper.appendChild(el);
          wrapper.appendChild(label);
          this.videoContainer.appendChild(wrapper);
          this.emit("screenShareTrackSubscribed", {
            participantIdentity: participant.identity,
            participantName: participant.name || participant.identity,
            element: el,
          });
        }
      },
    );
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      track.detach().forEach((el) => el.remove());
      if (track.source === Track.Source.ScreenShare) {
        this.videoContainer.querySelectorAll(".screen-share-tile").forEach((wrapper) => {
          if (!wrapper.querySelector("video, audio")) wrapper.remove();
        });
        this.emit("screenShareTrackUnsubscribed", participant.identity);
      }
    });
    room.on(RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.source !== Track.Source.ScreenShare || !pub.track) return;
      const el = pub.track.attach() as HTMLVideoElement;
      el.muted = true;
      el.dataset.participant = room.localParticipant.identity;
      el.className = "screen-share-video";
      const wrapper = document.createElement("div");
      wrapper.className = "screen-share-tile";
      wrapper.dataset.participant = room.localParticipant.identity;
      const label = document.createElement("span");
      label.className = "screen-share-label";
      label.textContent = "Your screen";
      wrapper.appendChild(el);
      wrapper.appendChild(label);
      this.videoContainer.appendChild(wrapper);
      this.emit("localScreenShareStarted", el);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source !== Track.Source.ScreenShare) return;
      pub.track?.detach().forEach((el) => el.remove());
      this.videoContainer
        .querySelectorAll(`.screen-share-tile[data-participant="${room.localParticipant.identity}"]`)
        .forEach((wrapper) => {
          if (!wrapper.querySelector("video, audio")) wrapper.remove();
        });
      this.emit("localScreenShareStopped");
    });

    await room.connect(url, token);
    this.refreshParticipants();
  }

  disconnect() {
    this.room?.disconnect();
    this.room = null;
  }

  async setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void> {
    if (!this.room) return;
    await this.room.localParticipant.setMicrophoneEnabled(enabled, deviceId ? { deviceId } : undefined);
  }

  setRemoteAudioMuted(muted: boolean) {
    this.deafened = muted;
    this.audioContainer.querySelectorAll("audio").forEach((el) => {
      (el as HTMLAudioElement).muted = muted;
    });
  }

  // getDisplayMedia rejects with NotAllowedError if the user cancels the
  // share picker -- not a real error, so screenSharing just stays false.
  //
  // The catch is deliberately noisy now. Electron denies getDisplayMedia with
  // that *same* error name when no display-media handler is registered in the
  // main process, so swallowing it silently hid a real bug: screen share was
  // broken in the desktop app on every platform, and the button simply did
  // nothing with no error anywhere. Logging costs nothing and makes the next
  // occurrence diagnosable instead of invisible.
  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.localParticipant.setScreenShareEnabled(enabled);
    } catch (err) {
      if ((err as Error).name !== "NotAllowedError") throw err;
      console.warn(
        "[screen-share] getDisplayMedia was denied. Normal if you cancelled the picker; " +
          "if you didn't, the platform refused the capture request.",
        err,
      );
    }
  }

  localIdentity(): string {
    return this.room?.localParticipant.identity ?? "";
  }

  getMicrophoneTrackForVad(): MediaStreamTrack | null {
    if (!this.room) return null;
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    return pub?.audioTrack?.mediaStreamTrack ?? null;
  }
}
