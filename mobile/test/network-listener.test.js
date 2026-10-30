"use strict";
/* ============================================================================
   THE REAL NETWORK LISTENER, RESUME SYNC AND THE HARDWARE BACK BUTTON
   ----------------------------------------------------------------------------
   A WebView's `navigator.onLine` stays "true" for seconds after the radio dies,
   so the Phase 2 poll is not enough on a phone. `@capacitor/network` reports
   the truth; public/js/mobile-shell.js feeds it into the SAME SyncEngine the
   browser uses (pill state, outbox flush, pull timer) — no second sync engine.

   Every listener here is fired by the test exactly as Capacitor would fire it.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bootNativeBridge, makeNetworkPlugin, makeAppPlugin, createDom, makeSecurePlugin, makeCapacitor } = require("./helpers");

function fakeSync() {
  const calls = { online: [], syncNow: 0, probe: null };
  return {
    calls,
    setOnline(value) { calls.online.push(value); },
    setConnectivityProbe(fn) { calls.probe = fn; return true; },
    syncNow() { calls.syncNow += 1; return Promise.resolve({ ok: true }); },
    state() { return { online: calls.online[calls.online.length - 1] }; },
  };
}

async function bootShell(options) {
  const opts = options || {};
  const sync = opts.sync || fakeSync();
  const network = opts.network || makeNetworkPlugin();
  const app = opts.app || makeAppPlugin();
  const secure = makeSecurePlugin(opts.secureOptions || {});
  const ctx = await bootNativeBridge({
    secure,
    network,
    app,
    storage: opts.storage || { "edusphere.mobile.server": "https://school.edusphere.app" },
    html: opts.html,
    url: opts.url,
    beforeEval: (window) => {
      window.SyncEngine = sync;
      if (opts.beforeEval) opts.beforeEval(window);
    },
  });
  ctx.evalFile("mobile-shell.js");
  return Object.assign(ctx, { sync, network, app, secure });
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));

test("the network plugin drives SyncEngine.setOnline (both directions)", async () => {
  const ctx = await bootShell();
  const { sync, network } = ctx;

  await tick(5);
  assert.deepEqual(sync.calls.online, [true], "the initial getStatus() is applied");

  network.listeners.networkStatusChange({ connected: false, connectionType: "none" });
  assert.equal(sync.calls.online[sync.calls.online.length - 1], false, "offline reaches the engine (pill + queue)");

  network.listeners.networkStatusChange({ connected: true, connectionType: "wifi" });
  assert.equal(sync.calls.online[sync.calls.online.length - 1], true, "reconnecting flushes the outbox and pulls");

  ctx.close();
});

test("SyncEngine's connectivity probe reports the native truth, not navigator.onLine", async () => {
  const ctx = await bootShell();
  const { sync, network } = ctx;
  assert.equal(typeof sync.calls.probe, "function", "the probe was installed");

  assert.equal(sync.calls.probe(), true);
  network.listeners.networkStatusChange({ connected: false });
  assert.equal(sync.calls.probe(), false, "pullNow() now refuses to try while the radio is down");

  /* navigator.onLine is deliberately left at jsdom's default (true) to prove the
     native answer wins. */
  assert.equal(ctx.window.navigator.onLine, true);
  ctx.close();
});

test("a malformed network event cannot corrupt the pill", async () => {
  const ctx = await bootShell();
  const { sync, network } = ctx;
  const before = sync.calls.online.length;
  network.listeners.networkStatusChange({});
  network.listeners.networkStatusChange(null);
  assert.equal(sync.calls.online.length, before, "nothing was applied");
  ctx.close();
});

test("returning to the foreground triggers an immediate sync", async () => {
  const ctx = await bootShell();
  assert.equal(typeof ctx.app.listeners.appStateChange, "function");

  ctx.app.listeners.appStateChange({ isActive: false });
  assert.equal(ctx.sync.calls.syncNow, 0, "going to the background does not sync");

  ctx.app.listeners.appStateChange({ isActive: true });
  await tick(5);
  assert.equal(ctx.sync.calls.syncNow, 1, "resuming flushes the queue and pulls");
  ctx.close();
});

