"use strict";
/* ============================================================================
   EduSphere Desktop — application menu
   ----------------------------------------------------------------------------
   A native menu bar with the desktop-only actions. Every item is a real,
   discoverable alternative to a keyboard shortcut, and none of them exposes
   anything the web app cannot already do:

     EduSphere  About · Desktop settings… · Quit
     File       Print… · Save as PDF… · Open data folder
     Mode       Cloud-synced app / Local school LAN hub (radio)
     Sync       Sync now · Show LAN Hub pairing info
     Edit/View  the standard roles (copy/paste, reload, zoom, devtools)
     Help       Documentation · Report a problem · Install help

   The template is pure data so the test suite can assert the Mode radio group
   and the "Sync now" item without launching Electron.
   ========================================================================== */

const DOCS_URL = "https://github.com/belloluqman2007-hue/EduSphere-Education-Management-Platform/blob/main/docs/DESKTOP-APP.md";
const ISSUES_URL = "https://github.com/belloluqman2007-hue/EduSphere-Education-Management-Platform/issues";

function buildMenuTemplate({ appName = "EduSphere", isMac = false, mode, modes = [], actions = {} } = {}) {
  const appMenu = {
    label: appName,
    submenu: [
      { label: "About " + appName, click: () => actions.about && actions.about() },
      { type: "separator" },
      { label: "Desktop settings…", accelerator: "CmdOrCtrl+,", click: () => actions.settings && actions.settings() },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { label: "Quit " + appName, accelerator: "CmdOrCtrl+Q", click: () => actions.quit && actions.quit() },
    ],
  };

  const fileMenu = {
    label: "File",
    submenu: [
      { label: "Print…", accelerator: "CmdOrCtrl+P", click: () => actions.print && actions.print() },
      { label: "Save as PDF…", accelerator: "CmdOrCtrl+Shift+P", click: () => actions.savePdf && actions.savePdf() },
      { type: "separator" },
      { label: "Open data folder", click: () => actions.openDataFolder && actions.openDataFolder() },
      { type: "separator" },
      ...(isMac ? [{ role: "close" }] : [{ label: "Close window", role: "close" }, { label: "Quit " + appName, click: () => actions.quit && actions.quit() }]),
    ],
  };

  const modeMenu = {
    label: "Mode",
    submenu: modes.map((entry) => ({
      label: entry.label,
      type: "radio",
      checked: entry.id === mode,
      click: () => actions.switchMode && actions.switchMode(entry.id),
    })),
  };

  const syncMenu = {
    label: "Sync",
    submenu: [
      { label: "Sync now", accelerator: "CmdOrCtrl+Shift+S", click: () => actions.syncNow && actions.syncNow() },
      { label: "LAN Hub pairing info…", click: () => actions.openHubInfo && actions.openHubInfo() },
    ],
  };

  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ],
  };

  const viewMenu = {
    label: "View",
    submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => actions.reload && actions.reload() },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      { role: "toggleDevTools" },
    ],
  };

  const helpMenu = {
    role: "help",
    label: "Help",
    submenu: [
      { label: "Desktop app guide", click: () => actions.openExternal && actions.openExternal(DOCS_URL) },
      { label: "Report a problem", click: () => actions.openExternal && actions.openExternal(ISSUES_URL) },
    ],
  };

  return [appMenu, fileMenu, modeMenu, syncMenu, editMenu, viewMenu, helpMenu];
}

module.exports = { DOCS_URL, ISSUES_URL, buildMenuTemplate };
