"use strict";
/* ============================================================================
   EduSphere — Student portal
   ----------------------------------------------------------------------------
   Mounted at /student. Renders inside the shared portal shell (portal.js) and
   talks only to endpoints that are student-scoped on the server:
     /api/portal/dashboard     /api/portal/me           /api/portal/results
     /api/portal/report-card   /api/portal/announcements
     /api/portal/assignments   /api/portal/exams        /api/portal/contacts
     /api/timetable/me         /api/extras/my-attendance
     /api/fees/student/:id     /api/library/my-loans    /api/quran-progress/me
     /api/communication/*      /api/calendar
   A student can only ever read their own data; every write (assignment
   submission) is validated against their own class on the server.
   ========================================================================== */
(function () {
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  /** True when the signed-in student's institution is the Islamic category.
   *  The server independently refuses /quran-progress/me on Western tenants,
   *  so this only decides whether the menu item is offered. */
  function isIslamic() {
    return window.BelloPortal && window.BelloPortal.category ? window.BelloPortal.category() !== "western" : true;
  }

  function schema() {
    const items = [
      { key: "dashboard", label: "Dashboard", icon: "dashboard", route: "dashboard" },
      { key: "timetable", label: "Timetable", icon: "calendar", route: "timetable" },
      { key: "lessons", label: "Lessons", icon: "book", route: "lessons" },
      { key: "assignments", label: "Assignments", icon: "file", route: "assignments" },
      { key: "exams", label: "Exam Timetable", icon: "academic", route: "exams" },
      { key: "online-exams", label: "Online Exams", icon: "academic", route: "online-exams" },
      { key: "results", label: "Results", icon: "check", route: "results" },
      { key: "attendance", label: "Attendance", icon: "check", route: "attendance" },
      { key: "fees", label: "School Fees", icon: "money", route: "fees" },
      { key: "library", label: "Library", icon: "book", route: "library" },
    ];
    // Qur'an progress exists only for Islamic institutions; the backend
    // refuses it for Western academies, so the menu item is hidden too.
    if (isIslamic()) items.push({ key: "quran", label: "Qur'an Progress", icon: "book", route: "quran" });
    items.push(
      { key: "calendar", label: "Calendar", icon: "calendar", route: "calendar" },
      { key: "messages", label: "Messages", icon: "chat", route: "messages" },
      { key: "notifications", label: "Notifications", icon: "bell", route: "notifications" },
      { key: "account", label: "My Account", icon: "settings", route: "account" }
    );
    return items;
  }

  const PAGE_TITLES = {
    dashboard: "My Dashboard", timetable: "My Timetable", lessons: "Lessons", assignments: "My Assignments",
    exams: "Exam Timetable", "online-exams": "Online Exams", results: "My Results", attendance: "My Attendance", fees: "School Fees",
    library: "My Library", quran: "Qur'an Progress", calendar: "Calendar & Events", messages: "Messages",
    notifications: "Notifications", account: "My Account",
  };
  function pageTitle(route) {
    const top = route.split("/")[0];
    if (route.startsWith("assignments/")) return "Assignment";
    if (route.startsWith("online-exams/take/")) return "Take Exam";
    if (route.startsWith("online-exams/review/")) return "Exam Review";
    return PAGE_TITLES[top] || null;
  }

  /* ------------------------------ dashboard -------------------------------- */

  async function pageDashboard(c, content) {
    const data = await c.api.get("/portal/dashboard");
    const me = data.children && data.children.length ? data.children[0] : null;
    const unread = data.unreadNotifications || 0;
    content.innerHTML = `
      <div class="portal-welcome">
        <div>
          <h2>${c.esc(me ? me.name : (data.user ? data.user.fullName : "Student"))}</h2>
          <p>${c.esc(me ? `${me.className || "No class"}${me.admissionNo ? " · " + me.admissionNo : ""}` : "")}</p>
        </div>
        <div class="portal-welcome-side">${c.esc(data.todayName)}, ${c.fmtDate(data.today)}<br>${c.esc(data.madrasa ? data.madrasa.name_en : "")}</div>
      </div>
      <div class="dash-stats-grid">
        ${c.statCard("check", me && me.attendancePct != null ? me.attendancePct + "%" : "—", "Attendance")}
        ${c.statCard("file", me ? me.pendingAssignments.length : 0, "Pending assignments", me && me.pendingAssignments.length ? "accent" : "")}
        ${c.statCard("academic", me ? me.upcomingExams.length : 0, "Upcoming exams")}
        ${c.statCard("money", me ? c.fmtMoney(me.fee.balance) : "—", "Fee balance", me && me.fee.balance > 0 ? "accent" : "")}
      </div>
      <div class="portal-grid-2">
        <div class="dash-card">
          <div class="dash-card-head"><h3>Today's timetable</h3><span class="hint">${c.esc(data.todayName)}</span></div>
          <div class="dash-card-pad portal-rows">
            ${(me && me.todaySlots.length) ? me.todaySlots.map((s) => `
              <div class="portal-row"><div class="portal-row-main"><strong>P${c.esc(s.period)} · ${c.esc(s.subject_en || s.subject_ar || "Lesson")}</strong>
                <small>${c.esc(String(s.start_time || "").slice(0, 5))}–${c.esc(String(s.end_time || "").slice(0, 5))}${s.room ? " · " + c.esc(s.room) : ""}</small></div></div>`).join("")
              : `<p class="hint">No lessons scheduled today.</p>`}
          </div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Upcoming exams</h3></div>
          <div class="dash-card-pad portal-rows">
            ${(me && me.upcomingExams.length) ? me.upcomingExams.map((e) => `
              <div class="portal-row"><div class="portal-row-main"><strong>${c.esc(e.title)}</strong>
                <small>${c.esc(e.subject_name || "")} · ${c.fmtDate(e.exam_date)}${e.start_time ? " · " + c.esc(String(e.start_time).slice(0, 5)) : ""}${e.classroom ? " · " + c.esc(e.classroom) : ""}</small></div></div>`).join("")
              : `<p class="hint">No upcoming exams.</p>`}
          </div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Latest results</h3></div>
          <div class="dash-card-pad">
            ${me && me.latestResult ? `
              <p class="dash-info-line"><strong>${c.esc(me.latestResult.session_label)} — ${c.esc(me.latestResult.term_name)}</strong>
              ${me.latestResult.total_average != null ? ` · average ${c.esc(me.latestResult.total_average)}%` : ""}
              ${me.latestResult.position ? ` · position ${c.esc(me.latestResult.position)}` : ""}</p>
              <a class="dash-btn dash-btn-primary dash-btn-sm" href="#/student/results">View results</a>`
              : `<p class="hint">No published results yet.</p>`}
          </div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Announcements</h3></div>
          <div class="dash-card-pad portal-rows">
            ${await announcementsHtml(c)}
          </div>
        </div>
      </div>
      ${unread ? `<p class="hint" style="margin-top:12px">${c.I.bell} You have ${c.esc(unread)} unread notification(s) — <a href="#/student/notifications">open the notification centre</a>.</p>` : ""}`;
  }

  async function announcementsHtml(c) {
    try {
      const data = await c.api.get("/portal/announcements");
      const rows = (data.announcements || []).slice(0, 5);
      return rows.length ? rows.map((a) => `
        <div class="portal-row"><div class="portal-row-main"><strong>${c.esc(a.title)}</strong><small>${c.fmtDate(a.created_at)}</small>
          <p style="margin:4px 0 0;font-size:.82rem;color:var(--d-muted)">${c.esc(String(a.body || "").slice(0, 160))}</p></div></div>`).join("")
        : `<p class="hint">No announcements.</p>`;
    } catch (e) { return `<p class="hint">Announcements are unavailable right now.</p>`; }
  }

  /* ------------------------------ timetable -------------------------------- */

  async function pageTimetable(c, content) {
    const data = await c.api.get("/timetable/me");
    const students = data.students || [];
    const mine = students[0];
    content.innerHTML = c.pageHead("Academic", "My timetable", mine && mine.class ? `${c.esc(mine.class.name_en || "")} — ${c.esc(data.days ? "" : "")}weekly schedule` : "Your class timetable.", "");
    const slots = (mine && mine.slots) || [];
    const periods = [...new Set(slots.map((s) => s.period))].sort((a, b) => a - b);
    const byDay = new Map(DAYS.map((d) => [d, new Map()]));
    slots.forEach((s) => { if (byDay.has(s.day)) byDay.get(s.day).set(Number(s.period), s); });
    content.insertAdjacentHTML("beforeend", `
      <div class="dash-card"><div class="dash-card-pad">
        <table class="portal-timetable">
          <thead><tr><th style="width:110px">Day</th>${periods.map((p) => `<th>P${p}</th>`).join("")}</tr></thead>
          <tbody>${DAYS.map((day) => `<tr><th>${c.esc(day)}</th>${periods.map((p) => {
            const s = byDay.get(day).get(p);
            return `<td>${s ? `<span class="t-subject">${c.esc(s.subjectEn || s.subjectAr || "—")}</span><span class="t-meta">${c.esc(s.teacherName || "")}${s.room ? " · " + c.esc(s.room) : ""}</span>` : "—"}</td>`;
          }).join("")}</tr>`).join("")}</tbody>
        </table></div></div>`);
  }

  /* ------------------------------- lessons --------------------------------- */

  async function pageLessons(c, content) {
    const data = await c.api.get("/homework?kind=lesson");
    const rows = data.homework || [];
    content.innerHTML = c.pageHead("Academic", "Lessons", "Lesson plans and classwork published for your class.", "");
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    card.innerHTML = `<div class="dash-card-pad portal-rows">
      ${rows.length ? rows.map((l) => `
        <div class="portal-row"><div class="portal-row-main">
          <strong>${c.esc(l.title)}</strong>
          <small>${c.esc(l.subject_en || "")}${l.class_en ? " · " + c.esc(l.class_en) : ""} · ${c.fmtDate(l.due_date)}</small>
          ${l.details ? `<p style="margin:4px 0 0;font-size:.82rem;color:var(--d-muted)">${c.esc(String(l.details).slice(0, 220))}</p>` : ""}
        </div></div>`).join("") : `<p class="hint">No lessons published yet.</p>`}
    </div>`;
  }

  /* ------------------------------ assignments ------------------------------- */

  async function pageAssignments(c, content, route) {
    const detailMatch = route.match(/^assignments\/(\d+)$/);
    if (detailMatch) return pageAssignmentDetail(c, content, Number(detailMatch[1]));
    const data = await c.api.get("/portal/assignments");
    const rows = data.assignments || [];
    const pending = rows.filter((a) => !a.submission && a.status === "published");
    const done = rows.filter((a) => a.submission);
    const card = (title, list) => `
      <div class="dash-card"><div class="dash-card-head"><h3>${c.esc(title)}</h3><span class="hint">${list.length}</span></div>
        <div class="dash-card-pad portal-rows">
          ${list.length ? list.map((a) => `
            <div class="portal-row"><div class="portal-row-main">
              <strong>${c.esc(a.title)}</strong>
              <small>${c.esc(a.subject_name || "")} · due ${c.fmtDate(a.due_date)}${a.teacher_name ? " · " + c.esc(a.teacher_name) : ""}</small>
              ${a.submission ? `<small>Submitted ${c.fmtDate(a.submission.submittedAt)}${a.submission.score != null ? ` · score ${c.esc(a.submission.score)}/${c.esc(a.maximum_score)}` : ""}</small>` : ""}
            </div>
            <div class="portal-row-actions">
              ${a.submission && a.submission.status === "graded" ? c.pill("graded") : a.submission ? c.pill(a.submission.status) : c.pill("pending")}
              <a class="dash-btn dash-btn-ghost dash-btn-sm" href="#/student/assignments/${c.esc(a.id)}">${a.submission && a.canSubmit ? "View / resubmit" : "View"}</a>
            </div></div>`).join("") : `<p class="hint">Nothing here right now.</p>`}
        </div></div>`;
    content.innerHTML = c.pageHead("Academic", "My assignments", "Work set for your class — submit, track and read your feedback.", "");
    const grid = document.createElement("div");
    grid.className = "portal-grid-2";
    grid.innerHTML = card("To do", pending) + card("Submitted", done);
    content.appendChild(grid);
  }

  async function pageAssignmentDetail(c, content, assignmentId) {
    const data = await c.api.get(`/portal/assignments/${assignmentId}`);
    const a = data.assignment;
    const sub = data.submission;
    content.innerHTML = c.pageHead("Academic", a.title, `${c.esc(a.subjectName || "")} · due ${c.fmtDate(a.dueDate)} · max ${c.esc(a.maximumScore)}`, `
      <a class="dash-btn dash-btn-ghost" href="#/student/assignments">Back to assignments</a>`);
    const grid = document.createElement("div");
    grid.className = "portal-grid-2";
    grid.innerHTML = `
      <div class="dash-card"><div class="dash-card-head"><h3>Instructions</h3>${c.pill(a.status)}</div>
        <div class="dash-card-pad">
          ${a.details ? `<p style="white-space:pre-wrap">${c.esc(a.details)}</p>` : `<p class="hint">No additional instructions.</p>`}
          ${a.homeworkText ? `<p style="white-space:pre-wrap">${c.esc(a.homeworkText)}</p>` : ""}
          ${(data.attachments || []).length ? `<h4 style="margin:14px 0 8px">Attachments</h4>
            <div class="portal-rows">${data.attachments.map((f) => `
              <div class="portal-row"><div class="portal-row-main"><strong>${c.esc(f.display_name || f.original_name)}</strong>
                <small>${c.esc(Math.round((f.file_size || 0) / 1024))} KB</small></div>
                <a class="dash-btn dash-btn-ghost dash-btn-sm" href="${c.api.url(`/portal/assignments/${a.id}/attachments/${f.id}`)}" target="_blank">${c.I.download} Download</a></div>`).join("")}</div>` : ""}
        </div></div>
      <div class="dash-card"><div class="dash-card-head"><h3>My submission</h3>${sub ? c.pill(sub.status) : c.pill("pending")}</div>
        <div class="dash-card-pad">
          ${sub ? `
            <div class="portal-detail-meta">
              <div><b>Submitted</b>${c.fmtDateTime(sub.submitted_at)}</div>
              <div><b>Score</b>${sub.score != null ? `${c.esc(sub.score)} / ${c.esc(a.maximumScore)}` : "Not graded yet"}</div>
              <div><b>Graded</b>${sub.graded_at ? c.fmtDateTime(sub.graded_at) : "—"}</div>
            </div>
            ${sub.submission_text ? `<p style="white-space:pre-wrap">${c.esc(sub.submission_text)}</p>` : ""}
            ${sub.original_name ? `<p>${c.I.file} <a href="${c.api.url(`/portal/assignments/${a.id}/submission/attachment`)}" target="_blank">${c.esc(sub.original_name)}</a></p>` : ""}
            ${sub.feedback ? `<div class="dash-card" style="margin-top:10px"><div class="dash-card-head"><h3>Teacher feedback</h3></div><div class="dash-card-pad"><p style="white-space:pre-wrap">${c.esc(sub.feedback)}</p></div></div>` : ""}
          ` : `<p class="hint">You have not submitted anything yet.</p>`}
          ${data.canSubmit ? `
            <form id="submitForm" style="margin-top:14px">
              <div class="dash-form-grid">
                <div class="dash-field" style="grid-column:1/-1"><label>Your answer${sub ? " (resubmission replaces the current one)" : ""}</label><textarea name="submission_text" rows="5">${c.esc(sub ? sub.submission_text || "" : "")}</textarea></div>
                <div class="dash-field" style="grid-column:1/-1"><label>Attach a file (PDF, image or document · max 15 MB)</label>
                  <input type="file" name="attachment" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"></div>
              </div>
              <div class="dash-actions" style="margin-top:12px"><button class="dash-btn dash-btn-primary" type="submit">${c.I.check} ${sub ? "Resubmit" : "Submit"}</button></div>
            </form>` : `<p class="hint">Submissions are closed for this assignment.</p>`}
        </div></div>`;
    content.appendChild(grid);
    const form = grid.querySelector("#submitForm");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const fd = new FormData(form);
        const payload = new FormData();
        payload.append("submission_text", fd.get("submission_text") || "");
        const file = form.querySelector("input[type=file]").files[0];
        if (file) payload.append("attachment", file);
        await c.api.post(`/academic/assignments/${a.id}/submissions/me`, payload);
        c.toast("Submission received.", "success");
        pageAssignmentDetail(c, content, assignmentId);
      } catch (err) {
        c.toast(err.message || "Could not submit.", "error");
        btn.disabled = false;
      }
    });
  }

  /* -------------------------------- exams ----------------------------------- */

  async function pageExams(c, content) {
    const data = await c.api.get("/portal/exams");
    const rows = data.exams || [];
    content.innerHTML = c.pageHead("Academic", "Exam timetable", "Scheduled examinations for your class.", "");
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    card.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
      <thead><tr><th>Examination</th><th>Subject</th><th>Date</th><th>Time</th><th>Room</th><th>Marks</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map((e) => `<tr>
        <td><strong>${c.esc(e.title)}</strong>${e.mode === "online" ? `<small><a href="#/student/online-exams">Online examination — take it here</a></small>` : ""}</td><td>${c.esc(e.subject_name || "—")}</td>
        <td>${c.fmtDate(e.exam_date)}</td>
        <td>${e.start_time ? `${c.esc(String(e.start_time).slice(0, 5))}${e.end_time ? "–" + c.esc(String(e.end_time).slice(0, 5)) : ""}` : "—"}</td>
        <td>${e.mode === "online" ? "In the portal" : c.esc(e.classroom || "—")}</td><td>${c.esc(e.total_marks)}</td><td>${c.pill(e.status)}</td></tr>`).join("") : c.emptyRow(7, "No examinations scheduled.")}</tbody></table></div>`;
    card.querySelectorAll("a[href='#/student/online-exams']").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); c.go("online-exams"); }));
  }

  /* -------------------------------- results --------------------------------- */

  async function pageResults(c, content) {
    const data = await c.api.get("/portal/results");
    const terms = data.terms || [];
    content.innerHTML = c.pageHead("Academic", "My results", "Published term results and report cards.", "");
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    if (!terms.length) {
      card.innerHTML = `<div class="dash-card-pad">${c.emptyState("check", "No results yet", "Your results will appear here once the school publishes them.")}</div>`;
      return;
    }
    const detail = document.createElement("div");
    detail.className = "dash-card";
    detail.style.marginTop = "16px";
    content.appendChild(detail);
    card.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
      <thead><tr><th>Session</th><th>Term</th><th>Average</th><th>Position</th><th>Published</th><th></th></tr></thead>
      <tbody>${terms.map((t) => `<tr>
        <td>${c.esc(t.session_label)}</td><td>${c.esc(t.term_name)}</td>
        <td>${t.total_average != null ? c.esc(t.total_average) + "%" : "—"}</td>
        <td>${t.position ? c.esc(t.position) : "—"}</td>
        <td>${c.fmtDate(t.published_at)}</td>
        <td><div class="module-actions">
          <button class="dash-btn dash-btn-ghost dash-btn-sm" data-term-view="${c.esc(t.term_id)}">Subjects</button>
          <a class="dash-btn dash-btn-ghost dash-btn-sm" href="${c.api.portalReportUrl(t.term_id)}" target="_blank">Report sheet</a>
        </div></td></tr>`).join("")}</tbody></table></div>`;
    const viewTerm = async (termId) => {
      detail.innerHTML = `<div class="dash-card-head"><h3>Subject results</h3></div><div class="dash-card-pad">${c.loading()}</div>`;
      try {
        const sub = await c.api.get(`/portal/results/${termId}`);
        detail.querySelector(".dash-card-pad").innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
          <thead><tr><th>Subject</th><th>CA</th><th>Exam</th><th>Total</th><th>%</th><th>Grade</th><th>Remark</th></tr></thead>
          <tbody>${(sub.subjects || []).length ? sub.subjects.map((s) => `<tr>
            <td>${c.esc(s.nameEn)}${s.nameAr ? ` <small dir="rtl">${c.esc(s.nameAr)}</small>` : ""}</td>
            <td>${c.esc(s.ca)}</td><td>${c.esc(s.exam)}</td><td>${c.esc(s.total)}</td><td>${c.esc(s.pct)}</td>
            <td>${c.esc(s.grade)}</td><td>${c.esc(s.remark || "—")}</td></tr>`).join("") : c.emptyRow(7, "No subject results for this term.")}</tbody></table></div>`;
      } catch (e) { detail.querySelector(".dash-card-pad").innerHTML = c.errorState(e.message); }
    };
    card.querySelectorAll("[data-term-view]").forEach((b) => b.addEventListener("click", () => viewTerm(Number(b.dataset.termView))));
  }

  /* ------------------------------- attendance -------------------------------- */

  async function pageAttendance(c, content) {
    const data = await c.api.get("/extras/my-attendance");
    const entry = (data.attendance || [])[0];
    const records = (entry && entry.records) || [];
    const counts = (entry && entry.counts) || { present: 0, absent: 0, late: 0, excused: 0 };
    const total = records.length;
    const pct = total ? Math.round(((counts.present + counts.late + counts.excused) / total) * 1000) / 10 : null;
    content.innerHTML = c.pageHead("Academic", "My attendance", "Your attendance record (read-only).", "");
    const stats = document.createElement("div");
    stats.className = "dash-stats-grid";
    stats.innerHTML = `
      ${c.statCard("check", pct != null ? pct + "%" : "—", "Attendance")}
      ${c.statCard("check", counts.present, "Days present")}
      ${c.statCard("close", counts.absent, "Days absent", counts.absent ? "accent" : "")}
      ${c.statCard("clock", counts.late, "Days late", counts.late ? "accent" : "")}`;
    content.appendChild(stats);
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    card.innerHTML = `<div class="dash-card-head"><h3>Recent records</h3><span class="hint">Last ${records.length} day(s)</span></div>
      <div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Date</th><th>Status</th></tr></thead>
        <tbody>${records.length ? records.map((r) => `<tr><td>${c.fmtDate(r.day)}</td><td>${c.pill(r.status)}</td></tr>`).join("") : c.emptyRow(2, "No attendance recorded yet.")}</tbody></table></div>`;
  }

  /* --------------------------------- fees ------------------------------------ */

  async function pageFees(c, content) {
    const me = await c.api.get("/portal/me");
    const self = me.self;
    if (!self) { content.innerHTML = c.errorState("No student record is linked to this account."); return; }
    const data = await c.api.get(`/fees/student/${self.id}`);
    content.innerHTML = c.pageHead("Finance", "School fees", `${c.esc(self.first_name)} ${c.esc(self.last_name)} — fee statement and payment history.`, "");
    const stats = document.createElement("div");
    stats.className = "dash-stats-grid";
    stats.innerHTML = `
      ${c.statCard("money", c.fmtMoney(data.totalFees), "Total billed")}
      ${c.statCard("check", c.fmtMoney(data.amountPaid), "Paid")}
      ${c.statCard("money", c.fmtMoney(data.outstandingBalance), "Outstanding", data.outstandingBalance > 0 ? "accent" : "")}`;
    content.appendChild(stats);
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    const payments = data.payments || [];
    card.innerHTML = `<div class="dash-card-head"><h3>Payments</h3><span class="hint">${payments.length} record(s)</span></div>
      <div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Date</th><th>Fee</th><th>Method</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead>
        <tbody>${payments.length ? payments.map((p) => `<tr>
          <td>${c.fmtDate(p.payment_date)}</td><td>${c.esc(p.fee_name || "—")}</td><td>${c.esc(p.method || "—")}</td>
          <td>${c.fmtMoney(p.amount_ngn)}</td><td>${c.pill(p.status)}</td>
          <td>${p.receipt_number ? `<a class="dash-btn dash-btn-ghost dash-btn-sm" href="${c.api.url(`/fees/payments/${p.id}/receipt`)}" target="_blank">${c.I.download} Receipt</a>` : "—"}</td></tr>`).join("") : c.emptyRow(6, "No payments recorded yet.")}</tbody></table></div>`;
  }

  /* -------------------------------- library ---------------------------------- */

  async function pageLibrary(c, content) {
    const data = await c.api.get("/library/my-loans");
    const loans = data.loans || [];
    content.innerHTML = c.pageHead("Library", "My library", "Books you borrowed, due dates and history (read-only).", "");
    const stats = document.createElement("div");
    stats.className = "dash-stats-grid";
    stats.innerHTML = `
      ${c.statCard("book", data.summary.active, "Books on loan")}
      ${c.statCard("clock", data.summary.overdue, "Overdue", data.summary.overdue ? "accent" : "")}
      ${c.statCard("money", c.fmtMoney(data.summary.fines), "Unpaid fines")}`;
    content.appendChild(stats);
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    card.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
      <thead><tr><th>Book</th><th>Issued</th><th>Due</th><th>Returned</th><th>Status</th><th>Fine</th></tr></thead>
      <tbody>${loans.length ? loans.map((l) => `<tr>
        <td><strong>${c.esc(l.title)}</strong>${l.author ? `<small>${c.esc(l.author)}</small>` : ""}</td>
        <td>${c.fmtDate(l.issue_date)}</td><td>${c.fmtDate(l.due_date)}</td><td>${c.fmtDate(l.return_date)}</td>
        <td>${c.pill(l.status)}${l.days_overdue > 0 && !l.return_date ? `<small>${c.esc(l.days_overdue)} day(s) overdue</small>` : ""}</td>
        <td>${l.fine_ngn ? c.fmtMoney(l.fine_ngn) : "—"}</td></tr>`).join("") : c.emptyRow(6, "You have not borrowed any books yet.")}</tbody></table></div>`;
  }

  /* ------------------------------ quran progress ----------------------------- */

  async function pageQuran(c, content) {
    let data;
    try {
      data = await c.api.get("/quran-progress/me");
    } catch (e) {
      content.innerHTML = c.pageHead("Islamic studies", "Qur'an progress", "Memorization, revision and Tajweed progress recorded by your teachers.", "");
      content.insertAdjacentHTML("beforeend", `<div class="dash-card"><div class="dash-card-pad">${c.emptyState("book", "Qur'an progress is not available", "Your school has not enabled Qur'an progress tracking.")}</div></div>`);
      return;
    }
    const records = data.records || [];
    content.innerHTML = c.pageHead("Islamic studies", "Qur'an progress", "Memorization, revision and Tajweed progress recorded by your teachers.", "");
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    card.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
      <thead><tr><th>Date</th><th>Surah / Juz</th><th>Ayah</th><th>Memorization</th><th>Revision</th><th>Tajweed</th><th>Status</th></tr></thead>
      <tbody>${records.length ? records.map((r) => `<tr>
        <td>${c.fmtDate(r.progress_date)}</td>
        <td><strong>${c.esc(r.surah || r.juz || "—")}</strong></td>
        <td>${c.esc(r.ayah_from || "—")}${r.ayah_to ? "–" + c.esc(r.ayah_to) : ""}</td>
        <td>${c.esc(r.memorization_progress)}%</td><td>${c.esc(r.revision_progress)}%</td>
        <td>${r.tajweed_assessment ? c.esc(r.tajweed_assessment) + "/5" : "—"}</td>
        <td>${c.pill(r.performance_status)}</td></tr>`).join("") : c.emptyRow(7, "No Qur'an progress records yet.")}</tbody></table></div>`;
  }

  /* -------------------------------- calendar ---------------------------------- */

  async function pageCalendar(c, content) {
    const data = await c.api.get(`/calendar?from=${c.todayIso()}`);
    const rows = data.events || [];
    content.innerHTML = c.pageHead("Institution", "Calendar & events", "Terms, holidays, exams, meetings and school activities.", "");
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    card.innerHTML = `<div class="dash-card-pad portal-rows">
      ${rows.length ? rows.map((e) => `
        <div class="portal-row"><div class="portal-row-main">
          <strong>${c.esc(e.title)}</strong>
          <small>${c.fmtDate(e.start_date)}${e.end_date && e.end_date !== e.start_date ? " – " + c.fmtDate(e.end_date) : ""}${e.start_time ? " · " + c.esc(String(e.start_time).slice(0, 5)) : ""}${e.location ? " · " + c.esc(e.location) : ""}</small>
        </div>${c.pill(e.event_type)}</div>`).join("") : `<p class="hint">No upcoming events.</p>`}
    </div>`;
  }

  /* -------------------------------- messages ---------------------------------- */

  async function pageMessages(c, content) {
    content.innerHTML = c.pageHead("Communication", "Messages", "Direct messages with your teachers and the school office.", `
      <button class="dash-btn dash-btn-primary" id="newMessage">${c.I.plus} New message</button>`);
    const list = document.createElement("div");
    list.className = "dash-card";
    content.appendChild(list);
    const renderList = async () => {
      list.innerHTML = `<div class="dash-card-pad">${c.loading()}</div>`;
      try {
        const data = await c.api.get("/communication/conversations");
        const rows = data.conversations || [];
        list.innerHTML = `<div class="dash-card-pad portal-rows">
          ${rows.length ? rows.map((conv) => `
            <div class="portal-row"><div class="portal-row-main">
              <strong>${c.esc(conv.subject || "(no subject)")}</strong>
              <small>${c.esc(conv.last_message || "")}</small>
              <small>${c.fmtDateTime(conv.updated_at)}${conv.unread_count ? ` · <b>${c.esc(conv.unread_count)} unread</b>` : ""}</small>
            </div><button class="dash-btn dash-btn-ghost dash-btn-sm" data-open-conversation="${c.esc(conv.id)}">Open</button></div>`).join("")
          : `<p class="hint">No conversations yet.</p>`}
        </div>`;
        list.querySelectorAll("[data-open-conversation]").forEach((b) => b.addEventListener("click", () => openConversation(Number(b.dataset.openConversation))));
      } catch (e) { list.innerHTML = `<div class="dash-card-pad">${c.errorState(e.message)}</div>`; }
    };
    const openConversation = async (id) => {
      const modal = c.openModal("Conversation", `<div class="dash-card-pad">${c.loading()}</div>`, { wide: true });
      try {
        const data = await c.api.get(`/communication/conversations/${id}`);
        modal.querySelector(".dash-modal-head h3").textContent = data.conversation.subject || "Conversation";
        modal.querySelector(".dash-modal-body").innerHTML = `
          <div class="portal-rows">
            ${(data.messages || []).map((m) => `
              <div class="portal-notif"><div class="portal-notif-body"><strong>${c.esc(m.sender_name || "—")}</strong>
                <p>${c.esc(m.body)}</p><small>${c.fmtDateTime(m.created_at)}</small></div></div>`).join("")}
          </div>`;
      } catch (e) { modal.querySelector(".dash-modal-body").innerHTML = c.errorState(e.message); }
    };
    const newMessage = async () => {
      let contacts = [];
      try { contacts = (await c.api.get("/portal/contacts")).contacts || []; }
      catch (e) { c.toast("Could not load contacts.", "error"); return; }
      const modal = c.openModal("New message", `
        <form id="newMessageForm">
          <div class="dash-form-grid">
            <div class="dash-field"><label>To *</label><select name="recipient" required><option value="">Select recipient</option>
              ${contacts.map((x) => `<option value="${c.esc(x.id)}">${c.esc(x.full_name)}${x.subjects ? " (" + c.esc(x.subjects) + ")" : ""}</option>`).join("")}
            </select></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Subject</label><input name="subject" maxlength="200"></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Message *</label><textarea name="body" rows="4" required></textarea></div>
          </div>
          <div class="dash-actions" style="margin-top:12px"><button class="dash-btn dash-btn-primary" type="submit">Send</button></div>
        </form>`);
      modal.querySelector("#newMessageForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await c.api.post("/communication/messages", {
            subject: fd.get("subject"), body: fd.get("body"), recipient_user_ids: [Number(fd.get("recipient"))],
          });
          c.toast("Message sent.", "success"); c.closeModal(); renderList();
        } catch (err) { c.toast(err.message || "Could not send the message.", "error"); }
      });
    };
    content.querySelector("#newMessage").addEventListener("click", newMessage);
    renderList();
  }

  /* -------------------------------- account ----------------------------------- */

  async function pageAccount(c, content) {
    let account = null;
    try { account = (await c.api.get("/auth/account")).account; } catch (e) { /* form still renders */ }
    content.innerHTML = c.pageHead("Settings", "My account", "Your profile details and password.", "");
    const grid = document.createElement("div");
    grid.className = "portal-grid-2";
    grid.innerHTML = `
      <div class="dash-card"><div class="dash-card-head"><h3>Profile</h3></div><div class="dash-card-pad">
        <form id="profileForm"><div class="dash-form-grid">
          <div class="dash-field"><label>Full name</label><input name="full_name" value="${c.esc(account ? account.full_name : "")}"></div>
          <div class="dash-field"><label>Email</label><input name="email" type="email" value="${c.esc(account ? account.email : "")}"></div>
          <div class="dash-field"><label>Phone</label><input name="phone" value="${c.esc(account ? account.phone : "")}"></div>
          <div class="dash-field"><label>Username</label><input value="${c.esc(account ? account.username : "")}" disabled></div>
        </div><div class="dash-actions" style="margin-top:12px"><button class="dash-btn dash-btn-primary" type="submit">${c.I.check} Save profile</button></div></form>
      </div></div>
      <div class="dash-card"><div class="dash-card-head"><h3>Change password</h3></div><div class="dash-card-pad">
        <form id="passwordForm"><div class="dash-form-grid">
          <div class="dash-field" style="grid-column:1/-1"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password"></div>
          <div class="dash-field" style="grid-column:1/-1"><label>New password (min 8 characters)</label><input name="newPassword" type="password" minlength="8" required autocomplete="new-password"></div>
        </div><div class="dash-actions" style="margin-top:12px"><button class="dash-btn dash-btn-primary" type="submit">Change password</button></div></form>
      </div></div>`;
    content.appendChild(grid);

    /* Students and staff can check their own card before anyone at a gate asks
       them to. Same code, same verification page, same camera. */
    if (window.EduScanner) {
      const cardHost = document.createElement("div");
      content.appendChild(cardHost);
      window.EduScanner.attachCardPanel(cardHost, { api: c.api });
    }

    /* The same account card an administrator sees. A student who joins a madrasa
       should be able to put a face on their own profile — and a teacher should be
       able to save the signature that prints on certificates — without waiting
       for someone else to do it for them. */
    if (window.EduProfile) {
      window.EduProfile.attachAccountCard(grid, {
        account: account || {},
        showSignature: false,
        hint: "Shown on your ID card and wherever your name is printed",
      });
    }
    grid.querySelector("#profileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target).entries());
      try { await c.api.put("/auth/account", payload); c.toast("Profile saved.", "success"); }
      catch (err) { c.toast(err.message || "Could not save the profile.", "error"); }
    });
    grid.querySelector("#passwordForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target).entries());
      try { await c.api.post("/auth/change-password", payload); c.toast("Password changed.", "success"); e.target.reset(); }
      catch (err) { c.toast(err.message || "Could not change the password.", "error"); }
    });
  }

  /* ----------------------------- online exams --------------------------------- */

  function examStatePill(c, e) {
    if (e.attempt && e.attempt.status !== "in_progress") {
      return `<span class="dash-pill ${e.attempt.status === "graded" ? "ok" : "info"}">${e.attempt.status === "graded" ? "Graded" : "Submitted"}</span>`;
    }
    if (e.attempt && e.attempt.status === "in_progress") return `<span class="dash-pill warn">In progress</span>`;
    if (e.state === "upcoming") return `<span class="dash-pill muted">Upcoming</span>`;
    if (e.state === "closed") return `<span class="dash-pill danger">Closed</span>`;
    return `<span class="dash-pill ok">Open</span>`;
  }

  async function pageOnlineExams(c, content) {
    content.innerHTML = c.pageHead("Academic", "Online examinations", "Examinations you take right here in the portal — timed, submitted and graded online.", "");
    const holder = document.createElement("div");
    content.appendChild(holder);
    (async () => {
      try {
        const data = await c.api.get("/portal/online-exams");
        const rows = data.exams || [];
        if (!rows.length) {
          holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.emptyState("academic", "No online examinations", "When your teachers publish an online examination for your class it will appear here.")}</div></div>`;
          return;
        }
        holder.innerHTML = `<div class="dash-card"><div class="dash-card-head"><h3>Your online examinations</h3><span class="hint">${rows.length} total</span></div>
          <div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Examination</th><th>Subject</th><th>Window</th><th>Marks</th><th>Status</th><th>Result</th><th></th></tr></thead>
            <tbody>${rows.map((e) => `<tr>
              <td><strong>${c.esc(e.title)}</strong><small>${e.question_count} question(s)</small></td>
              <td>${c.esc(e.subject_name || "—")}</td>
              <td>${c.fmtDate(e.exam_date)}<small>${c.esc(e.start_time || "")}–${c.esc(e.end_time || "")}</small></td>
              <td>${c.esc(e.total_marks)}</td>
              <td>${examStatePill(c, e)}</td>
              <td>${e.attempt && e.attempt.score != null ? `<strong>${c.esc(e.attempt.score)}</strong> / ${c.esc(e.total_marks)}` : (e.attempt ? "Pending" : "—")}</td>
              <td><div class="module-actions">
                ${e.can_take ? `<button class="dash-btn dash-btn-primary dash-btn-sm" data-exam-take="${e.id}">${e.attempt ? "Resume" : "Start"}</button>` : ""}
                ${e.attempt && e.attempt.status !== "in_progress" && (e.results_released || e.state === "closed") ? `<button class="dash-btn dash-btn-ghost dash-btn-sm" data-exam-review="${e.id}">Review</button>` : ""}
              </div></td>
            </tr>`).join("")}</tbody></table></div></div>`;
        holder.querySelectorAll("[data-exam-take]").forEach((b) => b.addEventListener("click", () => c.go(`online-exams/take/${b.dataset.examTake}`)));
        holder.querySelectorAll("[data-exam-review]").forEach((b) => b.addEventListener("click", () => c.go(`online-exams/review/${b.dataset.examReview}`)));
      } catch (e) {
        holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.errorState(e.message)}</div></div>`;
      }
    })();
  }

  /** The exam runner. Timing, saving and submission all go through the
      server; this page only renders state and never decides the rules. */
  async function pageTakeExam(c, content, route) {
    const examId = Number(String(route).split("/").pop()) || 0;
    content.innerHTML = c.pageHead("Academic", "Online examination", "Answer every question, save as you go, then submit before the timer ends.", "");
    const holder = document.createElement("div");
    content.appendChild(holder);
    let payload = null;
    try {
      payload = await c.api.post(`/portal/online-exams/${examId}/start`, {});
    } catch (e) {
      holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">
        <div class="dash-login-error" role="alert">${c.esc(e.message || "This examination cannot be opened.")}</div>
        <a class="dash-btn dash-btn-primary" href="#/student/online-exams">Back to online examinations</a>
      </div></div>`;
      return;
    }
    const exam = payload.exam, questions = payload.questions || [];
    const answers = new Map((payload.answers || []).map((a) => [Number(a.question_id), String(a.answer || "")]));
    // Server/client clock offset so the countdown matches the server's idea
    // of the remaining time, not the device's clock.
    const offset = Date.now() - new Date(payload.serverTime).getTime();
    const deadline = new Date(String(payload.attempt.expires_at).replace(" ", "T")).getTime();

    function parseOptions(q) {
      try { const o = JSON.parse(q.options || "[]"); return Array.isArray(o) ? o : []; } catch (e) { return []; }
    }
    function questionInputHtml(q) {
      const current = answers.get(Number(q.id)) || "";
      const name = `q_${q.id}`;
      if (q.question_type === "multiple_choice") {
        const opts = parseOptions(q);
        return opts.map((o, i) => `
          <label class="exam-option"><input type="radio" name="${name}" value="${c.esc(String(o))}" ${String(current) === String(o) ? "checked" : ""}>
          <span>${c.esc(String(o))}</span></label>`).join("");
      }
      if (q.question_type === "true_false") {
        return ["True", "False"].map((o) => `
          <label class="exam-option"><input type="radio" name="${name}" value="${o}" ${current === o ? "checked" : ""}><span>${o}</span></label>`).join("");
      }
      if (q.question_type === "long_answer" || q.question_type === "essay") {
        return `<textarea class="exam-answer-textarea" data-question="${q.id}" rows="5" placeholder="Write your answer…">${c.esc(current)}</textarea>`;
      }
      return `<input class="exam-answer-input" data-question="${q.id}" type="text" value="${c.esc(current)}" placeholder="Your answer">`;
    }

    holder.innerHTML = `
      <div class="exam-runner">
        <div class="exam-runner-bar">
          <div>
            <strong>${c.esc(exam.title)}</strong>
            <small>${c.esc(exam.subject_name || "")} · ${questions.length} question(s) · ${c.esc(exam.total_marks)} marks</small>
          </div>
          <div class="exam-timer" id="examTimer" role="timer" aria-live="off">--:--</div>
        </div>
        ${exam.instructions ? `<div class="exam-instructions"><strong>Instructions</strong><p>${c.esc(exam.instructions)}</p></div>` : ""}
        <div class="exam-navigator" id="examNavigator" aria-label="Question navigator">
          ${questions.map((q, i) => `<button type="button" class="exam-nav-chip" data-goto="q${q.id}">${i + 1}</button>`).join("")}
        </div>
        <div class="exam-questions" id="examQuestions">
          ${questions.map((q, i) => `
            <div class="exam-question" id="q${q.id}">
              <div class="exam-question-head"><strong>Question ${i + 1}</strong><span class="hint">${c.esc(q.marks)} mark(s) · ${c.esc(q.question_type.replace(/_/g, " "))}</span></div>
              <p class="exam-question-text">${c.esc(q.question_text)}</p>
              ${questionInputHtml(q)}
            </div>`).join("")}
        </div>
        <div class="exam-runner-actions">
          <button type="button" class="dash-btn dash-btn-ghost" id="examSave">Save progress</button>
          <button type="button" class="dash-btn dash-btn-primary" id="examSubmit">Submit examination</button>
        </div>
        <p class="hint" id="examSaveHint">Answers save when you press Save progress — submit before the timer reaches zero.</p>
      </div>`;

    const timerEl = holder.querySelector("#examTimer");
    let remaining = 0, timerHandle = null, finished = false;
    function paintTimer() {
      remaining = Math.max(0, deadline - (Date.now() - offset));
      const m = Math.floor(remaining / 60000), s = Math.floor((remaining % 60000) / 1000);
      timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      timerEl.classList.toggle("is-low", remaining < 5 * 60 * 1000);
      if (remaining <= 0 && !finished) { finished = true; submit(true); }
    }
    timerHandle = setInterval(paintTimer, 1000);
    paintTimer();

    holder.querySelectorAll(".exam-nav-chip").forEach((chip) => chip.addEventListener("click", () => {
      const target = holder.querySelector(`#${chip.dataset.goto}`);
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "center" });
    }));

    function collectAnswers() {
      const out = [];
      for (const q of questions) {
        if (q.question_type === "multiple_choice" || q.question_type === "true_false") {
          const picked = holder.querySelector(`input[name="q_${q.id}"]:checked`);
          answers.set(Number(q.id), picked ? picked.value : "");
        } else {
          const field = holder.querySelector(`[data-question="${q.id}"]`);
          answers.set(Number(q.id), field ? field.value : "");
        }
        const value = answers.get(Number(q.id));
        if (value !== undefined && value !== "") out.push({ question_id: Number(q.id), answer: String(value) });
      }
      return out;
    }

    async function saveAnswers() {
      if (finished) return;
      const payload2 = collectAnswers();
      const hint = holder.querySelector("#examSaveHint");
      try {
        await c.api.put(`/portal/online-exams/${examId}/answers`, { answers: payload2 });
        if (hint) hint.textContent = `Saved at ${new Date().toLocaleTimeString()}.`;
        holder.querySelectorAll(".exam-nav-chip").forEach((chip, i) => {
          const q = questions[i];
          chip.classList.toggle("is-answered", Boolean(answers.get(Number(q.id))));
        });
      } catch (e) {
        if (hint) hint.textContent = e.message || "Could not save — check your connection and press Save again.";
        if (e && e.status === 409) { finished = true; clearInterval(timerHandle); }
      }
    }

    async function submit(auto) {
      if (finished && !auto) return;
      if (!auto && !window.confirm("Submit this examination? You cannot change your answers afterwards.")) return;
      finished = true;
      clearInterval(timerHandle);
      const btn = holder.querySelector("#examSubmit");
      if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
      const saveBtn = holder.querySelector("#examSave");
      if (saveBtn) saveBtn.disabled = true;
      // Best effort: send the latest answers first so the graded paper holds
      // what is on screen, then lock it in.
      try { await c.api.put(`/portal/online-exams/${examId}/answers`, { answers: collectAnswers() }); } catch (e) { /* the submit below is the authority */ }
      let result = null, error = null;
      try { result = await c.api.post(`/portal/online-exams/${examId}/submit`, {}); }
      catch (e) { error = e; }
      holder.innerHTML = `
        <div class="dash-card"><div class="dash-card-pad exam-submit-card">
          ${error
            ? `<div class="dash-login-error" role="alert">${c.esc(error.message || "The examination could not be submitted.")}</div>`
            : `<div class="exam-submit-icon">${c.I.check}</div>
               <h3>${auto ? "Time ended — your saved answers were submitted" : "Examination submitted"}</h3>
               <p>${result && result.message ? c.esc(result.message) : ""}</p>
               ${result && result.score_visible
                 ? `<p class="exam-score-line">Your score: <strong>${c.esc(result.score)} / ${c.esc(result.total)}</strong>${result.score !== result.auto_score ? ` (auto-marked: ${c.esc(result.auto_score)})` : ""}</p>`
                 : `<p class="hint">Your score will be shown once the examination results are released.</p>`}`}
          <a class="dash-btn dash-btn-primary" href="#/student/online-exams">Back to online examinations</a>
        </div></div>`;
    }

    holder.querySelector("#examSave").addEventListener("click", saveAnswers);
    holder.querySelector("#examSubmit").addEventListener("click", () => submit(false));
    // Gentle autosave every 25 seconds so a dropped connection loses at most
    // a few seconds of typing. Both intervals stop themselves the moment the
    // runner is no longer on screen (route change), so nothing keeps firing
    // against a detached page.
    const autosaveHandle = setInterval(() => {
      if (!holder.isConnected) { clearInterval(autosaveHandle); clearInterval(timerHandle); return; }
      if (!finished) saveAnswers();
    }, 25000);
  }

  async function pageReviewExam(c, content, route) {
    const examId = Number(String(route).split("/").pop()) || 0;
    content.innerHTML = c.pageHead("Academic", "Examination review", "Your marked paper — answers, marks and the correct answers.", "");
    const holder = document.createElement("div");
    content.appendChild(holder);
    (async () => {
      try {
        const data = await c.api.get(`/portal/online-exams/${examId}/review`);
        const a = data.attempt;
        holder.innerHTML = `
          <div class="dash-stats-grid">
            ${c.statCard("academic", c.esc(a.score != null ? a.score : "—"), "Your score", "", `out of ${c.esc(data.exam.total_marks)}`)}
            ${c.statCard("check", c.esc(a.auto_score != null ? a.auto_score : "—"), "Auto-marked", "", "objective questions")}
            ${c.statCard("clock", c.fmtDateTime(a.submitted_at), "Submitted", "", data.attempt.status)}
          </div>
          <div class="dash-card"><div class="dash-card-head"><h3>${c.esc(data.exam.title)}</h3><span class="hint">${data.questions.length} question(s)</span></div>
            <div class="dash-card-pad">
              ${(data.questions || []).map((q, i) => `
                <div class="exam-review-question">
                  <div class="exam-question-head"><strong>Question ${i + 1}</strong>
                    <span class="hint">${c.esc(q.marks)} mark(s) · you scored ${c.esc(q.marks_awarded == null ? "—" : q.marks_awarded)}</span></div>
                  <p class="exam-question-text">${c.esc(q.question_text)}</p>
                  <p class="exam-review-line"><span>Your answer:</span> ${c.esc(q.answer || "—")}</p>
                  ${q.question_type === "multiple_choice" || q.question_type === "true_false" || q.question_type === "short_answer" || q.question_type === "fill_in_the_blank"
                    ? `<p class="exam-review-line"><span>Correct answer:</span> ${c.esc(q.correct_answer || "—")}</p>` : ""}
                  ${q.is_correct === 1 ? `<span class="dash-pill ok">Correct</span>` : q.is_correct === 0 ? `<span class="dash-pill danger">Incorrect</span>` : `<span class="dash-pill muted">Marked by teacher</span>`}
                  ${q.explanation ? `<p class="exam-review-explanation">${c.esc(q.explanation)}</p>` : ""}
                </div>`).join("")}
            </div></div>`;
      } catch (e) {
        holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">
          <div class="dash-login-error" role="alert">${c.esc(e.message || "This paper is not available for review.")}</div>
          <a class="dash-btn dash-btn-primary" href="#/student/online-exams">Back to online examinations</a>
        </div></div>`;
      }
    })();
  }

  /* -------------------------------- router ------------------------------------- */

  async function render(content, route, c) {
    const top = route.split("?")[0];
    if (top === "dashboard" || top === "") return pageDashboard(c, content);
    if (top === "timetable") return pageTimetable(c, content);
    if (top === "lessons") return pageLessons(c, content);
    if (top === "assignments" || top.startsWith("assignments/")) return pageAssignments(c, content, top);
    if (top === "exams") return pageExams(c, content);
    if (top === "online-exams") return pageOnlineExams(c, content);
    if (top.startsWith("online-exams/take/")) return pageTakeExam(c, content, top);
    if (top.startsWith("online-exams/review/")) return pageReviewExam(c, content, top);
    if (top === "results") return pageResults(c, content);
    if (top === "attendance") return pageAttendance(c, content);
    if (top === "fees") return pageFees(c, content);
    if (top === "library") return pageLibrary(c, content);
    if (top === "quran") return pageQuran(c, content);
    if (top === "calendar") return pageCalendar(c, content);
    if (top === "messages") return pageMessages(c, content);
    if (top === "notifications") return window.BelloPortal.renderNotifications(c, content);
    if (top === "account") return pageAccount(c, content);
    content.innerHTML = c.errorState("This page is not part of the student portal.");
  }

  window.BelloPortal.registerRole("student", { schema, render, pageTitle });
})();
