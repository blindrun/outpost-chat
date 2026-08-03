package com.outpostchat.mobile;

import android.Manifest;
import android.content.pm.PackageManager;
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
public class MainActivity extends BridgeActivity {
    private static final int RECORD_AUDIO_REQUEST_CODE = 1001;

    private PermissionRequest pendingWebViewRequest;

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
                        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
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
            pendingWebViewRequest.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
            pendingWebViewRequest.deny();
        }
        pendingWebViewRequest = null;
    }
}
