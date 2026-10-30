package app.edusphere.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The device token (and the installation id) live here — never in
 * localStorage, never in a plain file, never in a cookie.
 *
 * HOW IT IS PROTECTED
 *   • The AES-256-GCM key is generated inside the AndroidKeyStore and is not
 *     exportable; it never enters the app's process memory as raw bytes and
 *     cannot be read back out of the device.
 *   • Only the ciphertext (12-byte IV ‖ GCM tag ‖ payload) is written, base64,
 *     to a MODE_PRIVATE SharedPreferences file. A rooted device with the XML
 *     file in hand sees random bytes, not a bearer token.
 *   • Decryption failures (key invalidated by a lock-screen change, data
 *     restored to another device) return "" instead of throwing: a lost token
 *     means "sign in again", never a crash.
 *
 * The JavaScript side is public/js/native-bridge.js; `getDeviceToken()` stays
 * synchronous because api.js reads it on every request, so the value is primed
 * once at boot and the write-through happens here.
 */
final class SecureTokenStore {
    private static final String PREFS = "edusphere_secure";
    private static final String KEY_ALIAS = "edusphere.device_secrets.v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    private final Context context;

    SecureTokenStore(Context context) {
        this.context = context.getApplicationContext();
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return (SecretKey) store.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // No user-authentication gate: the app must be able to sync in
                // the background at a gate. The key still never leaves the
                // KeyStore, and `allowBackup=false` keeps the ciphertext off
                // cloud backups.
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKey();
    }

    /** Stored ciphertext for `key`, or "" when absent/unreadable. */
    String get(String name) {
        String stored = prefs().getString(normalize(name), null);
        if (stored == null || stored.isEmpty()) return "";
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            if (blob.length <= GCM_IV_BYTES) return "";
            byte[] iv = new byte[GCM_IV_BYTES];
            System.arraycopy(blob, 0, iv, 0, GCM_IV_BYTES);
            byte[] ciphertext = new byte[blob.length - GCM_IV_BYTES];
            System.arraycopy(blob, GCM_IV_BYTES, ciphertext, 0, ciphertext.length);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] plain = cipher.doFinal(ciphertext);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            // A key that no longer decrypts this blob (factory reset, restored
            // backup, lock-screen change) means "sign in again".
            return "";
        }
    }

    boolean set(String name, String value) {
        try {
            SecretKey secretKey = key();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey);
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] blob = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, blob, 0, iv.length);
            System.arraycopy(ciphertext, 0, blob, iv.length, ciphertext.length);
            return prefs().edit()
                    .putString(normalize(name), Base64.encodeToString(blob, Base64.NO_WRAP))
                    .commit();
        } catch (Exception e) {
            return false;
        }
    }

    boolean remove(String name) {
        try {
            return prefs().edit().remove(normalize(name)).commit();
        } catch (Exception e) {
            return false;
        }
    }

    private String normalize(String name) {
        String clean = name == null ? "" : name.trim();
        return clean.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_.-]", "_");
    }
}