test("the hardware back button closes a modal before it navigates", async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>
    <div id="app"><div class="dash-modal-backdrop"><div class="dash-modal" role="dialog">
      <button class="dash-modal-close" type="button">Close</button>
    </div></div></div></body></html>`;
  const ctx = await bootShell({ html });
  const window = ctx.window;

  let closed = 0;
  window.document.querySelector(".dash-modal-close").addEventListener("click", () => {
    closed += 1;
    window.document.querySelector(".dash-modal-backdrop").remove();
  });
  const before = window.history.length;

  ctx.app.listeners.backButton();

  assert.equal(closed, 1, "the modal was dismissed first");
  assert.equal(window.history.length, before, "history was not touched");
  assert.equal(ctx.app.calls.exitApp, 0, "the app was not closed");
  ctx.close();
});

test("back closes the drawer and the camera viewport, in that order", async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>
    <div id="app">
      <div class="ss-drawer is-open"><button id="schoolDrawerClose" type="button">Close menu</button></div>
      <div class="scan-viewport"><video></video><button data-scanner-running type="button">Stop camera</button></div>
    </div></body></html>`;
  const ctx = await bootShell({ html });
  const doc = ctx.window.document;

  doc.getElementById("schoolDrawerClose").addEventListener("click", () => {
    doc.querySelector(".ss-drawer").classList.remove("is-open");
  });
  doc.querySelector("[data-scanner-running]").addEventListener("click", () => {
    doc.querySelector(".scan-viewport").remove();
  });

  assert.equal(ctx.window.MobileShell.handleBack(), "drawer");
  assert.equal(doc.querySelector(".ss-drawer.is-open"), null);

  assert.equal(ctx.window.MobileShell.handleBack(), "scanner");
  assert.equal(doc.querySelector(".scan-viewport"), null);

  const result = ctx.window.MobileShell.handleBack();
  assert.equal(result, "exit", "nothing left to close and we are on the home route");
  ctx.app.listeners.backButton();
  assert.equal(ctx.app.calls.exitApp, 1, "only then does the app itself close");
  ctx.close();
});

test("back navigates the SPA when a route is open, and only exits at home", async () => {
  const ctx = await bootShell({ url: "https://localhost/students" });
  /* jsdom's history.back() is a no-op, so the decision is what is asserted:
     with a route open the shell walks history instead of leaving the app. */
  assert.equal(ctx.window.MobileShell.handleBack(), "history", "the SPA history is walked first");
  ctx.app.listeners.backButton();
  assert.equal(ctx.app.calls.exitApp, 0, "the app stays open while there is a route to go back to");
  ctx.close();
});

test("no rubber-band scrolling behind an open modal", async () => {
  const ctx = await bootShell();
  const doc = ctx.window.document;

  assert.equal(doc.body.classList.contains("is-modal-open"), false);
  const backdrop = doc.createElement("div");
  backdrop.className = "dash-modal-backdrop";
  doc.body.appendChild(backdrop);
  await tick(10);
  assert.equal(doc.body.classList.contains("is-modal-open"), true, "the page is locked while the dialog is up");

  backdrop.remove();
  await tick(10);
  assert.equal(doc.body.classList.contains("is-modal-open"), false, "and unlocked afterwards");
  ctx.close();
});

test("a touchmove outside the dialog is cancelled while it is open", async () => {
  const ctx = await bootShell();
  const doc = ctx.window.document;
  const backdrop = doc.createElement("div");
  backdrop.className = "dash-modal-backdrop";
  const dialog = doc.createElement("div");
  dialog.className = "dash-modal";
  backdrop.appendChild(dialog);
  doc.body.appendChild(backdrop);
  await tick(10);

  const outside = new ctx.window.Event("touchmove", { bubbles: true, cancelable: true });
  doc.body.dispatchEvent(outside);
  assert.equal(outside.defaultPrevented, true, "the page behind does not drag");

  const inside = new ctx.window.Event("touchmove", { bubbles: true, cancelable: true });
  dialog.dispatchEvent(inside);
  assert.equal(inside.defaultPrevented, false, "the dialog itself still scrolls");
  ctx.close();
});

