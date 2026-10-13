"use strict";
/* ============================================================================
   THE PRINTED QR CODE MUST ACTUALLY SCAN

   The platform draws its own QR symbols (services/print-documents.js) because a
   printable card must not depend on a package or a network call. A hand-written
   encoder can be wrong in a way nothing else notices: the card looks right, the
   squares look like a QR code, and no phone on earth reads it.

   So every symbol this file renders is decoded here by jsQR — an independent,
   widely-used QR decoder — exactly as a phone camera would. If the encoder
   regresses (block sizes, masks, format bits, version info), these tests fail
   instead of a school's cards failing at a gate.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jsQR = require("jsqr");
const print = require("../server/services/print-documents");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

/** The <svg class="qr-code"> the renderer emits → a 0/1 module matrix. */
function svgToMatrix(svg) {
  const size = Number(svg.match(/viewBox="-4 -4 (\d+) \d+"/)[1]) - 8;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const path = svg.match(/<path d="([^"]+)"/)[1];
  for (const match of path.matchAll(/M(-?\d+) (-?\d+)h1v1h-1z/g)) {
    const col = Number(match[1]);
    const row = Number(match[2]);
    if (row >= 0 && row < size && col >= 0 && col < size) matrix[row][col] = 1;
  }
  return matrix;
}

/** Rasterise the modules (with the quiet zone) and let a real decoder read it. */
function decode(matrix, scale = 6, quiet = 4) {
  const size = matrix.length;
  const side = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!matrix[row][col]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = ((row + quiet) * scale + y) * side + ((col + quiet) * scale + x);
          data[px * 4] = 0; data[px * 4 + 1] = 0; data[px * 4 + 2] = 0; data[px * 4 + 3] = 255;
        }
      }
    }
  }
  return jsQR(data, side, side, { inversionAttempts: "dontInvert" });
}

test("every symbol size the encoder can emit decodes, from v1 to v10", () => {
  // The largest payload each version can hold, so the list walks v1 → v10. The
  // last one matters most: version 10 is the first whose Reed–Solomon blocks are
  // not all the same length (68, 68, 69, 69 data codewords).
  const capacities = [17, 32, 53, 78, 106, 134, 154, 192, 230, 269];
  const seen = new Set();
  for (const length of capacities) {
    const prefix = "https://x.io/v/";
    const payload = prefix + "a".repeat(length - prefix.length);
    assert.equal(Buffer.byteLength(payload), length, "the payload hits the version boundary exactly");
    const svg = print.qrSvg(payload);
    assert.ok(svg, `no symbol was produced for ${Buffer.byteLength(payload)} bytes`);
    const matrix = svgToMatrix(svg);
    const version = (matrix.length - 17) / 4;
    seen.add(version);
    const result = decode(matrix);
    assert.ok(result, `a real decoder could not find a QR code in version ${version}`);
    assert.equal(result.data, payload, `version ${version} decoded to the wrong payload`);
  }
  // The payloads above must genuinely walk up the versions, otherwise this test
  // would only ever exercise version 1.
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("a payload too large for the encoder is refused rather than mis-printed", () => {
  const tooLong = `https://school.example/verify/${"a".repeat(300)}`;
  assert.equal(print.qrSvg(tooLong), "", "no symbol instead of an unreadable one");
  assert.equal(print.qrBlock(tooLong), "", "and no QR block either");
  assert.ok(Buffer.byteLength(tooLong, "utf8") > print.QR_MAX_BYTES);
});

let ctx, adminA;
before(async () => {
  ctx = await setup();
  adminA = new Client(ctx.base); await adminA.login("admin-a", PASSWORD);
});
after(async () => { if (ctx) await ctx.close(); });

test("the QR printed on an ID card opens that holder's verification page", async () => {
  const page = await adminA.req("GET", `/api/documents/id-card/${ctx.studentA1}`);
  assert.equal(page.status, 200);
  const html = await page.res.text();

  const credential = await adminA.api("GET", `/api/documents/card/student/${ctx.studentA1}/credential`);
  const code = credential.data.credential.code;
  assert.match(code, /^[a-f0-9]{24}$/, "a card code is 24 hex characters");

  const svg = html.match(/<svg class="qr-code"[\s\S]*?<\/svg>/);
  assert.ok(svg, "the printed card carries a QR symbol");
  const result = decode(svgToMatrix(svg[0]));
  assert.ok(result, "a phone camera would find a QR code on the card");
  const payload = result.data;
  assert.match(payload, new RegExp(`/verify/${code}$`), `the QR must open /verify/${code} (saw ${payload})`);
  assert.match(payload, /^https?:\/\//, "the QR carries an absolute URL, not a path a stranger cannot use");
  assert.match(html, new RegExp(code), "the same code is printed in text under the QR");
});

test("the code on the card then verifies through the public page and the JSON endpoint", async () => {
  const credential = await adminA.api("GET", `/api/documents/card/student/${ctx.studentA1}/credential`);
  const code = credential.data.credential.code;

  const json = await adminA.req("GET", `/api/public/card/${code}`);
  assert.equal(json.status, 200);
  assert.equal(json.data.card.valid, true);
  assert.equal(json.data.card.name, "Alpha One");

  const publicPage = await adminA.req("GET", `/verify/${code}`);
  assert.equal(publicPage.status, 200);
  const html = await publicPage.res.text();
  assert.match(html, /This card is valid/);
  assert.match(html, /data-scanner/, "the verification page can scan the next card");
  assert.match(html, /\/js\/card-scanner\.js/);
});
