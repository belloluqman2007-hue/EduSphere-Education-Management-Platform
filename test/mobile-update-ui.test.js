"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const script = fs.readFileSync(require.resolve("../public/js/mobile-updates.js"), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("Android update prompt offers Later without starting installation", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "http://localhost/" });
  let installs = 0, confirms = 0;
  dom.window.Capacitor = { getPlatform: () => "android", Plugins: { MobileUpdates: {
    confirm: async () => { confirms++; }, check: async () => ({ available: true, version: "abc", downloadBytes: 1048576 }),
    install: async () => { installs++; },
  } } };
  dom.window.eval(script);
  await tick();
  assert.equal(confirms, 1);
  assert.match(dom.window.document.body.textContent, /1\.00 MB/);
  const buttons = [...dom.window.document.querySelectorAll("button")];
  assert.deepEqual(buttons.map((b) => b.textContent), ["Update now", "Later"]);
  buttons[1].click();
  assert.equal(installs, 0);
  assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
  dom.window.close();
});

test("failed update retains prompt and allows retry", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "http://localhost/" });
  let requested;
  dom.window.Capacitor = { getPlatform: () => "android", Plugins: { MobileUpdates: {
    confirm: async () => {}, check: async () => ({ available: true, version: "abc", downloadBytes: 12 }),
    install: async (value) => { requested = value.version; throw new Error("network"); },
  } } };
  dom.window.eval(script); await tick();
  const now = dom.window.document.querySelector("button"); now.click(); await tick();
  assert.equal(requested, "abc");
  assert.match(dom.window.document.body.textContent, /could not be installed/);
  assert.equal(now.disabled, false);
  dom.window.close();
});

test("browser pages never invoke the mobile updater", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.eval(script); await tick();
  assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
  dom.window.close();
});
