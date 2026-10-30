import type { CapacitorConfig } from "@capacitor/cli";

/* ============================================================================
   EduSphere mobile & tablet shell (Capacitor 7 — Android, iOS/iPadOS)
   ----------------------------------------------------------------------------
   This configuration is intentionally small. Everything the app DOES lives in
   the shared `public/` bundle (copied here by scripts/sync-web.js), which is
   the same bundle the browser and the Electron desktop app load: one offline
   engine, one API client, one UI. The shell only contributes the things a
   phone needs — a WebView, a Keychain/Keystore token store, SQLite, a real
   network listener, the camera, and the `edusphere://` deep-link scheme.

     appId            app.edusphere.mobile  (must match the Android
                      applicationId and the iOS bundle identifier)
     scheme           edusphere://          (deep links: sync, open/<path>,
                                             hub?url=…, settings, about)
     androidScheme    http://localhost      A WebView origin of http://localhost
                      is a SECURE CONTEXT (so getUserMedia/crypto still work)
                      and it is NOT https, so pairing with a school LAN hub over
                      plain http://192.168.x.x does not hit Chrome's mixed-content
                      wall. The server's native CORS allow-list already includes
                      http://localhost.
     iosScheme        capacitor://localhost Apple's origin for WKWebView; the
                      server allow-list includes capacitor://localhost.
     allowNavigation  empty: the WebView may not navigate anywhere. Links that
                      should leave the app go through openExternal(), which
                      allow-lists http/https/mailto/tel only.
     allowMixedContent false — no reason to downgrade when the page origin is
                      already http://localhost.
   ========================================================================== */

const config: CapacitorConfig = {
  appId: "app.edusphere.mobile",
  appName: "EduSphere",
  webDir: "public",
  backgroundColor: "#220b40",
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    backgroundColor: "#220b40",
  },
  ios: {
    contentInset: "always",
    backgroundColor: "#220b40",
    scheme: "EduSphere",
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    androidScheme: "http",
    iosScheme: "capacitor",
    hostname: "localhost",
    allowNavigation: [],
  },
  plugins: {
    App: {
      /* Deep links arrive through the App plugin; native-bridge.js parses them
         against an allow-list before anything happens. */
      disableBackButtonHandler: false,
    },
  },
};

export default config;
