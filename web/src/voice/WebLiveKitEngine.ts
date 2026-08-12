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
import { AudioProcessing, toCaptureConstraints } from "../audioSettings";
import { ParticipantInfo, VoiceEngine, VoiceEngineEvents } from "./VoiceEngine";

function toInfo(p: Participant): ParticipantInfo {
  return { identity: p.identity, name: p.name || p.identity, isLocal: p instanceof LocalParticipant };
}

type Listener<K extends keyof VoiceEngineEvents> = VoiceEngineEvents[K];

// Exported so the settings screen can ask what this platform supports
// without constructing an engine (and without a second place that maps
// platform -> transport) -- see voiceCapabilities in createVoiceEngine.ts.
export const WEB_ENGINE_CAPABILITIES = {
  screenShare: true,
  vad: true,
  audioProcessing: true,
  camera: true,
};

export class WebLiveKitEngine implements VoiceEngine {
  readonly capabilities = WEB_ENGINE_CAPABILITIES;

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
    private audioProcessing: AudioProcessing,
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

  // Every tile -- camera or screen share, local or remote -- is a direct
  // child of the one container, so a single grid can lay them all out and
  // resize as feeds come and go. An earlier version put cameras in their
  // own row on the theory that a share should keep the full column; in
  // practice people expect a call to tile evenly however many feeds there
  // are, and a nested container can't participate in the outer grid.
  private videoFeedCount(): number {
    return this.videoContainer.querySelectorAll(".screen-share-tile, .camera-tile").length;
  }

  private announceFeeds() {
    this.emit("videoFeedsChanged", this.videoFeedCount());
  }

  // Drops wrappers whose media element has been detached. `:empty` on the
  // container is what hides the whole surface when nothing is being sent,
  // so leaving a childless wrapper behind would keep an empty box on screen.
  private pruneEmptyTiles() {
    this.videoContainer.querySelectorAll(".screen-share-tile, .camera-tile").forEach((wrapper) => {
      if (!wrapper.querySelector("video, audio")) wrapper.remove();
    });
    this.announceFeeds();
  }

  private setCameraTileMuted(identity: string, muted: boolean) {
    this.videoContainer
      .querySelectorAll<HTMLDivElement>(`.camera-tile[data-participant="${CSS.escape(identity)}"]`)
      .forEach((wrapper) => wrapper.classList.toggle("camera-muted", muted));
  }


