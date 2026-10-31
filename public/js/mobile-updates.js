"use strict";
/* Android-only signed interface updates. School connection URLs are never used
   as the source; the native plugin pins the operator's update origin and key. */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const cap = window.Capacitor;
  if (!cap || typeof cap.getPlatform !== "function" || cap.getPlatform() !== "android") return;
  const plugin = cap.Plugins && cap.Plugins.MobileUpdates;
  if (!plugin || typeof plugin.check !== "function") return;

  function promptUpdate(info) {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "EduSphere update available");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px";
    const box = document.createElement("div");
    box.style.cssText = "background:white;color:#251139;border-radius:16px;padding:24px;max-width:360px;width:100%;font:16px sans-serif;box-shadow:0 8px 30px #0004";
    const heading = document.createElement("h2"); heading.textContent = "Update available";
    const message = document.createElement("p");
    const mb = Math.max(0.01, Number(info.downloadBytes || 0) / 1048576).toFixed(2);
    message.textContent = "Update EduSphere now? Approximately " + mb + " MB will be downloaded. Your offline data will be kept.";
    const later = document.createElement("button"); later.textContent = "Later"; later.type = "button";
    const now = document.createElement("button"); now.textContent = "Update now"; now.type = "button";
    later.style.cssText = now.style.cssText = "padding:12px 16px;margin:8px 8px 0 0;border-radius:8px;border:1px solid #5b3476;cursor:pointer";
    now.style.background = "#51276e"; now.style.color = "white";
    const status = document.createElement("p"); status.setAttribute("role", "status");
    later.onclick = () => overlay.remove();
    now.onclick = async () => {
      now.disabled = true; later.disabled = true; status.textContent = "Downloading and verifying update…";
      try {
        // A cache-first service worker could otherwise keep old scripts after
        // switching bundles. Offline user records and the sync queue are not in these caches.
        if (navigator.serviceWorker) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        }
        if (window.caches) {
          const keys = await window.caches.keys();
          await Promise.all(keys.filter((key) => key.startsWith("edusphere-shell-")).map((key) => window.caches.delete(key)));
        }
        await plugin.install({ version: info.version });
        window.location.reload();
      } catch (_) {
        status.textContent = "The update could not be installed. Your current app has not been changed. Please try again later.";
        now.disabled = false; later.disabled = false;
      }
    };
    box.append(heading, message, status, now, later); overlay.appendChild(box); document.body.appendChild(overlay); now.focus();
  }
  window.addEventListener("load", async () => {
    try {
      await plugin.confirm();
      const info = await plugin.check();
      if (info && info.available) promptUpdate(info);
    } catch (_) { /* Offline or not configured: keep using the existing app. */ }
  }, { once: true });
})();
