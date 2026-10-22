"use strict";

/* ============================================================================
   EduSphere Education Platform — Western Academy Registration Module
   ----------------------------------------------------------------------------
   The Western directory has its own registration experience. It deliberately
   does NOT reuse the Madrasa (Islamic) registration screen:

     • its own information architecture (academy profile, curriculum,
       education levels, academic programs, enrolment)
     • its own navy / sky "Western Academy" identity, so pressing
       "Register Your Academy" never drops the visitor into the green
       Islamic onboarding flow
     • it posts to /api/public/register-academy with category "western",
       so an approved academy is promoted into the Western admin dashboard

   Mounted by the client router (public/js/app.js) at /register-academy.
   ========================================================================== */

window.BelloAcademyRegister = (function () {
  /* Offline fallback only: the live list (37 entries, the FCT under its own
     name) comes from the platform dataset at /api/public/locations, which
     also serves the cities and the towns under each city. */
  const NIGERIAN_STATES = [
    "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue",
    "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu",
    "Federal Capital Territory", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano",
    "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun",
    "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"
  ];

  const locationOptions = { states: [], cities: [], towns: [], citiesByState: {} };

  /* The shared API client already falls back to XMLHttpRequest where `fetch`
     is unavailable, so the cascade keeps working on any engine. A failed
     request resolves to an empty object and the fallback list stays. */
  function fetchLocations(query) {
    return window.API.public.locations(query);
  }

  async function loadLocationStates() {
    const data = await fetchLocations("?cities=1");
    if (data.states && data.states.length) locationOptions.states = data.states.slice();
    if (data.citiesByState) locationOptions.citiesByState = data.citiesByState;
  }

  function fillLocationSelect(sel, values, placeholder) {
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    sel.value = values.includes(current) ? current : "";
    sel.disabled = !values.length;
  }

  /* The whole state → city index is loaded with the page, so picking a state
     fills the city select instantly — no request, no flicker. Towns still come
     from the server, one request per city, and are filled in place so the page
     never re-renders or jumps while the visitor is choosing. */
  function onLocationStateChange(sel) {
    const m = state.formData.academy;
    m.state = sel.value;
    m.city = "";
    m.town = "";
    locationOptions.towns = [];
    locationOptions.cities = m.state ? (locationOptions.citiesByState[m.state] || []) : [];
    const citySelect = document.getElementById("a_city");
    fillLocationSelect(citySelect, locationOptions.cities, m.state ? "Select City" : "Select a state first");
    if (citySelect) citySelect.value = "";
    fillLocationSelect(document.getElementById("a_town"), [], "Select a city first");
  }

  async function onLocationCityChange(sel) {
    const m = state.formData.academy;
    m.city = sel.value;
    m.town = "";
    fillLocationSelect(document.getElementById("a_town"), [], "Select a city first");
    if (!m.city || !m.state) return;
    const data = await fetchLocations(`?state=${encodeURIComponent(m.state)}&city=${encodeURIComponent(m.city)}`);
    locationOptions.towns = data.towns || [];
    fillLocationSelect(document.getElementById("a_town"), locationOptions.towns, "Select Town");
  }

  /* Must stay in sync with server/services/institution.js WESTERN_TYPES so the
     submission is classified into the Western admin experience. */
  const INSTITUTION_TYPES = [
    "Nursery & Primary School",
    "Secondary School",
    "Nursery, Primary & Secondary School",
    "International School",
    "College",
    "Academy",
    "Other"
  ];

  const CURRICULA = [
    "Nigerian National Curriculum",
    "British (IGCSE / A-Level)",
    "American",
    "Montessori",
    "IB (International Baccalaureate)",
    "Blended / Other"
  ];

  /* Mirrors the Western Academic Programs catalogue used by the dashboard. */
  const SUBJECT_OPTIONS = [
    { id: "mathematics", name: "Mathematics", icon: "calculator" },
    { id: "english", name: "English", icon: "pen" },
    { id: "sciences", name: "Sciences", icon: "flask" },
    { id: "computer_science", name: "Computer Science", icon: "code" },
    { id: "technology", name: "Technology", icon: "monitor" },
    { id: "business", name: "Business", icon: "briefcase" },
    { id: "arts", name: "Arts", icon: "palette" },
    { id: "social_sciences", name: "Social Sciences", icon: "chart" },
    { id: "languages", name: "Languages", icon: "languages" },
    { id: "other", name: "Other", icon: "plus" }
  ];

  const EDUCATION_LEVELS = [
    "Nursery",
    "Primary",
    "Secondary",
    "College / Sixth Form",
    "Vocational & Professional"
  ];

  const ADMIN_ROLES = [
    "Proprietor",
    "Principal",
    "Vice Principal",
    "Head Teacher",
    "Director",
    "Administrator",
    "Other"
  ];

  const icons = {
    arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`,
    arrowLeft: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6M12 18l-6-6 6-6"/></svg>`,
    check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19.5 6.5"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10.2c0 5.2-8 10.3-8 10.3s-8-5.1-8-10.3a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10.2" r="2.6"/></svg>`,
    school: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-5 9 5-9 5-9-5Z"/><path d="M6 12.2V17c2.9 2.7 9.1 2.7 12 0v-4.8M21 10v6"/></svg>`,
    graduation: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 9 9-5 9 5-9 5-9-5Z"/><path d="M7 11.3v4.4c2.6 2.2 7.4 2.2 10 0v-4.4M21 9v5"/></svg>`,
    building: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M5 21V7l8-4v18M13 7l6 3v11M9 9v.01M9 13v.01M9 17v.01M17 13v.01M17 17v.01"/></svg>`,
    book: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.7A3.7 3.7 0 0 1 7.7 2H12v18H7.7A3.7 3.7 0 0 0 4 23V5.7ZM20 5.7A3.7 3.7 0 0 0 16.3 2H12v18h4.3A3.7 3.7 0 0 1 20 23V5.7Z"/></svg>`,
    calculator: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>`,
    pen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.1-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3M4 20l4-4"/></svg>`,
    flask: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6l-5.5 8.6A2.2 2.2 0 0 0 6.3 21h11.4a2.2 2.2 0 0 0 1.8-3.4L14 9V3"/><path d="M7.4 15h9.2"/></svg>`,
    code: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>`,
    monitor: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    briefcase: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/></svg>`,
    palette: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.3a1.7 1.7 0 0 0 1.4-2.7 1.7 1.7 0 0 1 1.4-2.7H18A3 3 0 0 0 21 12 9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="12" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r=".8" fill="currentColor" stroke="none"/></svg>`,
    chart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-7"/></svg>`,
    languages: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2c0 5-2.4 8.1-5.5 10M5.5 10h6M14 19l3.5-9 3.5 9M15.2 16h4.6"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    users: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-2.1A4.9 4.9 0 0 1 8.4 13h1.2a4.9 4.9 0 0 1 4.9 4.9V20M16 5.5a3 3 0 0 1 0 5.8M18.3 13.4a4.7 4.7 0 0 1 2.2 4V20"/></svg>`,
    teacher: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h12v10H4zM8 19h4M10 15v4M19 8v7M17 15h4"/><circle cx="19" cy="5" r="2"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>`,
    phone: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
    whatsapp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
    mail: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
    globe: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>`,
    instagram: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
    linkedin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5V18M10.5 18v-5a3.5 3.5 0 0 1 7 0v5"/><circle cx="6.5" cy="6.5" r="1"/></svg>`,
    upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    sparkles: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    close: `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    menu: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
    search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    info: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    link: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    shieldCheck: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 6v5.4c0 4.2-2.8 7.8-7 9.6-4.2-1.8-7-5.4-7-9.6V6l7-3Z"/><path d="m8.5 12 2.2 2.2 4.7-4.7"/></svg>`,
    rocket: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.2c2.7-.7 4.5-.2 5.3.5.7.7 1.2 2.5.5 5.3-.7 2.7-2.4 5.5-5.1 8.2l-3.1-3.1c-1.3-1.3-2.3-2.8-3.1-4.4 2.7-2.7 5.5-4.4 8.2-5.1Z"/><path d="m9 10.7-4.2.4-1.8 1.8 4.2 1.4M13.3 15l-.4 4.2-1.8 1.8-1.4-4.2"/><path d="m9.5 14.5-4 4"/></svg>`
  };

  /* ==========================================================================
     Like the Islamic flow, every stage of academy onboarding is its OWN
     addressable page. "Continue to Administrator Account" opens
     /register-academy/administrator — bookmarkable, reloadable, and reachable
     with the browser's Back/Forward buttons.
     ========================================================================== */
  const BASE_PATH = "/register-academy";
  const STEP_PATHS = {
    1: BASE_PATH,
    2: BASE_PATH + "/administrator",
    3: BASE_PATH + "/review",
    4: BASE_PATH + "/submitted"
  };
  const STEP_TITLES = {
    1: "Register Your Academy — EduSphere",
    2: "Administrator Account — Register Your Academy | EduSphere",
    3: "Review Your Registration — EduSphere",
    4: "Registration Submitted — EduSphere"
  };
  const DRAFT_KEY = "bello.academy-registration.draft";

  function normalisePath(pathname) {
    return String(pathname || "").replace(/\/+$/, "").toLowerCase() || "/";
  }

  function stepFromPath(pathname) {
    const p = normalisePath(pathname);
    for (const n of [2, 3, 4]) {
      if (p === normalisePath(STEP_PATHS[n])) return n;
    }
    return 1;
  }

  function syncUrl(step, replace) {
    const target = STEP_PATHS[step] || BASE_PATH;
    if (typeof document !== "undefined") document.title = STEP_TITLES[step] || STEP_TITLES[1];
    if (typeof history === "undefined" || !history.pushState) return;
    const current = normalisePath(window.location.pathname);
    if (replace || current === normalisePath(target)) {
      history.replaceState({ belloAcademyRegisterStep: step }, "", target);
    } else {
      history.pushState({ belloAcademyRegisterStep: step }, "", target);
    }
  }

  function saveDraft() {
    try {
      if (typeof sessionStorage === "undefined") return;
      const m = state.formData.academy;
      const a = state.formData.administrator;
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        // Logos are data URLs (potentially megabytes) and passwords are
        // secrets — neither is ever written to storage.
        academy: Object.assign({}, m, { logo: "", logoName: "", logoSize: 0 }),
        administrator: Object.assign({}, a, { password: "", confirmPassword: "" }),
        termsAccepted: state.formData.termsAccepted
      }));
    } catch (e) { /* private mode / storage full — the flow still works */ }
  }

  function restoreDraft() {
    try {
      if (typeof sessionStorage === "undefined") return false;
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== "object") return false;
      if (draft.academy) {
        Object.assign(state.formData.academy, draft.academy, {
          logo: state.formData.academy.logo,
          logoName: state.formData.academy.logoName,
          logoSize: state.formData.academy.logoSize
        });
      }
      if (draft.administrator) {
        Object.assign(state.formData.administrator, draft.administrator, {
          password: state.formData.administrator.password,
          confirmPassword: state.formData.administrator.confirmPassword
        });
      }
      state.formData.termsAccepted = !!draft.termsAccepted;
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearDraft() {
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* ignore */ }
  }

  function getInitialState() {
    return {
      currentStep: 1, // 1: Academy, 2: Administrator, 3: Review, 4: Submitted
      submitting: false,
      errors: {},
      // Shown when a later page is opened without its prerequisites.
      notice: "",
      showPassword: false,
      showConfirmPassword: false,
      formData: {
        academy: {
          id: "",
          name: "",
          officialName: "",
          logo: "",
          logoName: "",
          logoSize: 0,
          description: "",
          yearEstablished: "",
          institutionType: "Nursery & Primary School",
          curriculum: "Nigerian National Curriculum",
          country: "Nigeria",
          state: "Lagos",
          city: "",
          town: "",
          address: "",
          mapsLink: "",
          phone: "",
          whatsapp: "",
          email: "",
          website: "",
          facebook: "",
          instagram: "",
          subjects: ["Mathematics", "English", "Sciences"],
          otherSubjectText: "",
          studentCount: "",
          teacherCount: "",
          classCount: "",
          educationLevels: ["Primary", "Secondary"]
        },
        administrator: {
          fullName: "",
          position: "Proprietor",
          email: "",
          phone: "",
          password: "",
          confirmPassword: ""
        },
        termsAccepted: false
      },
      submissionReceipt: null,
      statusModal: {
        open: false,
        referenceQuery: "",
        phoneQuery: "",
        loading: false,
        result: null,
        error: null
      },
      termsModalOpen: false
    };
  }

  let state = getInitialState();

  function getPasswordStrength(password) {
    const p = String(password || "");
    if (!p) return { score: 0, label: "None", color: "", percent: 0, checks: { length: false, upperLower: false, number: false, special: false } };

    const checks = {
      length: p.length >= 8,
      upperLower: /[a-z]/.test(p) && /[A-Z]/.test(p),
      number: /[0-9]/.test(p),
      special: /[^a-zA-Z0-9]/.test(p)
    };

    let passed = 0;
    Object.keys(checks).forEach((k) => { if (checks[k]) passed += 1; });

    if (p.length < 6) return { score: 1, label: "Too Weak", color: "danger", percent: 20, checks };
    if (passed <= 1) return { score: 1, label: "Weak", color: "danger", percent: 25, checks };
    if (passed === 2) return { score: 2, label: "Fair", color: "warning", percent: 50, checks };
    if (passed === 3) return { score: 3, label: "Good", color: "sky", percent: 75, checks };
    return { score: 4, label: "Strong", color: "success", percent: 100, checks };
  }

  function validateStep(stepNumber) {
    const errors = {};
    const m = state.formData.academy;
    const a = state.formData.administrator;

    if (stepNumber === 1 || stepNumber === "all") {
      if (!m.name.trim()) errors.academyName = "Academy name is required.";
      if (!m.country.trim()) errors.country = "Country is required.";
      if (!m.state.trim()) errors.state = "State is required.";
      if (!m.city.trim()) errors.city = "City or town is required.";
      if (!m.address.trim()) errors.address = "Full address is required.";
      if (!m.phone.trim()) errors.phone = "Official phone number is required.";
      else if (!/^[0-9+\s()-]{7,25}$/.test(m.phone.trim())) {
        errors.phone = "Enter a valid phone number (e.g. +234 801 234 5678).";
      }
      if (m.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email.trim())) {
        errors.academyEmail = "Enter a valid email address.";
      }
      if (m.yearEstablished.trim() && !/^\d{4}$/.test(m.yearEstablished.trim())) {
        errors.yearEstablished = "Enter a valid 4-digit year (e.g. 2004).";
      }
      if (!m.educationLevels.length) {
        errors.educationLevels = "Select at least one education level your academy offers.";
      }
    }

    if (stepNumber === 2 || stepNumber === "all") {
      if (!a.fullName.trim()) errors.adminFullName = "Administrator full name is required.";
      if (!a.position.trim()) errors.adminPosition = "Position/Role is required.";
      if (!a.email.trim()) errors.adminEmail = "Administrator email is required.";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email.trim())) errors.adminEmail = "Enter a valid email address.";
      if (!a.phone.trim()) errors.adminPhone = "Administrator phone is required.";
      else if (!/^[0-9+\s()-]{7,25}$/.test(a.phone.trim())) errors.adminPhone = "Enter a valid phone number.";
      if (!a.password) errors.adminPassword = "Password is required.";
      else if (a.password.length < 8) errors.adminPassword = "Password must be at least 8 characters.";
      if (!a.confirmPassword) errors.adminConfirmPassword = "Confirm password is required.";
      else if (a.password !== a.confirmPassword) errors.adminConfirmPassword = "Passwords do not match.";
      if (!state.formData.termsAccepted) {
        errors.terms = "You must agree to EduSphere's Terms of Service and Privacy Policy.";
      }
    }

    return errors;
  }

  function handleLogoFile(file) {
    if (!file) return;
    const validTypes = ["image/png", "image/jpeg", "image/jpg"];
    if (!validTypes.includes(file.type)) {
      state.errors.logo = "Unsupported file type. Please upload a PNG, JPG, or JPEG file.";
      render();
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      state.errors.logo = "File is too large. Maximum allowed logo size is 5MB.";
      render();
      return;
    }
    delete state.errors.logo;
    const reader = new FileReader();
    reader.onload = function (e) {
      state.formData.academy.logo = e.target.result;
      state.formData.academy.logoName = file.name;
      state.formData.academy.logoSize = file.size;
      render();
    };
    reader.readAsDataURL(file);
  }

  function removeLogo() {
    const m = state.formData.academy;
    m.logo = "";
    m.logoName = "";
    m.logoSize = 0;
    delete state.errors.logo;
    render();
  }

  /* Navigating between stages navigates to that stage's own page. The guard
     keeps the Administrator page from opening before the academy information
     it belongs to is complete. */
  function goToStep(targetStep, options) {
    const opts = options || {};
    if (targetStep > state.currentStep) {
      // Validate every intermediate step so a direct link to /review cannot
      // skip the administrator page.
      for (let s = state.currentStep; s < targetStep; s++) {
        const errs = validateStep(s);
        if (Object.keys(errs).length > 0) {
          state.errors = errs;
          state.currentStep = s;
          state.notice = s === 1
            ? "Please complete your academy information before creating the administrator account."
            : "Please complete the administrator account before continuing.";
          syncUrl(s, true);
          render();
          scrollToFirstError();
          return false;
        }
      }
    }
    state.errors = {};
    state.notice = "";
    state.currentStep = targetStep;
    saveDraft();
    if (!opts.skipUrl) syncUrl(targetStep, !!opts.replaceUrl);
    render();
    if (!opts.noScroll) window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  /** Renders whichever step the current URL points at (Back/Forward + reload). */
  function syncFromUrl() {
    const wanted = stepFromPath(window.location.pathname);
    if (wanted === 4 && !state.submissionReceipt) {
      state.currentStep = 1;
      state.notice = "That registration receipt is no longer available. You can check an existing application with its reference ID.";
      syncUrl(1, true);
      render();
      return;
    }
    if (wanted === state.currentStep) {
      syncUrl(wanted, true);
      render();
      return;
    }
    if (wanted > state.currentStep) {
      goToStep(wanted, { replaceUrl: true, noScroll: true });
      return;
    }
    state.currentStep = wanted;
    state.errors = {};
    state.notice = "";
    syncUrl(wanted, true);
    render();
  }

  function scrollToFirstError() {
    setTimeout(() => {
      const firstErr = document.querySelector(".wa-field-error, .wa-field.has-error");
      // scrollIntoView is missing in some embedded/test browsers — guarding it
      // keeps a validation message from turning into a page-breaking error.
      if (firstErr && typeof firstErr.scrollIntoView === "function") {
        firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 50);
  }

  async function submitRegistration() {
    const errs = validateStep("all");
    if (Object.keys(errs).length > 0) {
      state.errors = errs;
      const step1Keys = ["academyName", "country", "state", "city", "address", "phone", "academyEmail", "yearEstablished", "educationLevels"];
      state.currentStep = step1Keys.some((k) => errs[k]) ? 1 : 2;
      render();
      scrollToFirstError();
      return;
    }

    state.submitting = true;
    state.errors = {};
    render();

    const m = state.formData.academy;
    const a = state.formData.administrator;

    const subjectsList = m.subjects.filter((s) => s !== "Other");
    if (m.subjects.includes("Other") && m.otherSubjectText.trim()) {
      subjectsList.push(m.otherSubjectText.trim());
    }

    const payload = {
      // The category is what routes the approved institution into the Western
      // admin dashboard rather than the Islamic one.
      category: "western",
      academy: {
        id: m.id || "academy_" + Math.random().toString(36).substring(2, 10),
        name: m.name.trim(),
        officialName: m.officialName.trim(),
        logo: m.logo,
        description: m.description.trim(),
        yearEstablished: m.yearEstablished.trim(),
        institutionType: m.institutionType,
        curriculum: m.curriculum,
        country: m.country.trim() || "Nigeria",
        state: m.state,
        city: m.city.trim(),
        town: m.town.trim(),
        address: m.address.trim(),
        mapsLink: m.mapsLink.trim(),
        phone: m.phone.trim(),
        whatsapp: m.whatsapp.trim(),
        email: m.email.trim(),
        website: m.website.trim(),
        facebook: m.facebook.trim(),
        instagram: m.instagram.trim(),
        subjects: subjectsList,
        studentCount: m.studentCount,
        teacherCount: m.teacherCount,
        classCount: m.classCount,
        // Reuses the shared "age groups" column as the education levels served.
        ageGroups: m.educationLevels
      },
      administrator: {
        fullName: a.fullName.trim(),
        position: a.position,
        email: a.email.trim(),
        phone: a.phone.trim(),
        password: a.password
      },
      termsAccepted: state.formData.termsAccepted
    };

    const receiptFrom = (registrationId, academyId, status, submittedAt) => ({
      registrationId,
      academyId,
      status: status || "Pending",
      submittedAt: submittedAt || new Date().toISOString(),
      academyName: payload.academy.name,
      officialName: payload.academy.officialName,
      adminFullName: payload.administrator.fullName,
      adminPosition: payload.administrator.position,
      adminEmail: payload.administrator.email,
      adminPhone: payload.administrator.phone,
      city: payload.academy.city,
      town: payload.academy.town,
      state: payload.academy.state
    });

    try {
      const response = await fetch("/api/public/register-academy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const resData = await response.json().catch(() => null);

      if (!response.ok || !resData || !resData.ok) {
        throw new Error((resData && resData.error) || "Registration failed. Please review your information and try again.");
      }

      state.submitting = false;
      state.submissionReceipt = receiptFrom(
        resData.registration.registrationId,
        resData.registration.madrasaId || payload.academy.id,
        resData.registration.status,
        resData.registration.submittedAt
      );
      state.currentStep = 4;
      clearDraft();
      syncUrl(4);
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      // Same rule as the madrasa form: no fabricated reference numbers. A
      // failed submit must not look like a successful one, or the academy
      // waits for an approval on an application that was never stored.
      console.error("Academy registration failed:", e);
      state.submitting = false;
      state.errors.submit = e && e.message
        ? e.message
        : "We could not reach the server. Your details are saved on this page — please check your connection and submit again.";
      state.currentStep = 3;
      render();
      scrollToFirstError();
    }
  }

  async function checkStatusLookup(reference, phone) {
    state.statusModal.loading = true;
    state.statusModal.error = null;
    state.statusModal.result = null;
    render();

    try {
      const q = new URLSearchParams({ ref: String(reference || "").trim(), phone: String(phone || "").trim() });
      const res = await fetch(`/api/public/registration-status?${q.toString()}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error((data && data.error) || "Could not find a registration with that reference and phone number.");
      }
      state.statusModal.loading = false;
      state.statusModal.result = data;
      render();
    } catch (e) {
      const rc = state.submissionReceipt;
      if (rc && String(rc.registrationId).toUpperCase() === String(reference || "").trim().toUpperCase()) {
        state.statusModal.loading = false;
        state.statusModal.result = {
          found: true,
          registrationId: rc.registrationId,
          madrasaName: rc.academyName,
          status: rc.status || "Pending",
          adminFullName: rc.adminFullName,
          submittedAt: rc.submittedAt
        };
      } else {
        state.statusModal.loading = false;
        state.statusModal.error = e.message || "No record found. Please verify the Reference ID.";
      }
      render();
    }
  }

  /* ------------------------------- markup ------------------------------- */

  function renderHeader() {
    return `
      <header class="western-header" id="academy-reg-top">
        <div class="western-nav-shell">
          <a class="western-brand" href="/western-schools" data-route="/western-schools" aria-label="EduSphere Western Academies home">
            <span class="western-brand-icon" aria-hidden="true"><span>B</span></span>
            <span class="western-brand-name"><strong>EduSphere</strong><small>Education Platform</small></span>
            <span class="western-brand-divider" aria-hidden="true"></span>
            <span class="western-brand-section">Western Academy</span>
          </a>
          <nav class="western-desktop-nav" aria-label="Academy registration navigation">
            <a href="/western-schools" data-route="/western-schools">Schools</a>
            <a href="/western-schools#academic-areas" data-route="/western-schools#academic-areas">Programs</a>
            <a class="active" href="/register-academy" data-route="/register-academy" aria-current="page">Register</a>
            <a href="/western-schools#western-contact" data-route="/western-schools#western-contact">Contact</a>
          </nav>
          <div class="western-nav-actions">
            <a class="western-login" href="/login">Login</a>
            <a class="western-register-button wa-reg-back" href="/western-schools" data-route="/western-schools"><span>${icons.arrowLeft}</span> Back to Academies</a>
          </div>
          <button class="western-menu-toggle" type="button" aria-expanded="false" aria-controls="academy-reg-menu" aria-label="Open menu">
            <span class="western-open-icon">${icons.menu}</span><span class="western-close-icon">${icons.close}</span>
          </button>
        </div>
        <nav class="western-mobile-nav" id="academy-reg-menu" aria-label="Academy registration mobile navigation" aria-hidden="true">
          <a href="/western-schools" data-route="/western-schools">Schools</a>
          <a href="/western-schools#academic-areas" data-route="/western-schools#academic-areas">Programs</a>
          <a href="/western-schools#western-contact" data-route="/western-schools#western-contact">Contact</a>
          <a class="western-mobile-login" href="/login">Login</a>
          <a class="western-register-button" href="/western-schools" data-route="/western-schools">Back to Academies</a>
        </nav>
      </header>`;
  }

  /* Each stage is its own page, so the hero announces the page you are on. */
  const HERO_COPY = {
    1: {
      title: "Register Your <em>Academy</em>",
      subtitle: "Bring your school into the EduSphere Western Academies directory. Create your academy profile, publish your programs, and manage students, teachers and classes from one place."
    },
    2: {
      title: "Administrator <em>Account</em>",
      subtitle: "Create the account that will manage your academy on EduSphere — classes, admissions, teachers, results and your public academy website."
    },
    3: {
      title: "Review Your <em>Registration</em>",
      subtitle: "Check every detail below. You can edit any section before submitting your academy for approval."
    },
    4: {
      title: "Registration <em>Submitted</em>",
      subtitle: "Your academy registration has been received and is now awaiting review by the EduSphere team."
    }
  };

  function renderHero() {
    const step = state.currentStep;
    const progress = step === 1 ? 25 : step === 2 ? 50 : step === 3 ? 75 : 100;
    const hero = HERO_COPY[step] || HERO_COPY[1];
    const steps = [
      ["1. Academy Information", "Academy Information"],
      ["2. Administrator", "Administrator Account"],
      ["3. Review", "Review Information"],
      ["4. Submit", "Registration Submitted"]
    ];

    return `
      <section class="wa-reg-hero">
        <div class="western-container">
          <div class="wa-reg-hero-copy">
            <p class="western-eyebrow"><span></span>EduSphere Education Platform <i></i> Academy Onboarding</p>
            <h1 id="academy-reg-title">${hero.title}</h1>
            <p class="wa-reg-hero-text">${escapeHtml(hero.subtitle)}</p>
          </div>

          ${state.notice ? `
            <div class="wa-reg-notice" role="status">
              <span>${icons.info}</span>
              <p>${escapeHtml(state.notice)}</p>
            </div>
          ` : ""}

          <div class="wa-stepper" aria-label="Registration steps">
            <div class="wa-stepper-track" style="--wa-progress: ${progress}%;"><span></span></div>
            ${steps.map(([label], i) => {
              const n = i + 1;
              const cls = `${step === n ? "is-active" : ""} ${step > n ? "is-complete" : ""}`;
              const clickable = step > n;
              return `
                <div class="wa-stepper-item ${cls}">
                  <button type="button" class="wa-stepper-bubble" ${clickable ? `data-wa-action="go-step" data-step="${n}"` : "disabled"} aria-current="${step === n ? "step" : "false"}">
                    ${step > n || (n === 4 && step === 4) ? icons.check : n}
                  </button>
                  <span class="wa-stepper-label">${label}</span>
                </div>`;
            }).join("")}
          </div>

          <div class="wa-mobile-step">
            <span>Step ${step} of 4:</span>
            <strong>${steps[step - 1][1]}</strong>
            <span class="wa-mobile-step-pct">${progress}%</span>
          </div>
        </div>
      </section>`;
  }

  function renderSidebar() {
    const step = state.currentStep;
    const list = [
      ["Academy Profile &amp; Location", "School info, address, contact"],
      ["Administrator Account", "Designated manager &amp; credentials"],
      ["Information Review", "Verify all data before submission"],
      ["Submission &amp; Review", "Pending academy approval"]
    ];

    return `
      <aside class="wa-reg-sidebar" aria-label="Registration guidance">
        <div class="wa-side-card">
          <div class="wa-side-head">
            <h3>Registration Progress</h3>
            <span class="wa-badge wa-badge-sky">Step ${step} of 4</span>
          </div>
          <ul class="wa-side-steps">
            ${list.map((item, i) => {
              const n = i + 1;
              return `
                <li class="${step >= n ? "is-done" : ""} ${step === n ? "is-current" : ""}">
                  <span class="wa-side-dot">${step > n || (n === 4 && step === 4) ? icons.check : "•"}</span>
                  <div><strong>${item[0]}</strong><small>${item[1]}</small></div>
                </li>`;
            }).join("")}
          </ul>
          <div class="wa-side-time"><span>${icons.clock}</span><span>Estimated time to complete: <strong>~ 3 minutes</strong></span></div>
        </div>

        <div class="wa-side-card wa-side-benefits">
          <span class="wa-side-kicker">Western Academy Network</span>
          <h3>Why register with EduSphere?</h3>
          <ul>
            <li><span>${icons.check}</span><span><strong>Be discovered</strong> by families searching for academies</span></li>
            <li><span>${icons.check}</span><span><strong>Publish your programs</strong>, subjects and education levels</span></li>
            <li><span>${icons.check}</span><span><strong>Get your own academy website</strong> with your name and colors</span></li>
            <li><span>${icons.check}</span><span><strong>Manage students, teachers and classes</strong> digitally</span></li>
            <li><span>${icons.check}</span><span><strong>Share results and reports</strong> with parents securely</span></li>
            <li><span>${icons.check}</span><span><strong>Run admissions online</strong> from one dashboard</span></li>
          </ul>
        </div>

        <div class="wa-side-card wa-side-help">
          <h4>Need assistance?</h4>
          <p>Our onboarding team can help your academy complete registration.</p>
          <a href="mailto:support@edusphere.app" class="wa-side-link">${icons.mail} support@edusphere.app</a>
          <button type="button" class="wa-side-link as-button" data-wa-action="open-status">${icons.search} Check existing application status</button>
        </div>
      </aside>`;
  }

  function renderStep1() {
    const m = state.formData.academy;
    const err = state.errors;

    return `
      <div class="wa-reg-step">
        <section class="wa-reg-card">
          <span class="wa-section-badge">Section 1</span>
          <div class="wa-section-title"><h2>Academy Information</h2><p>Tell families about your school.</p></div>

          <div class="wa-grid">
            <div class="wa-field col-12 ${err.academyName ? "has-error" : ""}">
              <label for="a_name">Academy Name <span class="wa-req">*</span></label>
              <div class="wa-input"><input type="text" id="a_name" value="${escapeHtml(m.name)}" placeholder="e.g. Northbridge Academy" autocomplete="organization" required></div>
              ${err.academyName ? `<p class="wa-field-error">${err.academyName}</p>` : ""}
            </div>

            <div class="wa-field col-12">
              <label for="a_official_name">Official Name <span class="wa-opt">(as registered with authorities)</span></label>
              <div class="wa-input"><input type="text" id="a_official_name" value="${escapeHtml(m.officialName)}" placeholder="Enter the official registered name"></div>
            </div>

            <div class="wa-field col-12 ${err.logo ? "has-error" : ""}">
              <label>Academy Logo</label>
              ${m.logo ? `
                <div class="wa-logo-preview">
                  <div class="wa-logo-thumb"><img src="${m.logo}" alt="Academy logo preview"></div>
                  <div class="wa-logo-meta"><strong>${escapeHtml(m.logoName || "academy-logo.png")}</strong><small>${m.logoSize ? (m.logoSize / 1024).toFixed(1) + " KB" : "Uploaded image"}</small></div>
                  <div class="wa-logo-actions">
                    <label class="wa-btn wa-btn-ghost wa-btn-small" for="a_logo_upload">Change Logo</label>
                    <button type="button" class="wa-btn wa-btn-danger wa-btn-small" data-wa-action="remove-logo">${icons.trash} Remove</button>
                  </div>
                  <input type="file" id="a_logo_upload" accept="image/png, image/jpeg, image/jpg" class="wa-sr-only">
                </div>
              ` : `
                <div class="wa-dropzone" id="a_logo_dropzone" role="button" tabindex="0" aria-label="Upload academy logo">
                  <input type="file" id="a_logo_upload" accept="image/png, image/jpeg, image/jpg" class="wa-sr-only">
                  <span class="wa-dropzone-icon">${icons.upload}</span>
                  <strong>Upload Academy Logo</strong>
                  <p>Drag and drop your logo here, or <span class="wa-browse">browse files</span></p>
                  <small>Supported: PNG, JPG, JPEG — Maximum 5MB</small>
                </div>
              `}
              ${err.logo ? `<p class="wa-field-error">${err.logo}</p>` : ""}
            </div>

            <div class="wa-field col-12">
              <label for="a_description">About Your Academy</label>
              <div class="wa-input wa-textarea"><textarea id="a_description" rows="4" placeholder="Share your academy's mission, strengths and learning culture...">${escapeHtml(m.description)}</textarea></div>
              <small class="wa-char-count">${m.description.length} characters</small>
            </div>

            <div class="wa-field col-6 ${err.yearEstablished ? "has-error" : ""}">
              <label for="a_year">Year Established</label>
              <div class="wa-input"><input type="text" id="a_year" value="${escapeHtml(m.yearEstablished)}" placeholder="e.g. 2004" maxlength="4"></div>
              ${err.yearEstablished ? `<p class="wa-field-error">${err.yearEstablished}</p>` : ""}
            </div>

            <div class="wa-field col-6">
              <label for="a_type">Type of Institution <span class="wa-req">*</span></label>
              <div class="wa-input wa-select"><select id="a_type">${INSTITUTION_TYPES.map((t) => `<option value="${t}" ${m.institutionType === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
            </div>

            <div class="wa-field col-12">
              <label for="a_curriculum">Curriculum</label>
              <div class="wa-input wa-select"><select id="a_curriculum">${CURRICULA.map((c) => `<option value="${c}" ${m.curriculum === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
              <p class="wa-field-help">${icons.info} Families use the curriculum to compare academies in the directory.</p>
            </div>
          </div>
        </section>

        <section class="wa-reg-card">
          <span class="wa-section-badge">Section 2</span>
          <div class="wa-section-title"><h2>Academy Location</h2><p>Where is your campus located?</p></div>

          <div class="wa-grid">
            <div class="wa-field col-6 ${err.country ? "has-error" : ""}">
              <label for="a_country">Country <span class="wa-req">*</span></label>
              <div class="wa-input"><input type="text" id="a_country" value="${escapeHtml(m.country || "Nigeria")}" required></div>
              ${err.country ? `<p class="wa-field-error">${err.country}</p>` : ""}
            </div>

            <div class="wa-field col-6 ${err.state ? "has-error" : ""}">
              <label for="a_state">State <span class="wa-req">*</span></label>
              <div class="wa-input wa-select"><select id="a_state" required><option value="">Select State</option>${(locationOptions.states.length ? locationOptions.states : NIGERIAN_STATES).map((st) => `<option value="${st}" ${m.state === st ? "selected" : ""}>${st}</option>`).join("")}</select></div>
              ${err.state ? `<p class="wa-field-error">${err.state}</p>` : ""}
            </div>

            <div class="wa-field col-6 ${err.city ? "has-error" : ""}">
              <label for="a_city">City <span class="wa-req">*</span></label>
              <div class="wa-input wa-select"><select id="a_city" required ${locationOptions.cities.length ? "" : "disabled"}><option value="">${m.state ? "Select City" : "Select a state first"}</option>${locationOptions.cities.map((c) => `<option value="${c}" ${m.city === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
              ${err.city ? `<p class="wa-field-error">${err.city}</p>` : ""}
            </div>

            <div class="wa-field col-6">
              <label for="a_town">Town <span class="wa-opt">(optional)</span></label>
              <div class="wa-input wa-select"><select id="a_town" ${locationOptions.towns.length ? "" : "disabled"}><option value="">${m.city ? "Select Town" : "Select a city first"}</option>${locationOptions.towns.map((t) => `<option value="${t}" ${m.town === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
              <p class="wa-field-help">${icons.info} Every Nigerian state, its cities and their towns.</p>
            </div>

            <div class="wa-field col-6 ${err.address ? "has-error" : ""}">
              <label for="a_address">Address <span class="wa-req">*</span></label>
              <div class="wa-input"><input type="text" id="a_address" value="${escapeHtml(m.address)}" placeholder="Enter full campus address" required></div>
              ${err.address ? `<p class="wa-field-error">${err.address}</p>` : ""}
            </div>

            <div class="wa-field col-12">
              <label for="a_maps">Google Maps Location <span class="wa-opt">(optional)</span></label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.pin}</span><input type="url" id="a_maps" value="${escapeHtml(m.mapsLink)}" placeholder="Paste Google Maps link"></div>
              <p class="wa-field-help">${icons.info} This helps students and parents find your academy easily.</p>
            </div>
          </div>
        </section>

        <section class="wa-reg-card">
          <span class="wa-section-badge">Section 3</span>
          <div class="wa-section-title"><h2>Contact Information</h2><p>Official channels for parents and platform notifications.</p></div>

          <div class="wa-grid">
            <div class="wa-field col-6 ${err.phone ? "has-error" : ""}">
              <label for="a_phone">Official Phone Number <span class="wa-req">*</span></label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.phone}</span><input type="tel" id="a_phone" value="${escapeHtml(m.phone)}" placeholder="e.g. +234 801 234 5678" required></div>
              ${err.phone ? `<p class="wa-field-error">${err.phone}</p>` : ""}
            </div>

            <div class="wa-field col-6">
              <label for="a_whatsapp">WhatsApp Number</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.whatsapp}</span><input type="tel" id="a_whatsapp" value="${escapeHtml(m.whatsapp)}" placeholder="e.g. +234 801 234 5678"></div>
            </div>

            <div class="wa-field col-6 ${err.academyEmail ? "has-error" : ""}">
              <label for="a_email">Email Address</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.mail}</span><input type="email" id="a_email" value="${escapeHtml(m.email)}" placeholder="info@youracademy.org"></div>
              ${err.academyEmail ? `<p class="wa-field-error">${err.academyEmail}</p>` : ""}
            </div>

            <div class="wa-field col-6">
              <label for="a_website">Website</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.globe}</span><input type="url" id="a_website" value="${escapeHtml(m.website)}" placeholder="https://youracademy.org"></div>
            </div>

            <div class="wa-field col-6">
              <label for="a_facebook">Facebook Page</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.facebook}</span><input type="text" id="a_facebook" value="${escapeHtml(m.facebook)}" placeholder="e.g. facebook.com/youracademy"></div>
            </div>

            <div class="wa-field col-6">
              <label for="a_instagram">Instagram</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.instagram}</span><input type="text" id="a_instagram" value="${escapeHtml(m.instagram)}" placeholder="e.g. @youracademy"></div>
            </div>
          </div>
        </section>

        <section class="wa-reg-card">
          <span class="wa-section-badge">Section 4</span>
          <div class="wa-section-title"><h2>Academic Programs</h2><p>Select the subject areas your academy offers.</p></div>

          <div class="wa-subject-grid">
            ${SUBJECT_OPTIONS.map((sub) => {
              const checked = m.subjects.includes(sub.name);
              return `
                <label class="wa-subject-chip ${checked ? "is-selected" : ""}" for="a_sub_${sub.id}">
                  <input type="checkbox" id="a_sub_${sub.id}" value="${sub.name}" ${checked ? "checked" : ""} class="wa-sr-only wa-subject-checkbox">
                  <span class="wa-chip-icon">${icons[sub.icon] || icons.book}</span>
                  <span class="wa-chip-title">${sub.name}</span>
                  <span class="wa-chip-check">${icons.check}</span>
                </label>`;
            }).join("")}
          </div>

          <div class="wa-other-subject ${m.subjects.includes("Other") ? "is-visible" : ""}" id="a_other_subject_box">
            <label for="a_other_subject">Other Subject / Program Name</label>
            <div class="wa-input"><input type="text" id="a_other_subject" value="${escapeHtml(m.otherSubjectText)}" placeholder="Specify other subject(s) or program(s)"></div>
          </div>
        </section>

        <section class="wa-reg-card">
          <span class="wa-section-badge">Section 5</span>
          <div class="wa-section-title"><h2>Education Levels &amp; Enrolment</h2><p>Help us set up your classes and academic structure.</p></div>

          <div class="wa-grid">
            <div class="wa-field col-12 ${err.educationLevels ? "has-error" : ""}">
              <label>Education Levels Offered <span class="wa-req">*</span></label>
              <div class="wa-level-grid">
                ${EDUCATION_LEVELS.map((lvl) => {
                  const checked = m.educationLevels.includes(lvl);
                  return `
                    <label class="wa-level-pill ${checked ? "is-selected" : ""}">
                      <input type="checkbox" value="${lvl}" ${checked ? "checked" : ""} class="wa-sr-only wa-level-checkbox">
                      <span class="wa-pill-check">${checked ? icons.check : "+"}</span>
                      <span>${lvl}</span>
                    </label>`;
                }).join("")}
              </div>
              ${err.educationLevels ? `<p class="wa-field-error">${err.educationLevels}</p>` : ""}
            </div>

            <div class="wa-field col-4">
              <label for="a_students">Current Number of Students</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.users}</span><input type="number" id="a_students" value="${escapeHtml(m.studentCount)}" placeholder="e.g. 420" min="0"></div>
            </div>

            <div class="wa-field col-4">
              <label for="a_teachers">Number of Teachers</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.teacher}</span><input type="number" id="a_teachers" value="${escapeHtml(m.teacherCount)}" placeholder="e.g. 28" min="0"></div>
            </div>

            <div class="wa-field col-4">
              <label for="a_classes">Number of Classes</label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.calendar}</span><input type="number" id="a_classes" value="${escapeHtml(m.classCount)}" placeholder="e.g. 14" min="0"></div>
            </div>
          </div>
        </section>

        <div class="wa-actions-bar">
          <a href="/western-schools" data-route="/western-schools" class="wa-btn wa-btn-ghost"><span>${icons.arrowLeft}</span> Cancel</a>
          <button type="button" class="wa-btn wa-btn-primary" data-wa-action="go-step" data-step="2">Continue to Administrator Account <span>${icons.arrow}</span></button>
        </div>
      </div>`;
  }

  /* The Administrator Account page (/register-academy/administrator).
     Opened by the "Continue to Administrator Account" button on the academy
     information page, and restates which academy the account is for. */
  function renderStep2() {
    const m = state.formData.academy;
    const a = state.formData.administrator;
    const err = state.errors;
    const strength = getPasswordStrength(a.password);
    const place = [m.town, m.city, m.state].filter(Boolean).join(", ");

    return `
      <div class="wa-reg-step" id="administrator-account">
        <section class="wa-reg-card wa-admin-context">
          <span class="wa-admin-context-logo">${m.logo ? `<img src="${m.logo}" alt="${escapeHtml(m.name)} logo">` : icons.building}</span>
          <div class="wa-admin-context-copy">
            <small>Creating the administrator account for</small>
            <strong>${escapeHtml(m.name || "Your academy")}</strong>
            ${place ? `<span>${icons.pin} ${escapeHtml(place)}</span>` : ""}
          </div>
          <button type="button" class="wa-btn wa-btn-outline wa-btn-small" data-wa-action="go-step" data-step="1">${icons.edit} Edit academy details</button>
        </section>

        <section class="wa-reg-card">
          <span class="wa-section-badge">Section 6</span>
          <div class="wa-section-title"><h2>Create Administrator Account</h2><p>This account will manage your academy on EduSphere.</p></div>

          <div class="wa-callout">
            <span>${icons.shieldCheck}</span>
            <div><strong>Academy Administrator Privileges</strong><small>This primary account manages classes, admissions, teachers, results and your public academy website.</small></div>
          </div>

          <div class="wa-grid">
            <div class="wa-field col-6 ${err.adminFullName ? "has-error" : ""}">
              <label for="a_admin_name">Administrator Full Name <span class="wa-req">*</span></label>
              <div class="wa-input"><input type="text" id="a_admin_name" value="${escapeHtml(a.fullName)}" placeholder="e.g. Mrs. Adaeze Okafor" autocomplete="name" required></div>
              ${err.adminFullName ? `<p class="wa-field-error">${err.adminFullName}</p>` : ""}
            </div>

            <div class="wa-field col-6 ${err.adminPosition ? "has-error" : ""}">
              <label for="a_admin_position">Position / Role <span class="wa-req">*</span></label>
              <div class="wa-input wa-select"><select id="a_admin_position" required>${ADMIN_ROLES.map((r) => `<option value="${r}" ${a.position === r ? "selected" : ""}>${r}</option>`).join("")}</select></div>
              ${err.adminPosition ? `<p class="wa-field-error">${err.adminPosition}</p>` : ""}
            </div>

            <div class="wa-field col-6 ${err.adminEmail ? "has-error" : ""}">
              <label for="a_admin_email">Email Address <span class="wa-req">*</span></label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.mail}</span><input type="email" id="a_admin_email" value="${escapeHtml(a.email)}" placeholder="admin@youracademy.org" autocomplete="email" required></div>
              ${err.adminEmail ? `<p class="wa-field-error">${err.adminEmail}</p>` : ""}
            </div>

            <div class="wa-field col-6 ${err.adminPhone ? "has-error" : ""}">
              <label for="a_admin_phone">Phone Number <span class="wa-req">*</span></label>
              <div class="wa-input has-icon"><span class="wa-icon">${icons.phone}</span><input type="tel" id="a_admin_phone" value="${escapeHtml(a.phone)}" placeholder="e.g. +234 801 234 5678" autocomplete="tel" required></div>
              ${err.adminPhone ? `<p class="wa-field-error">${err.adminPhone}</p>` : ""}
            </div>

            <div class="wa-field col-6 ${err.adminPassword ? "has-error" : ""}">
              <label for="a_admin_pass">Password <span class="wa-req">*</span></label>
              <div class="wa-input has-action">
                <input type="${state.showPassword ? "text" : "password"}" id="a_admin_pass" value="${escapeHtml(a.password)}" placeholder="Create a strong password" autocomplete="new-password" required>
                <button type="button" class="wa-input-action" data-wa-action="toggle-password" data-field="password" aria-label="Toggle password visibility">${state.showPassword ? icons.eyeOff : icons.eye}</button>
              </div>
              ${err.adminPassword ? `<p class="wa-field-error">${err.adminPassword}</p>` : ""}

              <div class="wa-password-meter" aria-live="polite">
                <div class="wa-strength-bars">
                  ${[1, 2, 3, 4].map((n) => `<span class="wa-bar ${strength.score >= n && strength.color ? "is-" + strength.color : ""}"></span>`).join("")}
                </div>
                <div class="wa-strength-label"><small>Strength: <strong>${strength.label}</strong></small></div>
                <ul class="wa-password-criteria">
                  <li class="${strength.checks.length ? "met" : ""}">${icons.check} At least 8 characters</li>
                  <li class="${strength.checks.upperLower ? "met" : ""}">${icons.check} Uppercase &amp; lowercase letters</li>
                  <li class="${strength.checks.number ? "met" : ""}">${icons.check} At least 1 number</li>
                  <li class="${strength.checks.special ? "met" : ""}">${icons.check} Special symbol (!@#$%^&amp;*)</li>
                </ul>
              </div>
            </div>

            <div class="wa-field col-6 ${err.adminConfirmPassword ? "has-error" : ""}">
              <label for="a_admin_confirm">Confirm Password <span class="wa-req">*</span></label>
              <div class="wa-input has-action">
                <input type="${state.showConfirmPassword ? "text" : "password"}" id="a_admin_confirm" value="${escapeHtml(a.confirmPassword)}" placeholder="Re-enter your password" autocomplete="new-password" required>
                <button type="button" class="wa-input-action" data-wa-action="toggle-password" data-field="confirm" aria-label="Toggle password visibility">${state.showConfirmPassword ? icons.eyeOff : icons.eye}</button>
              </div>
              ${err.adminConfirmPassword ? `<p class="wa-field-error">${err.adminConfirmPassword}</p>` : ""}
              ${a.confirmPassword && a.password === a.confirmPassword ? `<p class="wa-field-success">${icons.check} Passwords match</p>` : ""}
            </div>

            <div class="wa-field col-12 wa-terms ${err.terms ? "has-error" : ""}">
              <label class="wa-checkbox" for="a_terms">
                <input type="checkbox" id="a_terms" ${state.formData.termsAccepted ? "checked" : ""}>
                <span>I agree to EduSphere's
                  <button type="button" class="wa-text-button" data-wa-action="open-terms">Terms of Service</button> and
                  <button type="button" class="wa-text-button" data-wa-action="open-terms">Privacy Policy</button>.
                </span>
              </label>
              ${err.terms ? `<p class="wa-field-error">${err.terms}</p>` : ""}
            </div>
          </div>
        </section>

        <div class="wa-actions-bar">
          <button type="button" class="wa-btn wa-btn-ghost" data-wa-action="go-step" data-step="1"><span>${icons.arrowLeft}</span> Back to Academy Information</button>
          <button type="button" class="wa-btn wa-btn-primary" data-wa-action="go-step" data-step="3">Continue to Review <span>${icons.arrow}</span></button>
        </div>
      </div>`;
  }

  function reviewItem(label, value) {
    return `<div class="wa-rev-item"><small>${label}</small><strong>${escapeHtml(value || "—")}</strong></div>`;
  }

  function renderStep3() {
    const m = state.formData.academy;
    const a = state.formData.administrator;
    const err = state.errors;

    return `
      <div class="wa-reg-step">
        <section class="wa-reg-card">
          <span class="wa-section-badge">Section 7</span>
          <div class="wa-section-title"><h2>Review Your Academy Information</h2><p>Please verify all details before final submission.</p></div>

          <div class="wa-review-stack">
            <article class="wa-review-card">
              <div class="wa-review-top">
                <div><span class="wa-rev-icon">${icons.building}</span><h3>Academy</h3></div>
                <button type="button" class="wa-btn wa-btn-outline wa-btn-small" data-wa-action="go-step" data-step="1">${icons.edit} Edit</button>
              </div>
              <div class="wa-review-body">
                ${m.logo ? `<div class="wa-review-logo"><img src="${m.logo}" alt="Academy logo preview"></div>` : ""}
                <div class="wa-review-grid">
                  ${reviewItem("Academy Name", m.name)}
                  ${reviewItem("Official Registered Name", m.officialName)}
                  ${reviewItem("Type of Institution", m.institutionType)}
                  ${reviewItem("Curriculum", m.curriculum)}
                  ${reviewItem("Year Established", m.yearEstablished)}
                  <div class="wa-rev-item col-full"><small>About</small><p>${escapeHtml(m.description || "No description provided.")}</p></div>
                </div>
              </div>
            </article>

            <article class="wa-review-card">
              <div class="wa-review-top">
                <div><span class="wa-rev-icon">${icons.pin}</span><h3>Location</h3></div>
                <button type="button" class="wa-btn wa-btn-outline wa-btn-small" data-wa-action="go-step" data-step="1">${icons.edit} Edit</button>
              </div>
              <div class="wa-review-body">
                <div class="wa-review-grid">
                  ${reviewItem("Country", m.country)}
                  ${reviewItem("State", m.state)}
                  ${reviewItem("City", m.city)}
                  ${m.town ? reviewItem("Town", m.town) : ""}
                  ${reviewItem("Address", m.address)}
                  ${m.mapsLink ? `<div class="wa-rev-item col-full"><small>Google Maps Location</small><a class="wa-inline-link" href="${escapeHtml(m.mapsLink)}" target="_blank" rel="noopener noreferrer">${icons.link} View location link</a></div>` : ""}
                </div>
              </div>
            </article>

            <article class="wa-review-card">
              <div class="wa-review-top">
                <div><span class="wa-rev-icon">${icons.phone}</span><h3>Contact</h3></div>
                <button type="button" class="wa-btn wa-btn-outline wa-btn-small" data-wa-action="go-step" data-step="1">${icons.edit} Edit</button>
              </div>
              <div class="wa-review-body">
                <div class="wa-review-grid">
                  ${reviewItem("Phone", m.phone)}
                  ${reviewItem("WhatsApp", m.whatsapp)}
                  ${reviewItem("Email", m.email)}
                  ${reviewItem("Website", m.website)}
                </div>
              </div>
            </article>

            <article class="wa-review-card">
              <div class="wa-review-top">
                <div><span class="wa-rev-icon">${icons.graduation}</span><h3>Programs &amp; Levels</h3></div>
                <button type="button" class="wa-btn wa-btn-outline wa-btn-small" data-wa-action="go-step" data-step="1">${icons.edit} Edit</button>
              </div>
              <div class="wa-review-body">
                <div class="wa-review-part"><small>Academic Programs</small><div class="wa-review-chips">${m.subjects.map((s) => `<span>${s === "Other" && m.otherSubjectText ? escapeHtml(m.otherSubjectText) : escapeHtml(s)}</span>`).join("") || "<span>—</span>"}</div></div>
                <div class="wa-review-part"><small>Education Levels</small><div class="wa-review-chips">${m.educationLevels.map((l) => `<span>${escapeHtml(l)}</span>`).join("") || "<span>—</span>"}</div></div>
                <div class="wa-review-grid">
                  ${reviewItem("Students", m.studentCount)}
                  ${reviewItem("Teachers", m.teacherCount)}
                  ${reviewItem("Classes", m.classCount)}
                </div>
              </div>
            </article>

            <article class="wa-review-card">
              <div class="wa-review-top">
                <div><span class="wa-rev-icon">${icons.users}</span><h3>Administrator</h3></div>
                <button type="button" class="wa-btn wa-btn-outline wa-btn-small" data-wa-action="go-step" data-step="2">${icons.edit} Edit</button>
              </div>
              <div class="wa-review-body">
                <div class="wa-review-grid">
                  ${reviewItem("Name", a.fullName)}
                  ${reviewItem("Position", a.position)}
                  ${reviewItem("Email", a.email)}
                  ${reviewItem("Phone", a.phone)}
                </div>
              </div>
            </article>
          </div>
        </section>

        ${err.submit ? `
          <div class="wa-submit-error has-error" role="alert" aria-live="assertive">
            <strong>Registration not submitted</strong>
            <span>${escapeHtml(err.submit)}</span>
          </div>
        ` : ""}

        <div class="wa-actions-bar">
          <button type="button" class="wa-btn wa-btn-ghost" data-wa-action="go-step" data-step="2"><span>${icons.arrowLeft}</span> Back to Administrator</button>
          <button type="button" class="wa-btn wa-btn-submit ${state.submitting ? "is-loading" : ""}" data-wa-action="submit-registration" ${state.submitting ? "disabled" : ""}>
            ${state.submitting ? `<span class="wa-spinner"></span> Submitting Registration...` : `Submit Academy Registration <span>${icons.sparkles}</span>`}
          </button>
        </div>
      </div>`;
  }

  function renderSuccess() {
    const rc = state.submissionReceipt || {};
    const formattedDate = new Date(rc.submittedAt || Date.now()).toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
    const email = rc.adminEmail || state.formData.administrator.email;

    return `
      <div class="wa-success-card">
        <div class="wa-success-graphic"><span class="wa-success-ring"></span><span class="wa-success-badge">${icons.check}</span></div>
        <h1>Registration Submitted!</h1>
        <p class="wa-success-lead">Thank you for registering your academy with EduSphere.</p>
        <p class="wa-success-note">Your academy registration has been successfully submitted for review.</p>

        <div class="wa-status-pill"><span class="wa-status-dot"></span><strong>Registration Status: Pending Review</strong></div>

        <div class="wa-receipt">
          <div class="wa-receipt-head">
            <div>
              <small>Application Reference</small>
              <div class="wa-ref-box">
                <span id="a_receipt_ref">${escapeHtml(rc.registrationId || "REG-PENDING")}</span>
                <button type="button" data-wa-action="copy-reference" data-reference="${escapeHtml(rc.registrationId || "")}" title="Copy reference ID">${icons.copy}</button>
              </div>
            </div>
            <div class="wa-receipt-date"><small>Submitted On</small><strong>${formattedDate}</strong></div>
          </div>

          <div class="wa-receipt-grid">
            ${reviewItem("Academy Name", rc.academyName || state.formData.academy.name)}
            ${reviewItem("Administrator", `${rc.adminFullName || state.formData.administrator.fullName} (${rc.adminPosition || state.formData.administrator.position})`)}
            ${reviewItem("Contact Email", email)}
            ${reviewItem("Campus Location", `${rc.city || state.formData.academy.city}, ${rc.state || state.formData.academy.state}`)}
          </div>

          <div class="wa-receipt-next">
            <h4>${icons.info} What happens next?</h4>
            <ol>
              <li>Our verification team reviews your academy credentials (1–2 business days).</li>
              <li>You will receive an activation email at <strong>${escapeHtml(email)}</strong>.</li>
              <li>Once approved, log in to your EduSphere academy dashboard to add classes, students and teachers.</li>
            </ol>
          </div>
        </div>

        <div class="wa-success-actions">
          <a class="wa-btn wa-btn-primary" href="/western-schools" data-route="/western-schools">Back to Western Academies <span>${icons.arrow}</span></a>
          <button type="button" class="wa-btn wa-btn-ghost" data-wa-action="open-status" data-reference="${escapeHtml(rc.registrationId || "")}">${icons.search} View Registration Status</button>
        </div>
      </div>`;
  }

  function renderStatusModal() {
    if (!state.statusModal.open) return "";
    const res = state.statusModal.result;
    const err = state.statusModal.error;
    const isLoading = state.statusModal.loading;

    return `
      <div class="wa-modal-backdrop" data-wa-action="close-status-backdrop">
        <div class="wa-modal" role="dialog" aria-modal="true" aria-label="Academy registration status">
          <div class="wa-modal-head">
            <h3><span>${icons.search}</span> Academy Registration Status</h3>
            <button type="button" class="wa-modal-close" data-wa-action="close-status" aria-label="Close status dialog">${icons.close}</button>
          </div>
          <div class="wa-modal-body">
            <form class="wa-grid" data-wa-form="status-search">
              <div class="wa-field col-6">
                <label for="a_st_ref">Registration Reference ID <span class="wa-req">*</span></label>
                <div class="wa-input"><input type="text" id="a_st_ref" value="${escapeHtml(state.statusModal.referenceQuery)}" placeholder="e.g. REG-2026-AB12CD" required></div>
              </div>
              <div class="wa-field col-6">
                <label for="a_st_phone">Contact Phone Number</label>
                <div class="wa-input"><input type="tel" id="a_st_phone" value="${escapeHtml(state.statusModal.phoneQuery)}" placeholder="Phone number used at registration"></div>
              </div>
              <div class="wa-field col-12">
                <button type="submit" class="wa-btn wa-btn-primary wa-btn-block ${isLoading ? "is-loading" : ""}">${isLoading ? "Checking Status..." : "Check Status"}</button>
              </div>
            </form>

            ${err ? `<div class="wa-status-error"><span>${icons.info}</span><p>${escapeHtml(err)}</p></div>` : ""}

            ${res ? `
              <div class="wa-status-result">
                <div class="wa-status-result-head">
                  <div><small>Reference: <strong>${escapeHtml(res.registrationId || "")}</strong></small><h4>${escapeHtml(res.madrasaName || res.academyName || "Academy application")}</h4></div>
                  <span class="wa-badge ${res.status === "Approved" ? "wa-badge-success" : res.status === "Rejected" ? "wa-badge-danger" : "wa-badge-sky"}">${escapeHtml(res.status || "Pending")}</span>
                </div>
                <ol class="wa-timeline">
                  <li class="is-complete"><span>${icons.check}</span><div><strong>Submission Received</strong><small>${res.submittedAt ? new Date(res.submittedAt).toLocaleDateString() : "Received"}</small></div></li>
                  <li class="${res.status === "Approved" ? "is-complete" : "is-current"}"><span>${res.status === "Approved" ? icons.check : icons.clock}</span><div><strong>Academy Verification</strong><small>${res.status === "Approved" ? "Verified by the EduSphere team" : "Under review by our academy team"}</small></div></li>
                  <li class="${res.status === "Approved" ? "is-complete" : ""}"><span>${res.status === "Approved" ? icons.check : "3"}</span><div><strong>Admin Account Provisioning</strong><small>${res.status === "Approved" ? "Account active" : "Scheduled upon verification"}</small></div></li>
                  <li class="${res.status === "Approved" ? "is-complete" : ""}"><span>${res.status === "Approved" ? icons.check : "4"}</span><div><strong>Academy Activation</strong><small>${res.status === "Approved" ? "Ready for students & parents" : "Directory listing unlocked"}</small></div></li>
                </ol>
              </div>` : ""}
          </div>
          <div class="wa-modal-foot"><button type="button" class="wa-btn wa-btn-ghost" data-wa-action="close-status">Close</button></div>
        </div>
      </div>`;
  }

  function renderTermsModal() {
    if (!state.termsModalOpen) return "";
    return `
      <div class="wa-modal-backdrop" data-wa-action="close-terms-backdrop">
        <div class="wa-modal" role="dialog" aria-modal="true" aria-label="Terms of service">
          <div class="wa-modal-head">
            <h3>EduSphere Terms of Service &amp; Privacy Policy</h3>
            <button type="button" class="wa-modal-close" data-wa-action="close-terms" aria-label="Close dialog">${icons.close}</button>
          </div>
          <div class="wa-modal-body wa-terms-copy">
            <h4>1. Academy Partnership</h4>
            <p>By submitting your academy registration to the EduSphere platform, you certify that you are an authorized representative of the school and that the information submitted is accurate.</p>
            <h4>2. Data Privacy &amp; Student Protection</h4>
            <p>EduSphere safeguards school records, staff information and student academic data in line with modern digital data protection standards.</p>
            <h4>3. Academic Standards</h4>
            <p>Registered academies commit to providing a safe, inclusive and high-quality learning environment for every student.</p>
          </div>
          <div class="wa-modal-foot"><button type="button" class="wa-btn wa-btn-primary" data-wa-action="accept-terms">I Understand &amp; Agree</button></div>
        </div>
      </div>`;
  }

  function renderFooter() {
    return `
      <footer class="western-footer" id="academy-reg-contact">
        <div class="western-container western-footer-bottom">
          <span>© <span id="academy-reg-year"></span> EduSphere — Western Academies. All rights reserved.</span>
          <span>Powered by EduSphere Education Platform</span>
        </div>
      </footer>`;
  }

  function render() {
    const app = document.getElementById("app");
    if (!app) return;

    let content = "";
    if (state.currentStep === 1) content = renderStep1();
    else if (state.currentStep === 2) content = renderStep2();
    else if (state.currentStep === 3) content = renderStep3();
    else content = renderSuccess();

    app.innerHTML = `
      ${renderHeader()}
      <main id="main-content" class="wa-reg-main">
        <a class="wa-reg-back-top" href="/western-schools" data-route="/western-schools">
          <span>${icons.arrowLeft}</span> Back to the public website
        </a>
        ${renderHero()}
        <div class="western-container wa-reg-layout">
          <div class="wa-reg-column">${content}</div>
          ${state.currentStep < 4 ? renderSidebar() : ""}
        </div>
      </main>
      ${renderFooter()}
      ${renderStatusModal()}
      ${renderTermsModal()}
      <div id="wa-toast-container" class="wa-toast-container" aria-live="polite"></div>`;

    bindEvents();
  }

  function bindEvents() {
    const m = state.formData.academy;
    const a = state.formData.administrator;

    /* Keep every control compatible with the server's strict Content Security
       Policy. Inline event attributes are blocked by `script-src-attr 'none'`,
       so actions are described in data attributes and bound here, from this
       allowed same-origin script. */
    document.querySelectorAll("[data-wa-action]").forEach((control) => {
      control.addEventListener("click", (event) => {
        const action = control.dataset.waAction;

        if (action === "go-step") {
          event.preventDefault();
          goToStep(Number(control.dataset.step));
        } else if (action === "remove-logo") {
          removeLogo();
        } else if (action === "toggle-password") {
          togglePasswordVisibility(control.dataset.field);
        } else if (action === "submit-registration") {
          submitRegistration();
        } else if (action === "copy-reference") {
          copyRefCode(control.dataset.reference || "");
        } else if (action === "open-status") {
          openStatusModal(control.dataset.reference || undefined);
        } else if (action === "close-status") {
          closeStatusModal();
        } else if (action === "close-status-backdrop") {
          closeStatusModal(event);
        } else if (action === "open-terms") {
          // Policy buttons are nested in the terms label. Opening a policy
          // must not silently check or uncheck consent.
          event.preventDefault();
          event.stopPropagation();
          openTermsModal();
        } else if (action === "close-terms") {
          closeTermsModal();
        } else if (action === "close-terms-backdrop") {
          closeTermsModal(event);
        } else if (action === "accept-terms") {
          acceptTermsAndClose();
        }
      });
    });

    const statusSearchForm = document.querySelector('[data-wa-form="status-search"]');
    if (statusSearchForm) statusSearchForm.addEventListener("submit", handleStatusSearchSubmit);

    const year = document.getElementById("academy-reg-year");
    if (year) year.textContent = new Date().getFullYear();

    const bindInput = (id, setter) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", (e) => {
        setter(e.target.value);
        if (id === "a_description") {
          const counter = document.querySelector(".wa-char-count");
          if (counter) counter.textContent = `${e.target.value.length} characters`;
        }
      });
    };

    bindInput("a_name", (v) => { m.name = v; });
    bindInput("a_official_name", (v) => { m.officialName = v; });
    bindInput("a_description", (v) => { m.description = v; });
    bindInput("a_year", (v) => { m.yearEstablished = v; });
    bindInput("a_country", (v) => { m.country = v; });
    const citySelect = document.getElementById("a_city");
    if (citySelect) citySelect.addEventListener("change", (e) => onLocationCityChange(e.target));

    const townSelect = document.getElementById("a_town");
    if (townSelect) townSelect.addEventListener("change", (e) => { m.town = e.target.value; });
    bindInput("a_address", (v) => { m.address = v; });
    bindInput("a_maps", (v) => { m.mapsLink = v; });
    bindInput("a_phone", (v) => { m.phone = v; });
    bindInput("a_whatsapp", (v) => { m.whatsapp = v; });
    bindInput("a_email", (v) => { m.email = v; });
    bindInput("a_website", (v) => { m.website = v; });
    bindInput("a_facebook", (v) => { m.facebook = v; });
    bindInput("a_instagram", (v) => { m.instagram = v; });
    bindInput("a_other_subject", (v) => { m.otherSubjectText = v; });
    bindInput("a_students", (v) => { m.studentCount = v; });
    bindInput("a_teachers", (v) => { m.teacherCount = v; });
    bindInput("a_classes", (v) => { m.classCount = v; });

    const bindSelect = (id, setter) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", (e) => setter(e.target.value));
    };
    bindSelect("a_type", (v) => { m.institutionType = v; });
    bindSelect("a_curriculum", (v) => { m.curriculum = v; });
    const stateSelect = document.getElementById("a_state");
    if (stateSelect) stateSelect.addEventListener("change", (e) => onLocationStateChange(e.target));
    bindSelect("a_admin_position", (v) => { a.position = v; });

    bindInput("a_admin_name", (v) => { a.fullName = v; });
    bindInput("a_admin_email", (v) => { a.email = v; });
    bindInput("a_admin_phone", (v) => { a.phone = v; });
    bindInput("a_admin_confirm", (v) => { a.confirmPassword = v; });
    bindInput("a_admin_pass", (v) => {
      a.password = v;
      const meter = document.querySelector(".wa-password-meter");
      if (!meter) return;
      const str = getPasswordStrength(v);
      meter.querySelectorAll(".wa-strength-bars .wa-bar").forEach((bar, idx) => {
        bar.className = `wa-bar ${str.score > idx && str.color ? "is-" + str.color : ""}`;
      });
      const lbl = meter.querySelector(".wa-strength-label strong");
      if (lbl) lbl.textContent = str.label;
      const lis = meter.querySelectorAll(".wa-password-criteria li");
      if (lis[0]) lis[0].className = str.checks.length ? "met" : "";
      if (lis[1]) lis[1].className = str.checks.upperLower ? "met" : "";
      if (lis[2]) lis[2].className = str.checks.number ? "met" : "";
      if (lis[3]) lis[3].className = str.checks.special ? "met" : "";
    });

    const terms = document.getElementById("a_terms");
    if (terms) terms.addEventListener("change", (e) => { state.formData.termsAccepted = e.target.checked; });

    document.querySelectorAll(".wa-subject-checkbox").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const val = e.target.value;
        if (e.target.checked) {
          if (!m.subjects.includes(val)) m.subjects.push(val);
        } else {
          m.subjects = m.subjects.filter((s) => s !== val);
        }
        const card = e.target.closest(".wa-subject-chip");
        if (card) card.classList.toggle("is-selected", e.target.checked);
        const other = document.getElementById("a_other_subject_box");
        if (other) other.classList.toggle("is-visible", m.subjects.includes("Other"));
      });
    });

    document.querySelectorAll(".wa-level-checkbox").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const val = e.target.value;
        if (e.target.checked) {
          if (!m.educationLevels.includes(val)) m.educationLevels.push(val);
        } else {
          m.educationLevels = m.educationLevels.filter((l) => l !== val);
        }
        const pill = e.target.closest(".wa-level-pill");
        if (pill) {
          pill.classList.toggle("is-selected", e.target.checked);
          const check = pill.querySelector(".wa-pill-check");
          if (check) check.innerHTML = e.target.checked ? icons.check : "+";
        }
      });
    });

    const dropzone = document.getElementById("a_logo_dropzone");
    const fileInput = document.getElementById("a_logo_upload");
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) handleLogoFile(e.target.files[0]);
      });
    }
    if (dropzone && fileInput) {
      dropzone.addEventListener("click", () => fileInput.click());
      dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
      });
      ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (e) => {
        e.preventDefault(); e.stopPropagation(); dropzone.classList.add("is-dragging");
      }));
      ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (e) => {
        e.preventDefault(); e.stopPropagation(); dropzone.classList.remove("is-dragging");
      }));
      dropzone.addEventListener("drop", (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleLogoFile(e.dataTransfer.files[0]);
      });
    }

    const toggle = document.querySelector(".western-menu-toggle");
    const menu = document.getElementById("academy-reg-menu");
    if (toggle && menu) {
      const closeMenu = () => {
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open menu");
        menu.setAttribute("aria-hidden", "true");
        document.body.classList.remove("western-menu-open");
      };
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        menu.setAttribute("aria-hidden", String(!open));
        document.body.classList.toggle("western-menu-open", open);
      });
      menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
    }

    document.querySelectorAll("[data-route]").forEach((link) => {
      link.addEventListener("click", (e) => {
        const route = link.getAttribute("data-route");
        if (route && window.BelloRouter) {
          e.preventDefault();
          window.BelloRouter.navigate(route);
        }
      });
    });
  }

  function togglePasswordVisibility(field) {
    if (field === "password") state.showPassword = !state.showPassword;
    else state.showConfirmPassword = !state.showConfirmPassword;
    render();
  }

  function copyRefCode(code) {
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code)
        .then(() => showToast("Reference ID copied to clipboard!"))
        .catch(() => showToast("Reference ID: " + code));
    } else {
      showToast("Reference ID: " + code);
    }
  }

  function showToast(msg) {
    const cont = document.getElementById("wa-toast-container");
    if (!cont) return;
    const t = document.createElement("div");
    t.className = "wa-toast";
    t.innerHTML = `<span>${icons.check}</span> ${escapeHtml(msg)}`;
    cont.appendChild(t);
    setTimeout(() => {
      t.classList.add("is-out");
      setTimeout(() => t.remove(), 300);
    }, 3000);
  }

  function openStatusModal(refCode) {
    state.statusModal.open = true;
    state.statusModal.error = null;
    if (refCode) {
      state.statusModal.referenceQuery = refCode;
      state.statusModal.phoneQuery = state.formData.administrator.phone || "";
      checkStatusLookup(refCode, state.formData.administrator.phone);
    } else {
      render();
    }
  }

  function closeStatusModal(e) {
    if (e && e.target && !e.target.classList.contains("wa-modal-backdrop") && !e.target.closest(".wa-modal-close")) return;
    state.statusModal.open = false;
    render();
  }

  function handleStatusSearchSubmit(e) {
    e.preventDefault();
    const refEl = document.getElementById("a_st_ref");
    const phoneEl = document.getElementById("a_st_phone");
    const ref = refEl ? refEl.value : "";
    const phone = phoneEl ? phoneEl.value : "";
    state.statusModal.referenceQuery = ref;
    state.statusModal.phoneQuery = phone;
    checkStatusLookup(ref, phone);
  }

  function openTermsModal() {
    state.termsModalOpen = true;
    render();
  }

  function closeTermsModal(e) {
    if (e && e.target && !e.target.classList.contains("wa-modal-backdrop") && !e.target.closest(".wa-modal-close")) return;
    state.termsModalOpen = false;
    render();
  }

  function acceptTermsAndClose() {
    state.formData.termsAccepted = true;
    state.termsModalOpen = false;
    delete state.errors.terms;
    render();
  }

  function escapeHtml(str) {
    return String(str === 0 ? "0" : (str || ""))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /* Back/Forward is driven by the SPA router (public/js/app.js), which calls
     mount() again for the new URL — so this module does not add a competing
     popstate listener of its own. */
  return {
    mount() {
      // A deep link or a reload rebuilds the academy details from the saved
      // draft, but only while the form is still untouched so an in-progress
      // edit is never overwritten by a stale draft.
      const pristine = state.currentStep === 1 && !state.formData.academy.name.trim();
      if (pristine && stepFromPath(window.location.pathname) > 1) restoreDraft();
      syncFromUrl();
      // The live state list; re-render only when it replaced the fallback.
      loadLocationStates().then(async () => {
        const m = state.formData.academy;
        if (m.state && !locationOptions.states.includes(m.state)) {
          m.state = locationOptions.states.includes("Lagos") ? "Lagos" : (locationOptions.states[0] || "");
          m.city = ""; m.town = "";
        }
        if (m.state) {
          locationOptions.cities = locationOptions.citiesByState[m.state] || [];
          if (!locationOptions.cities.includes(m.city)) { m.city = ""; m.town = ""; }
        }
        // A restored draft keeps its town: fetch that one list so the select
        // shows what was already chosen.
        if (m.state && m.city) {
          const data = await fetchLocations(`?state=${encodeURIComponent(m.state)}&city=${encodeURIComponent(m.city)}`);
          locationOptions.towns = data.towns || [];
          if (!locationOptions.towns.includes(m.town)) m.town = "";
        }
        if (locationOptions.states.length) render();
      });
    },
    goToStep,
    submitRegistration,
    removeLogo,
    togglePasswordVisibility,
    copyRefCode,
    openStatusModal,
    closeStatusModal,
    handleStatusSearchSubmit,
    openTermsModal,
    closeTermsModal,
    acceptTermsAndClose,
    getState: () => state,
    /* Exposed so the router/tests can ask which page a URL maps to. */
    stepFromPath,
    stepPaths: () => Object.assign({}, STEP_PATHS),
    reset() { state = getInitialState(); clearDraft(); syncUrl(1, true); render(); }
  };
})();
