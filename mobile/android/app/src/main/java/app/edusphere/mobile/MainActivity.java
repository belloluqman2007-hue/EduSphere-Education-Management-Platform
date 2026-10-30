package app.edusphere.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * The single Activity of the EduSphere mobile app.
 *
 * It adds exactly one thing to Capacitor's BridgeActivity: the EduSphere native
 * plugin, which provides the OS-encrypted token store, SQLite, the camera
 * permission bridge and the external-link handler. Everything else (routing,
 * offline storage semantics, sync, the QR scanner) is the SHARED web bundle in
 * android/app/src/main/assets/public, identical to the browser and Electron
 * builds.
 *
 * The hardware Back button is not overridden here: @capacitor/app raises a
 * `backButton` event and public/js/mobile-shell.js decides (close modal →
 * close drawer → history.back() → leave), which keeps Android behaving like the
 * web app instead of dropping the operator out of a dialog.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EduSphereNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
