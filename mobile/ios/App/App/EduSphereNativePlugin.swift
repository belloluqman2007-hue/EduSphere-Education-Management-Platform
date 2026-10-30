import Foundation
import UIKit
import AVFoundation
import Capacitor

/* ============================================================================
   The only native surface the web bundle can reach (jsName = "EduSphereNative").
   ----------------------------------------------------------------------------
   Mirrors the Android plugin method for method, so public/js/native-bridge.js
   has one code path on both platforms:

     getSecureValue / setSecureValue / removeSecureValue  → iOS Keychain
     sqliteExec / sqliteQuery                             → durable offline store
     getCameraPermission / requestCameraPermission        → the three real answers
     openAppSettings                                      → route to Settings
     openExternal                                         → allow-listed links
     print / getDeviceModel                               → native print sheet

   Nothing here loads remote code or evaluates JavaScript.
   ========================================================================== */
@objc(EduSphereNativePlugin)
public class EduSphereNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EduSphereNativePlugin"
    public let jsName = "EduSphereNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSecureValue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSecureValue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeSecureValue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqliteExec", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqliteQuery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCameraPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestCameraPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceModel", returnType: CAPPluginReturnPromise),
    ]

    private let tokens = SecureTokenStore()
    private lazy var store: SqliteStore? = SqliteStore()

    // MARK: - Secure storage (Keychain)

    @objc func getSecureValue(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        call.resolve(["value": tokens.get(key)])
    }

    @objc func setSecureValue(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        let value = call.getString("value") ?? ""
        call.resolve(["persisted": tokens.set(key, value)])
    }

    @objc func removeSecureValue(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        tokens.remove(key)
        call.resolve(["removed": true])
    }

    // MARK: - SQLite

    @objc func sqliteExec(_ call: CAPPluginCall) {
        guard let store = store else {
            call.reject("The offline database could not be opened")
            return
        }
        let sql = call.getString("sql") ?? ""
        if sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            call.reject("Empty SQL statement")
            return
        }
        let affected = store.exec(sql, call.getArray("params", JSArray()).capacitor_toArray())
        call.resolve(["rowsAffected": Int(affected)])
    }

    @objc func sqliteQuery(_ call: CAPPluginCall) {
        guard let store = store else {
            call.reject("The offline database could not be opened")
            return
        }
        let sql = call.getString("sql") ?? ""
        if sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            call.reject("Empty SQL statement")
            return
        }
        let rows = store.query(sql, call.getArray("params", JSArray()).capacitor_toArray())
        call.resolve(["rows": rows])
    }

    // MARK: - Camera permission

    private func cameraState() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return "granted"
        case .notDetermined:
            return "prompt"
        case .denied, .restricted:
            // iOS never shows the system prompt twice: denied IS permanent, and
            // the only route back is Settings → EduSphere → Camera.
            return "denied-permanently"
        @unknown default:
            return "unknown"
        }
    }

    @objc func getCameraPermission(_ call: CAPPluginCall) {
        call.resolve(["state": cameraState()])
    }

    @objc func requestCameraPermission(_ call: CAPPluginCall) {
        let current = cameraState()
        if current == "granted" || current == "denied-permanently" {
            call.resolve(["state": current])
            return
        }
        AVCaptureDevice.requestAccess(for: .video) { _ in
            // The answer is read back on the main queue: the JS side treats this
            // resolution as the source of truth and must not race the UI.
            DispatchQueue.main.async {
                call.resolve(["state": self.cameraState()])
            }
        }
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("Could not open the app settings screen")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }

    // MARK: - Links, print, identity

    @objc func openExternal(_ call: CAPPluginCall) {
        let raw = (call.getString("url") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = raw.lowercased()
        let allowed = lower.hasPrefix("https://") || lower.hasPrefix("http://")
            || lower.hasPrefix("mailto:") || lower.hasPrefix("tel:")
        let denied = lower.hasPrefix("javascript:") || lower.hasPrefix("data:")
            || lower.hasPrefix("file:") || lower.hasPrefix("content:")
            || lower.contains("\n") || lower.contains("\r")
        guard allowed, !denied, let url = URL(string: raw) else {
            call.resolve(["opened": false, "reason": "blocked"])
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened, "reason": opened ? "" : "no-app"])
            }
        }
    }

    @objc func print(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView else {
                call.reject("Printing is not available on this device")
                return
            }
            let controller = UIPrintInteractionController.shared
            controller.printFormatter = webView.viewPrintFormatter()
            controller.present(animated: true) { _, _, error in
                if let error = error {
                    call.reject("Could not open the print sheet: \(error.localizedDescription)")
                } else {
                    call.resolve(["ok": true])
                }
            }
        }
    }

    @objc func getDeviceModel(_ call: CAPPluginCall) {
        let device = UIDevice.current
        let model = device.model.isEmpty ? "iOS device" : device.model
        call.resolve(["model": model, "systemVersion": device.systemVersion])
    }
}

/// Small helpers: Capacitor's JSArray/JSObject are `[Any]`/`[String: Any]`
/// subclasses, and the SQLite driver takes plain Swift values.
private extension JSArray {
    func capacitor_toArray() -> [Any] {
        var values: [Any] = []
        for index in 0..<self.count {
            if let value = self[index] as Any? {
                values.append(value is NSNull ? NSNull() : value)
            } else {
                values.append(NSNull())
            }
        }
        return values
    }
}
