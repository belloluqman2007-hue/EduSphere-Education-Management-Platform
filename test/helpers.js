"use strict";
/* ============================================================================
   Test helpers — isolated temp database + HTTP client.
   Each test file:  const { initEnv, setup } = require("./helpers");
                    initEnv();  // MUST run before any server module is required
                    const ctx = await setup();
   ========================================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");
// Pure data module (no db import), safe to require before initEnv().
const { FEATURE_KEYS: ALL_FEATURE_KEYS } = require("../server/services/plan-catalogue");

let tmpDir = null;

/* ---------------------------------------------------------------------------
   MySQL test mode (opt-in, never the default)
   ---------------------------------------------------------------------------
   The suite runs on SQLite exactly as before unless TEST_DB_DRIVER=mysql is
   exported. When it IS exported, every test file gets its OWN throwaway MySQL
   schema (mmtest_<pid>_<n>) on the server described by the TEST_MYSQL_* /
   DB_* environment variables — no credentials live in this file. The schema is
   created before migrations run and dropped in ctx.close(), so the isolation
   guarantee of the SQLite path (one empty database per file) is preserved.
   -------------------------------------------------------------------------- */
const USE_MYSQL = String(process.env.TEST_DB_DRIVER || "").trim().toLowerCase() === "mysql";
let mysqlSchema = null;
let schemaCounter = 0;

function mysqlAdminConfig() {
  return {
    host: process.env.TEST_MYSQL_HOST || process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.TEST_MYSQL_PORT || process.env.DB_PORT || 3306),
    user: process.env.TEST_MYSQL_USER || process.env.DB_USER || "",
    password: process.env.TEST_MYSQL_PASSWORD || process.env.DB_PASSWORD || "",
    socketPath: process.env.TEST_MYSQL_SOCKET || undefined,
    multipleStatements: false,
  };
}

/** Sets env for a throwaway test database. Call before requiring server code. */
function initEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmtest-"));
  process.env.NODE_ENV = "test";
  if (USE_MYSQL) {
    // Unique schema per test FILE (each file runs in its own process).
    schemaCounter += 1;
    mysqlSchema = `mmtest_${process.pid}_${schemaCounter}`;
    process.env.DATABASE_DRIVER = "mysql";
    process.env.DATABASE_URL = "";
    const c = mysqlAdminConfig();
    process.env.DB_HOST = c.host;
    process.env.DB_PORT = String(c.port);
    process.env.DB_USER = c.user;
    process.env.DB_PASSWORD = c.password;
    process.env.DB_NAME = mysqlSchema;
    process.env.DB_SSL = "false";
  } else {
    process.env.DATABASE_DRIVER = "sqlite";
  }
  process.env.DATABASE_FILE = path.join(tmpDir, "test.sqlite");
  process.env.SESSION_SECRET = "test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz0123";
  process.env.SUPER_ADMIN_USERNAME = "testadmin";
  process.env.SUPER_ADMIN_PASSWORD = "TestAdmin123!";
  process.env.LOGIN_RATE_LIMIT = "20";
  // The password-reset endpoint has its own strict per-IP bucket in
  // production; tests exercise the whole flow many times from one address.
  process.env.PASSWORD_RESET_RATE_LIMIT = "200";
  process.env.API_RATE_LIMIT = "1000000";
  process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
  // Keep every scratch file (state marker, pre-migration snapshots, upload
  // imports) inside the throwaway directory — tests must never touch ./data.
  process.env.DATA_DIR = path.join(tmpDir, "data");
  process.env.BACKUP_DIR = path.join(tmpDir, "data", "backups");
  process.env.BACKUP_INTERVAL_MINUTES = "0";
  process.env.MAX_UPLOAD_MB = "2";
  // The public endpoints are deliberately throttled in production; tests hit
  // them dozens of times from one IP, so the buckets are opened up here.
  process.env.PUBLIC_RATE_LIMIT = "1000000";
  process.env.PUBLIC_APPLY_LIMIT = "1000000";
  process.env.PUBLIC_VERIFY_LIMIT = "1000000";
  return tmpDir;
}

