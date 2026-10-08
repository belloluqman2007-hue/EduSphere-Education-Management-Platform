# Chat & Support — Mobile Unblock + Interface Redesign (Implementation Report)

Two things were wrong with the chat: **nothing on it could be pressed on a
phone**, and the conversation itself looked like a generic support table rather
than a chat. This pass fixes the first at the root cause and redesigns the
second inside the existing dashboard design system.

Scope: **presentation + client behaviour only.** The support-chat API
(`routes/support-chat.js`), the service rules (`services/support-chat.js`), the
`support_conversations` / `support_chat_messages` schema, tenant isolation,
status and priority transitions, attachment validation and private delivery,
unread counting and notification creation are untouched. No endpoint changed,
no request or response shape changed, no row is read from anywhere but the
database, and nothing is mocked.

---

## 1. The mobile bug — root cause

`public/css/support-chat.css` carried this pair of rules:

```css
.sc-drawer-backdrop { display: none; }            /* base */
@media (max-width: 1180px) {
  .sc-drawer-backdrop { display: block; position: fixed; inset: 0; z-index: 410; }
}
```

The element is `<div class="sc-drawer-backdrop" id="scDrawerBackdrop" hidden>` —
the script toggles it with the `hidden` **property**, which is a *content
attribute*. The user-agent stylesheet only says `[hidden] { display: none }`, an
author-origin rule of the same specificity as the base rule but written earlier
in every browser, so **any** author `display` declaration on that element wins.
The base `display: none` happened to keep it invisible on a desktop; inside the
`≤1180px` media query, `display: block` was an author declaration with no
`[hidden]` guard, so on every phone, tablet and narrow window the backdrop was
painted as a transparent `position: fixed; inset: 0` layer covering the entire
viewport.

The consequences were exactly what was reported:

- every tap landed on the backdrop, never on a conversation row, the composer,
  a filter, the status select or the send button — "can't press anything";
- because its `z-index: 410` sat *above* the dashboard modal layer
  (`--z-modal: 400`), the **New Conversation** form was unusable on phones too;
- the page still looked completely normal, because the layer was transparent —
  there was no visual hint that anything was wrong;
- desktop at ≥1181px was unaffected, which is why it survived review.

The fix is three-part, because the class of bug is broader than this one rule:

1. the backdrop's `display`, `position`, `inset` and `z-index` now live in a
   `:not([hidden])` rule, so they can only apply while the drawer is genuinely
   open — a `[hidden]` rule keeps the guard local as well;
2. `public/css/app.css` gained a global `[hidden] { display: none !important; }`
   next to the reset block. Every component in this app already guards its own
   `[hidden]`; this makes the guarantee app-wide so a future media query cannot
   reintroduce the same invisible wall elsewhere;
3. `test/support-chat-mobile.test.js` parses the shipped stylesheets and fails
   the build if any element that is `hidden`-toggled can paint itself over the
   viewport without a state gate. The old file fails that test; the new one
   passes it.

---

## 2. Files changed

