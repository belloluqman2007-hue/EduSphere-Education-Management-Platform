import Foundation
import Security

/* ============================================================================
   iOS Keychain store for the Bearer device token.
   ----------------------------------------------------------------------------
   The token is a credential: whoever holds it is signed in as that teacher or
   administrator. It therefore lives in the Keychain — never in
   UserDefaults, never in a plist, never in localStorage (the WebView's storage
   is readable by any script the page loads).

     kSecClass            kSecClassGenericPassword
     kSecAttrService      app.edusphere.mobile.secrets
     kSecAttrAccount      the key ("device_token", "device_id", …)
     kSecAttrAccessible   kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

   `AfterFirstUnlock` lets a background sync read the token after a reboot once
   the phone has been unlocked (a gate tablet in a drawer keeps working), while
   `ThisDeviceOnly` keeps the item out of iCloud Keychain and out of an iTunes
   backup restored onto a different device.

   Every failure returns "" rather than throwing: a missing token means "sign
   in again", never a crash.
   ========================================================================== */
final class SecureTokenStore {
    private let service = "app.edusphere.mobile.secrets"

    private func baseQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    func get(_ key: String) -> String {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return ""
        }
        return value
    }

    @discardableResult
    func set(_ key: String, _ value: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        let query = baseQuery(key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        if updateStatus != errSecItemNotFound { return false }
        var insert = query
        insert.merge(attributes) { _, new in new }
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    func remove(_ key: String) -> Bool {
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