/** Creates the empty per-file MySQL schema the app will migrate into. */
async function createMysqlSchema() {
  const mysql = require("mysql2/promise");
  const conn = await mysql.createConnection(mysqlAdminConfig());
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${mysqlSchema}\``);
    await conn.query(
      `CREATE DATABASE \`${mysqlSchema}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conn.end();
  }
}

/** Drops the per-file MySQL schema so no test data outlives the run. */
async function dropMysqlSchema() {
  if (!mysqlSchema) return;
  const mysql = require("mysql2/promise");
  try {
    const conn = await mysql.createConnection(mysqlAdminConfig());
    try { await conn.query(`DROP DATABASE IF EXISTS \`${mysqlSchema}\``); }
    finally { await conn.end(); }
  } catch (e) { /* server already gone: nothing to clean */ }
}

/**
 * Runs migrations, seeds plans + super admin + two madaris (A & B) with
 * users/classes/subjects/sessions, boots the app on an ephemeral port.
 * Returns { base, server, db, madrasaA, madrasaB, users }.
 */
async function setup() {
  const bcrypt = require("bcryptjs");
  if (USE_MYSQL) await createMysqlSchema();
  const db = require("../server/db");
  const { migrate } = require("../server/migrate");
  const { createApp } = require("../server/app");

  await migrate();

  // Plans. The fixture plan keeps its `free` code and its 50/3 limits (other
  // tests assert both), but EVERY feature key is switched on: a module test
  // exercises the module, not the tier matrix. Feature gating is covered on its
  // own in subscription-features.test.js, which downgrades a plan row and
  // asserts the 403. Without this, every payroll/library/export/health test on
  // this tenant would fail on the plan gate instead of on its own behaviour.
  const allFeatures = {};
  for (const key of ALL_FEATURE_KEYS) allFeatures[key] = true;
  await db.run("INSERT INTO plans (code,name,name_ar,price_ngn,student_limit,teacher_limit,features,sort_order) VALUES (?,?,?,?,?,?,?,?)",
    ["free", "Free", "مجاني", 0, 50, 3, JSON.stringify(allFeatures), 1]);

  // Super admin
  await db.run("INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (NULL,?,?, 'super_admin','Test Admin')",
    ["testadmin", bcrypt.hashSync("TestAdmin123!", 10)]);

  // Two madaris
  const madrasaA = (await db.run(
    "INSERT INTO madaris (slug,name_en,name_ar,motto_en,address,city,state_name,phone,email,plan_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["testa", "Test Madrasa A", "المدرسة الاختبارية أ", "Motto A", "1 Test St", "Ijebu-Ode", "Ogun", "+2348000000001", "a@test.example", 1]
  )).lastInsertRowid;
  const madrasaB = (await db.run(
    "INSERT INTO madaris (slug,name_en,name_ar,motto_en,address,city,state_name,phone,email,plan_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["testb", "Test Madrasa B", "المدرسة الاختبارية ب", "Motto B", "2 Test St", "Ijebu-Ode", "Ogun", "+2348000000002", "b@test.example", 1]
  )).lastInsertRowid;

  const users = {};
  async function mkUser(key, madrasaId, username, role, fullName = "User") {
    const hash = bcrypt.hashSync("Passw0rd!123", 10);
    users[key] = (await db.run(
      "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)",
      [madrasaId, username, hash, role, fullName]
    )).lastInsertRowid;
    return users[key];
  }
  await mkUser("adminA", madrasaA, "admin-a", "madrasa_admin", "Admin A");
  await mkUser("adminB", madrasaB, "admin-b", "madrasa_admin", "Admin B");
  await mkUser("teacherA", madrasaA, "teacher-a", "teacher", "Teacher A");

  // Academic session + terms (per madrasa)
  for (const mid of [madrasaA, madrasaB]) {
    const s = (await db.run("INSERT INTO academic_sessions (madrasa_id,label,start_date,end_date,is_current) VALUES (?,?, '2026-09-01','2027-08-31',1)", [mid, "2026/2027"])).lastInsertRowid;
    for (const [pos, en, ar] of [[1, "First Term", "الفترة الأولى"], [2, "Second Term", "الفترة الثانية"]]) {
      await db.run("INSERT INTO terms (madrasa_id,session_id,position,name_en,name_ar,start_date,end_date) VALUES (?,?,?,?,?,?,?)",
        [mid, s, pos, en, ar, "2026-09-01", "2026-12-19"]);
    }
  }
  const sessionA = (await db.get("SELECT id FROM academic_sessions WHERE madrasa_id = ?", [madrasaA])).id;
  const termA1 = (await db.get("SELECT id FROM terms WHERE madrasa_id = ? AND position = 1", [madrasaA])).id;

  // Classes + subjects (A has 2 classes, B has 1)
  const classA1 = (await db.run("INSERT INTO classes (madrasa_id,name_en,name_ar,sort_order) VALUES (?,?,?,1)", [madrasaA, "Class A1", "قسم أ1"])).lastInsertRowid;
  const classA2 = (await db.run("INSERT INTO classes (madrasa_id,name_en,name_ar,sort_order) VALUES (?,?,?,2)", [madrasaA, "Class A2", "قسم أ2"])).lastInsertRowid;
  const classB1 = (await db.run("INSERT INTO classes (madrasa_id,name_en,name_ar,sort_order) VALUES (?,?,?,1)", [madrasaB, "Class B1", "قسم ب1"])).lastInsertRowid;
  const subjA1 = (await db.run("INSERT INTO subjects (madrasa_id,name_en,name_ar) VALUES (?,?,?)", [madrasaA, "Fiqh", "الفقه"])).lastInsertRowid;
  const subjA2 = (await db.run("INSERT INTO subjects (madrasa_id,name_en,name_ar) VALUES (?,?,?)", [madrasaA, "English", "اللغة الإنجليزية"])).lastInsertRowid;
  const subjB1 = (await db.run("INSERT INTO subjects (madrasa_id,name_en,name_ar) VALUES (?,?,?)", [madrasaB, "Hadith", "الحديث"])).lastInsertRowid;
  await db.run("INSERT INTO class_subjects (madrasa_id,class_id,subject_id) VALUES (?,?,?)", [madrasaA, classA1, subjA1]);
  await db.run("INSERT INTO class_subjects (madrasa_id,class_id,subject_id) VALUES (?,?,?)", [madrasaA, classA1, subjA2]);
  await db.run("INSERT INTO class_subjects (madrasa_id,class_id,subject_id) VALUES (?,?,?)", [madrasaB, classB1, subjB1]);

  // Teacher A assignment: class A1 + subject Fiqh only
  await db.run("INSERT INTO teacher_assignments (madrasa_id,user_id,class_id,subject_id) VALUES (?,?,?,?)", [madrasaA, users.teacherA, classA1, subjA1]);

  // Students: 2 in A, 1 in B
  const studentA1 = (await db.run(
    "INSERT INTO students (madrasa_id,admission_no,first_name,last_name,name_ar,gender,date_of_birth,class_id,session_id,parent_name,parent_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [madrasaA, "TTA0001", "Alpha", "One", "ألف واحد", "M", "2012-01-01", classA1, sessionA, "Parent of Alpha", "+2348011111111"]
  )).lastInsertRowid;
  const studentA2 = (await db.run(
    "INSERT INTO students (madrasa_id,admission_no,first_name,last_name,name_ar,gender,date_of_birth,class_id,session_id,parent_name,parent_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [madrasaA, "TTA0002", "Bravo", "Two", "برافو اثنان", "F", "2012-02-02", classA1, sessionA, "Parent of Bravo", "+2348022222222"]
  )).lastInsertRowid;
  const studentB1 = (await db.run(
    "INSERT INTO students (madrasa_id,admission_no,first_name,last_name,name_ar,gender,date_of_birth,class_id,session_id,parent_name,parent_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [madrasaB, "TTB0001", "Charlie", "Three", "تشارلي ثلاثة", "M", "2013-03-03", classB1, (await db.get("SELECT id FROM academic_sessions WHERE madrasa_id = ?", [madrasaB])).id, "Parent of Charlie", "+2348033333333"]
  )).lastInsertRowid;

  // Student portal account for studentA1 + parent account linked to studentA1 & A2
  const studentUserA = (await db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, student_id) VALUES (?,?,?,?,?,?)",
    [madrasaA, "student-a1", bcrypt.hashSync("Passw0rd!123", 10), "student", "Alpha One", studentA1]
  )).lastInsertRowid;
  const parentUserA = (await db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)",
    [madrasaA, "parent-a", bcrypt.hashSync("Passw0rd!123", 10), "parent", "Guardian A"]
  )).lastInsertRowid;
  await db.run("INSERT INTO parent_links (madrasa_id,user_id,student_id) VALUES (?,?,?)", [madrasaA, parentUserA, studentA1]);
  await db.run("INSERT INTO parent_links (madrasa_id,user_id,student_id) VALUES (?,?,?)", [madrasaA, parentUserA, studentA2]);
  // A second parent linked to studentB1 only (in madrasa B)
  const parentUserB = (await db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)",
    [madrasaB, "parent-b", bcrypt.hashSync("Passw0rd!123", 10), "parent", "Guardian B"]
  )).lastInsertRowid;
  await db.run("INSERT INTO parent_links (madrasa_id,user_id,student_id) VALUES (?,?,?)", [madrasaB, parentUserB, studentB1]);

  // Result rows for A1 term: both students, 2 subjects
  for (const [sid, ca, ex] of [[studentA1, 30, 50], [studentA2, 20, 40]]) {
    await db.run("INSERT INTO results (madrasa_id,student_id,class_id,session_id,term_id,subject_id,ca,exam,total) VALUES (?,?,?,?,?,?,?,?,?)",
      [madrasaA, sid, classA1, sessionA, termA1, subjA1, ca, ex, ca + ex]);
    await db.run("INSERT INTO results (madrasa_id,student_id,class_id,session_id,term_id,subject_id,ca,exam,total) VALUES (?,?,?,?,?,?,?,?,?)",
      [madrasaA, sid, classA1, sessionA, termA1, subjA2, ca + 5, ex + 10, ca + ex + 15]);
  }
  // Attendance for A1 term
  await db.run("INSERT INTO attendance (madrasa_id,student_id,class_id,term_id,day,status) VALUES (?,?,?,?,?,?)", [madrasaA, studentA1, classA1, termA1, "2026-09-08", "present"]);
  await db.run("INSERT INTO attendance (madrasa_id,student_id,class_id,term_id,day,status) VALUES (?,?,?,?,?,?)", [madrasaA, studentA2, classA1, termA1, "2026-09-08", "present"]);

  // Announcements
  await db.run("INSERT INTO announcements (madrasa_id,title,body,audience,is_active,created_by) VALUES (?,?,?,?,1,?)", [madrasaA, "Ann A", "Body A", "all", users.adminA]);
  await db.run("INSERT INTO announcements (madrasa_id,title,body,audience,is_active,created_by) VALUES (?,?,?,?,1,?)", [madrasaB, "Ann B", "Body B", "all", users.adminB]);

  // Boot app
  const app = createApp();
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;

  return {
    base,
    server: srv,
    db,
    madrasaA,
    madrasaB,
    sessionA,
    termA1,
    classA1,
    classA2,
    classB1,
    subjA1,
    subjA2,
    subjB1,
    studentA1,
    studentA2,
    studentB1,
    users,
    async close() {
      srv.close();
      await db.close();
      if (USE_MYSQL) await dropMysqlSchema();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** Minimal cookie-aware HTTP client. */
class Client {
  constructor(base) { this.base = base; this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(res) {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(";")[0];
      const idx = pair.indexOf("=");
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (v === "" || /expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k];
      else this.cookies[k] = v;
    }
  }
  async req(method, path, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (Object.keys(this.cookies).length) headers["Cookie"] = this.cookieHeader();
    if (body && !opts.raw) headers["Content-Type"] = "application/json";
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body && !opts.raw ? JSON.stringify(body) : (opts.rawBody || undefined),
      redirect: "manual",
    });
    this.absorb(res);
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) data = await res.json().catch(() => null);
    return { status: res.status, data, res };
  }
  async csrf() {
    const r = await this.req("GET", "/api/csrf-token");
    return r.data.csrfToken;
  }
  async api(method, path, body) {
    const token = await this.csrf();
    return this.req(method, path, body, { headers: { "X-CSRF-Token": token } });
  }
  async login(username, password) {
    return this.req("POST", "/api/auth/login", { username, password });
  }
}

module.exports = { initEnv, setup, Client, USE_MYSQL, PASSWORD: "Passw0rd!123", SA_PASSWORD: "TestAdmin123!" };
