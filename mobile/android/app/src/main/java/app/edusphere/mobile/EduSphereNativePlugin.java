package app.edusphere.mobile;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.print.PrintManager;
import android.provider.Settings;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Locale;

/**
 * The ONLY native surface the web bundle can reach (jsName = "EduSphereNative").
 *
 * Everything else the app needs — offline storage, sync, the scanner UI — is
 * the shared JavaScript. This plugin contributes exactly what a browser cannot
 * do:
 *
 *   • getSecureValue / setSecureValue / removeSecureValue
 *         AndroidKeyStore AES-GCM (SecureTokenStore). The Bearer device token
 *         never touches localStorage or a plain file.
 *   • sqliteExec / sqliteQuery
 *         the durable offline database behind public/js/mobile-storage.js.
 *   • getCameraPermission / requestCameraPermission / openAppSettings
 *         the three real answers Android can give, including the permanent
 *         refusal that must NOT be re-asked, plus the route to Settings.
 *   • openExternal
 *         allow-listed again here (defense in depth) so a page bug cannot fire
 *         an intent:// or file:// URL.
 *   • print / getDeviceModel
 *         native print sheet for report cards, real device name for the
 *         signed-in devices list.
 *
 * No method here loads remote code, evaluates JavaScript, or reads files from
 * outside the app sandbox.
 */
@CapacitorPlugin(
        name = "EduSphereNative",
        permissions = {
                @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
        }
)
public class EduSphereNativePlugin extends Plugin {
    private static final String CAMERA_ALIAS = "camera";
    private static final String ASKED_PREFS = "edusphere_permissions";
    private static final String ASKED_CAMERA = "asked_camera_v1";

    private SecureTokenStore tokens;
    private SqliteStore sqlite;

    @Override
    public void load() {
        Context context = getContext();
        tokens = new SecureTokenStore(context);
        sqlite = new SqliteStore(context);
    }

    /* ----------------------------- secure store ---------------------------- */

    @PluginMethod
    public void getSecureValue(PluginCall call) {
        String key = call.getString("key", "");
        JSObject result = new JSObject();
        result.put("value", tokens.get(key));
        call.resolve(result);
    }

    @PluginMethod
    public void setSecureValue(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        boolean persisted = tokens.set(key, value == null ? "" : value);
        JSObject result = new JSObject();
        result.put("persisted", persisted);
        call.resolve(result);
    }

    @PluginMethod
    public void removeSecureValue(PluginCall call) {
        String key = call.getString("key", "");
        tokens.remove(key);
        JSObject result = new JSObject();
        result.put("removed", true);
        call.resolve(result);
    }

    /* -------------------------------- sqlite ------------------------------- */

    @PluginMethod
    public void sqliteExec(PluginCall call) {
        String sql = call.getString("sql", "");
        if (sql == null || sql.trim().isEmpty()) {
            call.reject("Empty SQL statement");
            return;
        }
        JSArray params = call.getArray("params", new JSArray());
        try {
            int affected = sqlite.exec(sql, params);
            JSObject result = new JSObject();
            result.put("rowsAffected", affected);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("SQL statement failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void sqliteQuery(PluginCall call) {
        String sql = call.getString("sql", "");
        if (sql == null || sql.trim().isEmpty()) {
            call.reject("Empty SQL statement");
            return;
        }
        JSArray params = call.getArray("params", new JSArray());
        try {
            JSArray rows = sqlite.query(sql, params);
            JSObject result = new JSObject();
            result.put("rows", rows);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("SQL query failed: " + e.getMessage(), e);
        }
    }

    /* ------------------------------- camera -------------------------------- */

    private SharedPreferences permissionPrefs() {
        return getContext().getSharedPreferences(ASKED_PREFS, Context.MODE_PRIVATE);
    }

    private boolean cameraGranted() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean shouldShowRationale() {
        try {
            return getActivity() != null
                    && getActivity().shouldShowRequestPermissionRationale(Manifest.permission.CAMERA);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * "granted" | "prompt" | "prompt-with-rationale" | "denied-permanently"
     *
     * Android cannot distinguish "never asked" from "denied for good" on its
     * own (both report no rationale), so the plugin remembers that it asked.
     */
    private String cameraState() {
        if (cameraGranted()) return "granted";
        if (shouldShowRationale()) return "prompt-with-rationale";
        boolean asked = permissionPrefs().getBoolean(ASKED_CAMERA, false);
        return asked ? "denied-permanently" : "prompt";
    }

    @PluginMethod
    public void getCameraPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("state", cameraState());
        call.resolve(result);
    }

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        if (cameraGranted()) {
            JSObject result = new JSObject();
            result.put("state", "granted");
            call.resolve(result);
            return;
        }
        permissionPrefs().edit().putBoolean(ASKED_CAMERA, true).apply();
        requestPermissionForAlias(CAMERA_ALIAS, call, "afterCameraPermission");
    }

    @PermissionCallback
    private void afterCameraPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("state", cameraState());
        call.resolve(result);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not open the app settings screen", e);
        }
    }

    /* ------------------------------ the rest ------------------------------- */

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        String lower = url == null ? "" : url.trim().toLowerCase(Locale.ROOT);
        boolean allowed = lower.startsWith("https://") || lower.startsWith("http://")
                || lower.startsWith("mailto:") || lower.startsWith("tel:");
        boolean denied = lower.startsWith("javascript:") || lower.startsWith("data:")
                || lower.startsWith("file:") || lower.startsWith("content:")
                || lower.startsWith("intent:") || lower.contains("\n") || lower.contains("\r");
        JSObject result = new JSObject();
        if (!allowed || denied || lower.isEmpty()) {
            result.put("opened", false);
            result.put("reason", "blocked");
            call.resolve(result);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            result.put("opened", true);
        } catch (Exception e) {
            result.put("opened", false);
            result.put("reason", "no-app");
        }
        call.resolve(result);
    }

    @PluginMethod
    public void print(PluginCall call) {
        try {
            WebView webView = getBridge().getWebView();
            PrintManager manager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
            if (manager == null || webView == null) {
                call.reject("Printing is not available on this device");
                return;
            }
            String job = call.getString("jobName", "EduSphere");
            manager.print(job, webView.createPrintDocumentAdapter(job), null);
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not open the print sheet", e);
        }
    }

    @PluginMethod
    public void getDeviceModel(PluginCall call) {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "" : Build.MODEL;
        String label = (model.toLowerCase(Locale.ROOT).startsWith(manufacturer.toLowerCase(Locale.ROOT)))
                ? model
                : (manufacturer + " " + model).trim();
        JSObject result = new JSObject();
        result.put("model", label.isEmpty() ? "Android device" : label);
        call.resolve(result);
    }
}