  /* A pop-out button per feed. Browsers give us exactly one Picture-in-Picture
     window, so this is a switch rather than a toggle per tile: asking for PiP
     on a second video moves the existing window to it. That is the browser's
     behaviour, not ours, and it is the right one -- two floating windows from
     one call would be worse.

     Firefox has no requestPictureInPicture on HTMLVideoElement, so the button
     is only added where the API exists rather than rendered and then failing
     on click. */
  private addPopoutButton(wrapper: HTMLDivElement, video: HTMLVideoElement) {
    if (typeof video.requestPictureInPicture !== "function") return;
    if ((document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === false) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tile-popout-btn";
    btn.title = "Pop out";
    btn.textContent = "⧉";
    btn.addEventListener("click", (e) => {
      // The tile is clickable itself (fullscreen), so this must not bubble.
      e.stopPropagation();
      if (document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(() => {});
      } else {
        video.requestPictureInPicture().catch((err) => console.warn("pop-out refused:", err));
      }
    });
    wrapper.appendChild(btn);
  }

  private addCameraTile(el: HTMLVideoElement, identity: string, label: string, isLocal: boolean) {
    el.dataset.participant = identity;
    el.className = "camera-video";
    const wrapper = document.createElement("div");
    // Your own preview is mirrored, the way every video-call app shows it
    // and the way a mirror does -- raising your right hand should move the
    // hand on the right. Remote faces are not: their text would read
    // backwards.
    wrapper.className = `camera-tile${isLocal ? " local" : ""}`;
    wrapper.dataset.participant = identity;
    const caption = document.createElement("span");
    caption.className = "screen-share-label";
    caption.textContent = label;
    wrapper.appendChild(el);
    wrapper.appendChild(caption);
    this.addPopoutButton(wrapper, el);
    this.videoContainer.appendChild(wrapper);
    this.announceFeeds();
  }

  private refreshParticipants() {
    if (!this.room) return;
    this.emit("participantsChanged", [
      toInfo(this.room.localParticipant),
      ...Array.from(this.room.remoteParticipants.values()).map(toInfo),
    ]);
  }

  async connect(url: string, token: string): Promise<void> {
    // audioCaptureDefaults *replaces* livekit-client's own audioDefaults
    // rather than merging into it (Room's constructor spreads one level
    // deep), so every processing constraint has to be named here or it
    // reverts to the browser's default rather than the user's choice.
    // Per-call options still win over these -- LiveKit fills in only the
    // keys a caller left undefined, and `false` counts as defined, so a
    // deliberately-off toggle survives the merge.
    const room = new Room({ audioCaptureDefaults: toCaptureConstraints(this.audioProcessing) });
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
        } else if (track.source === Track.Source.Camera) {
          this.addCameraTile(
            track.attach() as HTMLVideoElement,
            participant.identity,
            participant.name || participant.identity,
            false,
          );
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
          this.addPopoutButton(wrapper, el);
          this.videoContainer.appendChild(wrapper);
          this.announceFeeds();
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
        this.pruneEmptyTiles();
        this.emit("screenShareTrackUnsubscribed", participant.identity);
      } else if (track.source === Track.Source.Camera) {
        this.pruneEmptyTiles();
      }
    });
    // This engine turns its own camera off by unpublishing, so these only
    // matter for a peer whose client mutes instead (a bot, or a future
    // native client bridging a different SDK). Without them their tile
    // would sit there showing a frozen last frame, which reads as a live
    // camera far more than an empty space does.
    room.on(RoomEvent.TrackMuted, (pub, participant) => {
      if (pub.source === Track.Source.Camera) this.setCameraTileMuted(participant.identity, true);
    });
    room.on(RoomEvent.TrackUnmuted, (pub, participant) => {
      if (pub.source === Track.Source.Camera) this.setCameraTileMuted(participant.identity, false);
    });
    room.on(RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.source === Track.Source.Camera && pub.track) {
        const el = pub.track.attach() as HTMLVideoElement;
        el.muted = true;
        this.addCameraTile(el, room.localParticipant.identity, "You", true);
        this.emit("localCameraStarted");
        return;
      }
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
      this.announceFeeds();
      this.emit("localScreenShareStarted", el);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.Camera) {
        pub.track?.detach().forEach((el) => el.remove());
        this.pruneEmptyTiles();
        this.emit("localCameraStopped");
        return;
      }
      if (pub.source !== Track.Source.ScreenShare) return;
      pub.track?.detach().forEach((el) => el.remove());
      this.pruneEmptyTiles();
      this.emit("localScreenShareStopped");
    });

    await room.connect(url, token);
    this.refreshParticipants();
  }

  disconnect() {
    this.room?.disconnect();
    this.room = null;
    // Leaving must leave nothing on screen. Remote tiles clean themselves up
    // via TrackUnsubscribed, but a disconnect stops local tracks without
    // necessarily reporting them as unpublished, which would strand your own
    // preview over the app until the next join. Safe to clear wholesale:
    // React renders this container empty and every child in it was put there
    // by this engine.
    this.videoContainer.replaceChildren();
    this.audioContainer.replaceChildren();
  }

  async setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void> {
    if (!this.room) return;
    await this.room.localParticipant.setMicrophoneEnabled(enabled, deviceId ? { deviceId } : undefined);
  }

  // No try/catch equivalent to screen share's: there's no picker to cancel,
  // so a rejection here is a real failure (no camera, permission denied,
  // device already claimed by another app) and belongs in front of the user
  // rather than in the console.
  //
  // Turning the camera OFF unpublishes rather than going through LiveKit's
  // setCameraEnabled(false), which only *mutes*. Two reasons, one of them a
  // bug this avoids:
  //
  //  - Muting fires no LocalTrackUnpublished, and re-enabling a muted track
  //    fires no LocalTrackPublished either (it calls unmute()). The publish
  //    events this engine reports state from would fire exactly once, so
  //    the button would stick on "Stop Video" after the first toggle.
  //  - A muted camera is still an open capture: the hardware light stays on.
  //    "Off" should mean the LED goes out, or it isn't off.
  //
  // Screen share doesn't need this -- LiveKit already special-cases it to
  // unpublish, which is why that path works with the same event handling.
  async setCameraEnabled(enabled: boolean, deviceId?: string): Promise<void> {
    if (!this.room) return;
    if (enabled) {
      await this.room.localParticipant.setCameraEnabled(true, deviceId ? { deviceId } : undefined);
      return;
    }
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (pub?.track) await this.room.localParticipant.unpublishTrack(pub.track, true);
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
