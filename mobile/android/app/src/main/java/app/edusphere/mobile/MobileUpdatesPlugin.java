package app.edusphere.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.URL;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.HashSet;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;

/** Signed, file-level updates from the operator's fixed HTTPS origin. */
@CapacitorPlugin(name = "MobileUpdates")
public class MobileUpdatesPlugin extends Plugin {
    private static final String ORIGIN = "https://bello-institute.onrender.com";
    private static final String PREFS = "edusphere_mobile_updates";
    private static final long MAX_FILE = 64L * 1024 * 1024;
    private static final long MAX_TOTAL = 256L * 1024 * 1024;
    private volatile boolean busy = false;

    private SharedPreferences preferences() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private SharedPreferences webviewPreferences() { return getContext().getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE); }

    private byte[] readLimited(InputStream in, int maximum) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] b = new byte[8192]; int n, total = 0;
        while ((n = in.read(b)) != -1) { total += n; if (total > maximum) throw new IOException("Response too large"); out.write(b, 0, n); }
        return out.toByteArray();
    }
    private HttpsURLConnection connection(String path) throws Exception {
        HttpsURLConnection c = (HttpsURLConnection) new URL(ORIGIN + path).openConnection();
        c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(30000);
        c.setRequestProperty("Cache-Control", "no-cache");
        if (c.getResponseCode() != 200) { int code = c.getResponseCode(); c.disconnect(); throw new IOException("Update server returned " + code); }
        return c;
    }
    private static String hex(byte[] bytes) { StringBuilder s = new StringBuilder(); for (byte b : bytes) s.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return s.toString(); }
    private static String hash(byte[] bytes) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    private static String hashStream(InputStream in) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256"); byte[] b = new byte[32768]; int n;
        while ((n = in.read(b)) != -1) md.update(b, 0, n); return hex(md.digest());
    }
    private JSONObject manifest() throws Exception {
        String encodedKey = getContext().getString(R.string.edusphere_update_public_key);
        if (encodedKey.isEmpty()) throw new IOException("App update signing key is not configured");
        byte[] keyBytes = Base64.decode(encodedKey, Base64.DEFAULT);
        PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(keyBytes));
        HttpsURLConnection c = connection("/mobile-updates/manifest");
        byte[] response; try (InputStream in = c.getInputStream()) { response = readLimited(in, 2 * 1024 * 1024); } finally { c.disconnect(); }
        JSONObject envelope = new JSONObject(new String(response, java.nio.charset.StandardCharsets.UTF_8));
        byte[] payload = Base64.decode(envelope.getString("payload"), Base64.DEFAULT);
        byte[] signed = Base64.decode(envelope.getString("signature"), Base64.DEFAULT);
        Signature verifier = Signature.getInstance("SHA256withRSA"); verifier.initVerify(key); verifier.update(payload);
        if (!verifier.verify(signed)) throw new SecurityException("Invalid update signature");
        JSONObject result = new JSONObject(new String(payload, java.nio.charset.StandardCharsets.UTF_8));
        if (result.getInt("format") != 1 || result.getInt("nativeApi") != 1 || !result.getString("applicationId").equals("app.edusphere.mobile")) throw new SecurityException("Incompatible update");
        JSONArray files = result.getJSONArray("files");
        if (files.length() < 1 || files.length() > 5000) throw new SecurityException("Invalid file count");
        Set<String> seen = new HashSet<>(); long total = 0; boolean index = false;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.getJSONObject(i); String p = f.getString("path"), digest = f.getString("sha256"); long size = f.getLong("size");
            if (!p.matches("[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*") || p.contains("..") || !seen.add(p) || !digest.matches("[0-9a-f]{64}") || size < 0 || size > MAX_FILE) throw new SecurityException("Invalid update file");
            total += size; if (total > MAX_TOTAL) throw new SecurityException("Update too large");
            if (p.equals("index.html")) index = true;
        }
        if (!index) throw new SecurityException("Missing app entry point");
        result.put("_version", hash(payload));
        return result;
    }
    private File activeRoot() throws Exception {
        String p = webviewPreferences().getString("serverBasePath", "");
        File base = new File(getContext().getFilesDir(), "mobile-updates").getCanonicalFile();
        if (p.isEmpty()) return null;
        File active = new File(p).getCanonicalFile();
        return active.getPath().startsWith(base.getPath() + File.separator) && active.isDirectory() ? active : null;
    }
    private InputStream existing(File root, String path) throws Exception {
        if (root != null) { File file = new File(root, path); if (file.isFile()) return new FileInputStream(file); }
        try { return getContext().getAssets().open("public/" + path); } catch (IOException e) { return null; }
    }
    private boolean matches(File root, JSONObject file) throws Exception {
        InputStream in = existing(root, file.getString("path"));
        if (in == null) return false;
        try (InputStream stream = in) { return hashStream(stream).equals(file.getString("sha256")); }
    }
    private void deleteTree(File f) { if (f.isDirectory()) { File[] children = f.listFiles(); if (children != null) for (File c : children) deleteTree(c); } f.delete(); }
    @PluginMethod
    public void check(PluginCall call) {
        new Thread(() -> { try {
            JSONObject m = manifest(); String version = m.getString("_version");
            JSObject result = new JSObject();
            if (version.equals(preferences().getString("installed", ""))) { result.put("available", false); call.resolve(result); return; }
            File active = activeRoot(); long bytes = 0; int count = 0; JSONArray files = m.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) { JSONObject f = files.getJSONObject(i); if (!matches(active, f)) { bytes += f.getLong("size"); count++; } }
            result.put("available", count > 0); result.put("version", version); result.put("downloadBytes", bytes); result.put("changedFiles", count); call.resolve(result);
        } catch (Exception e) { call.reject("Cannot check for updates", e); } }).start();
    }
    @PluginMethod
    public synchronized void install(PluginCall call) {
        if (busy) { call.reject("An update is already running"); return; }
        busy = true;
        new Thread(() -> { File stage = null; try {
            JSONObject m = manifest(); String version = m.getString("_version");
            if (!version.equals(call.getString("version", ""))) throw new IOException("Update changed; check again");
            File root = new File(getContext().getFilesDir(), "mobile-updates"); if (!root.exists() && !root.mkdirs()) throw new IOException("Cannot create update folder");
            stage = new File(root, "staging-" + System.currentTimeMillis()); if (!stage.mkdirs()) throw new IOException("Cannot create staging folder");
            File active = activeRoot(); JSONArray files = m.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i); String p = f.getString("path"); File dest = new File(stage, p); File parent = dest.getParentFile();
                if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create asset directory");
                InputStream source; HttpsURLConnection conn = null;
                if (matches(active, f)) source = existing(active, p);
                else { conn = connection("/" + p); source = conn.getInputStream(); }
                long copied = 0; MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream in = source; OutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[32768]; int n;
                    while ((n = in.read(buf)) != -1) { copied += n; if (copied > f.getLong("size")) throw new IOException("Unexpected file size"); digest.update(buf, 0, n); out.write(buf, 0, n); }
                } finally { if (conn != null) conn.disconnect(); }
                if (copied != f.getLong("size") || !hex(digest.digest()).equals(f.getString("sha256"))) throw new SecurityException("File verification failed");
            }
            final File ready = stage; final String previous = webviewPreferences().getString("serverBasePath", "");
            // Save recovery information before changing the active bundle.
            if (!preferences().edit().putString("previous", previous).putString("pending", ready.getAbsolutePath()).commit()) throw new IOException("Cannot save update recovery state");
            if (!webviewPreferences().edit().putString("serverBasePath", ready.getAbsolutePath()).commit()) throw new IOException("Cannot activate update");
            getActivity().runOnUiThread(() -> { getBridge().setServerBasePath(ready.getAbsolutePath()); JSObject result = new JSObject(); result.put("installed", true); call.resolve(result); });
            stage = null;
        } catch (Exception e) { if (stage != null) deleteTree(stage); call.reject("Update failed; existing app was retained", e); } finally { busy = false; } }).start();
    }
    @PluginMethod
    public void confirm(PluginCall call) {
        String pending = preferences().getString("pending", "");
        String active = webviewPreferences().getString("serverBasePath", "");
        if (!pending.isEmpty() && pending.equals(active)) {
            // The version is set after the new UI has started; future checks can compare manifests.
            // Re-comparison is safe if this write is interrupted.
            String previous = preferences().getString("previous", "");
            if (preferences().edit().remove("pending").remove("previous").commit() && !previous.isEmpty()) {
                new Thread(() -> { try {
                    File base = new File(getContext().getFilesDir(), "mobile-updates").getCanonicalFile();
                    File old = new File(previous).getCanonicalFile();
                    if (old.getPath().startsWith(base.getPath() + File.separator) && !old.getPath().equals(active)) deleteTree(old);
                } catch (IOException ignored) { /* Keep the old bundle if cleanup fails. */ } }).start();
            }
        }
        call.resolve();
    }
}
