"use strict";
/* ============================================================================
   Menu + tray — the desktop-only affordances the roadmap asks for:
   "Sync now", "Mode", "Open data folder", LAN Hub pairing info.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");

const { buildMenuTemplate } = require("../menu");
const { buildTrayTemplate, createTray, destroyTray } = require("../tray");

const MODES = [
  { id: "cloud", label: "Cloud-synced app" },
  { id: "hub", label: "Local school LAN hub" },
];

function recorder() {
  const calls = [];
  return {
    calls,
    actions: {
      about: () => calls.push("about"),
      settings: () => calls.push("settings"),
      switchMode: (mode) => calls.push("switchMode:" + mode),
      syncNow: () => calls.push("syncNow"),
      openDataFolder: () => calls.push("openDataFolder"),
      openHubInfo: () => calls.push("openHubInfo"),
      reload: () => calls.push("reload"),
      print: () => calls.push("print"),
      savePdf: () => calls.push("savePdf"),
      openExternal: (url) => calls.push("openExternal:" + url),
      quit: () => calls.push("quit"),
    },
  };
}

function findItem(items, label) {
  for (const item of items) {
    if (item.label === label) return item;
    if (Array.isArray(item.submenu)) {
      const found = findItem(item.submenu, label);
      if (found) return found;
    }
  }
  return null;
}

test("the application menu exposes Mode, Sync now, printing and the data folder", () => {
  const { actions, calls } = recorder();
  const template = buildMenuTemplate({ appName: "EduSphere", isMac: false, mode: "hub", modes: MODES, actions });

  const labels = template.map((menu) => menu.label);
  assert.deepEqual(labels, ["EduSphere", "File", "Mode", "Sync", "Edit", "View", "Help"]);

  const modeMenu = template.find((menu) => menu.label === "Mode");
  assert.equal(modeMenu.submenu.length, 2);
  assert.equal(modeMenu.submenu.every((item) => item.type === "radio"), true);
  assert.equal(modeMenu.submenu.find((item) => item.checked).label, "Local school LAN hub");
  modeMenu.submenu[0].click();
  assert.deepEqual(calls.pop(), "switchMode:cloud");

  const syncNow = findItem(template, "Sync now");
  assert.ok(syncNow, "menu has Sync now");
  syncNow.click();
  assert.equal(calls.pop(), "syncNow");

  findItem(template, "Open data folder").click();
  assert.equal(calls.pop(), "openDataFolder");

  findItem(template, "LAN Hub pairing info…").click();
  assert.equal(calls.pop(), "openHubInfo");

  findItem(template, "Print…").click();
  assert.equal(calls.pop(), "print");
  findItem(template, "Save as PDF…").click();
  assert.equal(calls.pop(), "savePdf");

  findItem(template, "About EduSphere").click();
  assert.equal(calls.pop(), "about");

  findItem(template, "Desktop settings…").click();
  assert.equal(calls.pop(), "settings");

  findItem(template, "Desktop app guide").click();
  assert.match(calls.pop(), /^openExternal:https:\/\/github\.com\//);
});

test("the tray menu carries the same essential actions", () => {
  const { actions, calls } = recorder();
  const template = buildTrayTemplate({ appName: "EduSphere", mode: "cloud", modes: MODES, actions, isHub: false });

  assert.equal(findItem(template, "LAN Hub pairing info…"), null, "cloud mode has no pairing info");
  findItem(template, "Sync now").click();
  assert.equal(calls.pop(), "syncNow");
  findItem(template, "Open data folder").click();
  assert.equal(calls.pop(), "openDataFolder");

  const modeItem = template.find((item) => item.label === "Mode");
  assert.equal(modeItem.submenu.find((item) => item.checked).label, "Cloud-synced app");
  modeItem.submenu[1].click();
  assert.equal(calls.pop(), "switchMode:hub");

  const hubTemplate = buildTrayTemplate({ appName: "EduSphere", mode: "hub", modes: MODES, actions, isHub: true });
  assert.ok(findItem(hubTemplate, "LAN Hub pairing info…"), "hub mode shows the pairing entry");
});

test("createTray wires the context menu and survives a missing icon", () => {
  const made = [];
  class FakeTray extends EventEmitter {
    constructor(image) { super(); this.image = image; made.push(this); }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip(text) { this.tooltip = text; }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  const { actions } = recorder();

  const tray = createTray({ Tray: FakeTray, Menu, iconPath: "/does/not/exist.png", mode: "hub", modes: MODES, actions });
  assert.equal(made.length, 1);
  assert.equal(tray.tooltip, "EduSphere");
  assert.ok(tray.menu.template.some((item) => item.label === "Sync now"));

  destroyTray(tray);
  assert.equal(tray.destroyed, true);
  destroyTray(null); // never throws
});
