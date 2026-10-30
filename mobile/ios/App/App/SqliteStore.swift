import Foundation
import SQLite3

/* ============================================================================
   Durable SQLite for the offline database (iOS).
   ----------------------------------------------------------------------------
   Exactly the Android counterpart: a thin driver that runs the SQL written by
   public/js/mobile-storage.js. The schema, the tenant-scoped keys, the outbox
   and the conflict semantics stay in the shared web layer, so the phone cannot
   drift from the browser.

   The file lives in Application Support/edusphere_offline.db:
     • it survives app restarts, low-memory kills and iOS "Offsite" cache
       eviction (which is what destroys a WKWebView's IndexedDB),
     • it is excluded from iCloud backup only if the school prefers; by default
       it IS backed up so a replaced iPad keeps its queue.
   ========================================================================== */
final class SqliteStore {
    private var db: OpaquePointer?

    init?() {
        let fileManager = FileManager.default
        guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        if !fileManager.fileExists(atPath: support.path) {
            try? fileManager.createDirectory(at: support, withIntermediateDirectories: true)
        }
        let url = support.appendingPathComponent("edusphere_offline.db")
        if sqlite3_open(url.path, &db) != SQLITE_OK {
            db = nil
            return nil
        }
        // WAL keeps a long pull from blocking a scan write, and survives a kill.
        sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA synchronous=NORMAL;", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA foreign_keys=ON;", nil, nil, nil)
    }

    deinit {
        if let handle = db { sqlite3_close(handle) }
    }

    private func bind(_ statement: OpaquePointer, _ params: [Any]) {
        for (offset, value) in params.enumerated() {
            let index = Int32(offset + 1)
            if value is NSNull {
                sqlite3_bind_null(statement, index)
            } else if let number = value as? NSNumber {
                // JSON booleans arrive as NSNumber; SQLite has no boolean type.
                if CFGetTypeID(number) == CFBooleanGetTypeID() {
                    sqlite3_bind_int(statement, index, number.boolValue ? 1 : 0)
                } else {
                    let double = number.doubleValue
                    if double == double.rounded() && abs(double) < 9.0e18 {
                        sqlite3_bind_int64(statement, index, Int64(double))
                    } else {
                        sqlite3_bind_double(statement, index, double)
                    }
                }
            } else {
                let text = String(describing: value)
                sqlite3_bind_text(statement, index, text, -1, SQLITE_TRANSIENT)
            }
        }
    }

    @discardableResult
    func exec(_ sql: String, _ params: [Any]) -> Int32 {
        guard let handle = db else { return 0 }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(statement) }
        bind(statement!, params)
        let result = sqlite3_step(statement)
        if result != SQLITE_DONE && result != SQLITE_ROW { return 0 }
        return sqlite3_changes(handle)
    }

    func query(_ sql: String, _ params: [Any]) -> [[String: Any]] {
        guard let handle = db else { return [] }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(statement) }
        bind(statement!, params)
        var rows: [[String: Any]] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            var row: [String: Any] = [:]
            let columns = sqlite3_column_count(statement)
            for index in 0..<columns {
                guard let namePointer = sqlite3_column_name(statement, index) else { continue }
                let name = String(cString: namePointer)
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER:
                    row[name] = Int(sqlite3_column_int64(statement, index))
                case SQLITE_FLOAT:
                    row[name] = sqlite3_column_double(statement, index)
                case SQLITE_NULL:
                    row[name] = NSNull()
                default:
                    if let text = sqlite3_column_text(statement, index) {
                        row[name] = String(cString: text)
                    } else {
                        row[name] = ""
                    }
                }
            }
            rows.append(row)
        }
        return rows
    }
}

/// `SQLITE_TRANSIENT` is not exposed to Swift; this is the standard shim.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
