import UIKit
import Capacitor

/* ============================================================================
   EduSphere mobile — iOS/iPadOS app delegate
   ----------------------------------------------------------------------------
   Capacitor owns the WKWebView and loads the SAME `public/` bundle the browser
   and the desktop app use (staged into ios/App/App/public by
   mobile/scripts/sync-web.js). This file adds the two things only the native
   side can do:

     1. register `EduSphereNativePlugin` — Keychain token storage, SQLite, the
        camera permission bridge and allow-listed external links;
     2. forward `edusphere://` URLs to Capacitor, which raises `appUrlOpen`;
        native-bridge.js parses them against an allow-list before acting.

   No remote code, no dynamic frameworks beyond Capacitor's own pods, and no
   JavaScript evaluation from native code.
   ========================================================================== */
@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = EduSphereBridgeViewController()
        window?.makeKeyAndVisible()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // The web layer flushes the outbox on appStateChange; nothing to do here.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // SQLite writes are committed per statement, so a background kill keeps
        // the queue. mobile-shell.js also triggers a sync on resume.
    }

    // Deep links (edusphere://…) and universal-link style opens.
    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        return ApplicationDelegateProxy.shared.application(
            application, continue: userActivity, restorationHandler: restorationHandler
        )
    }
}

/// The bridge view controller: registers EduSphere's own plugin instance and
/// keeps Capacitor's defaults (contextIsolation-like separation, no JS bridge
/// widening).
class EduSphereBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(EduSphereNativePlugin())
    }
}
