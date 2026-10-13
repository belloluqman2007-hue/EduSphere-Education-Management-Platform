"use strict";
/* ============================================================================
   EduSphere — Parent-Teacher Meetings (admin workspace)
   ----------------------------------------------------------------------------
   Renders the "Parent-Teacher Meetings" item of the existing Communication
   group. It mounts into the dashboard's own #dashContent node and borrows the
   dashboard primitives (openModal, toast, statCard, fmtDate…) so it inherits
   the current design system, theme, RTL container and mobile breakpoints
   exactly like the Library, Leave and Health modules do.

   BOTH institution categories share this screen and the same API; only the
   wording (institution / academy) comes from the category configuration that
   the dashboard already resolves. No functionality is category-gated.
   ========================================================================== */
(function () {
  const ROUTES = new Set(["communication/ptm"]);

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function fmtDate(v) {
    if (!v) return "—";
    try { return new Date(String(v).slice(0, 10)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return String(v); }
  }
  function todayIso() { return new Date().toISOString().slice(0, 10); }
  function statusPill(status) {
    const s = String(status || "draft").toLowerCase();
    const kind = s === "open" ? "ok" : (s === "closed" ? "muted" : "warn");
    return `<span class="dash-pill ${kind}">${esc(s)}</span>`;
  }
  function emptyRow(ctx, cols, copy) { return ctx.emptyRow ? ctx.emptyRow(cols, copy) : `<tr class="dash-empty-row"><td colspan="${cols}">${esc(copy)}</td></tr>`; }
  function noun(ctx) {
    const t = ctx.T ? ctx.T() : {};
    return t.institutionNoun || "institution";
  }

  /* ----------------------------- create / edit ---------------------------- */
  function sessionForm(session, terms) {
    const s = session || {};
    return `
      <form id="ptmForm">
        <div class="dash-form-grid">
          <div class="dash-field" style="grid-column:1/-1">
            <label>Meeting title <span class="req">*</span></label>
            <input name="title" required maxlength="200" value="${esc(s.title || "")}" placeholder="First Term Parent-Teacher Meeting">
          </div>
          <div class="dash-field">
            <label>Date <span class="req">*</span></label>
            <input name="date" type="date" required value="${esc(s.date || todayIso())}">
          </div>
          <div class="dash-field">
            <label>Location</label>
            <input name="location" maxlength="200" value="${esc(s.location || "")}" placeholder="Main hall">
          </div>
          <div class="dash-field">
            <label>Start time <span class="req">*</span></label>
            <input name="session_start" type="time" required value="${esc(s.session_start || "09:00")}">
          </div>
          <div class="dash-field">
            <label>End time <span class="req">*</span></label>
            <input name="session_end" type="time" required value="${esc(s.session_end || "13:00")}">
          </div>
          <div class="dash-field">
            <label>Slot length (minutes)</label>
            <input name="slot_duration_mins" type="number" min="5" max="240" step="5" value="${esc(s.slot_duration_mins || 10)}">
          </div>
          <div class="dash-field">
            <label>Term</label>
            <select name="term_id"><option value="">No term</option>${(terms || []).map((t) => `<option value="${t.id}" ${Number(s.term_id) === Number(t.id) ? "selected" : ""}>${esc(`${t.session_label ? t.session_label + " · " : ""}${t.name_en}`)}</option>`).join("")}</select>
          </div>
          <div class="dash-field">
            <label>Status</label>
            <select name="status">
              ${["draft", "open", "closed"].map((x) => `<option value="${x}" ${String(s.status || "draft") === x ? "selected" : ""}>${x === "draft" ? "Draft (not visible to parents)" : x === "open" ? "Open for booking" : "Closed"}</option>`).join("")}
            </select>
          </div>
        </div>
        <p class="hint" style="margin-top:10px">Time slots are generated automatically from the start time, end time and slot length. Every active teacher is added as available and can opt out from their own screen.</p>
        <button class="dash-btn dash-btn-primary" type="submit" style="margin-top:14px">${s.id ? "Save changes" : "Create meeting session"}</button>
      </form>`;
  }

  function readForm(form) {
    const body = {
      title: form.elements.title.value,
      date: form.elements.date.value,
      session_start: form.elements.session_start.value,
      session_end: form.elements.session_end.value,
      slot_duration_mins: Number(form.elements.slot_duration_mins.value || 10),
      location: form.elements.location.value,
      status: form.elements.status.value,
    };
    body.term_id = form.elements.term_id.value ? Number(form.elements.term_id.value) : null;
    return body;
  }

  async function termOptions() {
    try {
      const data = await window.API.get("/sessions");
      return (data.sessions || []).flatMap((s) => (s.terms || []).map((t) => Object.assign({ session_label: s.label }, t)));
    } catch (e) { return []; }
  }

  /* ------------------------------- list page ------------------------------ */
  async function listPage(ctx, content) {
    const data = await window.API.get("/ptm");
    const sessions = data.sessions || [];
    const open = sessions.filter((s) => s.status === "open").length;
    const booked = sessions.reduce((sum, s) => sum + Number(s.booking_count || 0), 0);

    content.innerHTML = `
      <div class="dash-page-head">
        <div>
          <div class="dash-crumb">Communication</div>
          <h2>Parent-Teacher Meetings</h2>
          <p>Schedule meeting days, let teachers confirm availability and let parents book a time with their child's teachers. Every booking is scoped to this ${esc(noun(ctx))}.</p>
        </div>
        <button class="dash-btn dash-btn-primary" id="ptmNew">${ctx.I && ctx.I.plus ? ctx.I.plus : ""} New meeting session</button>
      </div>
      <div class="dash-stats-grid">
        ${ctx.statCard ? ctx.statCard("calendar", sessions.length, "Meeting sessions") : ""}
        ${ctx.statCard ? ctx.statCard("check", open, "Open for booking") : ""}
        ${ctx.statCard ? ctx.statCard("users", booked, "Confirmed bookings") : ""}
      </div>
      <div class="dash-card">
        <div class="dash-table-wrap">
          <table class="dash-table ptm-session-table">
            <thead><tr><th>Meeting</th><th>Date</th><th>Time</th><th>Slots</th><th>Teachers</th><th>Bookings</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${sessions.length ? sessions.map((s) => `<tr>
                <td><strong>${esc(s.title)}</strong><small>${esc(s.location || "No location set")}${s.term_name ? ` · ${esc(s.term_name)}` : ""}</small></td>
                <td>${fmtDate(s.date)}</td>
                <td>${esc(s.session_start)}–${esc(s.session_end)}<small>${esc(s.slot_duration_mins)} min slots</small></td>
                <td>${esc(s.slot_count)}</td>
                <td>${esc(s.teacher_count)}</td>
                <td>${esc(s.booking_count)}</td>
                <td>${statusPill(s.status)}</td>
                <td><div class="dash-table-actions">
                  <button class="dash-btn dash-btn-ghost dash-btn-sm" data-ptm-open="${s.id}">Booking grid</button>
                  <button class="dash-btn dash-btn-ghost dash-btn-sm" data-ptm-edit="${s.id}">Edit</button>
                  ${s.status !== "open" ? `<button class="dash-btn dash-btn-primary dash-btn-sm" data-ptm-status="${s.id}" data-ptm-to="open">Open</button>` : `<button class="dash-btn dash-btn-ghost dash-btn-sm" data-ptm-status="${s.id}" data-ptm-to="closed">Close</button>`}
                </div></td>
              </tr>`).join("") : emptyRow(ctx, 8, "No meeting sessions yet. Create one to open parent bookings.")}
            </tbody>
          </table>
        </div>
      </div>`;

    content.querySelector("#ptmNew").addEventListener("click", async () => {
      const terms = await termOptions();
      const modal = ctx.openModal("New meeting session", sessionForm(null, terms));
      modal.querySelector("#ptmForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await window.API.post("/ptm", readForm(e.target));
          ctx.closeModal();
          ctx.toast("Meeting session created. Time slots were generated automatically.", "success");
          listPage(ctx, content);
        } catch (x) { ctx.toast(x.message || "Could not create the meeting session.", "error"); }
      });
    });

    content.querySelectorAll("[data-ptm-edit]").forEach((btn) => btn.addEventListener("click", async () => {
      const session = sessions.find((s) => String(s.id) === btn.dataset.ptmEdit);
      const terms = await termOptions();
      const modal = ctx.openModal("Edit meeting session", sessionForm(session, terms));
      modal.querySelector("#ptmForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await window.API.patch(`/ptm/${session.id}`, readForm(e.target));
          ctx.closeModal();
          ctx.toast("Meeting session updated.", "success");
          listPage(ctx, content);
        } catch (x) { ctx.toast(x.message || "Could not update the meeting session.", "error"); }
      });
    }));

    content.querySelectorAll("[data-ptm-status]").forEach((btn) => btn.addEventListener("click", async () => {
      try {
        await window.API.patch(`/ptm/${btn.dataset.ptmStatus}`, { status: btn.dataset.ptmTo });
        ctx.toast(btn.dataset.ptmTo === "open" ? "Bookings are now open." : "Bookings are now closed.", "success");
        listPage(ctx, content);
      } catch (x) { ctx.toast(x.message || "Could not change the status.", "error"); }
    }));

    content.querySelectorAll("[data-ptm-open]").forEach((btn) => btn.addEventListener("click", () => {
      ctx.state.cache.ptmSessionId = Number(btn.dataset.ptmOpen);
      schedulePage(ctx, content, Number(btn.dataset.ptmOpen));
    }));
  }

  /* ----------------------------- booking grid ----------------------------- */
  async function schedulePage(ctx, content, id) {
    content.innerHTML = `<div class="dash-card"><div class="dash-card-pad"><p class="hint">Loading booking grid…</p></div></div>`;
    let data;
    try { data = await window.API.get(`/ptm/${id}/schedule`); }
    catch (x) {
      content.innerHTML = `<div class="dash-card"><div class="dash-card-pad"><p class="dash-error">${esc(x.message || "Could not load the booking grid.")}</p></div></div>`;
      return;
    }
    const s = data.session || {};
    const teachers = data.teachers || [];
    const grid = data.grid || [];
    const stats = data.stats || {};

    content.innerHTML = `
      <div class="dash-page-head">
        <div>
          <div class="dash-crumb">Communication · Parent-Teacher Meetings</div>
          <h2>${esc(s.title)}</h2>
          <p>${fmtDate(s.date)} · ${esc(s.session_start)}–${esc(s.session_end)} · ${esc(s.slot_duration_mins)} minute slots${s.location ? ` · ${esc(s.location)}` : ""}</p>
        </div>
        <div class="dash-actions">
          <button class="dash-btn dash-btn-ghost" id="ptmBack">Back to sessions</button>
          <a class="dash-btn dash-btn-ghost" href="${window.API.url(`/ptm/${id}/export.csv`)}">${ctx.I && ctx.I.download ? ctx.I.download : ""} Export CSV</a>
          <button class="dash-btn dash-btn-primary" id="ptmPrint">Print schedule</button>
        </div>
      </div>
      <div class="dash-stats-grid">
        ${ctx.statCard ? ctx.statCard("teacher", stats.teachers || 0, "Available teachers") : ""}
        ${ctx.statCard ? ctx.statCard("clock", stats.slots || 0, "Time slots") : ""}
        ${ctx.statCard ? ctx.statCard("check", stats.booked || 0, "Booked") : ""}
        ${ctx.statCard ? ctx.statCard("calendar", Math.max(0, Number(stats.capacity || 0) - Number(stats.booked || 0)), "Still free") : ""}
      </div>
      <div class="dash-card">
        <div class="dash-card-head"><h3>Booking grid</h3><span class="hint">${statusPill(s.status)} ${teachers.length} teacher(s) × ${grid.length} slot(s)</span></div>
        <div class="dash-table-wrap">
          <table class="dash-table ptm-grid">
            <thead><tr><th>Time</th>${teachers.map((t) => `<th>${esc(t.full_name || t.username)}</th>`).join("") || "<th>No available teachers</th>"}</tr></thead>
            <tbody>
              ${grid.length ? grid.map((row) => `<tr>
                <td class="ptm-slot-time"><strong>${esc(row.start)}</strong><small>${esc(row.end)}</small></td>
                ${teachers.length ? row.cells.map((cell) => cell.booking_id
                  ? `<td class="ptm-cell is-booked"><strong>${esc(cell.student_name || "Student")}</strong><small>${esc(cell.parent_name || "Parent")}${cell.class_en ? ` · ${esc(cell.class_en)}` : ""}</small><button class="dash-btn dash-btn-ghost dash-btn-sm" data-ptm-cancel="${cell.booking_id}">Cancel</button></td>`
                  : `<td class="ptm-cell is-free"><span class="hint">Free</span></td>`).join("") : `<td class="ptm-cell"><span class="hint">—</span></td>`}
              </tr>`).join("") : emptyRow(ctx, teachers.length + 1, "This meeting session has no time slots.")}
            </tbody>
          </table>
        </div>
      </div>
      <p class="hint" style="margin-top:12px">Parents book from their own portal; teachers confirm availability from theirs. Cancelling here notifies both the parent and the teacher.</p>`;

    content.querySelector("#ptmBack").addEventListener("click", () => listPage(ctx, content));
    content.querySelector("#ptmPrint").addEventListener("click", () => { if (window.EduPrint) window.EduPrint.print({ title: "Parent-teacher meeting schedule", meta: `Printed ${window.EduPrint.stamp()}` }); else window.print(); });
    content.querySelectorAll("[data-ptm-cancel]").forEach((btn) => btn.addEventListener("click", async () => {
      if (!window.confirm("Cancel this booking? The parent and the teacher are both notified.")) return;
      try {
        await window.API.del(`/ptm/bookings/${btn.dataset.ptmCancel}`);
        ctx.toast("Booking cancelled.", "success");
        schedulePage(ctx, content, id);
      } catch (x) { ctx.toast(x.message || "Could not cancel the booking.", "error"); }
    }));
  }

  window.BelloPTM = {
    handles: (route) => ROUTES.has(route),
    render: async (ctx, content, route) => { if (route === "communication/ptm") return await listPage(ctx, content); },
  };
})();
