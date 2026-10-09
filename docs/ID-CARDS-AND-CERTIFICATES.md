# ID Cards & Certificates — Print Design

Both documents are server-rendered HTML in `server/routes/documents.js` and
print through the browser (`public/js/print.js`). They share the palette of
the term report sheets: **forest green + old gold** for Islamic madaris and
**navy + slate blue** for Western academies. A school's brand colour overrides
the base brand colour.

## ID cards

- **Size:** ID-1 (85.6 × 54 mm). Front and back are printed as two card-sized pages.
- **Front:** school mark and name, passport-style photo, role, admission number,
  class, session, and an optional profile QR (`?qr=1`).
- **Back:** terms, school address and phone, emergency contact, and holder and
  principal signature lines.
- **Bulk (`/api/documents/id-card/bulk?classId=…&side=front|back`):** eight cards
  per A4 portrait sheet (2 × 4) with crop marks outside every card.
- **Colour:** backgrounds print in colour (`print-color-adjust: exact`).

## Certificates

- **Layout:** A4 landscape with a double frame, corner ornaments, school mark,
  name (and Arabic name for Islamic madaris), a template body, Principal and
  Class-teacher signature lines, an official seal, and a reference number
  `CERT-YYYY-NNNNNN`.
- **Template body:** still HTML with `{{placeholders}}`. The standard styles
  `cert-kicker`, `cert-name`, `cert-award` and `cert-note` are available.
- **Live preview:** the template editor renders the same server-side layout
  with sample data in a sandboxed frame. Scripts are stripped and never run.

## Print helper

`public/js/print.js` waits for every image (logo, photo) and webfonts to settle,
capped at 4 seconds, before opening the print dialog. Previously it printed
after 150 ms, which could produce sheets without photos.

## QR codes

`qrSvg()` is a dependency-free encoder. Versions 1–9 at level L are supported,
up to 230 bytes, which covers signed profile URLs. Version 7+ version-information
blocks are now written, so longer profile URLs scan correctly.

**Known limitation:** the profile token in the QR expires after 15 minutes
(`signedProfileUrl`). A printed card's QR therefore stops working shortly after
it is printed. Lengthening the lifetime changes who can read a student's
profile, so it is a policy decision and is not changed here.
