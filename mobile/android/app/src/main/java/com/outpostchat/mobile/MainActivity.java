package com.outpostchat.mobile;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import java.util.ArrayList;
import java.util.List;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

// Capacitor's WebView never forwards a page's getUserMedia() request to
// Android's own runtime permission system on its own -- the web client's
// useVoiceSession/LiveKit audio.getUserMedia({ audio: true }) call was
// hitting NotAllowedError with no OS permission dialog ever appearing.
// This bridges the WebView's PermissionRequest callback to a real
// RECORD_AUDIO runtime prompt (RECORD_AUDIO is also declared in
// AndroidManifest.xml, required but not sufficient on its own).
//
// Getting RECORD_AUDIO granted surfaced a second, separate failure:
// NotReadableError ("could not start audio source") from the WebView's own
// WebRTC audio capturer. The permission grant alone doesn't put the device
// in a state where AudioRecord can actually open -- Chromium's Android
// WebView audio path additionally needs AudioManager in communication mode
// with real audio focus, which nothing does automatically inside a WebView
// (a real native call app gets this via the telecom/voice-call APIs; a
// WebView has none of that). Requested once here, right before granting,
// rather than for the app's whole lifetime, since it only matters while
// voice capture is actually starting.
// Camera capture (video in voice channels) goes through the same bridge:
// this handler used to deny every non-audio resource outright, so a page
// calling getUserMedia({ video: true }) got NotAllowedError with no OS
// prompt -- the exact failure RECORD_AUDIO had before this class existed.
// Video needs no AudioManager equivalent; the audio-mode/focus dance above
// is specific to the WebView's audio capturer.
public class MainActivity extends BridgeActivity {
    private static final int MEDIA_PERMISSION_REQUEST_CODE = 1001;

    private PermissionRequest pendingWebViewRequest;
    // The WebView resources the pending request asked for, so the callback
    // grants exactly what was requested and backed by a granted permission
    // -- not a fixed list, and not everything that was asked for.
    private boolean pendingWantsAudio;
    private boolean pendingWantsVideo;
    private AudioFocusRequest audioFocusRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsAudio = false;
                    boolean wantsVideo = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            wantsAudio = true;
                        } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            wantsVideo = true;
                        }
                    }

                    // Anything that isn't mic or camera (e.g. protected media
                    // playback) is still denied rather than silently granted.
                    if (!wantsAudio && !wantsVideo) {
                        request.deny();
                        return;
                    }

                    List<String> missing = new ArrayList<>();
                    if (wantsAudio && !hasPermission(Manifest.permission.RECORD_AUDIO)) {
                        missing.add(Manifest.permission.RECORD_AUDIO);
                    }
                    if (wantsVideo && !hasPermission(Manifest.permission.CAMERA)) {
                        missing.add(Manifest.permission.CAMERA);
                    }

                    if (missing.isEmpty()) {
                        grantCapture(request, wantsAudio, wantsVideo);
                        return;
                    }

                    pendingWebViewRequest = request;
                    pendingWantsAudio = wantsAudio;
                    pendingWantsVideo = wantsVideo;
                    ActivityCompat.requestPermissions(
                            MainActivity.this,
                            missing.toArray(new String[0]),
                            MEDIA_PERMISSION_REQUEST_CODE);
                });
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode != MEDIA_PERMISSION_REQUEST_CODE || pendingWebViewRequest == null) {
            return;
        }

        // Read each result against its own permission rather than assuming a
        // single-element array: a request for mic *and* camera can come back
        // half-granted, and granting the resource whose permission the user
        // just refused would hand the page a track it can never open.
        boolean audioOk = pendingWantsAudio && hasPermission(Manifest.permission.RECORD_AUDIO);
        boolean videoOk = pendingWantsVideo && hasPermission(Manifest.permission.CAMERA);

        if (audioOk || videoOk) {
            grantCapture(pendingWebViewRequest, audioOk, videoOk);
        } else {
            pendingWebViewRequest.deny();
        }
        pendingWebViewRequest = null;
        pendingWantsAudio = false;
        pendingWantsVideo = false;
    }

    private boolean hasPermission(String permission) {
        return ContextCompat.checkSelfPermission(MainActivity.this, permission)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void grantCapture(PermissionRequest request, boolean audio, boolean video) {
        List<String> resources = new ArrayList<>();
        if (audio) {
            // Only for audio -- see prepareAudioManagerForCapture's comment.
            prepareAudioManagerForCapture();
            resources.add(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
        }
        if (video) {
            resources.add(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        }
        request.grant(resources.toArray(new String[0]));
    }

    private void prepareAudioManagerForCapture() {
        AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            return;
        }
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attributes)
                    .build();
            audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            audioManager.requestAudioFocus(
                    null,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN);
        }
    }
}
