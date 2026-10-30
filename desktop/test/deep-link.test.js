"use strict";
/* ============================================================================
   edusphere:// deep links — an untrusted input parsed by an allow-list.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeRoute, parseDeepLink, resolveDeepLink } = require("../deep-link");

test("known shell actions are accepted", () => {
  assert.deepEqual(parseDeepLink("edusphere://sync"), { ok: true, kind: "sync" });
  assert.deepEqual(parseDeepLink("edusphere://settings"), { ok: true, kind: "settings" });
  assert.deepEqual(parseDeepLink("edusphere://hub"), { ok: true, kind: "hub" });
  assert.deepEqual(parseDeepLink("edusphere://about"), { ok: true, kind: "about" });
  assert.deepEqual(parseDeepLink("edusphere:///sync"), { ok: true, kind: "sync" }, "triple-slash form");
  assert.deepEqual(parseDeepLink("EDUSPHERE://SYNC"), { ok: true, kind: "sync" }, "scheme and host are case-insensitive");
});

test("mode switching only accepts the two real modes", () => {
  assert.deepEqual(parseDeepLink("edusphere://mode/hub"), { ok: true, kind: "mode", mode: "hub" });
  assert.deepEqual(parseDeepLink("edusphere://mode/cloud"), { ok: true, kind: "mode", mode: "cloud" });
  assert.equal(parseDeepLink("edusphere://mode/root").ok, false);
  assert.equal(parseDeepLink("edusphere://mode").ok, false);
});

test("in-app paths are normalised and traversal is refused", () => {
  assert.deepEqual(parseDeepLink("edusphere://open/admin/students"), { ok: true, kind: "open", path: "admin/students" });
  assert.deepEqual(parseDeepLink("edusphere://app/portal"), { ok: true, kind: "open", path: "portal" });
  assert.equal(parseDeepLink("edusphere://open/../../etc/passwd").ok, false);
  assert.equal(parseDeepLink("edusphere://open/a%2E%2E%2Fb").ok, false);
  assert.equal(parseDeepLink("edusphere://open/https://evil.example").ok, false);
  assert.equal(parseDeepLink("edusphere://open/admin?x=1").kind, "open", "query strings are stripped, not executed");
  assert.equal(parseDeepLink("edusphere://open/admin?x=1").path, "admin");
  assert.equal(normalizeRoute(""), "");
  assert.equal(normalizeRoute("//evil"), "evil");
  assert.equal(normalizeRoute("javascript:alert(1)"), "");
});

test("everything else is rejected with a reason and never throws", () => {
  const bad = [
    "",
    "   ",
    "https://school.edusphere.app",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "edusphere://unknown-action",
    "edusphere://open",
    "edusphere://sync/extra",
    "edusphere://user:pass@sync",
    "edusphere://sync\nX-Injected: 1",
    "edusphere://" + "a".repeat(3000),
  ];
  for (const input of bad) {
    const result = parseDeepLink(input);
    assert.equal(result.ok, false, "expected rejection for: " + JSON.stringify(input.slice(0, 40)));
    assert.equal(result.kind, null);
    assert.equal(typeof result.error, "string");
  }
});

test("navigation links resolve against the configured base URL and cannot leave it", () => {
  const resolved = resolveDeepLink("edusphere://open/admin/students", "https://school.edusphere.app");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.url, "https://school.edusphere.app/admin/students");

  const hub = resolveDeepLink("edusphere://open/portal", "http://127.0.0.1:4123/");
  assert.equal(hub.url, "http://127.0.0.1:4123/portal");

  assert.equal(resolveDeepLink("edusphere://open/admin", "").ok, false, "no base URL means no navigation");
  assert.equal(resolveDeepLink("edusphere://open/admin", "file:///tmp").ok, false, "only http(s) bases are allowed");
  assert.equal(resolveDeepLink("edusphere://sync", "https://school.example.com").kind, "sync", "shell actions need no base");
});
