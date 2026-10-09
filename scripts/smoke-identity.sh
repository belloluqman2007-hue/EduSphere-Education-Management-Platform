#!/usr/bin/env bash
# ============================================================================
# Identity & documents smoke test
# ----------------------------------------------------------------------------
# Exercises the surfaces that were previously broken, end to end: a portrait on
# every kind of account, staff ID cards, a printed QR that still verifies after
# it leaves the printer, and certificates chosen from a design gallery instead
# of written in HTML.
#
#   BASE=http://127.0.0.1:3100 ADMIN_USER=... ADMIN_PASS=... bash scripts/smoke-identity.sh
#
# Prints PASS/FAIL per check and exits with the number of failures.
# ============================================================================
set -u
BASE="${BASE:-http://127.0.0.1:3100}"
ADMIN_USER="${ADMIN_USER:-demo-quraniyya-admin}"
ADMIN_PASS="${ADMIN_PASS:-Demo1234!}"
TEACHER_USER="${TEACHER_USER:-demo-quraniyya-ust1}"
TEACHER_PASS="${TEACHER_PASS:-Demo1234!}"
JAR="$(mktemp)"
FAILED=0

# make_png <w> <h> <r> <g> <b> -> base64 of a solid-colour PNG.
# A real image, because a 1x1 stub trips the "too small to print" guard and the
# check would then prove nothing.
make_png() {
  python3 - "$@" <<'PYEOF'
import sys, zlib, struct, base64
w, h, r, g, b = (int(v) for v in sys.argv[1:6])
raw = b"".join(b"\x00" + bytes((r, g, b, 255)) * w for _ in range(h))
def chunk(tag, body):
    return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
data = (b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b""))
sys.stdout.write(base64.b64encode(data).decode())
PYEOF
}

check() { # check <name> <expected-substring> <actual>
  local name="$1" expect="$2" actual="$3"
  if printf '%s' "$actual" | grep -qF -- "$expect"; then
    printf 'PASS  %s\n' "$name"
  else
    printf 'FAIL  %s  (wanted: %s | got: %s)\n' "$name" "$expect" "$(printf '%s' "$actual" | head -c 240 | tr '\n' ' ')"
    FAILED=$((FAILED + 1))
  fi
}

check_absent() { # check_absent <name> <forbidden-substring> <actual>
  local name="$1" expect="$2" actual="$3"
  if printf '%s' "$actual" | grep -qF -- "$expect"; then
    printf 'FAIL  %s  (must not contain: %s)\n' "$name" "$expect"
    FAILED=$((FAILED + 1))
  else
    printf 'PASS  %s\n' "$name"
  fi
}

count_of() { printf '%s' "$2" | grep -o "$1" | wc -l | tr -d ' '; }
check_re() { # check_re <name> <extended-regex> <actual>
  local name="$1" pattern="$2" actual="$3"
  if printf '%s' "$actual" | grep -qE -- "$pattern"; then
    printf 'PASS  %s\n' "$name"
  else
    printf 'FAIL  %s  (wanted /%s/)\n' "$name" "$pattern"
    FAILED=$((FAILED + 1))
  fi
}

csrf() { curl -s -b "$JAR" -c "$JAR" "$BASE/api/csrf-token" | sed 's/.*"csrfToken":"\([^"]*\)".*/\1/'; }
login() {
  local token; token="$(csrf)"
  curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $token" \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}"
}
api() { # api <method> <path> [json]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    local token; token="$(csrf)"
    curl -s -b "$JAR" -c "$JAR" -X "$method" "$BASE/api$path" \
      -H 'Content-Type: application/json' -H "X-CSRF-Token: $token" -d "$body"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$method" "$BASE/api$path"
  fi
}
pub() { curl -s "$1"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE$path"; }

echo "== identity: portrait and signature on any account =="
check "login (admin)" '"role"' "$(login "$ADMIN_USER" "$ADMIN_PASS")"
check "me carries a photo field" 'photoPath' "$(api GET /auth/me)"
PHOTO_PNG="$(make_png 240 240 31 49 84)"
check "self portrait accepted" '"ok' "$(api POST /auth/account/photo "{\"photoDataUrl\":\"data:image/png;base64,$PHOTO_PNG\"}")"
check "portrait now on /auth/me" '/uploads/' "$(api GET /auth/me)"
check "portrait on account view" 'photoPath' "$(api GET /auth/account)"
SIGN_PNG="$(make_png 220 70 12 12 12)"
check "self signature accepted" '"ok' "$(api PUT /auth/account/signature "{\"signatureDataUrl\":\"data:image/png;base64,$SIGN_PNG\"}")"
check "signature stored on account" 'hasSignature' "$(api GET /auth/account)"
check "a non-image upload is refused" '"error"' "$(api POST /auth/account/photo '{"photoDataUrl":"data:text/html;base64,PHNjcmlwdD4="}')"

echo "== student ID card: one card, one durable code =="
STUDENT_CARD="$(api GET /documents/id-card/1)"
check "student card renders" 'id-front' "$STUDENT_CARD"
check "exactly one front face" '1' "$(count_of 'id-front' "$STUDENT_CARD")"
check "card carries a QR" 'viewBox' "$STUDENT_CARD"
CODE="$(printf '%s' "$STUDENT_CARD" | grep -o 'verify/[0-9a-f]\{16,\}' | head -1 | sed 's|verify/||')"
check "a code was minted" "$CODE" "$CODE"
check "printed page has no inline script" '0' "$(count_of '<script>' "$STUDENT_CARD")"
check "verify page for the code" 'Card check' "$(pub "$BASE/verify/$CODE")"
check "verify JSON says valid" '"valid"' "$(pub "$BASE/api/public/card/$CODE")"
check "unknown code is refused" '404' "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/verify/ffffffffffffffff")"

