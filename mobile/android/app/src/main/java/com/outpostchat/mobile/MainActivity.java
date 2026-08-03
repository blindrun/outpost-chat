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
public class MainActivity extends BridgeActivity {
    private static final int RECORD_AUDIO_REQUEST_CODE = 1001;

    private PermissionRequest pendingWebViewRequest;
    private AudioFocusRequest audioFocusRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsAudio = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            wantsAudio = true;
                        }
                    }

                    // Only audio capture is ever requested by this app (voice
                    // channels) -- deny anything else (e.g. camera) outright
                    // rather than silently granting an unused permission.
                    if (!wantsAudio) {
                        request.deny();
                        return;
                    }

                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED) {
                        grantAudioCapture(request);
                    } else {
                        pendingWebViewRequest = request;
                        ActivityCompat.requestPermissions(
                                MainActivity.this,
                                new String[] { Manifest.permission.RECORD_AUDIO },
                                RECORD_AUDIO_REQUEST_CODE);
                    }
                });
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode != RECORD_AUDIO_REQUEST_CODE || pendingWebViewRequest == null) {
            return;
        }

        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            grantAudioCapture(pendingWebViewRequest);
        } else {
            pendingWebViewRequest.deny();
        }
        pendingWebViewRequest = null;
    }

    private void grantAudioCapture(PermissionRequest request) {
        prepareAudioManagerForCapture();
        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
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
