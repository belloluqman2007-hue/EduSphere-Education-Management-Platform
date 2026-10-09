"use strict";
/* ============================================================================
   EduSphere — Parent portal
   ----------------------------------------------------------------------------
   Mounted at /parent. A family dashboard: every page is about ONE selected
   child at a time (the switcher at the top), and the child relationship is
   re-validated by the server on every request — a child id from the browser
   is never trusted (see server/routes/portal.js: accessibleStudents).

   Reuses the same student-scoped endpoints with ?studentId=, plus the
   existing PTM booking module at /parent/meetings.
   ========================================================================== */
(function () {
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  function isIslamic() {
    return window.BelloPortal && window.BelloPortal.category ? window.BelloPortal.category() !== "western" : true;
  }

  /** The parent's children, from the shared /api/portal/me payload. */
  async function children(c) {
    const me = await c.api.get("/portal/me");
    return (me.children || []).map((ch) => Object.assign({}, ch, {
      name: `${ch.first_name} ${ch.last_name}`.trim(),
    }));
  }

  /** The currently selected child (validated server-side on every request). */
  function currentChild(c) {
    return (c.state.childrenCache || []).find((ch) => Number(ch.id) === Number(c.state.selectedChildId)) || (c.state.childrenCache || [])[0] || null;
  }

  function childSwitcher(c) {
    const kids = c.state.childrenCache || [];
    if (kids.length <= 1) return "";
    return `<div class="portal-child-switch" role="group" aria-label="Select child">
      <span class="portal-child-switch-label">Child</span>
      ${kids.map((ch) => `
        <button type="button" class="portal-child-chip${Number(currentChild(c) && currentChild(c).id) === Number(ch.id) ? " is-active" : ""}" data-child-select="${c.esc(ch.id)}">
          ${c.esc(ch.name)}<small>${c.esc(ch.classEn || ch.class_en || "No class")}</small>
        </button>`).join("")}
    </div>`;
  }

  function bindChildSwitcher(c, content, rerender) {
    content.querySelectorAll("[data-child-select]").forEach((btn) => btn.addEventListener("click", () => {
      c.state.selectedChildId = Number(btn.dataset.childSelect);
      rerender();
    }));
  }

  function schema() {
    const items = [
      { key: "dashboard", label: "Family Dashboard", icon: "dashboard", route: "dashboard" },
      { key: "attendance", label: "Attendance", icon: "check", route: "attendance" },
      { key: "results", label: "Results", icon: "academic", route: "results" },
      { key: "assignments", label: "Assignments", icon: "file", route: "assignments" },
      { key: "timetable", label: "Timetable", icon: "calendar", route: "timetable" },
      { key: "exams", label: "Exams", icon: "academic", route: "exams" },
      { key: "fees", label: "Fees", icon: "money", route: "fees" },
      { key: "meetings", label: "Book a Meeting", icon: "chat", route: "meetings" },
    ];
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
    dashboard: "Family Dashboard", attendance: "Child Attendance", results: "Child Results", assignments: "Child Assignments",
    timetable: "Class Timetable", exams: "Exam Timetable", fees: "School Fees", meetings: "Parent-Teacher Meetings",
    quran: "Qur'an Progress", calendar: "Calendar & Events", messages: "Messages", notifications: "Notifications", account: "My Account",
  };
  function pageTitle(route) {
    return PAGE_TITLES[route.split("/")[0]] || null;
  }

  /* ------------------------------ dashboard -------------------------------- */

  async function pageDashboard(c, content) {
    c.state.childrenCache = await children(c);
    const data = await c.api.get("/portal/dashboard");
    const kids = data.children || [];
    const me = data.user || {};
    content.innerHTML = `
      <div class="portal-welcome">
        <div>
          <h2>${c.esc(me.fullName || "Family dashboard")}</h2>
          <p>${kids.length} child(ren) · ${c.esc(data.madrasa ? data.madrasa.name_en : "")}</p>
        </div>
        <div class="portal-welcome-side">${c.esc(data.todayName)}, ${c.fmtDate(data.today)}${data.unreadNotifications ? `<br>${c.esc(data.unreadNotifications)} unread notification(s)` : ""}</div>
      </div>
      ${kids.length ? kids.map((k) => `
        <div class="dash-card" style="margin-bottom:16px">
          <div class="dash-card-head"><h3>${c.esc(k.name)}</h3><span class="hint">${c.esc(k.className || "No class")}${k.admissionNo ? " · " + c.esc(k.admissionNo) : ""}</span></div>
          <div class="dash-card-pad">
            <div class="dash-stats-grid" style="margin-bottom:0">
              ${c.statCard("check", k.attendancePct != null ? k.attendancePct + "%" : "—", "Attendance")}
              ${c.statCard("file", k.pendingAssignments.length, "Pending assignments", k.pendingAssignments.length ? "accent" : "")}
              ${c.statCard("academic", k.upcomingExams.length, "Upcoming exams")}
              ${c.statCard("money", c.fmtMoney(k.fee.balance), "Fee balance", k.fee.balance > 0 ? "accent" : "")}
            </div>
            <div class="dash-actions" style="margin-top:14px">
              <button class="dash-btn dash-btn-primary dash-btn-sm" data-child-focus="${c.esc(k.studentId)}" data-focus-page="results">Results</button>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-child-focus="${c.esc(k.studentId)}" data-focus-page="attendance">Attendance</button>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-child-focus="${c.esc(k.studentId)}" data-focus-page="fees">Fees</button>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-child-focus="${c.esc(k.studentId)}" data-focus-page="assignments">Assignments</button>
            </div>
          </div>
        </div>`).join("") : `<div class="dash-card"><div class="dash-card-pad">${c.emptyState("users", "No children linked", "Your account is not linked to any student yet. Contact the school office.")}</div></div>`}
      <div class="portal-grid-2">
        <div class="dash-card">
          <div class="dash-card-head"><h3>Announcements</h3></div>
          <div class="dash-card-pad portal-rows">${await announcementsHtml(c)}</div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Upcoming events</h3></div>
          <div class="dash-card-pad portal-rows">
            ${(data.events || []).length ? data.events.map((e) => `
              <div class="portal-row"><div class="portal-row-main"><strong>${c.esc(e.title)}</strong>
                <small>${c.fmtDate(e.start_date)}${e.start_time ? " · " + c.esc(String(e.start_time).slice(0, 5)) : ""}${e.location ? " · " + c.esc(e.location) : ""}</small></div>
                ${c.pill(e.event_type)}</div>`).join("") : `<p class="hint">No upcoming events.</p>`}
          </div>
        </div>
      </div>`;
    content.querySelectorAll("[data-child-focus]").forEach((btn) => btn.addEventListener("click", () => {
      c.state.selectedChildId = Number(btn.dataset.childFocus);
      c.go(btn.dataset.focusPage);
    }));
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

  /* ------------------------- child-scoped pages ---------------------------- */

  async function withChild(c, content, renderBody) {
    if (!c.state.childrenCache) c.state.childrenCache = await children(c);
    const child = currentChild(c);
    if (!child) {
      content.innerHTML = c.pageHead("Parent", "No child selected", "Link a child to your account first.", "");
      content.insertAdjacentHTML("beforeend", `<div class="dash-card"><div class="dash-card-pad">${c.emptyState("users", "No children linked", "Your account is not linked to any student yet. Contact the school office.")}</div></div>`);
      return;
    }
    content.innerHTML = childSwitcher(c);
    renderBody(child);
  }

  async function pageAttendance(c, content) {
    withChild(c, content, (child) => {
      const rerender = () => pageAttendance(c, content);
      bindChildSwitcher(c, content, rerender);
      content.insertAdjacentHTML("beforeend", c.pageHead("Parent", `Attendance — ${child.name}`, "Your child's attendance record (read-only).", ""));
      const holder = document.createElement("div");
      content.appendChild(holder);
      (async () => {
        try {
          const data = await c.api.get("/extras/my-attendance");
          const entry = (data.attendance || []).find((x) => Number(x.student.id) === Number(child.id));
          const records = (entry && entry.records) || [];
          const counts = (entry && entry.counts) || { present: 0, absent: 0, late: 0, excused: 0 };
          const total = records.length;
          const pct = total ? Math.round(((counts.present + counts.late + counts.excused) / total) * 1000) / 10 : null;
          holder.innerHTML = `
            <div class="dash-stats-grid">
              ${c.statCard("check", pct != null ? pct + "%" : "—", "Attendance")}
              ${c.statCard("check", counts.present, "Days present")}
              ${c.statCard("close", counts.absent, "Days absent", counts.absent ? "accent" : "")}
              ${c.statCard("clock", counts.late, "Days late", counts.late ? "accent" : "")}
            </div>
            <div class="dash-card"><div class="dash-card-head"><h3>Recent records</h3><span class="hint">Last ${records.length} day(s)</span></div>
              <div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Date</th><th>Status</th></tr></thead>
              <tbody>${records.length ? records.map((r) => `<tr><td>${c.fmtDate(r.day)}</td><td>${c.pill(r.status)}</td></tr>`).join("") : c.emptyRow(2, "No attendance recorded yet.")}</tbody></table></div></div>`;
        } catch (e) { holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.errorState(e.message)}</div></div>`; }
      })();
    });
  }

  async function pageResults(c, content) {
    withChild(c, content, (child) => {
      const rerender = () => pageResults(c, content);
      bindChildSwitcher(c, content, rerender);
      content.insertAdjacentHTML("beforeend", c.pageHead("Parent", `Results — ${child.name}`, "Published term results and report cards.", ""));
      const holder = document.createElement("div");
      content.appendChild(holder);
      (async () => {
        try {
          const data = await c.api.get(`/portal/results?studentId=${child.id}`);
          const terms = data.terms || [];
          if (!terms.length) {
            holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.emptyState("check", "No results yet", "Results will appear here once the school publishes them.")}</div></div>`;
            return;
          }
          const detail = document.createElement("div");
          detail.className = "dash-card";
          detail.style.marginTop = "16px";
          holder.innerHTML = `<div class="dash-card"><div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Session</th><th>Term</th><th>Average</th><th>Position</th><th>Published</th><th></th></tr></thead>
            <tbody>${terms.map((t) => `<tr>
              <td>${c.esc(t.session_label)}</td><td>${c.esc(t.term_name)}</td>
              <td>${t.total_average != null ? c.esc(t.total_average) + "%" : "—"}</td>
              <td>${t.position ? c.esc(t.position) : "—"}</td><td>${c.fmtDate(t.published_at)}</td>
              <td><div class="module-actions">
                <button class="dash-btn dash-btn-ghost dash-btn-sm" data-term-view="${c.esc(t.term_id)}">Subjects</button>
                <a class="dash-btn dash-btn-ghost dash-btn-sm" href="${c.api.portalReportUrl(t.term_id, child.id)}" target="_blank">Report sheet</a>
              </div></td></tr>`).join("")}</tbody></table></div></div>`;
          holder.appendChild(detail);
          const viewTerm = async (termId) => {
            detail.innerHTML = `<div class="dash-card-head"><h3>Subject results</h3></div><div class="dash-card-pad">${c.loading()}</div>`;
            try {
              const sub = await c.api.get(`/portal/results/${termId}?studentId=${child.id}`);
              detail.querySelector(".dash-card-pad").innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
                <thead><tr><th>Subject</th><th>CA</th><th>Exam</th><th>Total</th><th>%</th><th>Grade</th><th>Remark</th></tr></thead>
                <tbody>${(sub.subjects || []).length ? sub.subjects.map((s) => `<tr>
                  <td>${c.esc(s.nameEn)}</td><td>${c.esc(s.ca)}</td><td>${c.esc(s.exam)}</td><td>${c.esc(s.total)}</td>
                  <td>${c.esc(s.pct)}</td><td>${c.esc(s.grade)}</td><td>${c.esc(s.remark || "—")}</td></tr>`).join("") : c.emptyRow(7, "No subject results.")}</tbody></table></div>`;
            } catch (e) { detail.querySelector(".dash-card-pad").innerHTML = c.errorState(e.message); }
          };
          holder.querySelectorAll("[data-term-view]").forEach((b) => b.addEventListener("click", () => viewTerm(Number(b.dataset.termView))));
        } catch (e) { holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.errorState(e.message)}</div></div>`; }
      })();
    });
  }

  async function pageAssignments(c, content) {
    withChild(c, content, (child) => {
      const rerender = () => pageAssignments(c, content);
      bindChildSwitcher(c, content, rerender);
      content.insertAdjacentHTML("beforeend", c.pageHead("Parent", `Assignments — ${child.name}`, "Work set for your child's class. Parents follow progress; the student submits their own work.", ""));
      const holder = document.createElement("div");
      content.appendChild(holder);
      (async () => {
        try {
          const data = await c.api.get(`/portal/assignments?studentId=${child.id}`);
          const rows = data.assignments || [];
          const pending = rows.filter((a) => !a.submission && a.status === "published");
          const done = rows.filter((a) => a.submission);
          const card = (title, list) => `
            <div class="dash-card"><div class="dash-card-head"><h3>${c.esc(title)}</h3><span class="hint">${list.length}</span></div>
              <div class="dash-card-pad portal-rows">
                ${list.length ? list.map((a) => `
                  <div class="portal-row"><div class="portal-row-main">
                    <strong>${c.esc(a.title)}</strong>
                    <small>${c.esc(a.subject_name || "")} · due ${c.fmtDate(a.due_date)}</small>
                    ${a.submission ? `<small>Submitted ${c.fmtDate(a.submission.submittedAt)}${a.submission.score != null ? ` · score ${c.esc(a.submission.score)}/${c.esc(a.maximum_score)}` : ""}</small>` : ""}
                  </div>${a.submission && a.submission.status === "graded" ? c.pill("graded") : a.submission ? c.pill(a.submission.status) : c.pill("pending")}</div>`).join("") : `<p class="hint">Nothing here right now.</p>`}
              </div></div>`;
          const grid = document.createElement("div");
          grid.className = "portal-grid-2";
          grid.innerHTML = card("Outstanding", pending) + card("Submitted", done);
          holder.appendChild(grid);
        } catch (e) { holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.errorState(e.message)}</div></div>`; }
      })();
    });
  }

  async function pageTimetable(c, content) {
    withChild(c, content, (child) => {
      const rerender = () => pageTimetable(c, content);
      bindChildSwitcher(c, content, rerender);
      content.insertAdjacentHTML("beforeend", c.pageHead("Parent", `Timetable — ${child.name}`, "Your child's weekly class schedule.", ""));
      const holder = document.createElement("div");
      content.appendChild(holder);
      (async () => {
        try {
          const data = await c.api.get("/timetable/me");
          const mine = (data.students || []).find((s) => Number(s.studentId) === Number(child.id));
          const slots = (mine && mine.slots) || [];
          const periods = [...new Set(slots.map((s) => s.period))].sort((a, b) => a - b);
          const byDay = new Map(DAYS.map((d) => [d, new Map()]));
          slots.forEach((s) => { if (byDay.has(s.day)) byDay.get(s.day).set(Number(s.period), s); });
          holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">
            <table class="portal-timetable">
              <thead><tr><th style="width:110px">Day</th>${periods.map((p) => `<th>P${p}</th>`).join("")}</tr></thead>
              <tbody>${DAYS.map((day) => `<tr><th>${c.esc(day)}</th>${periods.map((p) => {
                const s = byDay.get(day).get(p);
                return `<td>${s ? `<span class="t-subject">${c.esc(s.subjectEn || s.subjectAr || "—")}</span><span class="t-meta">${c.esc(s.teacherName || "")}${s.room ? " · " + c.esc(s.room) : ""}</span>` : "—"}</td>`;
              }).join("")}</tr>`).join("")}</tbody>
            </table></div></div>`;
        } catch (e) { holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.errorState(e.message)}</div></div>`; }
      })();
    });
  }

  async function pageExams(c, content) {
    withChild(c, content, (child) => {
      const rerender = () => pageExams(c, content);
      bindChildSwitcher(c, content, rerender);
      content.insertAdjacentHTML("beforeend", c.pageHead("Parent", `Exams — ${child.name}`, "Scheduled examinations for your child's class.", ""));
      const holder = document.createElement("div");
      content.appendChild(holder);
      (async () => {
        try {
          const [data, online] = await Promise.all([
            c.api.get(`/portal/exams?studentId=${child.id}`),
            c.api.get(`/portal/online-exams?studentId=${child.id}`).catch(() => ({ exams: [] })),
          ]);
          const rows = data.exams || [];
          const onlineRows = (online.exams || []).filter((e) => e.mode !== undefined || e.question_count !== undefined);
          const onlineHtml = onlineRows.length ? `<div class="dash-card" style="margin-bottom:16px"><div class="dash-card-head"><h3>Online examinations</h3><span class="hint">taken in the student portal</span></div>
            <div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Examination</th><th>Subject</th><th>Window</th><th>Marks</th><th>Attempt</th><th>Score</th></tr></thead>
            <tbody>${onlineRows.map((e) => `<tr>
              <td><strong>${c.esc(e.title)}</strong></td><td>${c.esc(e.subject_name || "—")}</td>
              <td>${c.fmtDate(e.exam_date)}<small>${c.esc(e.start_time || "")}–${c.esc(e.end_time || "")}</small></td>
              <td>${c.esc(e.total_marks)}</td>
              <td>${e.attempt ? c.pill(e.attempt.status === "graded" ? "graded" : e.attempt.status === "in_progress" ? "pending" : "submitted") : `<span class="hint">${e.state === "upcoming" ? "Not started" : e.state === "closed" ? "Window closed" : "Open"}</span>`}</td>
              <td>${e.attempt && e.attempt.score != null ? `<strong>${c.esc(e.attempt.score)}</strong> / ${c.esc(e.total_marks)}` : "—"}</td>
            </tr>`).join("")}</tbody></table></div></div>` : "";
          holder.innerHTML = `${onlineHtml}<div class="dash-card"><div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Examination</th><th>Subject</th><th>Date</th><th>Time</th><th>Room</th><th>Status</th></tr></thead>
            <tbody>${rows.length ? rows.map((e) => `<tr>
              <td><strong>${c.esc(e.title)}</strong></td><td>${c.esc(e.subject_name || "—")}</td>
              <td>${c.fmtDate(e.exam_date)}</td>
              <td>${e.start_time ? `${c.esc(String(e.start_time).slice(0, 5))}${e.end_time ? "–" + c.esc(String(e.end_time).slice(0, 5)) : ""}` : "—"}</td>
              <td>${c.esc(e.classroom || "—")}</td><td>${c.pill(e.status)}</td></tr>`).join("") : c.emptyRow(6, "No examinations scheduled.")}</tbody></table></div></div>`;
        } catch (e) { holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.errorState(e.message)}</div></div>`; }
      })();
    });
  }

  async function pageFees(c, content, route) {
    withChild(c, content, (child) => {
      const rerender = () => pageFees(c, content, route);
      bindChildSwitcher(c, content, rerender);
      // The payment gateway returns to this page with ?payment=REF&status=…
      // (see /api/fees/payment/callback). Show the outcome banner and, while
      // the reference is still pending, poll the authoritative status.
      const qs = new URLSearchParams(String(route || "").split("?")[1] || "");
      const payRef = qs.get("payment"), payStatus = qs.get("status");
      content.insertAdjacentHTML("beforeend", c.pageHead("Parent", `School fees — ${child.name}`, "Fee statement, payment history, online payment and receipts.",
        `<button class="dash-btn dash-btn-primary" id="payOnlineBtn">${c.I.money} Pay online</button>`));
      const banner = document.createElement("div");
      if (payRef) content.appendChild(banner);
      const holder = document.createElement("div");
      content.appendChild(holder);
      const paintBanner = (status, receipt) => {
        if (!payRef) return;
        if (status === "successful") {
          banner.innerHTML = `<div class="dash-card"><div class="dash-card-pad dash-login-success" role="status">
            <strong>Payment successful.</strong> ${receipt ? `Receipt ${c.esc(receipt)} — download it below.` : "The receipt appears below once the record is written."}
          </div></div>`;
        } else if (status === "pending") {
          banner.innerHTML = `<div class="dash-card"><div class="dash-card-pad" role="status">
            <strong>Payment pending.</strong> Waiting for the payment provider to confirm reference ${c.esc(payRef)}… this page updates itself.
          </div></div>`;
        } else {
          banner.innerHTML = `<div class="dash-card"><div class="dash-card-pad dash-login-error" role="alert">
            <strong>Payment not completed.</strong> Reference ${c.esc(payRef)} did not go through. If you were debited, contact the school office with the reference.
          </div></div>`;
        }
      };
      (async () => {
        try {
          const data = await c.api.get(`/fees/student/${child.id}`);
          const payments = data.payments || [];
          const feeItems = (data.feeItems || []).filter((f) => f.outstanding > 0);
          const outstanding = Number(data.outstandingBalance || 0);
          holder.innerHTML = `
            <div class="dash-stats-grid">
              ${c.statCard("money", c.fmtMoney(data.totalFees), "Total billed")}
              ${c.statCard("check", c.fmtMoney(data.amountPaid), "Paid")}
              ${c.statCard("money", c.fmtMoney(outstanding), "Outstanding", outstanding > 0 ? "accent" : "")}
            </div>
            ${outstanding > 0 && feeItems.length ? `<div class="dash-card"><div class="dash-card-head"><h3>Outstanding fees</h3><span class="hint">pay online or at the school office</span></div>
              <div class="dash-table-wrap"><table class="dash-table">
                <thead><tr><th>Fee</th><th>Term</th><th>Due date</th><th>Billed</th><th>Paid</th><th>Outstanding</th></tr></thead>
                <tbody>${feeItems.map((f) => `<tr>
                  <td><strong>${c.esc(f.name)}</strong></td><td>${c.esc(f.term_name || "—")}</td><td>${c.fmtDate(f.due_date)}</td>
                  <td>${c.fmtMoney(f.amount_due)}</td><td>${c.fmtMoney(f.amount_paid)}</td><td><strong>${c.fmtMoney(f.outstanding)}</strong></td>
                </tr>`).join("")}</tbody></table></div></div>` : ""}
            <div class="dash-card"><div class="dash-card-head"><h3>Payments</h3><span class="hint">${payments.length} record(s)</span></div>
              <div class="dash-table-wrap"><table class="dash-table">
                <thead><tr><th>Date</th><th>Fee</th><th>Method</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead>
                <tbody>${payments.length ? payments.map((p) => `<tr>
                  <td>${c.fmtDate(p.payment_date)}</td><td>${c.esc(p.fee_name || "—")}</td><td>${c.esc(p.method || "—")}</td>
                  <td>${c.fmtMoney(p.amount_ngn)}</td><td>${c.pill(p.status)}</td>
                  <td>${p.receipt_number ? `<a class="dash-btn dash-btn-ghost dash-btn-sm" href="${c.api.url(`/fees/payments/${p.id}/receipt`)}" target="_blank">${c.I.download} Receipt</a>` : (p.reference ? `<small>${c.esc(p.reference)}</small>` : "—")}</td></tr>`).join("") : c.emptyRow(6, "No payments recorded yet.")}</tbody></table></div></div>`;
        } catch (e) { holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.errorState(e.message)}</div></div>`; }
      })();
      // Payment status follow-up: the query param says what the callback saw,
      // but the STATUS endpoint is the authority while a payment settles.
      if (payRef) {
        let rounds = 0;
        const poll = async () => {
          rounds += 1;
          try {
            const st = await c.api.get(`/fees/payment/status/${encodeURIComponent(payRef)}`);
            const status = st.payment && st.payment.status;
            paintBanner(status, st.payment && st.payment.receipt_number);
            if (status === "pending" && rounds < 12) setTimeout(poll, 5000);
          } catch (e) { paintBanner(payStatus || "failed", null); }
        };
        paintBanner(payStatus || "pending", null);
        if (payStatus === "pending" || !payStatus) poll();
      }
      // Pay online: the server validates the child link, creates a PENDING
      // payment row and hands back the provider's checkout URL. The payment
      // is only marked successful by the provider webhook/callback — never
      // by this page.
      const payBtn = content.querySelector("#payOnlineBtn");
      if (payBtn) payBtn.addEventListener("click", async () => {
        let items = [];
        let outstandingNow = 0;
        try {
          const data = await c.api.get(`/fees/student/${child.id}`);
          items = (data.feeItems || []).filter((f) => f.outstanding > 0);
          outstandingNow = Number(data.outstandingBalance || 0);
        } catch (e) { /* the modal still works with a manual amount */ }
        const modal = c.openModal("Pay school fees online", `
          <form id="payOnlineForm">
            <p class="hint">You will be taken to the payment provider's secure checkout. The school only records the payment once the provider confirms it.</p>
            <div class="dash-field"><label>Fee *</label><select name="fee_item_id" required>
              ${items.length ? items.map((f) => `<option value="${c.esc(f.id)}" data-outstanding="${c.esc(f.outstanding)}">${c.esc(f.name)} — outstanding ${c.fmtMoney(f.outstanding)}</option>`).join("") : `<option value="">No fee items with an outstanding balance</option>`}
            </select></div>
            <div class="dash-field"><label>Amount (₦) *</label><input name="amount_ngn" type="number" min="1" step="0.01" required value="${items.length ? Math.max(1, Math.floor(items[0].outstanding)) : ""}"></div>
            <button class="dash-btn dash-btn-primary" type="submit" style="margin-top:12px">${c.I.money} Continue to payment</button>
          </form>`);
        const form = modal.querySelector("#payOnlineForm");
        const feeSelect = form.querySelector("select[name=fee_item_id]");
        const amountInput = form.querySelector("input[name=amount_ngn]");
        if (feeSelect) feeSelect.addEventListener("change", () => {
          const opt = feeSelect.selectedOptions[0];
          if (opt && opt.dataset.outstanding) amountInput.value = Math.max(1, Math.floor(Number(opt.dataset.outstanding)));
        });
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = form.querySelector("button[type=submit]");
          btn.disabled = true; btn.textContent = "Opening checkout…";
          try {
            const payload = Object.fromEntries(new FormData(form).entries());
            const r = await c.api.post("/fees/payment/initiate", {
              student_id: child.id, fee_item_id: Number(payload.fee_item_id), amount_ngn: Number(payload.amount_ngn),
            });
            if (r && r.payment_url) window.location.href = r.payment_url;
            else { c.toast("The payment provider did not return a checkout link.", "error"); btn.disabled = false; btn.textContent = "Continue to payment"; }
          } catch (err2) {
            c.toast(err2.message || "Could not start the payment.", "error");
            btn.disabled = false; btn.textContent = "Continue to payment";
          }
        });
      });
    });
  }

  async function pageMeetings(c, content) {
    content.innerHTML = c.pageHead("Parent", "Parent-Teacher Meetings", "Book a meeting with your child's teachers.", `
      <a class="dash-btn dash-btn-primary" href="/parent/meetings">Open the booking page</a>`);
    content.insertAdjacentHTML("beforeend", `
      <div class="dash-card"><div class="dash-card-pad">
        <p>The meeting booking flow has its own page, so you can bookmark it and come back directly:</p>
        <p><a class="dash-btn dash-btn-primary" href="/parent/meetings">Book a meeting</a></p>
        <p class="hint">Choose your child, pick one of their teachers and reserve a time. Both you and the teacher are notified, and you can cancel from the same page.</p>
      </div></div>`);
  }

  async function pageQuran(c, content) {
    withChild(c, content, (child) => {
      const rerender = () => pageQuran(c, content);
      bindChildSwitcher(c, content, rerender);
      content.insertAdjacentHTML("beforeend", c.pageHead("Parent", `Qur'an progress — ${child.name}`, "Memorization, revision and Tajweed progress recorded by the teachers.", ""));
      const holder = document.createElement("div");
      content.appendChild(holder);
      (async () => {
        let data;
        try { data = await c.api.get("/quran-progress/me"); }
        catch (e) {
          holder.innerHTML = `<div class="dash-card"><div class="dash-card-pad">${c.emptyState("book", "Qur'an progress is not available", "Your school has not enabled Qur'an progress tracking.")}</div></div>`;
          return;
        }
        const records = (data.records || []).filter((r) => Number(r.student_id) === Number(child.id));
        holder.innerHTML = `<div class="dash-card"><div class="dash-table-wrap"><table class="dash-table">
          <thead><tr><th>Date</th><th>Surah / Juz</th><th>Ayah</th><th>Memorization</th><th>Revision</th><th>Tajweed</th><th>Status</th></tr></thead>
          <tbody>${records.length ? records.map((r) => `<tr>
            <td>${c.fmtDate(r.progress_date)}</td>
            <td><strong>${c.esc(r.surah || r.juz || "—")}</strong></td>
            <td>${c.esc(r.ayah_from || "—")}${r.ayah_to ? "–" + c.esc(r.ayah_to) : ""}</td>
            <td>${c.esc(r.memorization_progress)}%</td><td>${c.esc(r.revision_progress)}%</td>
            <td>${r.tajweed_assessment ? c.esc(r.tajweed_assessment) + "/5" : "—"}</td>
            <td>${c.pill(r.performance_status)}</td></tr>`).join("") : c.emptyRow(7, "No Qur'an progress records yet.")}</tbody></table></div></div>`;
      })();
    });
  }

  /* --------------------------- shared pages --------------------------------- */

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

  async function pageMessages(c, content) {
    content.innerHTML = c.pageHead("Communication", "Messages", "Direct messages with your children's teachers and the school office.", `
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

  /* -------------------------------- router ----------------------------------- */

  async function render(content, route, c) {
    const top = route.split("?")[0];
    if (top === "dashboard" || top === "") return pageDashboard(c, content);
    if (top === "attendance") return pageAttendance(c, content);
    if (top === "results") return pageResults(c, content);
    if (top === "assignments") return pageAssignments(c, content);
    if (top === "timetable") return pageTimetable(c, content);
    if (top === "exams") return pageExams(c, content);
    if (top === "fees") return pageFees(c, content, route);
    if (top === "meetings") return pageMeetings(c, content);
    if (top === "quran") return pageQuran(c, content);
    if (top === "calendar") return pageCalendar(c, content);
    if (top === "messages") return pageMessages(c, content);
    if (top === "notifications") return window.BelloPortal.renderNotifications(c, content);
    if (top === "account") return pageAccount(c, content);
    content.innerHTML = c.errorState("This page is not part of the parent portal.");
  }

  window.BelloPortal.registerRole("parent", { schema, render, pageTitle });
})();
