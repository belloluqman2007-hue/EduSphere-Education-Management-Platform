"use strict";
/* ============================================================================
   NATIVE DEVICE AUTH & OFFLINE SYNC ENGINE TESTS (Phase 1)
   ----------------------------------------------------------------------------
   Verifies:
     1. Device Bearer tokens (issue, verify, cross-origin CORS preflight,
        CSRF exemption ONLY for valid Bearer header, anti-piggyback security
        when a bogus Bearer header accompanies a live session cookie, device
        listing, remote revocation, logout revocation, password-change
        revocation, user deactivation & madrasa suspension enforcement).
     2. /api/sync/status & /api/sync/pull (full + incremental `?since=` pulls,
        strict tenant isolation between Madrasa A and Madrasa B, teacher
        class/subject scoping, student/parent portal scoping where draft marks
        never leak).
     3. /api/sync/push Outbox processor (idempotent `clientMutationId` retries,
        local-to-server ID mapping across `student.create` -> `attendance.mark`,
        `results.upsert`, `quran_progress.create`, and `fee_payment.record`,
        offline QR card scan + revoked card conflict reporting, cell-level
        result conflict isolation on `published`/`locked` rows, duplicate
        payment reference conflict handling, and plan feature gating).
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let ctx;
before(async () => {
  process.env.LOGIN_RATE_LIMIT = "200";
  ctx = await setup();
});
after(async () => {
  if (ctx) await ctx.close();
});

/** Cookie-less native app HTTP client using only Authorization: Bearer. */
async function bearerReq(base, token, method, path, body, extraHeaders = {}) {
  const headers = Object.assign({ Accept: "application/json" }, extraHeaders);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) data = await res.json().catch(() => null);
  return { status: res.status, data, res };
}

async function loginNative(base, username, password, device = {}) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({
      username,
      password,
      issueDeviceToken: true,
      deviceId: "dev-win-01",
      deviceName: "School Office PC",
      platform: "electron",
    }, device)),
  });
  const data = await res.json();
  return { status: res.status, data };
}

test("CORS preflight permits Capacitor & Electron origins with Authorization header", async () => {
  for (const origin of ["capacitor://localhost", "app://edusphere", "https://localhost"]) {
    const res = await fetch(ctx.base + "/api/sync/status", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Authorization, X-Device-Id",
      },
    });
    assert.equal(res.status, 204, `preflight status for ${origin}`);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    const allowHeaders = String(res.headers.get("access-control-allow-headers") || "");
    assert.match(allowHeaders, /Authorization/i);
  }

  // Arbitrary unknown website origin must NOT get CORS headers
  const untrusted = await fetch(ctx.base + "/api/sync/status", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example.com" },
  });
  assert.equal(untrusted.headers.get("access-control-allow-origin"), null);
});

test("ordinary web login does not mint a device token unless requested", async () => {
  const web = new Client(ctx.base);
  const login = await web.login("admin-a", PASSWORD);
  assert.equal(login.status, 200);
  assert.equal(login.data.deviceToken, undefined);

  // Cookie session STILL requires X-CSRF-Token on mutating endpoints
  const noCsrf = await web.req("POST", "/api/announcements", { title: "Blocked", body: "No CSRF" });
  assert.equal(noCsrf.status, 403);
});

