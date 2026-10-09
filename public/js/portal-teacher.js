"use strict";
/* ============================================================================
   EduSphere — Teacher workspace
   ----------------------------------------------------------------------------
   The teacher's complete professional workspace, mounted at /teacher. It
   renders inside the shared portal shell (portal.js) and talks only to the
   existing teacher-scoped API:
     /api/teachers/dashboard        /api/teachers/me/assignments
     /api/timetable/me              /api/attendance(/mark|/history|/student/:id)
     /api/academic/lessons          /api/academic/assignments(+submissions)
     /api/academic/exams(+marks)    /api/results/roster + /workflow
     /api/leave/me                  /api/library/my-loans
     /api/communication/*           /api/calendar
   The server enforces assignment scoping on every one of these — this file
   only decides what to render.
   ========================================================================== */
(function () {
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  function schema() {
    return [
      { key: "dashboard", label: "Dashboard", icon: "dashboard", route: "dashboard" },
      { key: "classes", label: "My Classes", icon: "classes", route: "classes" },
      { key: "timetable", label: "Timetable", icon: "calendar", route: "timetable" },
      { key: "attendance", label: "Attendance", icon: "check", route: "attendance" },
      { key: "lessons", label: "Lesson Plans", icon: "book", route: "lessons" },
      { key: "assignments", label: "Assignments", icon: "file", route: "assignments" },
      { key: "exams", label: "Examinations", icon: "academic", route: "exams" },
      { key: "results", label: "Results", icon: "check", route: "results" },
      { key: "calendar", label: "Calendar", icon: "calendar", route: "calendar" },
      { key: "messages", label: "Messages", icon: "chat", route: "messages" },
      { key: "notifications", label: "Notifications", icon: "bell", route: "notifications" },
      { key: "leave", label: "My Leave", icon: "leave", route: "leave" },
      { key: "library", label: "My Library", icon: "book", route: "library" },
      { key: "account", label: "My Account", icon: "settings", route: "account" },
    ];
  }

  const PAGE_TITLES = {
    dashboard: "Today", classes: "My Classes", timetable: "My Timetable", attendance: "Attendance Register",
    lessons: "Lesson Plans", assignments: "Assignments", exams: "Examinations", results: "Results Workbook",
    calendar: "Calendar & Events", messages: "Messages", notifications: "Notifications",
    leave: "My Leave", library: "My Library Loans", account: "My Account",
  };
  function pageTitle(route) {
    const top = route.split("/")[0];
    if (route.startsWith("classes/")) return "Class Detail";
    return PAGE_TITLES[top] || null;
  }

  /* ------------------------------- shared -------------------------------- */

  async function loadAssignments(c) {
    const data = await c.api.get("/teachers/me/assignments");
    return data;
  }

  /* ------------------------------ dashboard ------------------------------ */

  async function pageDashboard(c, content) {
    const data = await c.api.get("/teachers/dashboard");
    const d = c.state.me;
    content.innerHTML = `
      <div class="portal-welcome">
        <div>
          <h2>${c.esc(d.user ? (d.user.fullName || d.user.username) : "Teacher")}</h2>
          <p>${c.esc(data.todayName)}, ${c.fmtDate(data.today)}${data.nextSlot ? ` · Next class: ${c.esc(data.nextSlot.subject_name || data.nextSlot.class_name)} at ${c.esc(String(data.nextSlot.start_time).slice(0, 5))}` : ""}</p>
        </div>
        <div class="portal-welcome-side">${c.esc(c.state.institution ? c.state.institution.nameEn : "")}<br>${c.esc(data.classes.length)} class(es) · ${c.esc(data.subjects.length)} subject(s)</div>
      </div>
      <div class="dash-stats-grid">
        ${c.statCard("classes", data.classes.length, "Assigned classes")}
        ${c.statCard("users", data.classes.reduce((n, x) => n + Number(x.student_count || 0), 0), "Students in my classes")}
        ${c.statCard("check", data.attendancePending.length, "Attendance pending today", data.attendancePending.length ? "accent" : "")}
        ${c.statCard("file", data.assignmentsPending.reduce((n, x) => n + Number(x.ungraded || 0), 0), "Submissions to grade", data.assignmentsPending.length ? "accent" : "")}
      </div>
      <div class="portal-grid-2">
        <div class="dash-card">
          <div class="dash-card-head"><h3>Today's classes</h3><span class="hint">${c.esc(data.todayName)}</span></div>
          <div class="dash-card-pad portal-rows">
            ${data.todaySlots.length ? data.todaySlots.map((s) => `
              <div class="portal-row">
                <div class="portal-row-main"><strong>P${c.esc(s.period)} · ${c.esc(s.subject_name || s.subject_ar || "Lesson")}</strong>
                  <small>${c.esc(s.class_name)}${s.room ? " · " + c.esc(s.room) : ""} · ${c.esc(String(s.start_time).slice(0, 5))}–${c.esc(String(s.end_time).slice(0, 5))}</small></div>
                ${s.class_id ? `<a class="dash-btn dash-btn-ghost dash-btn-sm" href="#/teacher/attendance?classId=${c.esc(s.class_id)}">Register</a>` : ""}
              </div>`).join("") : `<p class="hint">No classes scheduled today.</p>`}
          </div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Work awaiting me</h3></div>
          <div class="dash-card-pad portal-rows">
            ${data.attendancePending.length ? `<div class="portal-row"><div class="portal-row-main"><strong>Attendance not marked</strong><small>${c.esc(data.attendancePending.length)} class(es) with a lesson today</small></div></div>` : ""}
            ${data.assignmentsPending.map((a) => `
              <div class="portal-row"><div class="portal-row-main"><strong>${c.esc(a.title)}</strong>
                <small>${c.esc(a.ungraded)} submission(s) to grade · ${c.esc(a.class_name || "")}${a.due_date ? " · due " + c.fmtDate(a.due_date) : ""}</small></div>
                <a class="dash-btn dash-btn-ghost dash-btn-sm" href="#/teacher/assignments">Open</a></div>`).join("")}
            ${!data.attendancePending.length && !data.assignmentsPending.length ? `<p class="hint">Nothing pending — results entered: ${c.esc(data.resultCounts.draft)} draft · ${c.esc(data.resultCounts.submitted)} submitted · ${c.esc(data.resultCounts.returned)} returned for correction.</p>` : ""}
            ${data.resultCounts.returned ? `<div class="portal-row"><div class="portal-row-main"><strong>Results returned for correction</strong><small>${c.esc(data.resultCounts.returned)} entry(ies) need correction and resubmission</small></div><a class="dash-btn dash-btn-ghost dash-btn-sm" href="#/teacher/results">Results</a></div>` : ""}
          </div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Announcements</h3></div>
          <div class="dash-card-pad portal-rows">
            ${data.announcements.length ? data.announcements.map((a) => `
              <div class="portal-row"><div class="portal-row-main"><strong>${c.esc(a.title)}</strong><small>${c.fmtDate(a.created_at)}</small>
                <p style="margin:4px 0 0;font-size:.82rem;color:var(--d-muted)">${c.esc(String(a.body || "").slice(0, 160))}</p></div></div>`).join("")
              : `<p class="hint">No announcements.</p>`}
          </div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Upcoming events</h3></div>
          <div class="dash-card-pad portal-rows">
            ${data.events.length ? data.events.map((e) => `
              <div class="portal-row"><div class="portal-row-main"><strong>${c.esc(e.title)}</strong>
                <small>${c.fmtDate(e.start_date)}${e.start_time ? " · " + c.esc(String(e.start_time).slice(0, 5)) : ""}${e.location ? " · " + c.esc(e.location) : ""}</small></div>
                ${c.pill(e.event_type)}</div>`).join("")
              : `<p class="hint">No upcoming events on the calendar.</p>`}
          </div>
        </div>
      </div>`;
  }

  /* ------------------------------- classes -------------------------------- */

  async function pageClasses(c, content, route) {
    const detailMatch = route.match(/^classes\/(\d+)$/);
    if (detailMatch) return pageClassDetail(c, content, Number(detailMatch[1]));
    const data = await loadAssignments(c);
    const classMap = new Map(data.classes.map((cl) => [Number(cl.id), cl]));
    const subjectByClass = new Map();
    for (const pair of data.subjects || []) {
      if (!subjectByClass.has(pair.classId)) subjectByClass.set(pair.classId, []);
      subjectByClass.get(pair.classId).push(pair.subject);
    }
    // Student counts in one query per class list render is avoided: reuse the
    // dashboard aggregate when it is cached, else fetch per class on open.
    content.innerHTML = c.pageHead("Teaching", "My classes", "Only the classes you are assigned to teach.", "");
    const grid = document.createElement("div");
    grid.className = "dash-grid-3";
    content.appendChild(grid);
    grid.innerHTML = data.classes.length ? data.classes.map((cl) => `
      <div class="dash-card"><div class="dash-card-pad">
        <h3 style="margin:0 0 6px;font-size:1rem">${c.esc(cl.name_en)}${cl.name_ar ? ` · <span dir="rtl">${c.esc(cl.name_ar)}</span>` : ""}</h3>
        <p class="hint" style="margin:0 0 10px">${c.esc((subjectByClass.get(Number(cl.id)) || []).map((s) => s ? s.name_en : "").filter(Boolean).join(", ") || cl.education_track || "")}</p>
        <a class="dash-btn dash-btn-primary dash-btn-sm" href="#/teacher/classes/${c.esc(cl.id)}">Open class</a>
      </div></div>`).join("") : `<div class="dash-card"><div class="dash-card-pad">${c.emptyState("classes", "No classes assigned yet", "The administration will appear here once you are assigned classes and subjects.")}</div></div>`;
  }

  async function pageClassDetail(c, content, classId) {
    const roster = await c.api.get(`/classes/${classId}/students`);
    const cls = roster.class || {};
    const students = (roster.students || []).filter((s) => ["active", "promoted", "suspended"].includes(String(s.status)));
    content.innerHTML = c.pageHead("Teaching", cls.name_en || "Class", `${students.length} student(s)`, `
      <a class="dash-btn dash-btn-ghost" href="#/teacher/classes">Back to classes</a>
      <a class="dash-btn dash-btn-primary" href="#/teacher/attendance?classId=${c.esc(classId)}">Mark attendance</a>`);
    content.insertAdjacentHTML("beforeend", `
      <div class="dash-card"><div class="dash-card-head"><h3>Student list</h3><span class="hint">${students.length} active</span></div>
        <div class="dash-table-wrap"><table class="dash-table">
          <thead><tr><th>Admission no</th><th>Name</th><th>Gender</th><th>Parent contact</th></tr></thead>
          <tbody>${students.length ? students.map((s) => `
            <tr><td>${c.esc(s.admission_no || "—")}</td>
                <td><strong>${c.esc(`${s.first_name || ""} ${s.last_name || ""}`.trim())}</strong>${s.name_ar ? ` <small dir="rtl">${c.esc(s.name_ar)}</small>` : ""}</td>
                <td>${c.esc(s.gender || "—")}</td>
                <td>${c.esc(s.parent_phone || s.parent_email || "—")}</td></tr>`).join("")
            : c.emptyRow(4, "No active students in this class.")}</tbody>
        </table></div></div>`);
  }

  /* ------------------------------ timetable ------------------------------- */

  async function pageTimetable(c, content) {
    const data = await c.api.get("/timetable/me");
    const slots = data.slots || [];
    content.innerHTML = c.pageHead("Teaching", "My timetable", "Your teaching week, from the institution timetable.", "");
    const byDay = new Map(DAYS.map((d) => [d, []]));
    slots.forEach((s) => { if (byDay.has(s.day)) byDay.get(s.day).push(s); });
    content.insertAdjacentHTML("beforeend", `
      <div class="dash-card"><div class="dash-card-pad">
        <table class="portal-timetable">
          <thead><tr><th style="width:110px">Day</th><th>Periods</th></tr></thead>
          <tbody>${DAYS.map((day) => {
            const rows = byDay.get(day);
            return `<tr><th>${c.esc(day)}</th><td>${rows.length ? rows.map((s) => `
              <div style="margin-bottom:6px"><span class="t-subject">P${c.esc(s.period)} · ${c.esc(s.subjectEn || s.subjectAr || "Lesson")} — ${c.esc(s.className)}</span>
              <span class="t-meta">${c.esc(String(s.startTime || "").slice(0, 5))}–${c.esc(String(s.endTime || "").slice(0, 5))}${s.room ? " · " + c.esc(s.room) : ""}</span></div>`).join("")
              : `<span class="t-meta">—</span>`}</td></tr>`;
          }).join("")}</tbody>
        </table></div></div>`);
  }

  /* ------------------------------ attendance ------------------------------ */

  async function pageAttendance(c, content) {
    const data = await loadAssignments(c);
    const hash = window.location.hash || "";
    const presetClass = Number((hash.match(/classId=(\d+)/) || [])[1] || 0);
    const classes = data.classes || [];
    content.innerHTML = c.pageHead("Teaching", "Attendance register", "Mark, edit and review attendance for your classes.", "");
    const toolbar = document.createElement("div");
    toolbar.className = "dash-card";
    toolbar.innerHTML = `<div class="dash-card-pad"><div class="dash-form-grid">
      <div class="dash-field"><label>Class</label><select id="attClass"><option value="">Select class</option>${c.options(classes)}</select></div>
      <div class="dash-field"><label>Date</label><input id="attDate" type="date" value="${c.todayIso()}"></div>
      <div class="dash-field" style="align-self:end"><button class="dash-btn dash-btn-primary" id="attLoad">Load register</button></div>
      <div class="dash-field" style="align-self:end"><button class="dash-btn dash-btn-ghost" id="attHistory">Attendance history</button></div>
    </div></div>`;
    content.appendChild(toolbar);
    const panel = document.createElement("div");
    panel.className = "dash-card";
    panel.style.marginTop = "16px";
    content.appendChild(panel);
    if (presetClass) toolbar.querySelector("#attClass").value = String(presetClass);

    const loadRegister = async () => {
      const classId = Number(toolbar.querySelector("#attClass").value || 0);
      const date = toolbar.querySelector("#attDate").value;
      if (!classId || !date) { panel.innerHTML = `<div class="dash-card-pad"><p class="hint">Choose a class and a date.</p></div>`; return; }
      panel.innerHTML = `<div class="dash-card-pad">${c.loading()}</div>`;
      try {
        const reg = await c.api.get(`/attendance?classId=${classId}&date=${date}`);
        const students = reg.students || [];
        const statuses = ["present", "absent", "late", "excused"];
        panel.innerHTML = `
          <div class="dash-card-head"><h3>${c.esc(reg.class ? reg.class.name_en : "Register")} — ${c.fmtDate(date)}</h3>
            <div class="dash-actions">
              <button class="dash-btn dash-btn-ghost dash-btn-sm" id="attAllPresent">Mark all present</button>
              <button class="dash-btn dash-btn-primary dash-btn-sm" id="attSave">Save register</button>
            </div></div>
          <div class="dash-card-pad portal-attendance-grid">
            ${students.length ? students.map((s) => `
              <div class="portal-attendance-row" data-att-student="${c.esc(s.id)}">
                <span class="who">${c.esc(`${s.first_name} ${s.last_name}`.trim())}<small>${c.esc(s.admission_no || "")}</small></span>
                <span class="portal-status-group" role="group" aria-label="Attendance status">
                  ${statuses.map((st) => `<button type="button" data-status="${st}" class="${s.status === st ? "is-" + st : ""}">${st}</button>`).join("")}
                </span>
                <input class="note" placeholder="Note (optional)" value="${c.esc(s.attendance_note || "")}" aria-label="Attendance note">
              </div>`).join("") : `<p class="hint">No active students in this class.</p>`}
          </div>`;
        const selected = new Map(students.map((s) => [String(s.id), s.status || ""]));
        panel.querySelectorAll(".portal-status-group button").forEach((btn) => btn.addEventListener("click", () => {
          const row = btn.closest("[data-att-student]");
          const sid = row.getAttribute("data-att-student");
          if (btn.classList.contains("is-present") || btn.classList.contains("is-absent") || btn.classList.contains("is-late") || btn.classList.contains("is-excused")) {
            // toggling off is not allowed — a status is always chosen
            return;
          }
          row.querySelectorAll(".portal-status-group button").forEach((b) => b.className = "");
          btn.className = "is-" + btn.dataset.status;
          selected.set(sid, btn.dataset.status);
        }));
        panel.querySelector("#attAllPresent").addEventListener("click", () => {
          panel.querySelectorAll("[data-att-student]").forEach((row) => {
            row.querySelectorAll(".portal-status-group button").forEach((b) => b.className = "");
            row.querySelector('[data-status="present"]').className = "is-present";
            selected.set(row.getAttribute("data-att-student"), "present");
          });
        });
        panel.querySelector("#attSave").addEventListener("click", async () => {
          const statusesOut = {}; const notes = {};
          panel.querySelectorAll("[data-att-student]").forEach((row) => {
            const sid = row.getAttribute("data-att-student");
            const active = row.querySelector(".portal-status-group button[class*='is-']");
            if (active) statusesOut[sid] = active.dataset.status;
            const note = row.querySelector("input.note");
            if (note && note.value.trim()) notes[sid] = note.value.trim();
          });
          if (!Object.keys(statusesOut).length) return c.toast("Choose a status for at least one student.", "error");
          try {
            const saved = await c.api.post("/attendance/mark", { classId, date, statuses: statusesOut, notes });
            c.toast(`Attendance saved (${saved.saved} student(s)).`, "success");
            loadRegister();
          } catch (e) { c.toast(e.message || "Could not save attendance.", "error"); }
        });
      } catch (e) {
        panel.innerHTML = `<div class="dash-card-pad">${c.errorState(e.message)}</div>`;
      }
    };
    toolbar.querySelector("#attLoad").addEventListener("click", loadRegister);
    toolbar.querySelector("#attHistory").addEventListener("click", async () => {
      const classId = Number(toolbar.querySelector("#attClass").value || 0);
      if (!classId) return c.toast("Choose a class first.", "error");
      try {
        const hist = await c.api.get(`/attendance/history?classId=${classId}&limit=2000`);
        // Aggregate the raw register into per-day counts for the modal table.
        const byDay = new Map();
        for (const r of hist.records || []) {
          const day = String(r.day).slice(0, 10);
          if (!byDay.has(day)) byDay.set(day, { present: 0, absent: 0, late: 0, excused: 0 });
          const entry = byDay.get(day);
          if (entry[r.status] !== undefined) entry[r.status]++;
        }
        const days = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1);
        c.openModal("Attendance history", `<div class="dash-table-wrap"><table class="dash-table">
          <thead><tr><th>Date</th><th>Present</th><th>Absent</th><th>Late</th><th>Excused</th></tr></thead>
          <tbody>${days.length ? days.map(([day, n]) => `<tr><td>${c.fmtDate(day)}</td><td>${n.present}</td><td>${n.absent}</td><td>${n.late}</td><td>${n.excused}</td></tr>`).join("") : c.emptyRow(5, "No attendance recorded yet.")}</tbody>
        </table></div>`, { wide: true });
      } catch (e) { c.toast(e.message || "Could not load history.", "error"); }
    });
    if (presetClass) loadRegister();
  }

  /* -------------------------- lessons & assignments ------------------------ */

  async function pageLessons(c, content) {
    const data = await c.api.get("/academic/lessons?perPage=50");
    const rows = data.lessons || [];
    content.innerHTML = c.pageHead("Teaching", "Lesson plans", "Plan, publish and complete your lessons.", `
      <button class="dash-btn dash-btn-primary" id="newLesson">${c.I.plus} New lesson</button>`);
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    const renderRows = () => {
      card.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Topic</th><th>Class / subject</th><th>Date</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((l) => `<tr>
          <td><strong>${c.esc(l.title)}</strong>${l.topic ? `<small>${c.esc(l.topic)}</small>` : ""}</td>
          <td>${c.esc(l.class_name || "—")} / ${c.esc(l.subject_name || "—")}</td>
          <td>${c.fmtDate(l.lesson_date)}</td><td>${c.pill(l.status)}</td>
          <td><div class="module-actions">
            <button class="dash-btn dash-btn-ghost dash-btn-sm" data-lesson-view="${c.esc(l.id)}">View</button>
            <button class="dash-btn dash-btn-ghost dash-btn-sm" data-lesson-edit="${c.esc(l.id)}">Edit</button>
          </div></td></tr>`).join("") : c.emptyRow(5, "No lessons yet — create your first lesson plan.")}</tbody></table></div>`;
      card.querySelectorAll("[data-lesson-view]").forEach((b) => b.addEventListener("click", () => viewLesson(rows.find((x) => String(x.id) === b.dataset.lessonView))));
      card.querySelectorAll("[data-lesson-edit]").forEach((b) => b.addEventListener("click", () => lessonForm(rows.find((x) => String(x.id) === b.dataset.lessonEdit))));
    };
    const refs = await loadAssignments(c);
    const classOptions = refs.classes || [];
    const subjectPairs = refs.subjects || [];
    const subjectOptionsFor = (classId) => classId ? subjectPairs.filter((p) => Number(p.classId) === Number(classId)).map((p) => p.subject).filter(Boolean) : [];
    const lessonForm = (lesson) => {
      const isNew = !lesson;
      const modal = c.openModal(isNew ? "New lesson plan" : "Edit lesson plan", `
        <form id="lessonForm">
          <div class="dash-form-grid">
            <div class="dash-field"><label>Title *</label><input name="title" required maxlength="200" value="${c.esc(lesson && lesson.title)}"></div>
            <div class="dash-field"><label>Class *</label><select name="class_id" id="lessonClass" required><option value="">Select class</option>${c.options(classOptions, lesson && lesson.class_id)}</select></div>
            <div class="dash-field"><label>Subject *</label><select name="subject_id" id="lessonSubject" required><option value="">Select class first</option></select></div>
            <div class="dash-field"><label>Lesson date *</label><input name="lesson_date" type="date" required value="${c.esc((lesson && lesson.lesson_date) || c.todayIso())}"></div>
            <div class="dash-field"><label>Topic</label><input name="topic" maxlength="255" value="${c.esc(lesson && lesson.topic)}"></div>
            <div class="dash-field"><label>Period</label><input name="period" placeholder="e.g. Period 2" value="${c.esc(lesson && lesson.period)}"></div>
            <div class="dash-field"><label>Status</label><select name="status">${["draft", "published", "completed", "archived"].map((s) => `<option value="${s}"${lesson && lesson.status === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Objectives</label><textarea name="objectives" rows="2">${c.esc(lesson && lesson.objectives)}</textarea></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Lesson content</label><textarea name="content" rows="5">${c.esc(lesson && lesson.content)}</textarea></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Learning materials</label><textarea name="learning_materials" rows="2">${c.esc(lesson && lesson.learning_materials)}</textarea></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Homework</label><textarea name="homework_text" rows="2">${c.esc(lesson && lesson.homework_text)}</textarea></div>
          </div>
          <div class="dash-actions" style="margin-top:14px"><button class="dash-btn dash-btn-primary" type="submit">${c.I.check} Save lesson</button></div>
        </form>`, { wide: true });
      const classSel = modal.querySelector("#lessonClass");
      const subjectSel = modal.querySelector("#lessonSubject");
      const fillSubjects = () => {
        const opts = subjectOptionsFor(classSel.value);
        subjectSel.innerHTML = `<option value="">Select subject</option>` + c.options(opts, lesson && lesson.subject_id);
      };
      classSel.addEventListener("change", fillSubjects);
      fillSubjects();
      modal.querySelector("#lessonForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = Object.fromEntries(fd.entries());
        try {
          if (isNew) await c.api.post("/academic/lessons", payload);
          else await c.api.patch(`/academic/lessons/${lesson.id}`, payload);
          c.toast("Lesson saved.", "success"); c.closeModal();
          const fresh = await c.api.get("/academic/lessons?perPage=50");
          rows.length = 0; rows.push(...(fresh.lessons || [])); renderRows();
        } catch (err) { c.toast(err.message || "Could not save the lesson.", "error"); }
      });
    };
    const viewLesson = (lesson) => {
      c.openModal(lesson.title, `
        <div class="portal-detail-meta">
          <div><b>Class / subject</b>${c.esc(lesson.class_name || "—")} / ${c.esc(lesson.subject_name || "—")}</div>
          <div><b>Date</b>${c.fmtDate(lesson.lesson_date)}</div>
          <div><b>Period</b>${c.esc(lesson.period || "—")}</div>
          <div><b>Status</b>${c.pill(lesson.status)}</div>
        </div>
        ${lesson.topic ? `<p><b>Topic:</b> ${c.esc(lesson.topic)}</p>` : ""}
        ${lesson.objectives ? `<p><b>Objectives:</b><br>${c.esc(lesson.objectives)}</p>` : ""}
        ${lesson.content ? `<p><b>Content:</b><br>${c.esc(lesson.content)}</p>` : ""}
        ${lesson.learning_materials ? `<p><b>Materials:</b><br>${c.esc(lesson.learning_materials)}</p>` : ""}
        ${lesson.homework_text ? `<p><b>Homework:</b><br>${c.esc(lesson.homework_text)}</p>` : ""}`);
    };
    content.querySelector("#newLesson").addEventListener("click", () => lessonForm(null));
    renderRows();
  }

  async function pageAssignments(c, content) {
    const data = await c.api.get("/academic/assignments?perPage=50");
    const rows = data.assignments || [];
    content.innerHTML = c.pageHead("Teaching", "Assignments", "Set work, watch submissions come in and grade them.", `
      <button class="dash-btn dash-btn-primary" id="newAssignment">${c.I.plus} New assignment</button>`);
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    const renderRows = () => {
      card.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Assignment</th><th>Class / subject</th><th>Due</th><th>Submissions</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((a) => `<tr>
          <td><strong>${c.esc(a.title)}</strong></td>
          <td>${c.esc(a.class_name || "—")} / ${c.esc(a.subject_name || "—")}</td>
          <td>${c.fmtDate(a.due_date)}</td>
          <td>${c.esc(a.submission_count || 0)}</td><td>${c.pill(a.status)}</td>
          <td><div class="module-actions">
            <button class="dash-btn dash-btn-ghost dash-btn-sm" data-submissions="${c.esc(a.id)}">Submissions</button>
            <button class="dash-btn dash-btn-ghost dash-btn-sm" data-assign-edit="${c.esc(a.id)}">Edit</button>
          </div></td></tr>`).join("") : c.emptyRow(6, "No assignments yet — create your first assignment.")}</tbody></table></div>`;
      card.querySelectorAll("[data-submissions]").forEach((b) => b.addEventListener("click", () => viewSubmissions(rows.find((x) => String(x.id) === b.dataset.submissions))));
      card.querySelectorAll("[data-assign-edit]").forEach((b) => b.addEventListener("click", () => assignmentForm(rows.find((x) => String(x.id) === b.dataset.assignEdit))));
    };
    const viewSubmissions = async (assignment) => {
      const modal = c.openModal(`Submissions — ${assignment.title}`, `<div class="dash-card-pad">${c.loading()}</div>`, { wide: true });
      try {
        const sub = await c.api.get(`/academic/assignments/${assignment.id}/submissions`);
        const rowsHtml = (sub.submissions || []).map((row) => `
          <tr data-submission-student="${c.esc(row.student_id)}">
            <td><strong>${c.esc(`${row.first_name} ${row.last_name}`.trim())}</strong><small>${c.esc(row.admission_no || "")}</small></td>
            <td>${c.pill(row.submission_status)}</td>
            <td>${c.fmtDate(row.submitted_at)}</td>
            <td><input class="score-input submission-score" type="number" min="0" max="${c.esc(sub.maximumScore)}" step="0.5" value="${row.score == null ? "" : c.esc(row.score)}" aria-label="Score" style="max-width:80px"></td>
            <td><input class="remark-input submission-feedback" value="${c.esc(row.feedback || "")}" placeholder="Feedback" aria-label="Feedback"></td>
            <td><div class="module-actions">
              ${row.original_name ? `<a class="dash-btn dash-btn-ghost dash-btn-sm" href="${c.api.url(`/academic/assignments/${assignment.id}/submissions/${row.student_id}/attachment`)}" target="_blank">${c.I.download}</a>` : ""}
              <button class="dash-btn dash-btn-primary dash-btn-sm" data-grade-submission="${c.esc(row.student_id)}">Grade</button>
            </div></td></tr>`).join("");
        modal.querySelector(".dash-modal-body").innerHTML = `
          <p class="dash-info-line"><strong>${(sub.submissions || []).filter((r) => r.submission_id).length}</strong> of ${(sub.submissions || []).length} submitted · maximum ${c.esc(sub.maximumScore)}</p>
          <div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Student</th><th>Status</th><th>Submitted</th><th>Score</th><th>Feedback</th><th></th></tr></thead>
            <tbody>${rowsHtml || c.emptyRow(6, "No students in this class.")}</tbody></table></div>`;
        modal.querySelectorAll("[data-grade-submission]").forEach((btn) => btn.addEventListener("click", async () => {
          const tr = btn.closest("[data-submission-student]");
          const studentId = tr.getAttribute("data-submission-student");
          const score = tr.querySelector(".submission-score").value;
          const feedback = tr.querySelector(".submission-feedback").value;
          if (score === "") return c.toast("Enter a score first.", "error");
          try {
            await c.api.put(`/academic/assignments/${assignment.id}/submissions/${studentId}`, { score: Number(score), feedback });
            c.toast("Submission graded.", "success");
            const fresh = await c.api.get(`/academic/assignments/${assignment.id}/submissions`);
            modal.remove();
            viewSubmissions(assignment);
          } catch (e) { c.toast(e.message || "Could not save the grade.", "error"); }
        }));
      } catch (e) {
        modal.querySelector(".dash-modal-body").innerHTML = c.errorState(e.message);
      }
    };
    const refs = await loadAssignments(c);
    const classOptions = refs.classes || [];
    const subjectPairs = refs.subjects || [];
    const assignmentForm = (assignment) => {
      const isNew = !assignment;
      const modal = c.openModal(isNew ? "New assignment" : "Edit assignment", `
        <form id="assignmentForm">
          <div class="dash-form-grid">
            <div class="dash-field" style="grid-column:1/-1"><label>Title *</label><input name="title" required maxlength="200" value="${c.esc(assignment && assignment.title)}"></div>
            <div class="dash-field"><label>Class *</label><select name="class_id" id="assignClass" required><option value="">Select class</option>${c.options(classOptions, assignment && assignment.class_id)}</select></div>
            <div class="dash-field"><label>Subject *</label><select name="subject_id" id="assignSubject" required><option value="">Select class first</option></select></div>
            <div class="dash-field"><label>Assigned date *</label><input name="assigned_date" type="date" required value="${c.esc((assignment && assignment.assigned_date) || c.todayIso())}"></div>
            <div class="dash-field"><label>Due date *</label><input name="due_date" type="date" required value="${c.esc(assignment && assignment.due_date)}"></div>
            <div class="dash-field"><label>Maximum score *</label><input name="maximum_score" type="number" min="1" step="0.5" required value="${c.esc((assignment && assignment.maximum_score) || 100)}"></div>
            <div class="dash-field"><label>Status</label><select name="status">${["draft", "published", "closed", "archived"].map((s) => `<option value="${s}"${(assignment ? assignment.status : "draft") === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Instructions</label><textarea name="details" rows="5">${c.esc(assignment && assignment.details)}</textarea></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Attachment${assignment ? " (replaces current)" : ""}</label><input type="file" name="attachment_file" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"></div>
          </div>
          <div class="dash-actions" style="margin-top:14px"><button class="dash-btn dash-btn-primary" type="submit">${c.I.check} Save assignment</button></div>
        </form>`, { wide: true });
      const classSel = modal.querySelector("#assignClass");
      const subjectSel = modal.querySelector("#assignSubject");
      const fillSubjects = () => {
        const opts = classSel.value ? subjectPairs.filter((p) => Number(p.classId) === Number(classSel.value)).map((p) => p.subject).filter(Boolean) : [];
        subjectSel.innerHTML = `<option value="">Select subject</option>` + c.options(opts, assignment && assignment.subject_id);
      };
      classSel.addEventListener("change", fillSubjects);
      fillSubjects();
      modal.querySelector("#assignmentForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = Object.fromEntries(fd.entries());
        try {
          if (isNew) await c.api.post("/academic/assignments", payload);
          else await c.api.patch(`/academic/assignments/${assignment.id}`, payload);
          c.toast("Assignment saved.", "success"); c.closeModal();
          const fresh = await c.api.get("/academic/assignments?perPage=50");
          rows.length = 0; rows.push(...(fresh.assignments || [])); renderRows();
        } catch (err) { c.toast(err.message || "Could not save the assignment.", "error"); }
      });
    };
    content.querySelector("#newAssignment").addEventListener("click", () => assignmentForm(null));
    renderRows();
  }

  /* -------------------------------- exams --------------------------------- */

  async function pageExams(c, content) {
    const data = await c.api.get("/academic/exams?perPage=50");
    const rows = data.exams || [];
    content.innerHTML = c.pageHead("Teaching", "Examinations", "Exam sittings for your classes — schedule, marks and status.", "");
    const card = document.createElement("div");
    card.className = "dash-card";
    content.appendChild(card);
    card.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
      <thead><tr><th>Examination</th><th>Class / subject</th><th>Date & time</th><th>Room</th><th>Marks</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((e) => `<tr>
        <td><strong>${c.esc(e.title)}</strong>${e.mode === "online" ? `<small>Online examination</small>` : ""}</td>
        <td>${c.esc(e.class_name || "—")} / ${c.esc(e.subject_name || "—")}</td>
        <td>${c.fmtDate(e.exam_date)}${e.start_time ? ` · ${c.esc(String(e.start_time).slice(0, 5))}` : ""}</td>
        <td>${c.esc(e.classroom || "—")}</td><td>${c.esc(e.total_marks)}</td><td>${c.pill(e.status)}</td>
        <td><div class="module-actions">
          <button class="dash-btn dash-btn-ghost dash-btn-sm" data-exam-marks="${c.esc(e.id)}">Marks</button>
          ${e.mode === "online" ? `<button class="dash-btn dash-btn-ghost dash-btn-sm" data-exam-questions="${c.esc(e.id)}">Questions</button><button class="dash-btn dash-btn-ghost dash-btn-sm" data-exam-attempts="${c.esc(e.id)}">Attempts</button>` : ""}
        </div></td></tr>`).join("") : c.emptyRow(7, "No examinations scheduled.")}</tbody></table></div>`;
    card.querySelectorAll("[data-exam-attempts]").forEach((btn) => btn.addEventListener("click", () => openOnlineExamAttempts(c, rows.find((x) => String(x.id) === btn.dataset.examAttempts))));
    card.querySelectorAll("[data-exam-questions]").forEach((btn) => btn.addEventListener("click", () => openExamQuestions(c, rows.find((x) => String(x.id) === btn.dataset.examQuestions))));
    card.querySelectorAll("[data-exam-marks]").forEach((btn) => btn.addEventListener("click", async () => {
      const exam = rows.find((x) => String(x.id) === btn.dataset.examMarks);
      const modal = c.openModal(`Marks — ${exam.title}`, `<div class="dash-card-pad">${c.loading()}</div>`, { wide: true });
      try {
        const marks = await c.api.get(`/academic/exams/${exam.id}/marks`);
        modal.querySelector(".dash-modal-body").innerHTML = `
          <p class="dash-info-line">Maximum ${c.esc(marks.maximumMarks)} · pass mark from the grading config applies at report time.</p>
          <div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Student</th><th>Current exam score</th><th>New score</th></tr></thead>
            <tbody>${(marks.students || []).map((s) => `<tr data-mark-student="${c.esc(s.student_id)}">
              <td><strong>${c.esc(`${s.first_name} ${s.last_name}`.trim())}</strong><small>${c.esc(s.admission_no || "")}</small></td>
              <td>${s.exam == null ? "—" : c.esc(s.exam)}</td>
              <td><input class="score-input mark-score" type="number" min="0" max="${c.esc(marks.maximumMarks)}" step="0.5" value="${s.exam == null ? "" : c.esc(s.exam)}" aria-label="Score"></td></tr>`).join("") || c.emptyRow(3, "No students.")}</tbody></table></div>
          <div class="dash-actions" style="margin-top:14px"><button class="dash-btn dash-btn-primary" id="saveExamMarks">${c.I.check} Save marks</button></div>`;
        modal.querySelector("#saveExamMarks").addEventListener("click", async () => {
          const entries = [];
          modal.querySelectorAll("[data-mark-student]").forEach((tr) => {
            const score = tr.querySelector(".mark-score").value;
            if (score !== "") entries.push({ studentId: Number(tr.getAttribute("data-mark-student")), score: Number(score) });
          });
          if (!entries.length) return c.toast("Enter at least one score.", "error");
          try {
            await c.api.put(`/academic/exams/${exam.id}/marks`, { entries });
            c.toast("Marks saved as draft results.", "success"); c.closeModal();
          } catch (e) { c.toast(e.message || "Could not save marks.", "error"); }
        });
      } catch (e) { modal.querySelector(".dash-modal-body").innerHTML = c.errorState(e.message); }
    }));
  }

  /** Question manager for an online examination (for teachers holding the
      exams.create permission; the server enforces the real rule). */
  function openExamQuestions(c, exam) {
    const modal = c.openModal(`Questions — ${exam.title}`, `<div class="dash-card-pad">${c.loading()}</div>`, { wide: true });
    const body = () => modal.querySelector(".dash-modal-body");
    const load = async () => {
      try {
        const [data, bank] = await Promise.all([
          c.api.get(`/academic/exams/${exam.id}/questions`),
          c.api.get("/academic/questions?perPage=100").catch(() => ({ questions: [] })),
        ]);
        const questions = data.questions || [];
        const bankRows = (bank.questions || []).slice(0, 50);
        body().innerHTML = `
          <p class="dash-info-line">${questions.length} question(s) · paper total ${c.esc(data.questionTotal)} mark(s)</p>
          ${questions.length ? `<div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Marks</th><th></th></tr></thead><tbody>
            ${questions.map((q, i) => `<tr><td>${i + 1}</td><td><strong>${c.esc(String(q.question_text).slice(0, 110))}</strong></td><td>${c.esc(q.question_type.replace(/_/g, " "))}</td><td>${c.esc(q.marks)}</td><td><button class="dash-btn dash-btn-ghost dash-btn-sm" data-del-question="${q.id}">Remove</button></td></tr>`).join("")}
            </tbody></table></div>` : `<p class="hint">No questions yet — add one below or import from your question bank.</p>`}
          <form id="tqForm"><div class="dash-form-grid" style="margin-top:14px">
            <div class="dash-field" style="grid-column:1/-1"><label>New question *</label><textarea name="question_text" rows="2" required></textarea></div>
            <div class="dash-field"><label>Type</label><select name="question_type"><option value="multiple_choice">Multiple choice</option><option value="true_false">True / false</option><option value="short_answer">Short answer</option><option value="essay">Essay</option><option value="fill_in_the_blank">Fill in the blank</option></select></div>
            <div class="dash-field"><label>Marks</label><input name="marks" type="number" min="0.5" step="0.5" value="1" required></div>
            <div class="dash-field" style="grid-column:1/-1"><label>Options (one per line, multiple choice)</label><textarea name="options" rows="3"></textarea></div>
            <div class="dash-field"><label>Correct answer (auto-marking)</label><input name="correct_answer"></div>
          </div><div class="dash-actions" style="margin-top:10px"><button class="dash-btn dash-btn-primary" type="submit">${c.I.plus} Add question</button></div></form>
          ${bankRows.length ? `<p class="hint" style="margin-top:16px">Question bank</p>
            <div class="dash-table-wrap"><table class="dash-table"><thead><tr><th></th><th>Question</th><th>Marks</th></tr></thead><tbody>
            ${bankRows.map((q) => `<tr><td><input type="checkbox" data-bank-import="${q.id}"></td><td>${c.esc(String(q.question_text).slice(0, 90))}</td><td>${c.esc(q.marks)}</td></tr>`).join("")}
            </tbody></table></div>
            <div class="dash-actions" style="margin-top:10px"><button class="dash-btn dash-btn-ghost" id="tqImport">${c.I.download} Import selected</button></div>` : ""}`;
        body().querySelectorAll("[data-del-question]").forEach((b) => b.addEventListener("click", async () => {
          try { await c.api.del(`/academic/exams/${exam.id}/questions/${b.dataset.delQuestion}`); load(); }
          catch (e) { c.toast(e.message || "Could not remove the question.", "error"); }
        }));
        body().querySelector("#tqForm").addEventListener("submit", async (e) => {
          e.preventDefault();
          const raw = Object.fromEntries(new FormData(e.target).entries());
          const payload = { question_text: raw.question_text, question_type: raw.question_type, marks: Number(raw.marks), correct_answer: raw.correct_answer || "" };
          if (raw.options && raw.options.trim()) payload.options = JSON.stringify(raw.options.split(/\n+/).map((x) => x.trim()).filter(Boolean));
          try { await c.api.post(`/academic/exams/${exam.id}/questions`, payload); c.toast("Question added.", "success"); load(); }
          catch (err2) { c.toast(err2.message || "Could not add the question.", "error"); }
        });
        const importBtn = body().querySelector("#tqImport");
        if (importBtn) importBtn.addEventListener("click", async () => {
          const ids = [...body().querySelectorAll("[data-bank-import]:checked")].map((x) => Number(x.dataset.bankImport));
          if (!ids.length) return c.toast("Select at least one question.", "error");
          try { const r = await c.api.post(`/academic/exams/${exam.id}/questions/import`, { question_ids: ids }); c.toast(`Imported ${r.imported} question(s).`, "success"); load(); }
          catch (err2) { c.toast(err2.message || "Could not import.", "error"); }
        });
      } catch (e) { body().innerHTML = c.errorState(e.message); }
    };
    load();
  }

  /** Online examination attempts: the submission queue, per-attempt grading
      of subjective answers and the results release. */
  function openOnlineExamAttempts(c, exam) {
    const modal = c.openModal(`Online attempts — ${exam.title}`, `<div class="dash-card-pad">${c.loading()}</div>`, { wide: true });
    const body = () => modal.querySelector(".dash-modal-body");
    const load = async () => {
      try {
        const data = await c.api.get(`/academic/exams/${exam.id}/attempts`);
        const attempts = data.attempts || [];
        body().innerHTML = `
          <p class="dash-info-line">${attempts.length} attempt(s) · paper total ${c.esc(data.questionTotal)} marks · ${data.questionCount} question(s)
            ${data.exam.results_released_at ? ` · <strong>results released</strong>` : ""}</p>
          <div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Student</th><th>Status</th><th>Started</th><th>Submitted</th><th>Auto</th><th>Score</th><th></th></tr></thead>
            <tbody>${attempts.length ? attempts.map((a) => `<tr>
              <td><strong>${c.esc(a.name)}</strong><small>${c.esc(a.admission_no || "")}</small></td>
              <td>${c.pill(a.status === "graded" ? "graded" : a.status === "submitted" ? "submitted" : "pending")}</td>
              <td>${c.fmtDateTime(a.started_at)}</td>
              <td>${c.fmtDateTime(a.submitted_at)}</td>
              <td>${c.esc(a.auto_score == null ? "—" : a.auto_score)}</td>
              <td><strong>${c.esc(a.score == null ? "—" : a.score)}</strong></td>
              <td><button class="dash-btn dash-btn-ghost dash-btn-sm" data-attempt-grade="${c.esc(a.id)}">${a.status === "in_progress" ? "View" : "Grade"}</button></td>
            </tr>`).join("") : c.emptyRow(7, "No attempts yet.")}</tbody></table></div>
          <div class="dash-actions" style="margin-top:14px">
            <button class="dash-btn dash-btn-ghost" id="attemptsRefresh">Refresh</button>
            <button class="dash-btn dash-btn-primary" id="releaseResults">${c.I.check} Release results to students</button>
          </div>`;
        body().querySelector("#attemptsRefresh").addEventListener("click", load);
        body().querySelector("#releaseResults").addEventListener("click", async (e) => {
          if (!window.confirm("Release this examination's results to the students? They will be able to see their marked papers.")) return;
          const btn = e.currentTarget; btn.disabled = true;
          try {
            await c.api.post(`/academic/exams/${exam.id}/release-results`, {});
            c.toast("Results released — students have been notified.", "success"); load();
          } catch (err2) { c.toast(err2.message || "Could not release results.", "error"); btn.disabled = false; }
        });
        body().querySelectorAll("[data-attempt-grade]").forEach((b) => b.addEventListener("click", () => openAttemptGrading(c, exam, b.dataset.attemptGrade, load)));
      } catch (e) { body().innerHTML = c.errorState(e.message); }
    };
    load();
  }

  function openAttemptGrading(c, exam, attemptId, done) {
    const modal = c.openModal("Grade attempt", `<div class="dash-card-pad">${c.loading()}</div>`, { wide: true });
    const body = () => modal.querySelector(".dash-modal-body");
    (async () => {
      try {
        const data = await c.api.get(`/academic/exams/${exam.id}/attempts/${attemptId}`);
        const a = data.attempt;
        body().innerHTML = `
          <p class="dash-info-line"><strong>${c.esc(a.name)}</strong> (${c.esc(a.admission_no || "")}) · ${c.pill(a.status === "graded" ? "graded" : a.status === "submitted" ? "submitted" : "pending")}
            · auto-marked ${c.esc(a.auto_score == null ? 0 : a.auto_score)} · total so far <strong>${c.esc(a.score == null ? "—" : a.score)}</strong></p>
          ${(data.questions || []).map((q, i) => `
            <div class="exam-review-question">
              <div class="exam-question-head"><strong>Question ${i + 1}</strong>
                <span class="hint">${c.esc(q.marks)} mark(s) · ${q.is_correct === 1 ? "correct" : q.is_correct === 0 ? "incorrect" : "manual marking"}</span></div>
              <p class="exam-question-text">${c.esc(q.question_text)}</p>
              <p class="exam-review-line"><span>Answer:</span> ${c.esc(q.answer_text || "— not answered —")}</p>
              ${q.question_type === "multiple_choice" || q.question_type === "true_false"
                ? `<p class="exam-review-line"><span>Correct:</span> ${c.esc(q.correct_answer || "—")}</p>` : ""}
              <div class="dash-field" style="max-width:220px"><label>Award (0–${c.esc(q.marks)})</label>
                <input class="score-input grade-mark" type="number" min="0" max="${c.esc(q.marks)}" step="0.5" value="${q.marks_awarded == null ? "" : c.esc(q.marks_awarded)}" data-question="${c.esc(q.id)}"></div>
            </div>`).join("")}
          <div class="dash-actions" style="margin-top:14px"><button class="dash-btn dash-btn-primary" id="saveGrades">${c.I.check} Save grades</button></div>`;
        body().querySelector("#saveGrades").addEventListener("click", async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          const answers = [];
          body().querySelectorAll(".grade-mark").forEach((input) => {
            if (input.value !== "") answers.push({ question_id: Number(input.dataset.question), marks_awarded: Number(input.value) });
          });
          if (!answers.length) { c.toast("Award at least one mark.", "error"); btn.disabled = false; return; }
          try {
            const r = await c.api.put(`/academic/exams/${exam.id}/attempts/${attemptId}/grade`, { answers });
            c.toast(`Grades saved — final score ${r.score} / ${r.total}.`, "success");
            c.closeModal(); if (done) done();
          } catch (err2) { c.toast(err2.message || "Could not save grades.", "error"); btn.disabled = false; }
        });
      } catch (e) { body().innerHTML = c.errorState(e.message); }
    })();
  }

  /* ------------------------------- results -------------------------------- */

  async function pageResults(c, content) {
    const refs = await loadAssignments(c);
    const classes = refs.classes || [];
    const pairs = refs.subjects || [];
    // Terms from the shared catalogue endpoint used by the admin workspace.
    let terms = [];
    try {
      const t = await c.api.get("/sessions?includeTerms=1");
      terms = (t.sessions || []).flatMap((s) => (s.terms || []).map((x) => ({ id: x.id, label: `${s.label} — ${x.name_en}` })));
    } catch (e) { terms = []; }
    content.innerHTML = c.pageHead("Teaching", "Results workbook", "Enter marks, submit for review and follow the approval workflow.", "");
    const toolbar = document.createElement("div");
    toolbar.className = "dash-card";
    toolbar.innerHTML = `<div class="dash-card-pad"><div class="dash-form-grid">
      <div class="dash-field"><label>Class</label><select id="resClass"><option value="">Select class</option>${c.options(classes)}</select></div>
      <div class="dash-field"><label>Subject</label><select id="resSubject"><option value="">Select class first</option></select></div>
      <div class="dash-field"><label>Term</label><select id="resTerm"><option value="">Select term</option>${c.options(terms)}</select></div>
    </div></div>`;
    content.appendChild(toolbar);
    const panel = document.createElement("div");
    panel.className = "dash-card";
    panel.style.marginTop = "16px";
    content.appendChild(panel);
    const subjectSel = toolbar.querySelector("#resSubject");
    toolbar.querySelector("#resClass").addEventListener("change", () => {
      const classId = toolbar.querySelector("#resClass").value;
      const opts = classId ? pairs.filter((p) => Number(p.classId) === Number(classId)).map((p) => p.subject).filter(Boolean) : [];
      subjectSel.innerHTML = `<option value="">Select subject</option>` + c.options(opts);
    });
    const loadRoster = async () => {
      const classId = toolbar.querySelector("#resClass").value;
      const subjectId = subjectSel.value;
      const termId = toolbar.querySelector("#resTerm").value;
      if (!classId || !subjectId || !termId) { panel.innerHTML = `<div class="dash-card-pad"><p class="hint">Choose a class, subject and term to open the gradebook.</p></div>`; return; }
      panel.innerHTML = `<div class="dash-card-pad">${c.loading()}</div>`;
      try {
        const roster = await c.api.get(`/results/roster?classId=${classId}&termId=${termId}&subjectId=${subjectId}`);
        panel.innerHTML = `
          <div class="dash-card-head"><h3>Gradebook</h3><span class="hint">CA max ${c.esc(roster.config.caMax)} · Exam max ${c.esc(roster.config.examMax)}</span></div>
          <div class="dash-table-wrap"><table class="dash-table">
            <thead><tr><th>Student</th><th>CA</th><th>Exam</th><th>Total</th><th>Grade</th><th>Remark</th><th>Status</th></tr></thead>
            <tbody>${roster.students.length ? roster.students.map((s) => `<tr data-result-student="${c.esc(s.student_id)}">
              <td><strong>${c.esc(`${s.first_name} ${s.last_name}`.trim())}</strong><small>${c.esc(s.student_code || s.admission_no || "")}</small></td>
              <td><input class="score-input result-ca" type="number" min="0" max="${c.esc(roster.config.caMax)}" step="0.5" value="${s.ca === "" ? "" : c.esc(s.ca)}" aria-label="CA"></td>
              <td><input class="score-input result-exam" type="number" min="0" max="${c.esc(roster.config.examMax)}" step="0.5" value="${s.exam === "" ? "" : c.esc(s.exam)}" aria-label="Exam"></td>
              <td class="score-total">${s.total === "" ? "—" : c.esc(s.total)}</td>
              <td class="result-grade">${c.esc(s.grade || "—")}</td>
              <td><input class="remark-input result-remark" value="${c.esc(s.teacher_remark || "")}" placeholder="Remark" aria-label="Remark"></td>
              <td class="workbook-status">${c.pill(s.status)}</td></tr>`).join("") : c.emptyRow(7, "No active students.")}</tbody></table></div>
          <div class="dash-actions" style="padding:14px 20px">
            <button class="dash-btn dash-btn-ghost" id="saveDraftResults">Save draft</button>
            <button class="dash-btn dash-btn-primary" id="submitResults">Submit for review</button>
          </div>`;
        const collect = () => {
          const entries = [];
          panel.querySelectorAll("[data-result-student]").forEach((tr) => {
            const ca = tr.querySelector(".result-ca").value;
            const exam = tr.querySelector(".result-exam").value;
            if (ca === "" && exam === "") return;
            entries.push({
              studentId: Number(tr.getAttribute("data-result-student")),
              ca: ca === "" ? 0 : Number(ca),
              exam: exam === "" ? 0 : Number(exam),
              teacher_remark: tr.querySelector(".result-remark").value,
            });
          });
          return entries;
        };
        panel.querySelector("#saveDraftResults").addEventListener("click", async () => {
          const entries = collect();
          if (!entries.length) return c.toast("Enter at least one score.", "error");
          try {
            await c.api.put("/results", { classId: Number(classId), termId: Number(termId), subjectId: Number(subjectId), entries });
            c.toast("Draft results saved.", "success"); loadRoster();
          } catch (e) { c.toast(e.message || "Could not save results.", "error"); }
        });
        panel.querySelector("#submitResults").addEventListener("click", async () => {
          const entries = collect();
          if (!entries.length) return c.toast("Enter at least one score before submitting.", "error");
          if (!window.confirm("Submit these results for review? They will be locked for editing until approved or returned.")) return;
          try {
            await c.api.put("/results", { classId: Number(classId), termId: Number(termId), subjectId: Number(subjectId), entries });
            await c.api.post("/results/workflow", { classId: Number(classId), termId: Number(termId), subjectId: Number(subjectId), action: "submit" });
            c.toast("Results submitted for review.", "success"); loadRoster();
          } catch (e) { c.toast(e.message || "Could not submit results.", "error"); }
        });
      } catch (e) { panel.innerHTML = `<div class="dash-card-pad">${c.errorState(e.message)}</div>`; }
    };
    toolbar.querySelectorAll("select").forEach((s) => s.addEventListener("change", loadRoster));
    panel.innerHTML = `<div class="dash-card-pad"><p class="hint">Choose a class, subject and term to open the gradebook.</p></div>`;
  }

  /* ------------------------------- calendar ------------------------------- */

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
          ${e.description ? `<small>${c.esc(e.description)}</small>` : ""}
        </div>${c.pill(e.event_type)}</div>`).join("") : `<p class="hint">No upcoming events.</p>`}
    </div>`;
  }

  /* ------------------------------- messages ------------------------------- */

  async function pageMessages(c, content) {
    content.innerHTML = c.pageHead("Communication", "Messages", "Direct messages with staff and parents of your classes.", `
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
              <small>${c.fmtDateTime(conv.updated_at)} · ${c.esc(conv.participant_count)} participant(s)${conv.unread_count ? ` · <b>${c.esc(conv.unread_count)} unread</b>` : ""}</small>
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
              <div class="portal-notif${Number(m.user_id) === Number((c.state.me.user || {}).id) ? "" : " is-unread"}">
                <div class="portal-notif-body"><strong>${c.esc(m.sender_name || "—")}</strong>
                  <p>${c.esc(m.body)}</p><small>${c.fmtDateTime(m.created_at)}</small></div>
              </div>`).join("")}
          </div>
          <form id="replyForm" style="margin-top:12px"><div class="dash-form-grid">
            <div class="dash-field" style="grid-column:1/-1"><label>Reply</label><textarea name="body" rows="3" required></textarea></div>
          </div><div class="dash-actions" style="margin-top:10px"><button class="dash-btn dash-btn-primary" type="submit">Send</button></div></form>`;
        modal.querySelector("#replyForm").addEventListener("submit", async (e) => {
          e.preventDefault();
          const body = new FormData(e.target).get("body");
          const others = (data.participants || []).map((p) => p.user_id).filter((uid) => Number(uid) !== Number((c.state.me.user || {}).id));
          if (!others.length) return c.toast("No one to reply to.", "error");
          try {
            await c.api.post("/communication/messages", { subject: data.conversation.subject, body, recipient_user_ids: others });
            c.toast("Reply sent.", "success");
            openConversation(id);
          } catch (err) { c.toast(err.message || "Could not send the reply.", "error"); }
        });
      } catch (e) { modal.querySelector(".dash-modal-body").innerHTML = c.errorState(e.message); }
    };
    const newMessage = async () => {
      // Teachers write to administrators, fellow teachers and (via the parent
      // directory) parents of their classes. The server enforces recipient
      // availability; this composer just lists who exists.
      let contacts = [];
      try {
        const staff = await c.api.get("/teachers?perPage=100");
        contacts = (staff.teachers || []).map((t) => ({ id: t.user_id || t.id, full_name: t.full_name, role: "teacher" }));
      } catch (e) { /* teachers.view may be revoked */ }
      try {
        const parents = await c.api.get("/communication/parents");
        contacts = contacts.concat((parents.parents || []).map((p) => ({ id: p.id, full_name: p.full_name || p.username, role: "parent" })));
      } catch (e) { /* communication.view may be revoked */ }
      const modal = c.openModal("New message", `
        <form id="newMessageForm">
          <div class="dash-form-grid">
            <div class="dash-field"><label>To *</label><select name="recipient" required><option value="">Select recipient</option>
              ${contacts.map((x) => `<option value="${c.esc(x.id)}">${c.esc(x.full_name)} (${c.esc(x.role)})</option>`).join("")}
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

  /* -------------------------------- leave --------------------------------- */

  async function pageLeave(c, content) {
    const data = await c.api.get("/leave/me");
    const balances = data.balances || [];
    const requests = data.requests || [];
    content.innerHTML = c.pageHead("Staff", "My leave", "Balances, requests and history.", `
      <button class="dash-btn dash-btn-primary" id="newLeave">${c.I.plus} Request leave</button>`);
    const grid = document.createElement("div");
    grid.className = "portal-grid-2";
    grid.innerHTML = `
      <div class="dash-card"><div class="dash-card-head"><h3>Leave balances</h3>${data.session ? `<span class="hint">${c.esc(data.session.label)}</span>` : ""}</div>
        <div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Type</th><th>Entitled</th><th>Taken</th><th>Remaining</th></tr></thead>
        <tbody>${balances.length ? balances.map((b) => `<tr><td>${c.esc(b.type_name)}</td><td>${c.esc(b.entitlement)}</td><td>${c.esc(b.taken)}</td><td><strong>${c.esc(b.remaining)}</strong></td></tr>`).join("") : c.emptyRow(4, "No leave balances configured.")}</tbody></table></div></div>
      <div class="dash-card"><div class="dash-card-head"><h3>My requests</h3></div>
        <div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Dates</th><th>Type</th><th>Days</th><th>Status</th></tr></thead>
        <tbody>${requests.length ? requests.map((r) => `<tr><td>${c.fmtDate(r.start_date)} – ${c.fmtDate(r.end_date)}</td><td>${c.esc(r.type_name || "—")}</td><td>${c.esc(r.days)}</td><td>${c.pill(r.status)}</td></tr>`).join("") : c.emptyRow(4, "No leave requests yet.")}</tbody></table></div></div>`;
    content.appendChild(grid);
    content.querySelector("#newLeave").addEventListener("click", () => {
      const types = data.types || [];
      const modal = c.openModal("Request leave", `
        <form id="leaveForm"><div class="dash-form-grid">
          <div class="dash-field"><label>Leave type *</label><select name="type_id" required>${c.options(types, null, (t) => t.name)}</select></div>
          <div class="dash-field"><label>From *</label><input name="start_date" type="date" required value="${c.todayIso()}"></div>
          <div class="dash-field"><label>To *</label><input name="end_date" type="date" required value="${c.todayIso()}"></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Reason</label><textarea name="reason" rows="3"></textarea></div>
        </div><div class="dash-actions" style="margin-top:12px"><button class="dash-btn dash-btn-primary" type="submit">Submit request</button></div></form>`);
      modal.querySelector("#leaveForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = Object.fromEntries(new FormData(e.target).entries());
        try {
          await c.api.post("/leave", payload);
          c.toast("Leave request submitted.", "success"); c.closeModal();
          pageLeave(c, content);
        } catch (err) { c.toast(err.message || "Could not submit the request.", "error"); }
      });
    });
  }

  /* ------------------------------- library -------------------------------- */

  async function pageLibrary(c, content) {
    const data = await c.api.get("/library/my-loans");
    const loans = data.loans || [];
    content.innerHTML = c.pageHead("Library", "My library loans", "Books you have borrowed, due dates and history.", "");
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

  /* -------------------------------- account -------------------------------- */

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
        showSignature: true,
        hint: "Shown on your staff ID card, your register entries and the certificates you sign",
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

  /* ------------------------------- router ---------------------------------- */

  async function render(content, route, c) {
    const top = route.split("?")[0];
    if (top === "dashboard" || top === "") return pageDashboard(c, content);
    if (top === "classes" || top.startsWith("classes/")) return pageClasses(c, content, top);
    if (top === "timetable") return pageTimetable(c, content);
    if (top === "attendance") return pageAttendance(c, content);
    if (top === "lessons") return pageLessons(c, content);
    if (top === "assignments") return pageAssignments(c, content);
    if (top === "exams") return pageExams(c, content);
    if (top === "results") return pageResults(c, content);
    if (top === "calendar") return pageCalendar(c, content);
    if (top === "messages") return pageMessages(c, content);
    if (top === "notifications") return window.BelloPortal.renderNotifications(c, content);
    if (top === "leave") return pageLeave(c, content);
    if (top === "library") return pageLibrary(c, content);
    if (top === "account") return pageAccount(c, content);
    content.innerHTML = c.errorState("This page is not part of the teacher workspace.");
  }

  window.BelloPortal.registerRole("teacher", { schema, render, pageTitle });
})();