echo "== staff ID card: same rights for teachers =="
check "staff card renders" 'id-back' "$(api GET /documents/staff-id-card/3)"
check "card registry lists staff cards" '"role"' "$(api GET '/documents/cards?holderType=teacher')"
check "staff card honours side=back" 'id-back' "$(api GET '/documents/staff-id-card/3?side=back')"
check "bulk staff sheet is sheet-sized" '85.6mm' "$(api GET '/documents/staff-id-card/bulk?side=front')"

echo "== revocation is immediate =="
check "card can be revoked" '"revoked"' "$(api POST '/documents/card/student/1/status' '{"status":"revoked"}')"
check "revoked card stops verifying" 'cancelled' "$(pub "$BASE/verify/$CODE")"
api POST '/documents/card/student/1/status' '{"status":"active"}' >/dev/null
check "restored card verifies again" '"valid"' "$(pub "$BASE/api/public/card/$CODE")"

echo "== certificates: chosen from a gallery, never written in HTML =="
DESIGNS="$(api GET /documents/certificate-designs)"
check "gallery is served" '"heritage"' "$DESIGNS"
check "designs explain themselves" '"tagline"' "$DESIGNS"
check "designs say who they suit" '"suits"' "$DESIGNS"
check "tokens are offered as chips" 'holder_name' "$DESIGNS"
# User 2 is the administrator who saved a signature at the top of this run, so a
# signature image on the page proves the stored one is really printed.
PREVIEW="$(api POST /documents/templates/preview '{"designKey":"royal","type":"graduation","config":{"title":"Certificate of Graduation","body":"{{holder_name}} completed {{program}} on {{issued_date}}.","signatories":[{"name":"Mallam Ibrahim","label":"Principal","userId":2,"showSignature":true}]}}')"
# {{issued_date}} is not a listed token — it is an accepted synonym for the date,
# so the sentence must read "... on 9 October 2026." and never "... on ."
check_re "alias token expands to a date" 'on [0-9]{1,2} [A-Z][a-z]+ [0-9]{4}' "$PREVIEW"
check "preview uses the chosen design" 'cert-design-royal' "$PREVIEW"
check "preview prints a stored signature" '/uploads/' "$PREVIEW"
check "preview runs no scripts" '0' "$(count_of '<script' "$PREVIEW")"
TEMPLATE="$(api POST /documents/templates '{"name":"Graduation 2026","type":"graduation","designKey":"heritage","config":{"title":"Certificate of Graduation","body":"This certifies that {{holder_name}} of {{class}} completed {{program}} on {{issued_date}}.","showQR":true,"showSeal":true}}')"
check "template saved against a design" '"designKey"' "$TEMPLATE"
TID="$(printf '%s' "$TEMPLATE" | sed 's/.*"id":\([0-9]*\).*/\1/')"
check "template stores no html" '""' "$(printf '%s' "$(api GET "/documents/templates/$TID")" | sed 's/.*"html_template":\("[^"]*"\).*/\1/')"
check "old html endpoint still maps to a design" 'heritage' "$(api GET '/documents/templates')"
CERT="$(api POST /documents/certificates "{\"student_ids\":[1],\"template_id\":$TID,\"issued_date\":\"2026-10-09\",\"term\":\"First Term\",\"result\":\"Distinction\"}")"
check "certificate issued" '"verifyUrl"' "$CERT"
CID="$(printf '%s' "$CERT" | sed 's/.*"id":\([0-9]*\).*/\1/')"
CCODE="$(printf '%s' "$CERT" | sed 's/.*"verifyCode":"\([^"]*\)".*/\1/')"
CERT_HTML="$(api GET "/documents/certificates/$CID")"
check "certificate names the holder" 'Adeyemi Kunle' "$CERT_HTML"
check "certificate carries the class" 'Class 1' "$CERT_HTML"
check "certificate carries the result" 'Distinction' "$CERT_HTML"
check "certificate carries the term" 'First Term' "$CERT_HTML"
check "certificate prints a verify code" "$CCODE" "$CERT_HTML"
# The template's wording contains the token; the printed page must not.
check_absent "no unexpanded token on paper" "{{holder_name}}" "$CERT_HTML"
check "certificate verify page works" 'ertificate' "$(pub "$BASE/verify/certificate/$CCODE")"

echo "== self-service (no administrator in the loop) =="
rm -f "$JAR"
check "login (teacher)" '"role"' "$(login "$TEACHER_USER" "$TEACHER_PASS")"
check "teacher prints their own card" 'id-front' "$(api GET /documents/my-card)"
check "teacher reads their card code" '"code"' "$(api GET /documents/my-card/credential)"
MY_CODE="$(printf '%s' "$(api GET /documents/my-card/credential)" | sed 's/.*"code":"\([^"]*\)".*/\1/')"
check "their card verifies publicly" '"valid"' "$(pub "$BASE/api/public/card/$MY_CODE")"
check "a teacher may not create templates" '403' "$(printf '%s' "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X POST "$BASE/api/documents/templates" -H 'Content-Type: application/json' -H "X-CSRF-Token: $(csrf)" -d '{"name":"nope","type":"graduation"}')")"
check "a teacher may not read another's card code" '403' "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/documents/card/teacher/2/credential")"

rm -f "$JAR"
if [ "$FAILED" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILED CHECK(S) FAILED"; fi
exit "$FAILED"