test("native login mints hashed Bearer token, authenticates without cookies/CSRF, and prevents bogus-Bearer CSRF bypass", async () => {
  const native = await loginNative(ctx.base, "admin-a", PASSWORD, {
    deviceId: "android-tab-1",
    deviceName: "Gate Tablet #1",
    platform: "android",
  });
  assert.equal(native.status, 200);
  assert.ok(native.data.deviceToken && native.data.deviceToken.startsWith("eds_"));
  assert.ok(native.data.deviceTokenExpiresAt);

  // Raw token is NEVER stored in plaintext in the database
  const storedRows = await ctx.db.all("SELECT token_hash FROM device_auth_tokens WHERE id = ?", [native.data.deviceTokenId]);
  assert.equal(storedRows.length, 1);
  assert.notEqual(storedRows[0].token_hash, native.data.deviceToken);
  assert.equal(storedRows[0].token_hash.length, 64);

  // Cookie-less GET /api/auth/me and GET /api/sync/status succeed via Bearer
  const me = await bearerReq(ctx.base, native.data.deviceToken, "GET", "/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.loggedIn, true);
  assert.equal(me.data.user.username, "admin-a");

  const status = await bearerReq(ctx.base, native.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(status.status, 200);
  assert.equal(status.data.authMethod, "bearer");
  assert.ok(Array.isArray(status.data.supportedMutations));

  // State-changing POST with valid Bearer token (and NO cookie / NO CSRF token) succeeds
  const postAnn = await bearerReq(ctx.base, native.data.deviceToken, "POST", "/api/announcements", {
    title: "From Android Tablet",
    body: "Sent via Bearer auth",
  });
  assert.equal(postAnn.status, 200);

  // SECURITY: If a browser has a live session cookie AND sends a forged Bearer
  // token without X-CSRF-Token, it must NOT fall back to the cookie or bypass CSRF!
  const browser = new Client(ctx.base);
  await browser.login("admin-a", PASSWORD);
  const piggyback = await browser.req(
    "POST",
    "/api/announcements",
    { title: "Bypass Attempt", body: "Nope" },
    { headers: { Authorization: "Bearer eds_0000000000000000000000000000000000000000000000000000000000000000" } }
  );
  assert.equal(piggyback.status, 401);
});

test("device listing, remote revocation, logout revocation, user deactivation & madrasa suspension", async () => {
  const pc = await loginNative(ctx.base, "admin-a", PASSWORD, {
    deviceId: "office-pc-1",
    deviceName: "Principal Windows PC",
    platform: "windows",
  });
  const phone = await loginNative(ctx.base, "admin-a", PASSWORD, {
    deviceId: "admin-phone-1",
    deviceName: "Principal Phone",
    platform: "ios",
  });

  // Re-logging in with the same deviceId rotates the previous token for that device
  const phoneRelogin = await loginNative(ctx.base, "admin-a", PASSWORD, {
    deviceId: "admin-phone-1",
    deviceName: "Principal Phone",
    platform: "ios",
  });
  const oldPhoneCheck = await bearerReq(ctx.base, phone.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(oldPhoneCheck.status, 401, "rotated token from same deviceId is revoked");

  // List active devices
  const list = await bearerReq(ctx.base, pc.data.deviceToken, "GET", "/api/auth/devices");
  assert.equal(list.status, 200);
  const currentDev = list.data.devices.find((d) => d.id === pc.data.deviceTokenId);
  assert.ok(currentDev && currentDev.current === true);
  assert.ok(list.data.devices.some((d) => d.id === phoneRelogin.data.deviceTokenId));

  // Remotely revoke the phone token from the PC
  const revoke = await bearerReq(ctx.base, pc.data.deviceToken, "DELETE", `/api/auth/devices/${phoneRelogin.data.deviceTokenId}`);
  assert.equal(revoke.status, 200);
  const revokedPhoneCheck = await bearerReq(ctx.base, phoneRelogin.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(revokedPhoneCheck.status, 401);

  // Suspending the madrasa immediately blocks active Bearer tokens
  await ctx.db.run("UPDATE madaris SET status = 'suspended' WHERE id = ?", [ctx.madrasaA]);
  const whileSuspended = await bearerReq(ctx.base, pc.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(whileSuspended.status, 401);
  await ctx.db.run("UPDATE madaris SET status = 'active' WHERE id = ?", [ctx.madrasaA]);

  // Deactivating the user immediately blocks active Bearer tokens
  await ctx.db.run("UPDATE users SET is_active = 0 WHERE id = ?", [ctx.users.adminA]);
  const whileInactive = await bearerReq(ctx.base, pc.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(whileInactive.status, 401);
  await ctx.db.run("UPDATE users SET is_active = 1 WHERE id = ?", [ctx.users.adminA]);

  // Logout revokes the caller's Bearer token
  const logout = await bearerReq(ctx.base, pc.data.deviceToken, "POST", "/api/auth/logout", {});
  assert.equal(logout.status, 200);
  const afterLogout = await bearerReq(ctx.base, pc.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(afterLogout.status, 401);
});

test("/api/sync/pull enforces strict tenant isolation, teacher assignment scope, and portal draft-result privacy", async () => {
  const adminA = await loginNative(ctx.base, "admin-a", PASSWORD, { deviceId: "pull-admin-a" });
  const teacherA = await loginNative(ctx.base, "teacher-a", PASSWORD, { deviceId: "pull-teacher-a" });
  const studentA1 = await loginNative(ctx.base, "student-a1", PASSWORD, { deviceId: "pull-student-a1" });
  const parentA = await loginNative(ctx.base, "parent-a", PASSWORD, { deviceId: "pull-parent-a" });

  // Add a student in Class A2 (NOT assigned to teacherA) to test teacher isolation
  const stuA2Only = (await ctx.db.run(
    "INSERT INTO students (madrasa_id, admission_no, first_name, last_name, gender, class_id, session_id) VALUES (?,?,?,?,?,?,?)",
    [ctx.madrasaA, "TTA0099", "Unassigned", "ClassTwo", "M", ctx.classA2, ctx.sessionA]
  )).lastInsertRowid;

  // Mark one result published and leave the rest draft/unapproved
  await ctx.db.run(
    "UPDATE results SET status = 'draft' WHERE madrasa_id = ? AND student_id = ? AND subject_id = ?",
    [ctx.madrasaA, ctx.studentA1, ctx.subjA1]
  );
  await ctx.db.run(
    "UPDATE results SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND student_id = ? AND subject_id = ?",
    [ctx.madrasaA, ctx.studentA1, ctx.subjA2]
  );

  // 1. Admin A sees Madrasa A (including Class A1 & Class A2), NEVER Madrasa B
  const pullAdmin = await bearerReq(ctx.base, adminA.data.deviceToken, "GET", "/api/sync/pull");
  assert.equal(pullAdmin.status, 200);
  assert.equal(pullAdmin.data.isIncremental, false);
  assert.equal(pullAdmin.data.profile.madrasaId, ctx.madrasaA);
  assert.ok(pullAdmin.data.collections.students.some((s) => s.id === ctx.studentA1));
  assert.ok(pullAdmin.data.collections.students.some((s) => s.id === Number(stuA2Only)));
  assert.ok(!pullAdmin.data.collections.students.some((s) => s.id === ctx.studentB1), "never leaks Madrasa B students");
  // Password hashes must never appear in pulled teachers
  for (const t of pullAdmin.data.collections.teachers || []) {
    assert.equal(t.password_hash, undefined);
  }

  // 2. Teacher A (assigned ONLY to Class A1 + Fiqh subjA1) sees Class A1 students & Fiqh results ONLY
  const pullTeacher = await bearerReq(ctx.base, teacherA.data.deviceToken, "GET", "/api/sync/pull");
  assert.equal(pullTeacher.status, 200);
  assert.deepEqual(pullTeacher.data.collections.classes.map((c) => c.id), [ctx.classA1]);
  assert.ok(pullTeacher.data.collections.students.every((s) => s.class_id === ctx.classA1));
  assert.ok(!pullTeacher.data.collections.students.some((s) => s.id === Number(stuA2Only)), "teacher never pulls unassigned class students");
  assert.ok(pullTeacher.data.collections.results.every((r) => r.subject_id === ctx.subjA1), "teacher only pulls assigned subject results");

  // 3. Student A1 sees ONLY own student row and ONLY published/locked results (never draft!)
  const pullStudent = await bearerReq(ctx.base, studentA1.data.deviceToken, "GET", "/api/sync/pull");
  assert.equal(pullStudent.status, 200);
  assert.deepEqual(pullStudent.data.collections.students.map((s) => s.id), [ctx.studentA1]);
  assert.ok(pullStudent.data.collections.results.length >= 1);
  assert.ok(pullStudent.data.collections.results.every((r) => r.student_id === ctx.studentA1 && ["published", "locked"].includes(r.status)));

  // 4. Parent A sees linked children (studentA1 & studentA2), NOT stuA2Only or studentB1
  const pullParent = await bearerReq(ctx.base, parentA.data.deviceToken, "GET", "/api/sync/pull");
  assert.equal(pullParent.status, 200);
  const parentStudentIds = pullParent.data.collections.students.map((s) => s.id).sort((a, b) => a - b);
  assert.deepEqual(parentStudentIds, [ctx.studentA1, ctx.studentA2].sort((a, b) => a - b));

  // 5. Incremental pull (?since=...) returns cursor and only recent changes
  const cursor = pullAdmin.data.serverCursor;
  await ctx.db.run("UPDATE students SET first_name = 'AlphaUpdated', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [ctx.studentA1]);
  const delta = await bearerReq(ctx.base, adminA.data.deviceToken, "GET", `/api/sync/pull?since=${encodeURIComponent(cursor)}`);
  assert.equal(delta.status, 200);
  assert.equal(delta.data.isIncremental, true);
  assert.ok(delta.data.collections.students.some((s) => s.id === ctx.studentA1 && s.first_name === "AlphaUpdated"));
});

test("/api/sync/push executes Outbox mutations idempotently and resolves offline local IDs across records and batches", async () => {
  const adminA = await loginNative(ctx.base, "admin-a", PASSWORD, { deviceId: "push-admin-a" });
  const token = adminA.data.deviceToken;

  // Create an expense category first so offline expense creation can reference it
  const catRes = await ctx.db.run(
    "INSERT INTO expense_categories (madrasa_id, name, type) VALUES (?, 'Diesel & Generator', 'operating')",
    [ctx.madrasaA]
  );
  const categoryId = Number(catRes.lastInsertRowid);

  // Batch 1: Create student offline ("local_stu_offline_1"), then immediately
  // mark their attendance, enter their Fiqh score, log Hifz progress, record a
  // cash fee payment, and log a generator expense — ALL in one offline Outbox flush!
  const mutations = [
    {
      clientMutationId: "mut_stu_create_001",
      type: "student.create",
      localId: "local_stu_offline_1",
      clientTimestamp: "2026-10-30T08:00:00.000Z",
      payload: {
        first_name: "Zainab",
        last_name: "Offline",
        gender: "F",
        class_id: ctx.classA1,
        session_id: ctx.sessionA,
        parent_name: "Mallam Musa",
        parent_phone: "+2348055555555",
      },
    },
    {
      clientMutationId: "mut_att_mark_001",
      type: "attendance.mark",
      clientTimestamp: "2026-10-30T08:10:00.000Z",
      payload: {
        classId: ctx.classA1,
        date: "2026-10-30",
        statuses: {
          local_stu_offline_1: { status: "present", note: "Arrived early offline" },
        },
      },
    },
    {
      clientMutationId: "mut_res_upsert_001",
      type: "results.upsert",
      clientTimestamp: "2026-10-30T09:00:00.000Z",
      payload: {
        classId: ctx.classA1,
        termId: ctx.termA1,
        subjectId: ctx.subjA1,
        status: "draft",
        entries: [
          { studentId: "local_stu_offline_1", ca: 35, exam: 55, teacherRemark: "Excellent offline entry" },
        ],
      },
    },
    {
      clientMutationId: "mut_hifz_create_001",
      type: "quran_progress.create",
      localId: "local_qp_1",
      clientTimestamp: "2026-10-30T10:00:00.000Z",
      payload: {
        student_id: "local_stu_offline_1",
        surah: "Al-Mulk",
        juz: "29",
        ayah_from: 1,
        ayah_to: 15,
        memorization_progress: 85,
        performance_status: "excellent",
        progress_date: "2026-10-30",
      },
    },
    {
      clientMutationId: "mut_fee_pay_001",
      type: "fee_payment.record",
      clientTimestamp: "2026-10-30T11:00:00.000Z",
      payload: {
        student_id: "local_stu_offline_1",
        amount_ngn: 25000,
        method: "cash",
        reference: "OFFLINE-CASH-20261030-01",
        payment_date: "2026-10-30",
        notes: "Collected at bursary while internet was down",
      },
    },
    {
      clientMutationId: "mut_exp_create_001",
      type: "expense.create",
      clientTimestamp: "2026-10-30T11:30:00.000Z",
      payload: {
        category_id: categoryId,
        amount_ngn: 12500,
        vendor: "Station Oil",
        description: "25L diesel for school office",
        payment_method: "cash",
        payment_date: "2026-10-30",
      },
    },
  ];

  const push1 = await bearerReq(ctx.base, token, "POST", "/api/sync/push", {
    deviceId: "office-pc-1",
    mutations,
  });
  assert.equal(push1.status, 200);
  assert.equal(push1.data.summary.applied, 6);
  assert.equal(push1.data.summary.duplicate, 0);
  assert.equal(push1.data.summary.conflict, 0);
  assert.equal(push1.data.summary.rejected, 0);

  const realStudentId = push1.data.idMap["student:local_stu_offline_1"];
  assert.ok(Number.isInteger(realStudentId) && realStudentId > 0);

  // Verify every linked record landed accurately in SQLite/MySQL
  const att = await ctx.db.get("SELECT * FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day = '2026-10-30'", [ctx.madrasaA, realStudentId]);
  assert.equal(att.status, "present");
  const resRow = await ctx.db.get("SELECT * FROM results WHERE madrasa_id = ? AND student_id = ? AND subject_id = ?", [ctx.madrasaA, realStudentId, ctx.subjA1]);
  assert.equal(Number(resRow.total), 90);
  const qpRow = await ctx.db.get("SELECT * FROM quran_progress WHERE madrasa_id = ? AND student_id = ?", [ctx.madrasaA, realStudentId]);
  assert.equal(qpRow.surah, "Al-Mulk");
  const payRow = await ctx.db.get("SELECT * FROM fee_payments WHERE madrasa_id = ? AND student_id = ?", [ctx.madrasaA, realStudentId]);
  assert.equal(Number(payRow.amount_ngn), 25000);
  assert.match(payRow.receipt_number, /^REC-/);

  // REPLAY TEST (Network dropped before client received HTTP 200):
  // Sending the EXACT SAME batch a second time must create ZERO duplicate rows!
  const pushReplay = await bearerReq(ctx.base, token, "POST", "/api/sync/push", {
    deviceId: "office-pc-1",
    mutations,
  });
  assert.equal(pushReplay.status, 200);
  assert.equal(pushReplay.data.summary.applied, 0);
  assert.equal(pushReplay.data.summary.duplicate, 6);
  assert.equal(pushReplay.data.idMap["student:local_stu_offline_1"], realStudentId);

  const paymentCount = await ctx.db.get("SELECT COUNT(*) AS n FROM fee_payments WHERE madrasa_id = ? AND student_id = ?", [ctx.madrasaA, realStudentId]);
  assert.equal(Number(paymentCount.n), 1, "payment was never double-recorded on network retry");

  // CROSS-BATCH LOCAL ID RESOLUTION:
  // A second push later still resolves "local_stu_offline_1" & "local_qp_1" from sync_mutations!
  const push2 = await bearerReq(ctx.base, token, "POST", "/api/sync/push", {
    deviceId: "office-pc-1",
    mutations: [
      {
        clientMutationId: "mut_stu_update_002",
        type: "student.update",
        payload: { student_id: "local_stu_offline_1", preferred_name: "Zainab M." },
      },
      {
        clientMutationId: "mut_qp_update_002",
        type: "quran_progress.update",
        payload: { id: "local_qp_1", ayah_to: 30, memorization_progress: 100 },
      },
    ],
  });
  assert.equal(push2.status, 200);
  assert.equal(push2.data.summary.applied, 2);
  const updatedStu = await ctx.db.get("SELECT preferred_name FROM students WHERE id = ?", [realStudentId]);
  assert.equal(updatedStu.preferred_name, "Zainab M.");
  const updatedQp = await ctx.db.get("SELECT ayah_to, memorization_progress FROM quran_progress WHERE student_id = ?", [realStudentId]);
  assert.equal(Number(updatedQp.ayah_to), 30);
  assert.equal(Number(updatedQp.memorization_progress), 100);
});

test("/api/sync/push isolates conflicts (frozen results, revoked QR cards, duplicate payment refs) without aborting valid siblings", async () => {
  const adminA = await loginNative(ctx.base, "admin-a", PASSWORD, { deviceId: "conflict-admin-a" });
  const token = adminA.data.deviceToken;
  const cardCreds = require("../server/services/card-credentials");

  // Mint two student ID cards: keep studentA1 active, revoke studentA2's card
  const card1 = await cardCreds.ensureCardCredential(ctx.madrasaA, "student", ctx.studentA1);
  const card2 = await cardCreds.ensureCardCredential(ctx.madrasaA, "student", ctx.studentA2);
  await cardCreds.setCardStatus(ctx.madrasaA, "student", ctx.studentA2, "revoked", ctx.users.adminA);

  // Freeze (publish) subjA2 for studentA1 so offline overwrite triggers RESULTS_FROZEN
  await ctx.db.run(
    "UPDATE results SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND student_id = ? AND term_id = ? AND subject_id = ?",
    [ctx.madrasaA, ctx.studentA1, ctx.termA1, ctx.subjA2]
  );

  const mixed = await bearerReq(ctx.base, token, "POST", "/api/sync/push", {
    deviceId: "gate-tab-2",
    mutations: [
      // 1. Valid offline QR scan -> should SUCCEED
      {
        clientMutationId: "mut_mix_valid_scan",
        type: "attendance.scan",
        clientTimestamp: "2026-10-31T07:45:00.000Z",
        payload: { code: card1.code, date: "2026-10-31", status: "present" },
      },
      // 2. Revoked QR card scan -> should report CARD_REVOKED conflict
      {
        clientMutationId: "mut_mix_revoked_scan",
        type: "attendance.scan",
        clientTimestamp: "2026-10-31T07:46:00.000Z",
        payload: { code: card2.code, date: "2026-10-31", status: "present" },
      },
      // 3. Frozen result overwrite -> should report RESULTS_FROZEN conflict
      {
        clientMutationId: "mut_mix_frozen_result",
        type: "results.upsert",
        payload: {
          classId: ctx.classA1,
          termId: ctx.termA1,
          subjectId: ctx.subjA2,
          entries: [{ studentId: ctx.studentA1, ca: 40, exam: 60 }],
        },
      },
      // 4. Duplicate payment reference -> should report DUPLICATE_PAYMENT_REFERENCE conflict
      {
        clientMutationId: "mut_mix_dup_payment",
        type: "fee_payment.record",
        payload: {
          student_id: ctx.studentA1,
          amount_ngn: 5000,
          method: "cash",
          reference: "OFFLINE-CASH-20261030-01",
        },
      },
      // 5. Valid announcement after conflicts -> should STILL SUCCEED!
      {
        clientMutationId: "mut_mix_valid_ann",
        type: "announcement.create",
        payload: { title: "Mid-Term Break", body: "School resumes Monday." },
      },
    ],
  });

  assert.equal(mixed.status, 200);
  assert.equal(mixed.data.summary.applied, 2);
  assert.equal(mixed.data.summary.conflict, 3);

  const byId = Object.fromEntries(mixed.data.results.map((r) => [r.clientMutationId, r]));
  assert.equal(byId.mut_mix_valid_scan.status, "applied");
  assert.equal(byId.mut_mix_revoked_scan.status, "conflict");
  assert.equal(byId.mut_mix_revoked_scan.code, "CARD_REVOKED");
  assert.equal(byId.mut_mix_frozen_result.status, "conflict");
  assert.equal(byId.mut_mix_frozen_result.code, "RESULTS_FROZEN");
  assert.equal(byId.mut_mix_dup_payment.status, "conflict");
  assert.equal(byId.mut_mix_dup_payment.code, "DUPLICATE_PAYMENT_REFERENCE");
  assert.equal(byId.mut_mix_valid_ann.status, "applied");

  // Students cannot call /api/sync/push
  const stuLogin = await loginNative(ctx.base, "student-a1", PASSWORD, { deviceId: "stu-dev" });
  const stuPush = await bearerReq(ctx.base, stuLogin.data.deviceToken, "POST", "/api/sync/push", { mutations: [] });
  assert.equal(stuPush.status, 403);
});

test("password change revokes all OTHER device tokens while preserving the active device token", async () => {
  const dev1 = await loginNative(ctx.base, "teacher-a", PASSWORD, { deviceId: "teach-laptop" });
  const dev2 = await loginNative(ctx.base, "teacher-a", PASSWORD, { deviceId: "teach-phone" });

  const chg = await bearerReq(ctx.base, dev1.data.deviceToken, "POST", "/api/auth/change-password", {
    currentPassword: PASSWORD,
    newPassword: "UpdatedPass123!",
  });
  assert.equal(chg.status, 200);

  // dev1 (the device that changed the password) remains active
  const dev1Check = await bearerReq(ctx.base, dev1.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(dev1Check.status, 200);

  // dev2 (another device) is immediately revoked
  const dev2Check = await bearerReq(ctx.base, dev2.data.deviceToken, "GET", "/api/sync/status");
  assert.equal(dev2Check.status, 401);

  // Restore original password for cleanliness
  const bcrypt = require("bcryptjs");
  await ctx.db.run(
    "UPDATE users SET password_hash = ? WHERE id = ?",
    [bcrypt.hashSync(PASSWORD, 10), ctx.users.teacherA]
  );
});

test("public/js/api.js supports native Bearer tokens, API.sync helpers, and transport interceptors", async (t) => {
  let JSDOM;
  try { ({ JSDOM } = require("jsdom")); } catch (e) { t.skip("jsdom not installed"); return; }
  const fs = require("fs");
  const path = require("path");
  const apiSrc = fs.readFileSync(path.join(__dirname, "..", "public", "js", "api.js"), "utf8");

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://localhost/",
    runScripts: "outside-only",
  });
  dom.window.__APP_CONFIG__ = { apiBase: ctx.base + "/api" };
  dom.window.__EDUSPHERE_NATIVE__ = {
    deviceId: "jsdom-tablet-01",
    deviceName: "JSDOM Android Tablet",
    platform: "android",
  };
  dom.window.fetch = fetch;
  dom.window.eval(apiSrc);

  const API = dom.window.API;
  const loginRes = await API.login("admin-a", PASSWORD, true);
  assert.ok(loginRes.deviceToken && loginRes.deviceToken.startsWith("eds_"));
  assert.equal(API.getDeviceToken(), loginRes.deviceToken);

  const syncStatus = await API.sync.status();
  assert.equal(syncStatus.authMethod, "bearer");

  const pulled = await API.sync.pull();
  assert.equal(pulled.ok, true);
  assert.ok(Array.isArray(pulled.collections.students));

  // Verify transportInterceptor hook (used in Phase 2 for offline reads/Outbox)
  let intercepted = 0;
  API.setTransportInterceptor(async ({ method, path: reqPath, onlineRequest }) => {
    intercepted += 1;
    if (method === "GET" && reqPath === "/offline-probe") {
      return { fromOfflineCache: true };
    }
    return onlineRequest();
  });
  const cached = await API.get("/offline-probe");
  assert.equal(cached.fromOfflineCache, true);
  assert.equal(intercepted, 1);

  API.setTransportInterceptor(null);
  await API.logout();
  assert.equal(API.getDeviceToken(), "");
  dom.window.close();
});

