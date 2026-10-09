"use strict";
/* ============================================================================
   PORTRAITS, SIGNATURES AND VERIFIABLE CARDS — API regression
   ----------------------------------------------------------------------------
   Two promises the platform makes to a school:
     1. Anyone can fix their own picture and signature — no administrator has to
        act as a file clerk, and no role is left out.
     2. A card that leaves the printer stays checkable. The code under its QR is
        a permanent identifier of THIS card, so it must survive printing, expiry
        of any token, and re-issuing — and must stop working the moment the card
        is reported lost.
   The second promise is the security-sensitive one: the public answer may only
   repeat what is already printed on the card, and never a phone number, an
   address, a fee balance or a medical note.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

/** A real PNG, written by hand: a 1x1 stub would trip the "too small" guard. */
function pngDataUrl(width, height) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0)]);
  for (let x = 0; x < width; x++) { row[1 + x * 4] = 40; row[2 + x * 4] = 90; row[3 + x * 4] = 140; row[4 + x * 4] = 255; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const makeChunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, body])), 0);
    return Buffer.concat([len, type, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk(Buffer.from("IHDR"), ihdr),
    makeChunk(Buffer.from("IDAT"), zlib.deflateSync(raw, { level: 6 })),
    makeChunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

let ctx;
let admin;
let teacher;
let student;

test.before(async () => {
  ctx = await setup();
  admin = new Client(ctx.base);
  assert.equal((await admin.login("admin-a", PASSWORD)).status, 200);
  teacher = new Client(ctx.base);
  assert.equal((await teacher.login("teacher-a", PASSWORD)).status, 200);
  // The seeded pupil account ("student-a1" is linked to studentA1 by setup()).
  student = new Client(ctx.base);
  assert.equal((await student.login("student-a1", PASSWORD)).status, 200, "the student account can sign in");
});
test.after(async () => { if (ctx) await ctx.close(); });

test("an account can set and clear its own portrait", async () => {
  const saved = await teacher.api("POST", "/api/auth/account/photo", { photoDataUrl: pngDataUrl(240, 240) });
  assert.equal(saved.status, 200);
  assert.match(saved.data.photoPath, /^\/uploads\/.*\.png$/);

  const me = await teacher.req("GET", "/api/auth/me");
  assert.equal(me.data.user.photoPath, saved.data.photoPath, "the session reports the new picture");

  const account = await teacher.api("GET", "/api/auth/account");
  assert.equal(account.data.account.photoPath, saved.data.photoPath, "the account view agrees");

  const cleared = await teacher.api("DELETE", "/api/auth/account/photo");
  assert.equal(cleared.status, 200);
  const after = await teacher.api("GET", "/api/auth/account");
  assert.equal(after.data.account.photoPath, "", "removing it really removes it");
});

test("a portrait is mirrored onto the linked record so every surface agrees", async () => {
  const uploaded = await admin.api("POST", `/api/students/${ctx.studentA1}/photo`, { photoDataUrl: pngDataUrl(240, 240) });
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.data.photoPath, /^\/uploads\//);

  const row = await ctx.db.get("SELECT photo_path FROM students WHERE id = ?", [ctx.studentA1]);
  assert.match(row.photo_path, /^\/uploads\//, "stored on the student record");
  // The login is linked the other way round (users.student_id), and it is the
  // account the portal header reads — so it has to agree immediately.
  const accountRow = await ctx.db.get("SELECT photo_path FROM users WHERE student_id = ? AND role = 'student'", [ctx.studentA1]);
  assert.ok(accountRow, "the student has a login account");
  assert.equal(accountRow.photo_path, row.photo_path, "and the account carries the same picture");

  // The card is the document people actually hold, so it must show it.
  const card = await admin.req("GET", `/api/documents/id-card/${ctx.studentA1}`);
  const html = await card.res.text();
  assert.match(html, new RegExp(escapeRegExp(uploaded.data.photoPath)), "the ID card prints the portrait");

  await admin.api("DELETE", `/api/students/${ctx.studentA1}/photo`);
  const blanked = await ctx.db.get("SELECT photo_path FROM students WHERE id = ?", [ctx.studentA1]);
  assert.equal(blanked.photo_path, "", "deleting a portrait clears it from both records");
});

test("a signature is stored for the account that will sign documents", async () => {
  const saved = await teacher.api("PUT", "/api/auth/account/signature", { signatureDataUrl: pngDataUrl(220, 70) });
  assert.equal(saved.status, 200);
  assert.match(saved.data.signaturePath, /^\/uploads\/.*\.png$/);

  const list = await admin.api("GET", "/api/teachers");
  const me = (list.data.teachers || []).find((row) => row.username === "teacher-a");
  assert.ok(me, "the teacher appears in the staff directory");
  assert.ok(me.hasSignature, "the directory knows a signature exists");
  assert.match(me.signature_path, /^\/uploads\//, "and can reach the image");
});

test("a pupil can put their own picture on their profile", async () => {
  // The complaint this answers: "profile pictures cannot be changed". A student
  // has no admin screen, so the self endpoint is the only way in — and the change
  // must reach the student record, because that is the row the ID card prints.
  const before = await student.req("GET", "/api/auth/me");
  assert.equal(before.status, 200);

  const saved = await student.api("POST", "/api/auth/account/photo", { photoDataUrl: pngDataUrl(200, 200) });
  assert.equal(saved.status, 200);
  assert.match(saved.data.photoPath, /^\/uploads\//);

  const onRecord = await ctx.db.get("SELECT photo_path FROM students WHERE id = ?", [ctx.studentA1]);
  assert.equal(onRecord.photo_path, saved.data.photoPath, "mirrored onto the student record");

  const card = await admin.req("GET", `/api/documents/id-card/${ctx.studentA1}`);
  assert.match(await card.res.text(), new RegExp(escapeRegExp(saved.data.photoPath)), "and on the card the school prints");

  await student.api("DELETE", "/api/auth/account/photo");
});

test("an image is required: HTML disguised as a portrait is refused", async () => {
  const hostile = await teacher.api("POST", "/api/auth/account/photo", {
    photoDataUrl: "data:image/svg+xml;base64," + Buffer.from("<script>alert(1)</script>").toString("base64"),
  });
  assert.equal(hostile.status, 400, "a script-carrying SVG is not accepted as a portrait");
  const empty = await teacher.api("POST", "/api/auth/account/photo", { photoDataUrl: "" });
  assert.ok(empty.status >= 400, "an empty upload is a client error, not a crash");
});

test("a printed card carries a code that keeps verifying, and can be switched off", async () => {
  const card = await admin.req("GET", `/api/documents/id-card/${ctx.studentA1}`);
  const html = await card.res.text();
  const code = (/\/verify\/([0-9a-f]{24})/.exec(html) || [])[1];
  assert.ok(code, "the card embeds a verification code");
  assert.doesNotMatch(html, /student-profile\//, "and not the old 15-minute signed link");

  const page = await admin.req("GET", `/verify/${code}`);
  assert.equal(page.status, 200);
  const pageHtml = await page.res.text();
  assert.match(pageHtml, /noindex/, "a stranger's lookup page is not searchable");
  assert.equal(page.res.headers.get("cache-control"), "no-store", "nor cached by a shared proxy");
  assert.doesNotMatch(pageHtml, /<script src="http/, "no third-party script may observe a scan");

  const json = await admin.req("GET", `/api/public/card/${code}`);
  assert.equal(json.status, 200);
  assert.equal(json.data.card.verdict, "valid");
  assert.match(json.data.card.name, /Alpha One|Student/i);

  // Revocation has to be immediate: a lost card is only safe if the next scan
  // already says so, with no re-printing and no cache to wait out.
  const revoked = await admin.api("POST", `/api/documents/card/student/${ctx.studentA1}/status`, { status: "revoked" });
  assert.equal(revoked.status, 200);
  const afterRevoke = await admin.req("GET", `/verify/${code}`);
  assert.match(await afterRevoke.res.text(), /cancelled|revoked/i, "the printed card now reports itself void");
  const afterJson = await admin.req("GET", `/api/public/card/${code}`);
  assert.equal(afterJson.data.card.verdict, "revoked");
  await admin.api("POST", `/api/documents/card/student/${ctx.studentA1}/status`, { status: "active" });

  // A code nobody issued must not be answerable, and must not leak a tenant.
  const unknown = await admin.req("GET", `/verify/${"f".repeat(24)}`);
  assert.equal(unknown.status, 404);
});

test("staff get ID cards on the same terms as students", async () => {
  const single = await admin.req("GET", `/api/documents/staff-id-card/${ctx.users.teacherA}`);
  assert.equal(single.status, 200);
  const html = await single.res.text();
  assert.match(html, /class="id-card id-front/, "a staff card is a real card, not a notice");
  assert.match(html, /class="id-card id-back/);
  assert.match(html, /role-staff/, "and is marked as staff so it is not mistaken for a pupil's");
  assert.match(html, /\/verify\/[0-9a-f]{24}/, "carrying its own durable code");

  const bulk = await admin.req("GET", "/api/documents/staff-id-card/bulk?side=front");
  assert.equal(bulk.status, 200);
  const bulkHtml = await bulk.res.text();
  assert.match(bulkHtml, /@page\{size:A4 portrait/, "printed as a sheet like the students'");
  assert.match(bulkHtml, /grid-template-columns:repeat\(2,85\.6mm\)/);

  // A card for a member of staff who has no teaching profile at all: the card
  // describes a person, so the absence of an optional profile must not block it.
  const plain = (await ctx.db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)",
    [ctx.madrasaA, "bursar-a", require("bcryptjs").hashSync(PASSWORD, 10), "madrasa_admin", "Bursar One"]
  )).lastInsertRowid;
  const bursarCard = await admin.req("GET", `/api/documents/staff-id-card/${plain}`);
  assert.equal(bursarCard.status, 200, "any staff account is printable");
  assert.match(await bursarCard.res.text(), /Bursar One/);
});

test("a member of staff can print their own card but not a colleague's", async () => {
  const mine = await teacher.req("GET", "/api/documents/my-card");
  assert.equal(mine.status, 200, "self-service printing, no administrator in the loop");
  assert.match(await mine.res.text(), /Teacher A/);

  const credential = await teacher.api("GET", "/api/documents/my-card/credential");
  assert.equal(credential.status, 200);
  assert.match(credential.data.credential.code, /^[0-9a-f]{24}$/);

  const someoneElse = await teacher.req("GET", `/api/documents/staff-id-card/${ctx.users.adminA}?side=front`);
  assert.equal(someoneElse.status, 403, "reading another person's card is admin work");
});

test("a certificate prints the facts it was issued with, and stays checkable", async () => {
  const template = await admin.api("POST", "/api/documents/templates", {
    name: "Merit 2026", type: "merit", designKey: "modern",
    config: { title: "Certificate of Merit", body: "Awarded to {{holder_name}} of {{class}} for {{result}} in the {{term}}." },
  });
  assert.equal(template.status, 200);
  assert.equal(template.data.config.designKey, "modern", "the chosen design is what is stored");
  assert.equal(await (async () => {
    const row = await ctx.db.get("SELECT html_template FROM certificate_templates WHERE id = ?", [template.data.id]);
    return row.html_template === "" ? true : false;
  })(), true, "no markup is stored behind it");

  const issued = await admin.api("POST", "/api/documents/certificates", {
    student_ids: [ctx.studentA1], template_id: template.data.id, issued_date: "2026-09-17", term: "First Term", result: "Distinction",
  });
  assert.equal(issued.status, 200);
  assert.match(issued.data.verifyUrl, /\/verify\/certificate\/[0-9a-f]{24}$/);

  const printable = await admin.req("GET", `/api/documents/certificates/${issued.data.id}`);
  const html = await printable.res.text();
  assert.match(html, /Distinction/, "the result prints");
  assert.match(html, /First Term/, "the term prints");
  assert.doesNotMatch(html, /\{\{[a-z_]+\}\}/i, "no unexpanded token reaches the paper");

  const check = await admin.req("GET", `/verify/certificate/${issued.data.verifyCode}`);
  assert.equal(check.status, 200);
  const checkHtml = await check.res.text();
  assert.match(checkHtml, /genuine/i, "a scanner sees a certificate that is real");
  assert.doesNotMatch(checkHtml, /fee|balance|medical/i, "and nothing the certificate never carried");

  // The snapshot rule: editing the template must not rewrite a document that
  // already exists in someone's hand.
  await admin.api("PATCH", `/api/documents/templates/${template.data.id}`, { config: { title: "Completely Different" } });
  const reprint = await admin.req("GET", `/api/documents/certificates/${issued.data.id}`);
  assert.match(await reprint.res.text(), /Certificate of Merit/, "the issued certificate keeps its own wording");
});

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

test("portraits are stored in the database and survive losing the uploads directory", async () => {
  const fs = require("fs");
  const path = require("path");
  const config = require("../server/config");
  const uploaded = await admin.api("POST", `/api/students/${ctx.studentA1}/photo`, { photoDataUrl: pngDataUrl(240, 240) });
  assert.equal(uploaded.status, 200);
  const webPath = uploaded.data.photoPath;
  assert.match(webPath, /^\/uploads\//);

  // The durable copy: every stored image is also kept in media_files, keyed
  // by the same web path the photo_path columns already use.
  const row = await ctx.db.get("SELECT web_path, bytes FROM media_files WHERE web_path = ?", [webPath]);
  assert.ok(row, "the media store holds the picture");
  assert.ok(Number(row.bytes) > 0, "with its bytes");

  // Simulate the deploy bug: the container filesystem is replaced and the
  // uploads directory is gone. The URL must keep working from the database.
  const abs = path.join(config.UPLOAD_DIR, webPath.replace(/^\/uploads\//, ""));
  assert.ok(fs.existsSync(abs), "the fast-path file is on disk first");
  fs.unlinkSync(abs);
  const served = await admin.req("GET", webPath);
  assert.equal(served.status, 200, "a missing file is answered from the database");
  const bytes = Buffer.from(await served.res.arrayBuffer());
  assert.ok(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e, "and the PNG bytes are intact");

  // Removing the picture removes the durable copy with it.
  await admin.api("DELETE", `/api/students/${ctx.studentA1}/photo`);
  const gone = await ctx.db.get("SELECT web_path FROM media_files WHERE web_path = ?", [webPath]);
  assert.ok(!gone, "the media row is deleted with the picture");
});
