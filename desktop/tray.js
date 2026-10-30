"use strict";
/* ============================================================================
   EduSphere Desktop — system tray
   ----------------------------------------------------------------------------
   Sits in the notification area / menu bar while the app runs. It exists for
   the two things a school actually needs from a tray icon:

     • "Sync now"          flush the offline outbox immediately
     • "Mode"              switch between Cloud and School LAN Hub
     • "Open data folder"  reach the SQLite database, uploads and JSON backups
     • "LAN Hub pairing"   re-open the QR / URL / firewall window

   Linux desktops without an AppIndicator implementation simply have no tray;
   `createTray()` throws and the caller keeps going without one. Nothing here is
   required for the app to work.
   ========================================================================== */

/** The tray's context menu (kept pure so it can be asserted in tests). */
function buildTrayTemplate({ appName = "EduSphere", mode, modes = [], actions = {}, isHub = false } = {}) {
  const template = [
    {
      label: "Open " + appName,
      click: () => actions.showWindow && actions.showWindow(),
    },
    { type: "separator" },
    {
      label: "Sync now",
      click: () => actions.syncNow && actions.syncNow(),
    },
    {
      label: "Mode",
      submenu: modes.map((entry) => ({
        label: entry.label,
        type: "radio",
        checked: entry.id === mode,
        click: () => actions.switchMode && actions.switchMode(entry.id),
      })),
    },
  ];

  if (isHub) {
    template.push({
      label: "LAN Hub pairing info…",
      click: () => actions.openHubInfo && actions.openHubInfo(),
    });
  }

  template.push(
    { type: "separator" },
    {
      label: "Open data folder",
      click: () => actions.openDataFolder && actions.openDataFolder(),
    },
    {
      label: "Desktop settings…",
      click: () => actions.settings && actions.settings(),
    },
    { type: "separator" },
    {
      label: "Quit " + appName,
      click: () => actions.quit && actions.quit(),
    }
  );

  return template;
}

/**
 * @param {object} options
 * @param {Function} options.Tray         Electron Tray constructor
 * @param {Function} options.Menu         Electron Menu
 * @param {Function} [options.nativeImage]
 * @param {string} options.iconPath
 */
function createTray({ Tray, Menu, nativeImage, iconPath, appName = "EduSphere", mode, modes = [], actions = {} } = {}) {
  if (typeof Tray !== "function") throw new Error("System tray is not available");

  let image = iconPath;
  if (typeof nativeImage === "function" && nativeImage && typeof nativeImage.createFromPath === "function") {
    try {
      const candidate = nativeImage.createFromPath(iconPath);
      if (candidate && (!candidate.isEmpty || !candidate.isEmpty())) image = candidate;
    } catch (e) {
      image = iconPath;
    }
  }

  const tray = new Tray(image);
  const template = buildTrayTemplate({ appName, mode, modes, actions, isHub: mode === "hub" });

  if (Menu && typeof Menu.buildFromTemplate === "function" && typeof tray.setContextMenu === "function") {
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }
  if (typeof tray.setToolTip === "function") tray.setToolTip(appName);

  tray.__edusphereTemplate = template;
  return tray;
}

function destroyTray(tray) {
  try {
    if (tray && typeof tray.destroy === "function") tray.destroy();
  } catch (e) {
    /* already gone */
  }
}

module.exports = { buildTrayTemplate, createTray, destroyTray };