| File | Change |
| ---- | ------ |
| `public/css/support-chat.css` | Rewritten (519 lines changed). The overlay fix above, plus: the page owns the viewport height with `100dvh` minus the real header and content padding, with a `100vh` fallback and a `min-height` floor so a landscape phone does not force the whole page to scroll; a phone shows **one pane at a time** via `data-view="list|thread"`; the details pane becomes a bottom-anchored sheet with its own gated scrim and `overscroll-behavior: contain`; message grouping (avatars only on the last message of a run, tighter spacing inside a run), date dividers, delivery ticks, pill composer with attachment chip and character counter; 44–48px hit targets under `pointer: coarse`; 16px inputs at ≤820px so iOS Safari does not zoom the page away; `env(safe-area-inset-bottom)` clearance for the home indicator; `prefers-reduced-motion` handling. |
| `public/js/support-chat.js` | Rewritten (722 lines changed). Message **grouping + day dividers** derived in `decorate()`; **signature guards** on both panes so the 20-second poll only re-renders when the data actually changed (a poll used to rebuild the thread, destroying focus, scroll position and a half-typed message); the composer **draft is module state** rather than a DOM read, so it survives every repaint and is keyed per conversation; **scroll anchoring** (a background refresh keeps the reader's position, an explicit open lands on the latest message) and a "N new messages" chip that only appears when the reader has scrolled up; **on-screen-keyboard handling** through `visualViewport` so the composer stays above the keyboard instead of behind it; the drawer remembers its **opener** and restores focus to it, with Escape handled on the page root so it works even while focus is in a text box; the send button is **never `disabled`** (it is classed `is-idle`) so a programmatic submit is never silently dropped; unread/total **counters** are published even while a thread is open; the Super Admin's **stat cards are repainted** with the counts that ride in on the list response instead of staying at zero for the whole session; local icon set for send / paperclip / arrow-down / info / back, which the dashboard's icon map does not carry. |
| `public/css/app.css` | +9 lines: the global `[hidden] { display: none !important; }` guarantee described above. |
| `test/support-chat-mobile.test.js` | New, 8 tests. Static stylesheet analysis (no ungated viewport-covering overlay; the backdrop's own guard; the app-wide `[hidden]` rule; 16px fields; ≥44px coarse-pointer targets; safe-area and viewport-height handling) plus a jsdom walkthrough at phone size of the pane switching, the details sheet, day dividers, grouping, ticks, the new-message chip and draft persistence. |

`public/js/dashboard.js` is unchanged: the module still exposes
`window.EduSphereSupportChat = { handles, render, stopPolling, USER_ROUTE,
ADMIN_ROUTE }`, so the router dispatch, the sidebar unread badge, the
`edusphere:support-unread` event and the logout teardown all work as before.

---

## 3. The design contract

The chat is now built from the dashboard's own tokens (`--d-*`), so it inherits
both presentation themes — the Islamic forest-green/old-gold treatment and the
Western navy/slate treatment — and dark mode, with no per-theme overrides.

**Layout.** On a wide screen the three panes the API already implies are all
visible: the conversation list (with the status / priority / category /
institution filters), the thread, and the conversation details. At ≤820px the
list and the thread share the viewport one at a time and the details pane
becomes a sheet; at ≤1180px the details pane is a right-hand (RTL: left-hand)
drawer with a gated scrim. The page head and the Super Admin's stat row step
aside while a thread is open on a phone, so the message list and the composer
get the whole height.

**The thread.** Messages are grouped by author: a run of consecutive messages
from the same sender shows the name, role and avatar once, and the following
bubbles sit closer together with only a time. Day boundaries ("Today",
"Yesterday", otherwise the full date) are marked with a divider. Outgoing
messages carry a delivery tick that becomes a read tick when the other side has
opened them. Attachments render as a named, sized, downloadable card inside the
bubble.

**The composer.** A pill box with an attach button, an auto-growing textarea, a
character counter that only appears as the 8000-character limit approaches, and
a send button that reflects the pending / ready / sending states by class rather
than by being disabled. The staged file appears as a removable chip above the
box, and the hint line states the accepted types and size limit taken from the
server's own `meta` vocabulary rather than duplicated in the client.

**Reachability.** Everything is keyboard reachable and announced: the message
list is a `role="log"` live region with a scrollable tab stop, the drawer keeps
`aria-expanded` in step, the sheet traps nothing and closes on Escape or a scrim
tap, and focus returns to the control that opened it.

---

## 4. Behaviour notes worth knowing

- **Polling.** Unchanged at 20 seconds, and still skipped while the tab is
  hidden. What changed is that a poll no longer costs the reader anything: both
  panes compare a signature of the data they were given and leave the DOM alone
  when nothing moved.
- **Reading state.** Opening a conversation still marks that conversation's
  incoming messages read server-side, per message, and publishes the new unread
  total; the sidebar badge updates from the same event as before.
- **Closed and resolved conversations.** A closed conversation still shows the
  transcript with the composer replaced by the closed notice. Status changes
  remain Super-Admin controlled; an institution user sees their own status
  control only where the service allows it.
- **Empty and error states.** Every pane keeps a real empty state and a real
  error state with a retry, including the filtered-list case, which offers a
  "Clear filters" control instead of blaming the reader for an empty result.

---

## 5. Tests

`npm test` — **673 pass / 0 fail**, up from 665 before this pass; the 8 new
tests are the mobile suite (`npm test` globs `test/*.test.js`, so they run in
the normal suite, not only on demand). Pre-existing coverage that had to keep
passing, and does:

- `test/support-chat-ui.test.js` — the institution and Super Admin walkthroughs
  through the real UI: page titles and copy, sidebar labels, the `.sc-layout`
  three-pane contract, search and filters, `#scComposer` / `#scMessage`, the
  status pills and `#scSetStatus`, the details pane, exactly one `.sc-msg` per
  message, the admin-only `#scInstitution` / `#scPriority` / `#scCategory`, the
  sidebar unread badge, tenant names, and the New Conversation modal — each
  ending with `assert.deepEqual(page.errors, [])`;
- `test/support-chat.test.js` — tenant isolation, unread counting in both
  directions, status and priority transitions, attachment validation and
  private delivery, role permissions (a teacher may use the chat; parents and
  students may not), and the refusal of empty messages and unknown
  conversations.

The two chat UI tests submit `#scComposer` after setting `#scMessage.value`
without firing an `input` event. The composer deliberately reads the textarea at
submit time and never disables the send button, so that path stays real rather
than being accommodated by a test-only shim.

Verified by hand against a running server (demo data, real HTTP, real database)
at phone width: the list is tappable, a conversation opens, the composer accepts
text and sends, the attachment chip stages and clears, the status control
changes the conversation, the details sheet opens and closes on Escape and on a
scrim tap with focus restored, and the same flows work for the Super Admin
across both demo institutions.
