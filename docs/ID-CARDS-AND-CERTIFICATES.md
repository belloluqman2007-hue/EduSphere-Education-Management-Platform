# ID Cards, Certificates and Portraits

Everything in this area is server-rendered HTML printed through the browser
(`public/js/print.js`), so there is no PDF library, no headless Chrome and no
second copy of the layout to keep in sync. The print engine *is* the renderer:
the page you preview is byte-for-byte the page that comes out of the printer.

Shared code lives in `server/services/`:

| Service | Owns |
| --- | --- |
| `print-documents.js` | theme (school colours, category), print shell, QR encoder, asset-path safety |
| `id-card-designs.js` | the 85.6 × 54 mm card, front and back, and the 8-up A4 sheet |
| `certificate-designs.js` | the seven certificate designs, the wording fields, tokens and the A4 landscape page |
| `verification-page.js` | the public page a card or certificate QR opens |
| `card-credentials.js` | durable card codes, status, print counts, scan logging |
| `profile-media.js` | portrait and signature uploads (size caps, image sniffing) |

Routes are in `server/routes/documents.js`.

## Portraits and signatures

A picture is stored once, on the account: `users.photo_path` and
`users.signature_path`. Because the records that actually get printed —
`students.photo_path`, `teacher_profiles.photo_path|signature_path` — are
mirrored on every write, the profile screen, the portal header, the ID card and
the certificate can never disagree about whose face goes where.

*Self-service for every role.* `POST|DELETE /api/auth/account/photo` and
`PUT|POST|DELETE /api/auth/account/signature` need no special permission: a
pupil, a teacher, a bursar and a parent all change their own picture the same
way. Administrators additionally have `POST|DELETE /api/students/:id/photo` and
`/api/teachers/:id/photo`, which write both sides.

*One picker, everywhere.* `public/js/profile-photo.js` (`window.EduProfile`)
provides the drag-and-drop / file / camera / clipboard chooser with a square
crop and zoom, plus a signature pad that trims the canvas to the ink. The
output is a 512 px JPEG at q0.9 (signatures: PNG with transparency). Nothing is
uploaded until the crop is accepted, and files stay on the school's own disk.
The image never passes through a third party.

## ID cards

- **Size:** ID-1 (85.6 × 54 mm), front and back, each a card-sized page.
- **Front:** school mark and name, portrait, role line, admission or staff ID,
  class or department, session, and the verification QR.
- **Back:** terms of use, address and phone, emergency contact, the holder's
  signature, the principal's signature, and the code typed out in text.
- **Students:** `GET /api/documents/id-card/:studentId`, and
  `?classId=…&side=front|back` on `/id-card/bulk` for an eight-up A4 sheet.
- **Staff:** `GET /api/documents/staff-id-card/:userId` and
  `/staff-id-card/bulk?side=&role=&q=`. Any active staff account is printable,
  including one that has no teaching profile row — the card describes a person,
  not a job record. Teachers print their own card; printing a colleague's is
  admin work.
- **Self-service:** `GET /api/documents/my-card` returns the card of whoever is
  signed in, so a card can be re-printed on the first day of term without
  waiting for the office.
- `?qr=0` drops the QR, `?side=front|back` prints one face.

The admin screen (**Documents → ID Cards**) is one page with two tabs — student
cards and staff cards — a registry of which codes exist and whether each is
active, revoke/restore, and the camera verifier below it.

## The QR code, and why it now outlives the printer

A card is only worth printing if a gate, a bank or an exam hall can check it.
That used to be a signed profile URL valid for fifteen minutes, so the code on
a laminated card was dead before the card reached a bag.

Each holder now has a **card credential**: an unguessable 24-hex-character code
in `card_credentials`, minted the first time the card is rendered and never
recycled. The QR encodes `{origin}/verify/{code}`; the same code is printed as
text, so a damaged QR can still be typed in.

- `GET /verify/{code}` — the human page (`server/services/verification-page.js`)
- `GET /api/public/card/{code}` — the JSON a scanning app can read
- `GET /verify/certificate/{code}` — the same idea for certificates

Properties that matter:

- **No login, no tenant leakage.** A code is only ever resolvable inside the
  madrasa that issued it; unknown codes are a plain 404.
- **Nothing new is revealed.** The page repeats only what is already printed on
  the card — name, class, session, issue date, status. No fees, no attendance,
  no medical record, no phone number.