test("tablets get the two-column register layout; phones get one column", async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><div id="app">
    <div class="dash-card"><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Student</th><th>Status</th></tr></thead>
      <tbody>${Array.from({ length: 12 }, (_, index) => `<tr><td>Student ${index + 1}</td><td>present</td></tr>`).join("")}</tbody>
    </table></div></div></div></body></html>`;

  const tablet = await bootShell({
    html,
    beforeEval: (window) => { window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} }); },
  });
  assert.equal(tablet.window.document.documentElement.classList.contains("is-tablet"), true);
  const grid = tablet.window.document.querySelector(".reg-two-col");
  assert.ok(grid, "installing the shell splits the register on a tablet");
  const tables = grid.querySelectorAll("table");
  assert.equal(tables.length, 2, "two tables, one per column");
  assert.equal(grid.querySelectorAll("tbody tr").length, 12, "no row was lost");
  assert.equal(grid.querySelectorAll("thead").length, 2, "both columns repeat the header");
  assert.equal(tablet.window.MobileShell.enhanceRegisters(), 0, "running it again is a no-op");
  token: {
    /* The header clone must not duplicate ids, or labels would point at the
       wrong checkbox. */
    const ids = Array.from(grid.querySelectorAll("[id]"));
    assert.equal(ids.length, 0, "no id is duplicated by the split");
  }
  tablet.close();

  const phone = await bootShell({
    html,
    beforeEval: (window) => { window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} }); },
  });
  assert.equal(phone.window.document.documentElement.classList.contains("is-phone"), true);
  assert.equal(phone.window.document.querySelector(".reg-two-col"), null, "a phone keeps one column");
  assert.equal(phone.window.MobileShell.enhanceRegisters(), 0, "and refuses to split");
  phone.close();
});

test("a first run with no server address shows the pairing screen", async () => {
  const ctx = await bootShell({ storage: {} });
  const doc = ctx.window.document;
  const screen = doc.getElementById("edusphere-pairing");
  assert.ok(screen, "the operator is asked where their school is");
  assert.match(screen.textContent, /Connect to your school/);
  assert.match(screen.textContent, /LAN Hub/i, "the LAN hub address is explained");

  const input = doc.getElementById("edusphere-pairing-input");
  input.value = "http://school.example.com"; // public http is not allowed
  const form = screen.querySelector("form");
  const submit = new ctx.window.Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(submit);
  assert.match(screen.querySelector(".edusphere-pairing__error").textContent, /https:\/\//, "the refusal explains the rule");
  assert.equal(ctx.mobile.server.get(), "", "nothing was saved");

  input.value = "http://192.168.1.5:4123";
  assert.equal(ctx.mobile.server.normalize(input.value), "http://192.168.1.5:4123", "a school LAN address is accepted");
  ctx.close();
});

test("a configured install never shows the pairing screen", async () => {
  const ctx = await bootShell();
  assert.equal(ctx.window.document.getElementById("edusphere-pairing"), null);
  ctx.close();
});

test("the shell refuses to install when a native plugin is missing, instead of throwing", async () => {
  const dom = createDom({
    capacitor: makeCapacitor({ platform: "android", plugins: {} }),
    beforeEval: (window) => { window.SyncEngine = fakeSync(); },
  });
  dom.evalFile("native-bridge.js");
  await dom.window.__EDUSPHERE_MOBILE__.ready;
  dom.evalFile("mobile-shell.js");
  assert.ok(dom.window.MobileShell, "the shell still exposes its surface");
  assert.equal(dom.errors.length, 0, "and nothing threw: " + dom.errors.map((e) => e.message).join(","));
  dom.close();
});
