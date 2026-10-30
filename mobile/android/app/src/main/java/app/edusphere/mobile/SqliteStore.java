package app.edusphere.mobile;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Durable SQLite for the offline database (`edusphere_offline_v1` in the
 * browser, `edusphere_offline.db` here).
 *
 * This class is a thin, honest driver: it executes the SQL that
 * public/js/mobile-storage.js writes and returns rows as plain objects. The
 * schema, the scoped keys and the outbox semantics stay in ONE place — the
 * shared web layer — so the phone cannot drift from the browser.
 *
 * Files live in the app's private storage (getDatabasePath), which survives
 * app restarts, low-memory kills and Android's "Clear cache". Only "Clear
 * storage"/uninstall removes them — exactly the durability IndexedDB lacked.
 */
final class SqliteStore extends SQLiteOpenHelper {
    static final String DATABASE_NAME = "edusphere_offline.db";
    static final int DATABASE_VERSION = 1;

    SqliteStore(Context context) {
        super(context, DATABASE_NAME, null, DATABASE_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        // The schema is created by mobile-storage.js on first use (SCHEMA[]).
        // Creating it twice is harmless; keeping it out of Java means one
        // source of truth.
        db.execSQL("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Forward-only, additive migrations are written in mobile-storage.js
        // (`CREATE TABLE IF NOT EXISTS` for every table and index).
    }

    private Object[] args(JSArray params) {
        if (params == null) return new Object[0];
        Object[] out = new Object[params.length()];
        for (int i = 0; i < params.length(); i++) {
            Object value;
            try {
                value = params.get(i);
            } catch (Exception e) {
                value = null;
            }
            if (value == null || value == JSONObject.NULL) {
                out[i] = null;
            } else if (value instanceof Boolean) {
                out[i] = ((Boolean) value) ? 1 : 0;
            } else if (value instanceof Number) {
                double d = ((Number) value).doubleValue();
                if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 9.0e18) {
                    out[i] = (long) d;
                } else {
                    out[i] = d;
                }
            } else {
                out[i] = String.valueOf(value);
            }
        }
        return out;
    }

    /** Executes one statement; returns the number of rows it touched. */
    int exec(String sql, JSArray params) {
        SQLiteDatabase db = getWritableDatabase();
        Object[] bind = args(params);
        if (bind.length == 0) db.execSQL(sql);
        else db.execSQL(sql, bind);
        Cursor cursor = db.rawQuery("SELECT changes()", null);
        try {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } finally {
            cursor.close();
        }
    }

    /** Runs one SELECT and returns every row as a JSON object. */
    JSArray query(String sql, JSArray params) {
        SQLiteDatabase db = getReadableDatabase();
        Object[] bind = args(params);
        Cursor cursor = bind.length == 0 ? db.rawQuery(sql, null) : db.rawQuery(sql, toStrArray(bind));
        JSArray rows = new JSArray();
        try {
            String[] columns = cursor.getColumnNames();
            while (cursor.moveToNext()) {
                JSObject row = new JSObject();
                for (int i = 0; i < columns.length; i++) {
                    switch (cursor.getType(i)) {
                        case Cursor.FIELD_TYPE_NULL:
                            row.put(columns[i], JSONObject.NULL);
                            break;
                        case Cursor.FIELD_TYPE_INTEGER:
                            row.put(columns[i], cursor.getLong(i));
                            break;
                        case Cursor.FIELD_TYPE_FLOAT:
                            row.put(columns[i], cursor.getDouble(i));
                            break;
                        case Cursor.FIELD_TYPE_BLOB:
                            row.put(columns[i], android.util.Base64.encodeToString(cursor.getBlob(i), android.util.Base64.NO_WRAP));
                            break;
                        default:
                            row.put(columns[i], cursor.getString(i));
                    }
                }
                rows.put(row);
            }
        } finally {
            cursor.close();
        }
        return rows;
    }

    /**
     * SQLite's rawQuery only binds strings, so numbers are converted here.
     * Every column the shared layer writes is TEXT or INTEGER, and SQLite's
     * affinity makes "42" and 42 compare equal in these queries, so this is
     * safe as well as simple.
     */
    private String[] toStrArray(Object[] bind) {
        String[] out = new String[bind.length];
        for (int i = 0; i < bind.length; i++) {
            out[i] = bind[i] == null ? null : String.valueOf(bind[i]);
        }
        return out;
    }
}
