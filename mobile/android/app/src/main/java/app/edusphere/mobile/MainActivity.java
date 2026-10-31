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
        // If the updated UI never confirmed startup, restore the prior bundle
        // on the next launch instead of trapping the user in a broken shell.
        android.content.SharedPreferences updates = getSharedPreferences("edusphere_mobile_updates", MODE_PRIVATE);
        if (!updates.getString("pending", "").isEmpty()) {
            String previous = updates.getString("previous", "");
            android.content.SharedPreferences.Editor web = getSharedPreferences("CapWebViewSettings", MODE_PRIVATE).edit();
            if (previous.isEmpty()) web.remove("serverBasePath"); else web.putString("serverBasePath", previous);
            web.commit();
            updates.edit().remove("pending").remove("previous").commit();
        }
        registerPlugin(EduSphereNativePlugin.class);
        registerPlugin(MobileUpdatesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
