"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bootNativeBridge, script } = require("./helpers");

test("native pairing recovery pre-fills the currently saved server address", async () => {
  const server = "https://bello-institute.onrender.com";
  const ctx = await bootNativeBridge({ storage: { "edusphere.mobile.server": server } });
  try {
    ctx.evalFile("mobile-shell.js");
    const dialog = ctx.window.MobileShell.showPairing();
    assert.ok(dialog, "repair opens the existing Connect to your school dialog");
    assert.equal(ctx.window.document.getElementById("edusphere-pairing-input").value, server);
  } finally {
    ctx.close();
  }
});

test("native network sign-in failures expose the server repair action", () => {
  const dashboard = script("dashboard.js");
  assert.match(dashboard, /dashRepairServerBtn/);
  assert.match(dashboard, /window\.MobileShell\.showPairing\(\)/);
  assert.match(dashboard, /window\.__EDUSPHERE_MOBILE__/);
  assert.match(dashboard, /loginError\.status === 0/);
});