- **Not indexable, not cacheable.** `noindex, nofollow` plus
  `Cache-Control: no-store`, because a shared proxy that caches "valid" would
  keep a stolen card working after it was reported lost.
- **Rate limited** by `scanLimiter` (120 lookups per 15 min per IP).
- **Revocable in one step.** `POST /api/documents/card/:type/:id/status`
  with `{"status":"revoked"}` makes the printed card say *cancelled* on the very
  next scan. Re-printing the card afterwards mints a fresh code, so a replaced
  card cannot be shadowed by the lost one.
- Every lookup is logged (`card_verifications`) with the outcome, so "did anyone
  check this card?" is answerable.

**Scanning in the app.** `public/js/card-scanner.js` (`window.EduScanner`)
upgrades any `[data-scanner]` block into a camera scanner using the browser's own
`BarcodeDetector`, with the typed-code path always available. It uses
`getUserMedia({ facingMode: "environment" })`, stops the stream as soon as a
code is read, and degrades to "type the code" where no detector exists (older
Safari). No video frame ever leaves the device — there is no remote decoding
service, deliberately: a child's face is not something to POST to a third party.

## Certificates

Certificates are **chosen, not coded**. There is no HTML editor: the old
textarea asked a school administrator to be a front-end developer, and the only
feedback they got was a preview that broke when a tag was lost.

`GET /api/documents/certificate-designs` lists seven designs — heritage, royal,
modern, geometric, laurel, ribbon, executive — each with a tagline, the
certificate types it suits, an ornament and a layout. A template stores
`design_key` plus a JSON `config`; `html_template` is kept in the schema for
compatibility and is written as an empty string, which is what proves nothing
executable is stored.

The designer (`public/js/certificate-designer.js`, `window.EduCertificates`) is
four labelled sections:

1. **Design** — a gallery where each thumbnail is the server's own renderer on
   sample data, scaled into the card. What is approved at 200 px is what prints
   at 297 mm.
2. **Wording** — title, line above the name, main text, award line, closing,
   footer note, watermark. Plain text with a maxlength, never markup. Chips
   insert tokens such as `{{holder_name}}`, `{{class}}`, `{{term}}`.
3. **Details** — which facts to print (admission no., class, session, term,
   programme, track, result, date), the portrait, the seal, the QR, Arabic
   name, motto, and the school's accent colour.
4. **Signatories** — up to three lines: a label, a name, and optionally a
   member of staff picked from real accounts. Choosing a person prints the
   signature *they* saved on their own profile, so it is real ink, not a blank
   line — and it updates when they redraw it.

Rules the renderer enforces:

- Field text is escaped before tokens are expanded, so wording can never become
  markup. A token that resolves to nothing leaves no hole: facts with an empty
  value are skipped rather than printed blank.
- `{{issued_date}}`, `{{certificate_no}}`, `{{full_name}}` and similar natural
  guesses are accepted as synonyms of the documented tokens.
- The designer warns inline about a token the renderer does not know, before
  anything can print.
- The preview endpoint returns raw HTML for a sandboxed `<iframe>`, never an
  inline `<script>` — the platform's CSP is `script-src 'self'`, and the preview
  runs with `sandbox=""`.

**Issuing.** `POST /api/documents/certificates` takes `student_ids` (or a single
`student_id`), `template_id`, `issued_date`, `term`, `result` and custom fields.
Each certificate gets its own `verify_code` at issue time — not at print time —
and stores a **snapshot of the config** it was issued with. Editing a template
afterwards therefore cannot rewrite documents people already hold.

## Print helper

`public/js/print.js` waits for images (logo, portrait, signature) and webfonts
to settle, capped at 4 seconds, before opening the print dialog — otherwise a
sheet could print with empty photo boxes. The print bar is CSS and that script
only; no printed page has ever contained inline JavaScript.

## Legacy templates

A template saved before this change held raw HTML. `legacyConfigFromHtml()`
reduces it to the wording it clearly carried (`cert-kicker` → kicker,
`cert-award` → award, `cert-note` → closing, an `<h1>` that says "Certificate
of …" → title, the rest → body) and lets it be edited as a normal design. Tokens
that would otherwise be lost in the collapse — a `{{custom_field_1}}` sitting in
inline markup, for example — are re-attached to the body so a conversion never
quietly deletes information a school had already printed.
