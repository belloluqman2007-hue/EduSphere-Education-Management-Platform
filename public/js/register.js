"use strict";

/* ============================================================================
   EduSphere Education Platform — Madrasa Registration Module
   ============================================================================ */

window.BelloRegister = (function () {
  /* Kept as the offline fallback: the live list (37 entries, the FCT
     included under its own name) comes from the platform's own dataset at
     /api/public/locations, which also serves the cities and towns. */
  const NIGERIAN_STATES = [
    "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue",
    "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu",
    "Federal Capital Territory", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano",
    "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun",
    "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"
  ];

  /* The State -> City -> Town cascade. Options are fetched from the platform
     dataset so the location an applicant picks is exactly what the public
     directory can filter on. */
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
    const m = state.formData.madrasa;
    m.state = sel.value;
    m.city = "";
    m.town = "";
    locationOptions.towns = [];
    locationOptions.cities = m.state ? (locationOptions.citiesByState[m.state] || []) : [];
    const citySelect = document.getElementById("f_city");
    fillLocationSelect(citySelect, locationOptions.cities, m.state ? "Select City" : "Select a state first");
    if (citySelect) citySelect.value = "";
    fillLocationSelect(document.getElementById("f_town"), [], "Select a city first");
  }

  async function onLocationCityChange(sel) {
    const m = state.formData.madrasa;
    m.city = sel.value;
    m.town = "";
    fillLocationSelect(document.getElementById("f_town"), [], "Select a city first");
    if (!m.city || !m.state) return;
    const data = await fetchLocations(`?state=${encodeURIComponent(m.state)}&city=${encodeURIComponent(m.city)}`);
    locationOptions.towns = data.towns || [];
    fillLocationSelect(document.getElementById("f_town"), locationOptions.towns, "Select Town");
  }

  const INSTITUTION_TYPES = [
    "Madrasa",
    "Islamic School",
    "Qur'an School",
    "Arabic School",
    "Islamic Learning Centre",
    "Other"
  ];

  const SUBJECT_OPTIONS = [
    { id: "quran", name: "Qur'an", icon: "book" },
    { id: "memorization", name: "Qur'an Memorization", icon: "bookmark" },
    { id: "tajweed", name: "Tajweed", icon: "sound" },
    { id: "hadith", name: "Hadith", icon: "quote" },
    { id: "fiqh", name: "Fiqh", icon: "balance" },
    { id: "tawheed", name: "Tawheed", icon: "star" },
    { id: "aqeedah", name: "Aqeedah", icon: "shield" },
    { id: "seerah", name: "Seerah", icon: "compass" },
    { id: "arabic", name: "Arabic Language", icon: "language" },
    { id: "nahw", name: "Nahw", icon: "grammar" },
    { id: "sarf", name: "Sarf", icon: "morphology" },
    { id: "islamic_studies", name: "Islamic Studies", icon: "library" },
    { id: "islamic_history", name: "Islamic History", icon: "history" },
    { id: "adab", name: "Adab", icon: "heart" },
    { id: "other", name: "Other", icon: "plus" }
  ];

  const AGE_GROUPS = [
    "Children",
    "Teenagers",
    "Adults",
    "All Ages"
  ];

  const ADMIN_ROLES = [
    "Proprietor",
    "Principal",
    "Director",
    "Head Teacher",
    "Administrator",
    "Other"
  ];

  const icons = {
    arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`,
    arrowLeft: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6M12 18l-6-6 6-6"/></svg>`,
    check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19.5 6.5"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10.2c0 5.2-8 10.3-8 10.3s-8-5.1-8-10.3a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10.2" r="2.6"/></svg>`,
    building: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M5 21V7l8-4v18M13 7l6 3v11M9 9v.01M9 13v.01M9 17v.01M17 13v.01M17 17v.01"/></svg>`,
    book: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.7A3.7 3.7 0 0 1 7.7 2H12v18H7.7A3.7 3.7 0 0 0 4 23V5.7ZM20 5.7A3.7 3.7 0 0 0 16.3 2H12v18h4.3A3.7 3.7 0 0 1 20 23V5.7Z"/></svg>`,
    bookmark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
    sound: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h3l4 4V6L8 10H5Zm10.5-.8a4.2 4.2 0 0 1 0 5.6M18 6.4a8 8 0 0 1 0 11.2"/></svg>`,
    quote: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.7 7.2C5.6 8.3 4 10.7 4 14.4h4.5v-4H6.8c.4-1.2 1.3-2 2.9-2.7V7.2Zm8.5 0c-3.1 1.1-4.7 3.5-4.7 7.2H17v-4h-1.7c.4-1.2 1.3-2 2.9-2.7V7.2Z"/></svg>`,
    balance: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M7 21h10M5 7h14M7 7l-4 7h8L7 7Zm10 0-4 7h8l-4-7Z"/></svg>`,
    star: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.2 4.7L19.3 8l-3.7 3.7.9 5.3-4.5-2.5-4.5 2.5.9-5.3L4.7 8l5.1-.3L12 3Z"/></svg>`,
    shield: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    compass: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m15.8 8.2-2.3 5.3-5.3 2.3 2.3-5.3 5.3-2.3Z"/></svg>`,
    language: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h11M9.5 3v2c0 6-2.2 10.1-6.5 12.2M6 10.5c2.2 2.3 4.7 3.8 7.6 4.6M15 18l3.3-8 3.2 8M16.2 15h4.2"/></svg>`,
    grammar: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    morphology: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 16 4-4-4-4M8 8l-4 4 4 4M14 4l-4 16"/></svg>`,
    library: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h4v16H4zM9 4h4v16H9zM14 4h4v16h-4zM19 6h1v14h-1z"/></svg>`,
    history: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    users: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-2.1A4.9 4.9 0 0 1 8.4 13h1.2a4.9 4.9 0 0 1 4.9 4.9V20M16 5.5a3 3 0 0 1 0 5.8M18.3 13.4a4.7 4.7 0 0 1 2.2 4V20"/></svg>`,
    teacher: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h12v10H4zM8 19h4M10 15v4M19 8v7M17 15h4"/><circle cx="19" cy="5" r="2"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>`,
    phone: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
    whatsapp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><path d="M9.5 9.5c.3-.5.7-.5 1-.5h.3c.2 0 .4.1.5.4l.6 1.5c.1.3.1.6 0 .8l-.4.5c-.1.2-.1.3 0 .5.4.7 1 1.3 1.7 1.7.2.1.3.1.5 0l.5-.4c.2-.1.5-.1.8 0l1.5.6c.3.1.4.3.4.5v.3c0 .3 0 .7-.5 1-.4.3-1 .4-1.6.3-1.6-.2-3.1-1.1-4.2-2.2s-2-2.6-2.2-4.2c-.1-.6 0-1.2.3-1.6z"/></svg>`,
    mail: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
    globe: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>`,
    instagram: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
    upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    sparkles: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    close: `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    info: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    link: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
  };

  /* ==========================================================================
     Every stage of the onboarding flow is its OWN addressable page.
     Pressing "Continue to Administrator Account" therefore opens
     /register-madrasa/administrator — a real URL that can be bookmarked,
     shared, reloaded and reached with the browser's Back/Forward buttons —
     instead of silently swapping markup behind the registration URL.
     ========================================================================== */
  const BASE_PATH = "/register-madrasa";
  const STEP_PATHS = {
    1: BASE_PATH,
    2: BASE_PATH + "/administrator",
    3: BASE_PATH + "/review",
    4: BASE_PATH + "/submitted"
  };
  const STEP_TITLES = {
    1: "Register Your Madrasa — EduSphere",
    2: "Administrator Account — Register Your Madrasa | EduSphere",
    3: "Review Your Registration — EduSphere",
    4: "Registration Submitted — EduSphere"
  };
  /* Draft of the madrasa information, so the administrator page survives a
     reload or a shared link. Passwords are NEVER written to storage. */
  const DRAFT_KEY = "bello.madrasa-registration.draft";

  function normalisePath(pathname) {
    return String(pathname || "").replace(/\/+$/, "").toLowerCase() || "/";
  }

  /** Which step the current URL is asking for (1 when it is not a step URL). */
  function stepFromPath(pathname) {
    const p = normalisePath(pathname);
    for (const n of [2, 3, 4]) {
      if (p === normalisePath(STEP_PATHS[n])) return n;
    }
    return 1;
  }

  /** Puts the step's own URL + document title in the address bar. */
  function syncUrl(step, replace) {
    const target = STEP_PATHS[step] || BASE_PATH;
    if (typeof document !== "undefined") document.title = STEP_TITLES[step] || STEP_TITLES[1];
    if (typeof history === "undefined" || !history.pushState) return;
    const current = normalisePath(window.location.pathname);
    if (replace || current === normalisePath(target)) {
      history.replaceState({ belloRegisterStep: step }, "", target);
    } else {
      history.pushState({ belloRegisterStep: step }, "", target);
    }
  }

  function saveDraft() {
    try {
      if (typeof sessionStorage === "undefined") return;
      const m = state.formData.madrasa;
      const a = state.formData.administrator;
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        // The logo is a data URL that can be megabytes wide — it is kept in
        // memory only, never in storage.
        madrasa: Object.assign({}, m, { logo: "", logoName: "", logoSize: 0 }),
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
      if (draft.madrasa) {
        Object.assign(state.formData.madrasa, draft.madrasa, {
          logo: state.formData.madrasa.logo,
          logoName: state.formData.madrasa.logoName,
          logoSize: state.formData.madrasa.logoSize
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

  /* Default Form State with full structured schema */
  function getInitialState() {
    return {
      currentStep: 1, // 1: Madrasa Info, 2: Administrator, 3: Review, 4: Submitted
      submitting: false,
      errors: {},
      // Message shown when a later page is opened directly without its
      // prerequisites (e.g. the administrator link before the madrasa details).
      notice: "",
      showPassword: false,
      showConfirmPassword: false,
      formData: {
        madrasa: {
          id: "",
          name: "",
          officialName: "",
          logo: "",
          logoName: "",
          logoSize: 0,
          description: "",
          yearEstablished: "",
          institutionType: "Madrasa",
          country: "Nigeria",
          state: "Ogun",
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
          subjects: ["Qur'an", "Tajweed", "Arabic Language"],
          otherSubjectText: "",
          studentCount: "",
          teacherCount: "",
          classCount: "",
          ageGroups: ["Children", "Teenagers"]
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

  /* Password strength evaluation */
  function getPasswordStrength(password) {
    const p = String(password || "");
    if (!p) return { score: 0, label: "None", percent: 0, checks: { length: false, upperLower: false, number: false, special: false } };

    const checks = {
      length: p.length >= 8,
      upperLower: /[a-z]/.test(p) && /[A-Z]/.test(p),
      number: /[0-9]/.test(p),
      special: /[^a-zA-Z0-9]/.test(p)
    };

    let passedCount = 0;
    if (checks.length) passedCount++;
    if (checks.upperLower) passedCount++;
    if (checks.number) passedCount++;
    if (checks.special) passedCount++;

    if (p.length < 6) {
      return { score: 1, label: "Too Weak", color: "danger", percent: 20, checks };
    }

    switch (passedCount) {
      case 1:
        return { score: 1, label: "Weak", color: "danger", percent: 25, checks };
      case 2:
        return { score: 2, label: "Fair", color: "warning", percent: 50, checks };
      case 3:
        return { score: 3, label: "Good", color: "gold", percent: 75, checks };
      case 4:
        return { score: 4, label: "Strong", color: "success", percent: 100, checks };
      default:
        return { score: 1, label: "Weak", color: "danger", percent: 25, checks };
    }
  }

  /* Validation rules per step */
  function validateStep(stepNumber) {
    const errors = {};
    const m = state.formData.madrasa;
    const a = state.formData.administrator;

    if (stepNumber === 1 || stepNumber === "all") {
      if (!m.name.trim()) errors.madrasaName = "Madrasa name is required.";
      if (!m.country.trim()) errors.country = "Country is required.";
      if (!m.state.trim()) errors.state = "State is required.";
      if (!m.city.trim()) errors.city = "City or town is required.";
      if (!m.address.trim()) errors.address = "Full address is required.";
      if (!m.phone.trim()) errors.phone = "Official phone number is required.";
      else if (!/^[0-9+\s()-]{7,25}$/.test(m.phone.trim())) {
        errors.phone = "Enter a valid phone number (e.g. +234 801 234 5678).";
      }

      if (m.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email.trim())) {
        errors.madrasaEmail = "Enter a valid email address.";
      }

      if (m.yearEstablished.trim() && !/^\d{4}$/.test(m.yearEstablished.trim())) {
        errors.yearEstablished = "Enter a valid 4-digit year (e.g. 1995).";
      }
    }

    if (stepNumber === 2 || stepNumber === "all") {
      if (!a.fullName.trim()) errors.adminFullName = "Administrator full name is required.";
      if (!a.position.trim()) errors.adminPosition = "Position/Role is required.";
      if (!a.email.trim()) errors.adminEmail = "Administrator email is required.";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email.trim())) {
        errors.adminEmail = "Enter a valid email address.";
      }

      if (!a.phone.trim()) errors.adminPhone = "Administrator phone is required.";
      else if (!/^[0-9+\s()-]{7,25}$/.test(a.phone.trim())) {
        errors.adminPhone = "Enter a valid phone number.";
      }

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

  /* Handle Logo File Selection & Drag-and-Drop */
  function handleLogoFile(file) {
    if (!file) return;

    const validTypes = ["image/png", "image/jpeg", "image/jpg"];
    if (!validTypes.includes(file.type)) {
      state.errors.logo = "Unsupported file type. Please upload a PNG, JPG, or JPEG file.";
      render();
      return;
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      state.errors.logo = "File is too large. Maximum allowed logo size is 5MB.";
      render();
      return;
    }

    delete state.errors.logo;
    const reader = new FileReader();
    reader.onload = function (e) {
      state.formData.madrasa.logo = e.target.result;
      state.formData.madrasa.logoName = file.name;
      state.formData.madrasa.logoSize = file.size;
      render();
    };
    reader.readAsDataURL(file);
  }

  function removeLogo() {
    state.formData.madrasa.logo = "";
    state.formData.madrasa.logoName = "";
    state.formData.madrasa.logoSize = 0;
    delete state.errors.logo;
    render();
  }

  /* Step Navigation & Submission
     Moving between stages navigates to that stage's own page. The guard below
     is what keeps the Administrator page honest: it only opens once the
     madrasa information it belongs to is complete. */
  function goToStep(targetStep, options) {
    const opts = options || {};
    if (targetStep > state.currentStep) {
      // Validate every earlier step, not just the current one, so a direct
      // link to /register-madrasa/review cannot skip the administrator page.
      for (let s = state.currentStep; s < targetStep; s++) {
        const errs = validateStep(s);
        if (Object.keys(errs).length > 0) {
          state.errors = errs;
          state.currentStep = s;
          state.notice = s === 1
            ? "Please complete your madrasa information before creating the administrator account."
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
    // The success page is a receipt — it only exists right after submitting.
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
      const firstErr = document.querySelector(".field-error-text, .form-field.has-error");
      // scrollIntoView is missing in some embedded/test browsers — guarding it
      // keeps a validation message from turning into a page-breaking error.
      if (firstErr && typeof firstErr.scrollIntoView === "function") {
        firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 50);
  }

  /* Submit Form with structured data */
  async function submitRegistration() {
    const errs = validateStep("all");
    if (Object.keys(errs).length > 0) {
      state.errors = errs;
      state.currentStep = errs.madrasaName || errs.country || errs.state || errs.city || errs.address || errs.phone ? 1 : 2;
      render();
      scrollToFirstError();
      return;
    }

    state.submitting = true;
    state.errors = {};
    render();

    // Prepare complete structured dataset
    const m = state.formData.madrasa;
    const a = state.formData.administrator;

    const subjectsList = [...m.subjects];
    if (m.subjects.includes("Other") && m.otherSubjectText.trim()) {
      subjectsList.push(m.otherSubjectText.trim());
    }

    const payload = {
      madrasa: {
        id: m.id || "madrasa_" + Math.random().toString(36).substring(2, 10),
        name: m.name.trim(),
        officialName: m.officialName.trim(),
        logo: m.logo,
        description: m.description.trim(),
        yearEstablished: m.yearEstablished.trim(),
        institutionType: m.institutionType,
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
        ageGroups: m.ageGroups
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

    try {
      // Call public API endpoint
      const response = await fetch("/api/public/register-madrasa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const resData = await response.json().catch(() => null);

      if (!response.ok || !resData || !resData.ok) {
        throw new Error((resData && resData.error) || "Registration failed. Please review your information and try again.");
      }

      state.submitting = false;
      state.submissionReceipt = {
        registrationId: resData.registration.registrationId,
        madrasaId: resData.registration.madrasaId,
        status: resData.registration.status || "Pending",
        submittedAt: resData.registration.submittedAt || new Date().toISOString(),
        madrasaName: payload.madrasa.name,
        officialName: payload.madrasa.officialName,
        adminFullName: payload.administrator.fullName,
        adminPosition: payload.administrator.position,
        adminEmail: payload.administrator.email,
        adminPhone: payload.administrator.phone,
        city: payload.madrasa.city,
        state: payload.madrasa.state
      };
      state.currentStep = 4;
      clearDraft();
      syncUrl(4);
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      // NEVER invent a reference number here. The old fallback minted a fake
      // "REG-…" id and showed the success screen even though the server had
      // saved nothing, so the madrasa believed it had registered while the
      // super admin's Registrations list stayed empty. Keep the applicant on
      // the review step, keep their draft, and tell them the truth.
      console.error("Madrasa registration failed:", err);
      state.submitting = false;
      state.errors.submit = err && err.message
        ? err.message
        : "We could not reach the server. Your details are saved on this page — please check your connection and submit again.";
      state.currentStep = 3;
      render();
      scrollToFirstError();
    }
  }

  /* Registration Status Checker */
  async function checkStatusLookup(reference, phone) {
    state.statusModal.loading = true;
    state.statusModal.error = null;
    state.statusModal.result = null;
    render();

    try {
      const q = new URLSearchParams({ ref: reference.trim(), phone: (phone || "").trim() });
      const res = await fetch(`/api/public/registration-status?${q.toString()}`);
      const data = await res.json().catch(() => null);

      if (!res.ok || !data) {
        throw new Error((data && data.error) || "Could not find registration with the provided reference and phone.");
      }

      state.statusModal.loading = false;
      state.statusModal.result = data;
      render();
    } catch (e) {
      // If offline/fallback, check local submission receipt
      if (state.submissionReceipt && state.submissionReceipt.registrationId.toUpperCase() === reference.trim().toUpperCase()) {
        state.statusModal.loading = false;
        state.statusModal.result = {
          found: true,
          registrationId: state.submissionReceipt.registrationId,
          madrasaName: state.submissionReceipt.madrasaName,
          status: state.submissionReceipt.status || "Pending",
          adminFullName: state.submissionReceipt.adminFullName,
          submittedAt: state.submissionReceipt.submittedAt
        };
      } else {
        state.statusModal.loading = false;
        state.statusModal.error = e.message || "No record found. Please verify the Reference ID.";
      }
      render();
    }
  }

  /* HTML Builders */
  function renderHeader() {
    return `
      <header class="site-header is-scrolled" id="register-header">
        <div class="nav-shell">
          <a class="brand" href="/" data-route="/" aria-label="EduSphere home">
            <span class="brand-logo"><img src="/assets/edusphere-logo.png" alt="EduSphere logo"></span>
            <span class="brand-words"><strong>EduSphere</strong><small>Education Platform</small></span>
          </a>
          <nav class="desktop-nav platform-nav" aria-label="Registration navigation">
            <a href="/" data-route="/">Home</a>
            <a href="/islamic-schools" data-route="/islamic-schools">Islamic Schools</a>
            <a href="/western-schools" data-route="/western-schools">Western Academies</a>
          </nav>
          <div class="nav-actions">
            <a class="button button-small button-secondary" href="/" data-route="/">
              <span>${icons.arrowLeft}</span> Back to Home
            </a>
          </div>
          <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-reg-menu" aria-label="Open menu">
            <span class="open-icon">${icons.building}</span><span class="close-icon">${icons.close}</span>
          </button>
        </div>
        <nav class="mobile-nav" id="mobile-reg-menu" aria-label="Mobile navigation" aria-hidden="true">
          <a href="/" data-route="/">Home</a>
          <a href="/islamic-schools" data-route="/islamic-schools">Islamic Schools</a>
          <a href="/western-schools" data-route="/western-schools">Western Academies</a>
          <a class="button button-secondary" href="/islamic-schools" data-route="/islamic-schools"><span>${icons.arrowLeft}</span> Back to Islamic Schools</a>
        </nav>
      </header>
    `;
  }

  /* Each stage is its own page, so the hero announces the page you are on. */
  const HERO_COPY = {
    1: {
      title: "Register Your Madrasa",
      subtitle: "Bring your madrasa into the EduSphere education community. Create your institution profile and manage your madrasa from one platform."
    },
    2: {
      title: "Administrator Account",
      subtitle: "Create the account that will manage your madrasa on EduSphere — classes, admissions, teachers, results and your public madrasa page."
    },
    3: {
      title: "Review Your Registration",
      subtitle: "Check every detail below. You can edit any section before submitting your madrasa for approval."
    },
    4: {
      title: "Registration Submitted",
      subtitle: "Your madrasa registration has been received and is now awaiting review by the EduSphere team."
    }
  };

  function renderPageHeader() {
    const step = state.currentStep;
    const progressPercent = step === 1 ? 25 : step === 2 ? 50 : step === 3 ? 75 : 100;
    const hero = HERO_COPY[step] || HERO_COPY[1];

    return `
      <a class="reg-back-link" href="/islamic-schools" data-route="/islamic-schools">
        <span>${icons.arrowLeft}</span> Back to the public website
      </a>
      <section class="reg-hero section-pattern">
        <div class="container">
          <div class="reg-hero-content">
            <div class="eyebrow"><span class="eyebrow-dot"></span> Institution Onboarding</div>
            <h1 id="reg-page-title">${escapeHtml(hero.title)}</h1>
            <p class="reg-subtitle">${escapeHtml(hero.subtitle)}</p>
          </div>

          ${state.notice ? `
            <div class="reg-notice" role="status">
              <span>${icons.info}</span>
              <p>${escapeHtml(state.notice)}</p>
            </div>
          ` : ""}

          <!-- Progress Indicator -->
          <div class="reg-stepper" aria-label="Registration Steps">
            <div class="stepper-track" style="--track-progress: ${progressPercent}%;">
              <span class="stepper-bar"></span>
            </div>
            
            <div class="stepper-item ${step === 1 ? 'is-active' : ''} ${step > 1 ? 'is-complete' : ''}" data-step="1">
              <button type="button" class="stepper-bubble" ${step > 1 ? 'data-reg-action="go-step" data-step="1"' : ''} aria-current="${step === 1 ? 'step' : 'false'}">
                <span class="step-num">${step > 1 ? icons.check : '1'}</span>
              </button>
              <span class="stepper-label">1. Madrasa Information</span>
            </div>

            <div class="stepper-item ${step === 2 ? 'is-active' : ''} ${step > 2 ? 'is-complete' : ''}" data-step="2">
              <button type="button" class="stepper-bubble" ${step > 2 ? 'data-reg-action="go-step" data-step="2"' : ''} aria-current="${step === 2 ? 'step' : 'false'}">
                <span class="step-num">${step > 2 ? icons.check : '2'}</span>
              </button>
              <span class="stepper-label">2. Administrator</span>
            </div>

            <div class="stepper-item ${step === 3 ? 'is-active' : ''} ${step > 3 ? 'is-complete' : ''}" data-step="3">
              <button type="button" class="stepper-bubble" ${step > 3 ? 'data-reg-action="go-step" data-step="3"' : ''} aria-current="${step === 3 ? 'step' : 'false'}">
                <span class="step-num">${step > 3 ? icons.check : '3'}</span>
              </button>
              <span class="stepper-label">3. Review</span>
            </div>

            <div class="stepper-item ${step === 4 ? 'is-active is-complete' : ''}" data-step="4">
              <div class="stepper-bubble" aria-current="${step === 4 ? 'step' : 'false'}">
                <span class="step-num">${step === 4 ? icons.check : '4'}</span>
              </div>
              <span class="stepper-label">4. Submit</span>
            </div>
          </div>

          <!-- Mobile step ticker -->
          <div class="mobile-step-pill">
            <span>Step ${step} of 4:</span>
            <strong>${step === 1 ? 'Madrasa Information' : step === 2 ? 'Administrator Account' : step === 3 ? 'Review Information' : 'Registration Submitted'}</strong>
            <span class="mobile-step-pct">${progressPercent}%</span>
          </div>
        </div>
      </section>
    `;
  }

  function renderSidebar() {
    const step = state.currentStep;
    return `
      <aside class="reg-sidebar" aria-label="Registration guidance and benefits">
        <!-- Progress Checklist Card -->
        <div class="reg-card sidebar-progress-card">
          <div class="sidebar-card-header">
            <h3>Registration Progress</h3>
            <span class="badge badge-gold">Step ${step} of 4</span>
          </div>
          <ul class="sidebar-steps-list">
            <li class="${step >= 1 ? 'is-done' : ''} ${step === 1 ? 'is-current' : ''}">
              <span class="check-dot">${step > 1 ? icons.check : '•'}</span>
              <div>
                <strong>Madrasa Profile &amp; Location</strong>
                <small>Institution info, address, contact</small>
              </div>
            </li>
            <li class="${step >= 2 ? 'is-done' : ''} ${step === 2 ? 'is-current' : ''}">
              <span class="check-dot">${step > 2 ? icons.check : '•'}</span>
              <div>
                <strong>Administrator Account</strong>
                <small>Designated manager &amp; credentials</small>
              </div>
            </li>
            <li class="${step >= 3 ? 'is-done' : ''} ${step === 3 ? 'is-current' : ''}">
              <span class="check-dot">${step > 3 ? icons.check : '•'}</span>
              <div>
                <strong>Information Review</strong>
                <small>Verify all data before submission</small>
              </div>
            </li>
            <li class="${step >= 4 ? 'is-done' : ''} ${step === 4 ? 'is-current' : ''}">
              <span class="check-dot">${step === 4 ? icons.check : '•'}</span>
              <div>
                <strong>Submission &amp; Review</strong>
                <small>Pending institutional approval</small>
              </div>
            </li>
          </ul>
          <div class="est-time">
            <span class="est-icon">${icons.clock}</span>
            <span>Estimated time to complete: <strong>~ 3 minutes</strong></span>
          </div>
        </div>

        <!-- Why Register With EduSphere Card -->
        <div class="reg-card sidebar-benefit-card">
          <div class="sidebar-card-header">
            <span class="card-kicker">Multi-Madrasa Network</span>
            <h3>Why register with EduSphere?</h3>
          </div>
          <ul class="benefit-checklist">
            <li>
              <span class="benefit-tick">${icons.check}</span>
              <span><strong>Reach more students</strong> across your community</span>
            </li>
            <li>
              <span class="benefit-tick">${icons.check}</span>
              <span><strong>Manage your madrasa digitally</strong> with ease</span>
            </li>
            <li>
              <span class="benefit-tick">${icons.check}</span>
              <span><strong>Organize teachers and classes</strong> seamlessly</span>
            </li>
            <li>
              <span class="benefit-tick">${icons.check}</span>
              <span><strong>Manage student records</strong> &amp; report cards</span>
            </li>
            <li>
              <span class="benefit-tick">${icons.check}</span>
              <span><strong>Connect with parents and students</strong> in real time</span>
            </li>
            <li>
              <span class="benefit-tick">${icons.check}</span>
              <span><strong>Build your madrasa's online presence</strong></span>
            </li>
          </ul>
        </div>

        <!-- Support Card -->
        <div class="reg-card sidebar-help-card">
          <h4>Need assistance?</h4>
          <p>Our onboarding team is available to assist your administration with registration.</p>
          <div class="support-links">
            <a href="mailto:support@edusphere.app" class="support-item">
              <span class="sup-icon">${icons.mail}</span>
              <span>support@edusphere.app</span>
            </a>
            <button type="button" class="text-link status-lookup-btn" data-reg-action="open-status">
              <span>${icons.search}</span> Check existing application status
            </button>
          </div>
        </div>
      </aside>
    `;
  }

  function renderStep1() {
    const m = state.formData.madrasa;
    const err = state.errors;

    return `
      <div class="reg-form-step reveal is-visible">
        <!-- Section 1: Madrasa Information -->
        <div class="reg-form-section">
          <div class="section-badge">Section 1</div>
          <div class="section-title-wrap">
            <h2>Madrasa Information</h2>
            <p>Tell us about your madrasa.</p>
          </div>

          <div class="form-grid">
            <!-- Madrasa Name -->
            <div class="form-field col-12 ${err.madrasaName ? 'has-error' : ''}">
              <label for="f_name">Madrasa Name <span class="req">*</span></label>
              <div class="input-wrap">
                <input type="text" id="f_name" name="name" value="${escapeHtml(m.name)}" placeholder="Enter your madrasa name" required autocomplete="organization">
              </div>
              ${err.madrasaName ? `<p class="field-error-text">${err.madrasaName}</p>` : ''}
            </div>

            <!-- Official Name -->
            <div class="form-field col-12">
              <label for="f_official_name">Official Name <span class="opt">(as registered with authorities)</span></label>
              <div class="input-wrap">
                <input type="text" id="f_official_name" name="officialName" value="${escapeHtml(m.officialName)}" placeholder="Enter the official registered name">
              </div>
            </div>

            <!-- Logo Upload Drag and Drop -->
            <div class="form-field col-12 ${err.logo ? 'has-error' : ''}">
              <label>Madrasa Logo</label>
              
              ${m.logo ? `
                <div class="logo-preview-box">
                  <div class="logo-thumb">
                    <img src="${m.logo}" alt="Madrasa Logo Preview">
                  </div>
                  <div class="logo-meta">
                    <strong>${escapeHtml(m.logoName || 'madrasa-logo.png')}</strong>
                    <small>${m.logoSize ? (m.logoSize / 1024).toFixed(1) + ' KB' : 'Uploaded image'}</small>
                  </div>
                  <div class="logo-actions">
                    <label class="button button-small button-secondary change-logo-btn" for="f_logo_upload">
                      Change Logo
                    </label>
                    <button type="button" class="button button-small button-danger-light" data-reg-action="remove-logo">
                      ${icons.trash} Remove
                    </button>
                  </div>
                  <input type="file" id="f_logo_upload" accept="image/png, image/jpeg, image/jpg" class="sr-only">
                </div>
              ` : `
                <div class="dropzone" id="logo_dropzone" role="button" tabindex="0" aria-label="Upload Madrasa Logo">
                  <input type="file" id="f_logo_upload" accept="image/png, image/jpeg, image/jpg" class="sr-only">
                  <div class="dropzone-icon">${icons.upload}</div>
                  <div class="dropzone-copy">
                    <strong>Upload Madrasa Logo</strong>
                    <p>Drag and drop your logo file here, or <span class="browse-link">browse files</span></p>
                    <small>Supported: PNG, JPG, JPEG — Maximum 5MB</small>
                  </div>
                </div>
              `}
              ${err.logo ? `<p class="field-error-text">${err.logo}</p>` : ''}
            </div>

            <!-- Description -->
            <div class="form-field col-12">
              <label for="f_description">Description</label>
              <div class="textarea-wrap">
                <textarea id="f_description" name="description" rows="4" placeholder="Tell students and parents about your madrasa...">${escapeHtml(m.description)}</textarea>
                <small class="char-count">${m.description.length} characters</small>
              </div>
            </div>

            <!-- Year Established -->
            <div class="form-field col-6 ${err.yearEstablished ? 'has-error' : ''}">
              <label for="f_year">Year Established</label>
              <div class="input-wrap">
                <input type="text" id="f_year" name="yearEstablished" value="${escapeHtml(m.yearEstablished)}" placeholder="e.g. 1986" maxlength="4">
              </div>
              ${err.yearEstablished ? `<p class="field-error-text">${err.yearEstablished}</p>` : ''}
            </div>

            <!-- Type of Institution -->
            <div class="form-field col-6">
              <label for="f_type">Type of Institution <span class="req">*</span></label>
              <div class="select-wrap">
                <select id="f_type" name="institutionType">
                  ${INSTITUTION_TYPES.map(t => `<option value="${t}" ${m.institutionType === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- Section 2: Location -->
        <div class="reg-form-section">
          <div class="section-badge">Section 2</div>
          <div class="section-title-wrap">
            <h2>Madrasa Location</h2>
            <p>Where is your physical or administrative campus located?</p>
          </div>

          <div class="form-grid">
            <!-- Country -->
            <div class="form-field col-6 ${err.country ? 'has-error' : ''}">
              <label for="f_country">Country <span class="req">*</span></label>
              <div class="input-wrap has-prefix">
                <span class="input-prefix">🇳🇬</span>
                <input type="text" id="f_country" name="country" value="${escapeHtml(m.country || 'Nigeria')}" required>
              </div>
              ${err.country ? `<p class="field-error-text">${err.country}</p>` : ''}
            </div>

            <!-- State -->
            <div class="form-field col-6 ${err.state ? 'has-error' : ''}">
              <label for="f_state">State <span class="req">*</span></label>
              <div class="select-wrap">
                <select id="f_state" name="state" required>
                  <option value="">Select State</option>
                  ${(locationOptions.states.length ? locationOptions.states : NIGERIAN_STATES).map(st => `<option value="${st}" ${m.state === st ? 'selected' : ''}>${st}</option>`).join('')}
                </select>
              </div>
              ${err.state ? `<p class="field-error-text">${err.state}</p>` : ''}
            </div>

            <!-- City (LGA / area council) -->
            <div class="form-field col-6 ${err.city ? 'has-error' : ''}">
              <label for="f_city">City <span class="req">*</span></label>
              <div class="select-wrap">
                <select id="f_city" name="city" required ${locationOptions.cities.length ? '' : 'disabled'}>
                  <option value="">${m.state ? 'Select City' : 'Select a state first'}</option>
                  ${locationOptions.cities.map(c => `<option value="${c}" ${m.city === c ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
              </div>
              ${err.city ? `<p class="field-error-text">${err.city}</p>` : ''}
            </div>

            <!-- Town / district -->
            <div class="form-field col-6">
              <label for="f_town">Town <span class="opt">(optional)</span></label>
              <div class="select-wrap">
                <select id="f_town" name="town" ${locationOptions.towns.length ? '' : 'disabled'}>
                  <option value="">${m.city ? 'Select Town' : 'Select a city first'}</option>
                  ${locationOptions.towns.map(t => `<option value="${t}" ${m.town === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
              </div>
              <p class="field-helper-text">${icons.info} Every Nigerian state, its cities and their towns — pick the ones that apply.</p>
            </div>

            <!-- Address -->
            <div class="form-field col-12 ${err.address ? 'has-error' : ''}">
              <label for="f_address">Address <span class="req">*</span></label>
              <div class="input-wrap">
                <input type="text" id="f_address" name="address" value="${escapeHtml(m.address)}" placeholder="Enter full madrasa address" required>
              </div>
              ${err.address ? `<p class="field-error-text">${err.address}</p>` : ''}
            </div>

            <!-- Google Maps Location -->
            <div class="form-field col-12">
              <label for="f_maps">Google Maps Location <span class="opt">(optional)</span></label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.pin}</span>
                <input type="url" id="f_maps" name="mapsLink" value="${escapeHtml(m.mapsLink)}" placeholder="Paste Google Maps link">
              </div>
              <p class="field-helper-text">${icons.info} This helps students and parents find your madrasa easily.</p>
            </div>
          </div>
        </div>

        <!-- Section 3: Contact Information -->
        <div class="reg-form-section">
          <div class="section-badge">Section 3</div>
          <div class="section-title-wrap">
            <h2>Madrasa Contact Information</h2>
            <p>Official communication channels for parents and platform notifications.</p>
          </div>

          <div class="form-grid">
            <!-- Official Phone Number -->
            <div class="form-field col-6 ${err.phone ? 'has-error' : ''}">
              <label for="f_phone">Official Phone Number <span class="req">*</span></label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.phone}</span>
                <input type="tel" id="f_phone" name="phone" value="${escapeHtml(m.phone)}" placeholder="e.g. +234 801 234 5678" required>
              </div>
              ${err.phone ? `<p class="field-error-text">${err.phone}</p>` : ''}
            </div>

            <!-- WhatsApp Number -->
            <div class="form-field col-6">
              <label for="f_whatsapp">WhatsApp Number</label>
              <div class="input-wrap has-icon">
                <span class="field-icon whatsapp-color">${icons.whatsapp}</span>
                <input type="tel" id="f_whatsapp" name="whatsapp" value="${escapeHtml(m.whatsapp)}" placeholder="e.g. +234 801 234 5678">
              </div>
            </div>

            <!-- Email Address -->
            <div class="form-field col-6 ${err.madrasaEmail ? 'has-error' : ''}">
              <label for="f_email">Email Address</label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.mail}</span>
                <input type="email" id="f_email" name="email" value="${escapeHtml(m.email)}" placeholder="info@yourmadrasa.org">
              </div>
              ${err.madrasaEmail ? `<p class="field-error-text">${err.madrasaEmail}</p>` : ''}
            </div>

            <!-- Website -->
            <div class="form-field col-6">
              <label for="f_website">Website</label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.globe}</span>
                <input type="url" id="f_website" name="website" value="${escapeHtml(m.website)}" placeholder="https://yourmadrasa.org">
              </div>
            </div>

            <!-- Facebook -->
            <div class="form-field col-6">
              <label for="f_facebook">Facebook Page</label>
              <div class="input-wrap has-icon">
                <span class="field-icon fb-color">${icons.facebook}</span>
                <input type="text" id="f_facebook" name="facebook" value="${escapeHtml(m.facebook)}" placeholder="e.g. facebook.com/yourmadrasa">
              </div>
            </div>

            <!-- Instagram -->
            <div class="form-field col-6">
              <label for="f_instagram">Instagram</label>
              <div class="input-wrap has-icon">
                <span class="field-icon ig-color">${icons.instagram}</span>
                <input type="text" id="f_instagram" name="instagram" value="${escapeHtml(m.instagram)}" placeholder="e.g. @yourmadrasa">
              </div>
            </div>
          </div>
        </div>

        <!-- Section 4: Subjects & Programs -->
        <div class="reg-form-section">
          <div class="section-badge">Section 4</div>
          <div class="section-title-wrap">
            <h2>Subjects &amp; Programs</h2>
            <p>Select the subjects your madrasa offers.</p>
          </div>

          <div class="subjects-selector-grid">
            ${SUBJECT_OPTIONS.map(sub => {
              const isChecked = m.subjects.includes(sub.name);
              return `
                <label class="subject-chip-card ${isChecked ? 'is-selected' : ''}" for="sub_${sub.id}">
                  <input type="checkbox" id="sub_${sub.id}" value="${sub.name}" ${isChecked ? 'checked' : ''} class="sr-only subject-checkbox">
                  <div class="chip-icon">${icons[sub.icon] || icons.book}</div>
                  <span class="chip-title">${sub.name}</span>
                  <span class="chip-check">${icons.check}</span>
                </label>
              `;
            }).join('')}
          </div>

          <!-- Other Subject Field -->
          <div class="other-subject-wrap ${m.subjects.includes('Other') ? 'is-visible' : ''}" id="other_subject_box">
            <label for="f_other_subject">Other Subject Name</label>
            <div class="input-wrap">
              <input type="text" id="f_other_subject" name="otherSubjectText" value="${escapeHtml(m.otherSubjectText)}" placeholder="Specify other subject(s)">
            </div>
          </div>
        </div>

        <!-- Section 5: Student Capacity -->
        <div class="reg-form-section">
          <div class="section-badge">Section 5</div>
          <div class="section-title-wrap">
            <h2>Student Capacity</h2>
            <p>Help us configure class sizes and initial infrastructure.</p>
          </div>

          <div class="form-grid">
            <!-- Current Number of Students -->
            <div class="form-field col-4">
              <label for="f_students">Current Number of Students</label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.users}</span>
                <input type="number" id="f_students" name="studentCount" value="${escapeHtml(m.studentCount)}" placeholder="e.g. 150" min="0">
              </div>
            </div>

            <!-- Number of Teachers -->
            <div class="form-field col-4">
              <label for="f_teachers">Number of Teachers</label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.teacher}</span>
                <input type="number" id="f_teachers" name="teacherCount" value="${escapeHtml(m.teacherCount)}" placeholder="e.g. 12" min="0">
              </div>
            </div>

            <!-- Number of Classes -->
            <div class="form-field col-4">
              <label for="f_classes">Number of Classes</label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.calendar}</span>
                <input type="number" id="f_classes" name="classCount" value="${escapeHtml(m.classCount)}" placeholder="e.g. 8" min="0">
              </div>
            </div>

            <!-- Age Groups Served -->
            <div class="form-field col-12">
              <label>Age Groups Served</label>
              <div class="age-groups-grid">
                ${AGE_GROUPS.map(ag => {
                  const isChecked = m.ageGroups.includes(ag);
                  return `
                    <label class="age-pill-card ${isChecked ? 'is-selected' : ''}">
                      <input type="checkbox" value="${ag}" ${isChecked ? 'checked' : ''} class="sr-only age-checkbox">
                      <span class="pill-check">${isChecked ? icons.check : '+'}</span>
                      <span class="pill-title">${ag}</span>
                    </label>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
        </div>

        <!-- Step 1 Navigation Actions -->
        <div class="form-actions-bar">
          <a href="/" data-route="/" class="button button-secondary">
            <span>${icons.arrowLeft}</span> Cancel
          </a>
          <button type="button" class="button button-primary" data-reg-action="go-step" data-step="2">
            Continue to Administrator Account <span>${icons.arrow}</span>
          </button>
        </div>
      </div>
    `;
  }

  /* The Administrator Account page (/register-madrasa/administrator).
     Opened by the "Continue to Administrator Account" button on the madrasa
     information page. It restates which madrasa the account is being created
     for, so a visitor arriving by link or reload always has the context. */
  function renderStep2() {
    const m = state.formData.madrasa;
    const a = state.formData.administrator;
    const err = state.errors;
    const strength = getPasswordStrength(a.password);
    const place = [m.town, m.city, m.state].filter(Boolean).join(", ");

    return `
      <div class="reg-form-step reveal is-visible" id="administrator-account">
        <!-- Which madrasa this administrator account belongs to -->
        <div class="reg-form-section admin-context-card">
          <div class="admin-context-head">
            <span class="admin-context-logo">${m.logo ? `<img src="${m.logo}" alt="${escapeHtml(m.name)} logo">` : icons.building}</span>
            <div class="admin-context-copy">
              <small>Creating the administrator account for</small>
              <strong>${escapeHtml(m.name || "Your madrasa")}</strong>
              ${place ? `<span>${icons.pin} ${escapeHtml(place)}</span>` : ""}
            </div>
            <button type="button" class="button button-small button-outline-gold" data-reg-action="go-step" data-step="1">
              ${icons.edit} Edit madrasa details
            </button>
          </div>
        </div>

        <!-- Section 6: Create Administrator Account -->
        <div class="reg-form-section">
          <div class="section-badge">Section 6</div>
          <div class="section-title-wrap">
            <h2>Create Administrator Account</h2>
            <p>This account will be used to manage your madrasa on EduSphere.</p>
          </div>

          <div class="admin-callout">
            <span class="callout-icon">${icons.shield}</span>
            <div>
              <strong>Super Administrator Privileges</strong>
              <small>This primary account will hold administrative access for class creation, admissions, teachers, and student reports.</small>
            </div>
          </div>

          <div class="form-grid">
            <!-- Administrator Full Name -->
            <div class="form-field col-6 ${err.adminFullName ? 'has-error' : ''}">
              <label for="f_admin_name">Administrator Full Name <span class="req">*</span></label>
              <div class="input-wrap">
                <input type="text" id="f_admin_name" name="adminFullName" value="${escapeHtml(a.fullName)}" placeholder="e.g. Ustadh Ahmad Ibrahim" required autocomplete="name">
              </div>
              ${err.adminFullName ? `<p class="field-error-text">${err.adminFullName}</p>` : ''}
            </div>

            <!-- Position / Role -->
            <div class="form-field col-6 ${err.adminPosition ? 'has-error' : ''}">
              <label for="f_admin_position">Position / Role <span class="req">*</span></label>
              <div class="select-wrap">
                <select id="f_admin_position" name="adminPosition" required>
                  ${ADMIN_ROLES.map(r => `<option value="${r}" ${a.position === r ? 'selected' : ''}>${r}</option>`).join('')}
                </select>
              </div>
              ${err.adminPosition ? `<p class="field-error-text">${err.adminPosition}</p>` : ''}
            </div>

            <!-- Email Address -->
            <div class="form-field col-6 ${err.adminEmail ? 'has-error' : ''}">
              <label for="f_admin_email">Email Address <span class="req">*</span></label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.mail}</span>
                <input type="email" id="f_admin_email" name="adminEmail" value="${escapeHtml(a.email)}" placeholder="admin@yourmadrasa.org" required autocomplete="email">
              </div>
              ${err.adminEmail ? `<p class="field-error-text">${err.adminEmail}</p>` : ''}
            </div>

            <!-- Phone Number -->
            <div class="form-field col-6 ${err.adminPhone ? 'has-error' : ''}">
              <label for="f_admin_phone">Phone Number <span class="req">*</span></label>
              <div class="input-wrap has-icon">
                <span class="field-icon">${icons.phone}</span>
                <input type="tel" id="f_admin_phone" name="adminPhone" value="${escapeHtml(a.phone)}" placeholder="e.g. +234 801 234 5678" required autocomplete="tel">
              </div>
              ${err.adminPhone ? `<p class="field-error-text">${err.adminPhone}</p>` : ''}
            </div>

            <!-- Password -->
            <div class="form-field col-6 ${err.adminPassword ? 'has-error' : ''}">
              <label for="f_admin_pass">Password <span class="req">*</span></label>
              <div class="input-wrap has-action">
                <input type="${state.showPassword ? 'text' : 'password'}" id="f_admin_pass" name="adminPassword" value="${escapeHtml(a.password)}" placeholder="Create a strong password" required autocomplete="new-password">
                <button type="button" class="field-action-btn" data-reg-action="toggle-password" data-field="password" aria-label="Toggle password visibility">
                  ${state.showPassword ? icons.eyeOff : icons.eye}
                </button>
              </div>
              ${err.adminPassword ? `<p class="field-error-text">${err.adminPassword}</p>` : ''}

              <!-- Password Strength Meter -->
              <div class="password-meter-wrap" aria-live="polite">
                <div class="strength-bars">
                  <span class="bar ${strength.score >= 1 ? 'is-' + strength.color : ''}"></span>
                  <span class="bar ${strength.score >= 2 ? 'is-' + strength.color : ''}"></span>
                  <span class="bar ${strength.score >= 3 ? 'is-' + strength.color : ''}"></span>
                  <span class="bar ${strength.score >= 4 ? 'is-' + strength.color : ''}"></span>
                </div>
                <div class="strength-label">
                  <small>Strength: <strong>${strength.label}</strong></small>
                </div>
                <ul class="pwd-criteria-list">
                  <li class="${strength.checks.length ? 'met' : ''}">${icons.check} At least 8 characters</li>
                  <li class="${strength.checks.upperLower ? 'met' : ''}">${icons.check} Uppercase &amp; lowercase letters</li>
                  <li class="${strength.checks.number ? 'met' : ''}">${icons.check} At least 1 number</li>
                  <li class="${strength.checks.special ? 'met' : ''}">${icons.check} Special symbol (!@#$%^&amp;*)</li>
                </ul>
              </div>
            </div>

            <!-- Confirm Password -->
            <div class="form-field col-6 ${err.adminConfirmPassword ? 'has-error' : ''}">
              <label for="f_admin_confirm">Confirm Password <span class="req">*</span></label>
              <div class="input-wrap has-action">
                <input type="${state.showConfirmPassword ? 'text' : 'password'}" id="f_admin_confirm" name="adminConfirmPassword" value="${escapeHtml(a.confirmPassword)}" placeholder="Re-enter your password" required autocomplete="new-password">
                <button type="button" class="field-action-btn" data-reg-action="toggle-password" data-field="confirm" aria-label="Toggle password visibility">
                  ${state.showConfirmPassword ? icons.eyeOff : icons.eye}
                </button>
              </div>
              ${err.adminConfirmPassword ? `<p class="field-error-text">${err.adminConfirmPassword}</p>` : ''}
              ${a.confirmPassword && a.password === a.confirmPassword ? `
                <p class="field-success-text">${icons.check} Passwords match</p>
              ` : ''}
            </div>

            <!-- Terms & Conditions Checkbox -->
            <div class="form-field col-12 terms-field ${err.terms ? 'has-error' : ''}">
              <label class="checkbox-container" for="f_terms">
                <input type="checkbox" id="f_terms" name="termsAccepted" ${state.formData.termsAccepted ? 'checked' : ''}>
                <span class="checkmark"></span>
                <span class="checkbox-label">
                  I agree to EduSphere's 
                  <button type="button" class="text-button" data-reg-action="open-terms" data-policy="terms">Terms of Service</button>
                  and
                  <button type="button" class="text-button" data-reg-action="open-terms" data-policy="privacy">Privacy Policy</button>.
                </span>
              </label>
              ${err.terms ? `<p class="field-error-text">${err.terms}</p>` : ''}
            </div>
          </div>
        </div>

        <!-- Step 2 Navigation Actions -->
        <div class="form-actions-bar">
          <button type="button" class="button button-secondary" data-reg-action="go-step" data-step="1">
            <span>${icons.arrowLeft}</span> Back to Madrasa Information
          </button>
          <button type="button" class="button button-primary" data-reg-action="go-step" data-step="3">
            Continue to Review <span>${icons.arrow}</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderStep3() {
    const m = state.formData.madrasa;
    const a = state.formData.administrator;
    const err = state.errors;

    return `
      <div class="reg-form-step reveal is-visible">
        <div class="reg-form-section">
          <div class="section-badge">Section 7</div>
          <div class="section-title-wrap">
            <h2>Review Your Madrasa Information</h2>
            <p>Please verify all your details before final submission for review.</p>
          </div>

          <!-- Review Cards Container -->
          <div class="review-cards-stack">
            <!-- Madrasa Card -->
            <div class="review-card">
              <div class="review-card-top">
                <div class="review-heading">
                  <span class="rev-icon">${icons.building}</span>
                  <h3>Madrasa</h3>
                </div>
                <button type="button" class="button button-small button-outline-gold" data-reg-action="go-step" data-step="1">
                  ${icons.edit} Edit Information
                </button>
              </div>
              <div class="review-card-body">
                ${m.logo ? `
                  <div class="review-logo-preview">
                    <img src="${m.logo}" alt="Logo preview">
                  </div>
                ` : ''}
                <div class="review-grid">
                  <div class="rev-item">
                    <small>Madrasa Name</small>
                    <strong>${escapeHtml(m.name)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Official Registered Name</small>
                    <strong>${escapeHtml(m.officialName || '—')}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Institution Type</small>
                    <strong>${escapeHtml(m.institutionType)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Year Established</small>
                    <strong>${escapeHtml(m.yearEstablished || '—')}</strong>
                  </div>
                  <div class="rev-item col-full">
                    <small>Description</small>
                    <p class="rev-description">${escapeHtml(m.description || 'No description provided.')}</p>
                  </div>
                </div>
              </div>
            </div>

            <!-- Location Card -->
            <div class="review-card">
              <div class="review-card-top">
                <div class="review-heading">
                  <span class="rev-icon">${icons.pin}</span>
                  <h3>Location</h3>
                </div>
                <button type="button" class="button button-small button-outline-gold" data-reg-action="go-step" data-step="1">
                  ${icons.edit} Edit Location
                </button>
              </div>
              <div class="review-card-body">
                <div class="review-grid">
                  <div class="rev-item">
                    <small>Country</small>
                    <strong>${escapeHtml(m.country)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>State</small>
                    <strong>${escapeHtml(m.state)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>City</small>
                    <strong>${escapeHtml(m.city)}</strong>
                  </div>
                  ${m.town ? `
                  <div class="rev-item">
                    <small>Town</small>
                    <strong>${escapeHtml(m.town)}</strong>
                  </div>` : ''}
                  <div class="rev-item">
                    <small>Address</small>
                    <strong>${escapeHtml(m.address)}</strong>
                  </div>
                  ${m.mapsLink ? `
                    <div class="rev-item col-full">
                      <small>Google Maps Location</small>
                      <a href="${escapeHtml(m.mapsLink)}" target="_blank" rel="noopener noreferrer" class="text-link">
                        ${icons.link} View location link
                      </a>
                    </div>
                  ` : ''}
                </div>
              </div>
            </div>

            <!-- Contact Card -->
            <div class="review-card">
              <div class="review-card-top">
                <div class="review-heading">
                  <span class="rev-icon">${icons.phone}</span>
                  <h3>Contact</h3>
                </div>
                <button type="button" class="button button-small button-outline-gold" data-reg-action="go-step" data-step="1">
                  ${icons.edit} Edit Contact
                </button>
              </div>
              <div class="review-card-body">
                <div class="review-grid">
                  <div class="rev-item">
                    <small>Phone</small>
                    <strong>${escapeHtml(m.phone)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>WhatsApp</small>
                    <strong>${escapeHtml(m.whatsapp || '—')}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Email</small>
                    <strong>${escapeHtml(m.email || '—')}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Website</small>
                    <strong>${escapeHtml(m.website || '—')}</strong>
                  </div>
                </div>
              </div>
            </div>

            <!-- Subjects & Capacity Card -->
            <div class="review-card">
              <div class="review-card-top">
                <div class="review-heading">
                  <span class="rev-icon">${icons.book}</span>
                  <h3>Subjects &amp; Capacity</h3>
                </div>
                <button type="button" class="button button-small button-outline-gold" data-reg-action="go-step" data-step="1">
                  ${icons.edit} Edit Subjects
                </button>
              </div>
              <div class="review-card-body">
                <div class="review-section-part">
                  <small>Selected Subjects</small>
                  <div class="review-chips-list">
                    ${m.subjects.map(sub => `
                      <span class="review-chip">${sub === 'Other' && m.otherSubjectText ? escapeHtml(m.otherSubjectText) : escapeHtml(sub)}</span>
                    `).join('')}
                  </div>
                </div>
                <div class="review-grid mt-16">
                  <div class="rev-item">
                    <small>Students</small>
                    <strong>${escapeHtml(m.studentCount || '—')}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Teachers</small>
                    <strong>${escapeHtml(m.teacherCount || '—')}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Classes</small>
                    <strong>${escapeHtml(m.classCount || '—')}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Age Groups</small>
                    <strong>${m.ageGroups.length ? m.ageGroups.join(', ') : '—'}</strong>
                  </div>
                </div>
              </div>
            </div>

            <!-- Administrator Card -->
            <div class="review-card">
              <div class="review-card-top">
                <div class="review-heading">
                  <span class="rev-icon">${icons.users}</span>
                  <h3>Administrator</h3>
                </div>
                <button type="button" class="button button-small button-outline-gold" data-reg-action="go-step" data-step="2">
                  ${icons.edit} Edit Administrator
                </button>
              </div>
              <div class="review-card-body">
                <div class="review-grid">
                  <div class="rev-item">
                    <small>Name</small>
                    <strong>${escapeHtml(a.fullName)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Position</small>
                    <strong>${escapeHtml(a.position)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Email</small>
                    <strong>${escapeHtml(a.email)}</strong>
                  </div>
                  <div class="rev-item">
                    <small>Phone</small>
                    <strong>${escapeHtml(a.phone)}</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        ${err.submit ? `
          <div class="submit-error-banner has-error" role="alert" aria-live="assertive">
            <strong>Registration not submitted</strong>
            <span>${escapeHtml(err.submit)}</span>
          </div>
        ` : ''}

        <!-- Step 3 Navigation Actions -->
        <div class="form-actions-bar">
          <button type="button" class="button button-secondary" data-reg-action="go-step" data-step="2">
            <span>${icons.arrowLeft}</span> Back to Administrator
          </button>
          <button type="button" class="button button-gold submit-final-btn ${state.submitting ? 'is-loading' : ''}" data-reg-action="submit-registration" ${state.submitting ? 'disabled' : ''}>
            ${state.submitting ? `
              <span class="spinner"></span> Submitting Registration...
            ` : `
              Submit Madrasa Registration <span>${icons.sparkles}</span>
            `}
          </button>
        </div>
      </div>
    `;
  }

  function renderSuccess() {
    const rc = state.submissionReceipt || {};
    const formattedDate = new Date(rc.submittedAt || Date.now()).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    return `
      <div class="success-screen-card reveal is-visible">
        <div class="success-celebrate-graphic">
          <div class="success-ring-outer"></div>
          <div class="success-ring-inner"></div>
          <div class="success-icon-badge">
            <span class="party-emoji">🎉</span>
          </div>
        </div>

        <h1 class="success-title">Registration Submitted!</h1>
        <p class="success-greeting">Thank you for registering your madrasa with EduSphere.</p>
        <p class="success-notice">Your registration has been successfully submitted for review.</p>

        <!-- Status Badge -->
        <div class="status-pill-wrap">
          <div class="reg-status-pill status-pending">
            <span class="status-dot-pulse"></span>
            <strong>Registration Status: Pending Review</strong>
          </div>
        </div>

        <!-- Receipt Card -->
        <div class="reg-receipt-card">
          <div class="receipt-header">
            <div>
              <small>Application Reference</small>
              <div class="ref-code-box">
                <span class="ref-number" id="receipt_ref">${rc.registrationId || 'REG-2026-PENDING'}</span>
                <button type="button" class="copy-ref-btn" data-reg-action="copy-reference" data-reference="${escapeHtml(rc.registrationId || '')}" title="Copy Reference ID">
                  ${icons.copy}
                </button>
              </div>
            </div>
            <div class="receipt-date">
              <small>Submitted On</small>
              <strong>${formattedDate}</strong>
            </div>
          </div>

          <div class="receipt-details-grid">
            <div class="rc-item">
              <small>Madrasa Name</small>
              <strong>${escapeHtml(rc.madrasaName || state.formData.madrasa.name)}</strong>
            </div>
            <div class="rc-item">
              <small>Administrator</small>
              <strong>${escapeHtml(rc.adminFullName || state.formData.administrator.fullName)} (${escapeHtml(rc.adminPosition || state.formData.administrator.position)})</strong>
            </div>
            <div class="rc-item">
              <small>Contact Email</small>
              <strong>${escapeHtml(rc.adminEmail || state.formData.administrator.email)}</strong>
            </div>
            <div class="rc-item">
              <small>Campus Location</small>
              <strong>${escapeHtml(rc.city || state.formData.madrasa.city)}, ${escapeHtml(rc.state || state.formData.madrasa.state)}</strong>
            </div>
          </div>

          <div class="receipt-next-steps">
            <h4>${icons.info} What happens next?</h4>
            <ol>
              <li>Our verification team will review your institution credentials (1–2 business days).</li>
              <li>You will receive an activation email at <strong>${escapeHtml(rc.adminEmail || state.formData.administrator.email)}</strong>.</li>
              <li>Once approved, you can log in to your EduSphere admin portal to add classes, students, and teachers.</li>
            </ol>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="success-actions-row">
          <a href="/" data-route="/" class="button button-primary">
            Go to Homepage <span>${icons.arrow}</span>
          </a>
          <button type="button" class="button button-secondary" data-reg-action="open-status" data-reference="${escapeHtml(rc.registrationId || '')}">
            ${icons.search} View Registration Status
          </button>
        </div>
      </div>
    `;
  }

  function renderStatusModal() {
    if (!state.statusModal.open) return '';
    const res = state.statusModal.result;
    const err = state.statusModal.error;
    const isLoading = state.statusModal.loading;

    return `
      <div class="modal-backdrop" data-reg-action="close-status-backdrop">
        <div class="modal-dialog reg-status-modal">
          <div class="modal-header">
            <div class="modal-title-group">
              <span class="modal-icon">${icons.search}</span>
              <h3>Madrasa Registration Status</h3>
            </div>
            <button type="button" class="modal-close-btn" data-reg-action="close-status" aria-label="Close status dialog">
              ${icons.close}
            </button>
          </div>

          <div class="modal-body">
            <!-- Search Form -->
            <form class="status-search-form" data-reg-form="status-search">
              <div class="form-grid">
                <div class="form-field col-6">
                  <label for="st_ref">Registration Reference ID <span class="req">*</span></label>
                  <input type="text" id="st_ref" value="${escapeHtml(state.statusModal.referenceQuery)}" placeholder="e.g. REG-2026-AB12CD" required>
                </div>
                <div class="form-field col-6">
                  <label for="st_phone">Contact Phone Number</label>
                  <input type="tel" id="st_phone" value="${escapeHtml(state.statusModal.phoneQuery)}" placeholder="Phone number given in registration">
                </div>
                <div class="form-field col-12">
                  <button type="submit" class="button button-primary w-full ${isLoading ? 'is-loading' : ''}">
                    ${isLoading ? 'Checking Status...' : 'Check Status'}
                  </button>
                </div>
              </div>
            </form>

            ${err ? `
              <div class="status-error-box">
                <span class="err-icon">${icons.info}</span>
                <p>${escapeHtml(err)}</p>
              </div>
            ` : ''}

            ${res ? `
              <div class="status-result-card">
                <div class="status-badge-header">
                  <div>
                    <small>Reference: <strong>${escapeHtml(res.registrationId)}</strong></small>
                    <h4>${escapeHtml(res.madrasaName || 'Madrasa Application')}</h4>
                  </div>
                  <span class="badge ${res.status === 'Approved' ? 'badge-success' : res.status === 'Rejected' ? 'badge-danger' : 'badge-gold'}">
                    ${escapeHtml(res.status || 'Pending')}
                  </span>
                </div>

                <!-- Timeline Stages -->
                <div class="status-timeline">
                  <div class="timeline-step is-complete">
                    <div class="tl-node">${icons.check}</div>
                    <div class="tl-content">
                      <strong>Submission Received</strong>
                      <small>${res.submittedAt ? new Date(res.submittedAt).toLocaleDateString() : 'Received'}</small>
                    </div>
                  </div>

                  <div class="timeline-step ${res.status === 'Approved' ? 'is-complete' : 'is-current'}">
                    <div class="tl-node">${res.status === 'Approved' ? icons.check : icons.clock}</div>
                    <div class="tl-content">
                      <strong>Document &amp; Profile Verification</strong>
                      <small>${res.status === 'Approved' ? 'Verified by the EduSphere team' : 'Under review by our institutional team'}</small>
                    </div>
                  </div>

                  <div class="timeline-step ${res.status === 'Approved' ? 'is-complete' : ''}">
                    <div class="tl-node">${res.status === 'Approved' ? icons.check : '3'}</div>
                    <div class="tl-content">
                      <strong>Admin Account Provisioning</strong>
                      <small>${res.status === 'Approved' ? 'Account active' : 'Scheduled upon verification'}</small>
                    </div>
                  </div>

                  <div class="timeline-step ${res.status === 'Approved' ? 'is-complete' : ''}">
                    <div class="tl-node">${res.status === 'Approved' ? icons.check : '4'}</div>
                    <div class="tl-content">
                      <strong>Official Activation</strong>
                      <small>${res.status === 'Approved' ? 'Ready for students & parents' : 'Platform access unlocked'}</small>
                    </div>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>

          <div class="modal-footer">
            <button type="button" class="button button-secondary" data-reg-action="close-status">
              Close
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderTermsModal() {
    if (!state.termsModalOpen) return '';

    return `
      <div class="modal-backdrop" data-reg-action="close-terms-backdrop">
        <div class="modal-dialog terms-modal">
          <div class="modal-header">
            <h3>EduSphere Terms of Service &amp; Privacy Policy</h3>
            <button type="button" class="modal-close-btn" data-reg-action="close-terms" aria-label="Close dialog">
              ${icons.close}
            </button>
          </div>
          <div class="modal-body terms-copy">
            <h4>1. Institutional Partnership</h4>
            <p>By submitting your madrasa registration to the EduSphere platform, you certify that you are an authorized representative of the institution and that the submitted information is accurate.</p>
            
            <h4>2. Data Privacy &amp; Student Protection</h4>
            <p>EduSphere strictly safeguards Islamic educational institution records, teacher information, and student academic evaluations in accordance with modern digital data protection standards.</p>

            <h4>3. Community Standards</h4>
            <p>All registered institutions commit to fostering inclusive, authentic, and high-quality Islamic learning environments aligned with core Islamic ethics.</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="button button-primary" data-reg-action="accept-terms">
              I Understand &amp; Agree
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function render() {
    const app = document.getElementById("app");
    if (!app) return;

    let contentHtml = "";
    if (state.currentStep === 1) contentHtml = renderStep1();
    else if (state.currentStep === 2) contentHtml = renderStep2();
    else if (state.currentStep === 3) contentHtml = renderStep3();
    else if (state.currentStep === 4) contentHtml = renderSuccess();

    app.innerHTML = `
      ${renderHeader()}
      <main id="main-content" class="reg-page-main">
        ${renderPageHeader()}
        <div class="container reg-layout-grid">
          <div class="reg-form-column">
            ${contentHtml}
          </div>
          ${state.currentStep < 4 ? renderSidebar() : ''}
        </div>
      </main>
      ${renderStatusModal()}
      ${renderTermsModal()}
      <div id="toast-container" class="toast-container" aria-live="polite"></div>
    `;

    bindEvents();
  }

  /* Event Handlers */
  function bindEvents() {
    // Input syncing
    const m = state.formData.madrasa;
    const a = state.formData.administrator;

    /*
     * Registration controls must be bound from this external script rather
     * than with inline `onclick` attributes. The server deliberately sends
     * `script-src-attr 'none'` in its Content Security Policy, so browsers
     * correctly refuse inline handlers. That made the Continue button appear
     * to do nothing even though it worked in DOM tests that do not enforce
     * CSP. Data attributes keep the markup declarative and CSP-safe.
     */
    document.querySelectorAll("[data-reg-action]").forEach((control) => {
      control.addEventListener("click", (event) => {
        const action = control.dataset.regAction;

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
          // These buttons sit inside the terms checkbox label; do not let the
          // label click toggle consent while merely reading a policy.
          event.preventDefault();
          event.stopPropagation();
          openTermsModal(control.dataset.policy || "terms");
        } else if (action === "close-terms") {
          closeTermsModal();
        } else if (action === "close-terms-backdrop") {
          closeTermsModal(event);
        } else if (action === "accept-terms") {
          acceptTermsAndClose();
        }
      });
    });

    const statusSearchForm = document.querySelector('[data-reg-form="status-search"]');
    if (statusSearchForm) statusSearchForm.addEventListener("submit", handleStatusSearchSubmit);

    const bindInput = (id, setter) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("input", (e) => {
          setter(e.target.value);
          if (id === "f_description") {
            const counter = el.parentElement.querySelector(".char-count");
            if (counter) counter.textContent = `${e.target.value.length} characters`;
          }
        });
      }
    };

    // Step 1 Fields
    bindInput("f_name", v => { m.name = v; });
    bindInput("f_official_name", v => { m.officialName = v; });
    bindInput("f_description", v => { m.description = v; });
    bindInput("f_year", v => { m.yearEstablished = v; });
    bindInput("f_country", v => { m.country = v; });
    bindInput("f_address", v => { m.address = v; });
    bindInput("f_maps", v => { m.mapsLink = v; });
    bindInput("f_phone", v => { m.phone = v; });
    bindInput("f_whatsapp", v => { m.whatsapp = v; });
    bindInput("f_email", v => { m.email = v; });
    bindInput("f_website", v => { m.website = v; });
    bindInput("f_facebook", v => { m.facebook = v; });
    bindInput("f_instagram", v => { m.instagram = v; });
    bindInput("f_other_subject", v => { m.otherSubjectText = v; });
    bindInput("f_students", v => { m.studentCount = v; });
    bindInput("f_teachers", v => { m.teacherCount = v; });
    bindInput("f_classes", v => { m.classCount = v; });

    const typeSelect = document.getElementById("f_type");
    if (typeSelect) typeSelect.addEventListener("change", e => { m.institutionType = e.target.value; });

    const stateSelect = document.getElementById("f_state");
    if (stateSelect) stateSelect.addEventListener("change", e => onLocationStateChange(e.target));

    const citySelect = document.getElementById("f_city");
    if (citySelect) citySelect.addEventListener("change", e => onLocationCityChange(e.target));

    const townSelect = document.getElementById("f_town");
    if (townSelect) townSelect.addEventListener("change", e => { m.town = e.target.value; });

    // Step 2 Fields
    bindInput("f_admin_name", v => { a.fullName = v; });
    bindInput("f_admin_email", v => { a.email = v; });
    bindInput("f_admin_phone", v => { a.phone = v; });
    bindInput("f_admin_pass", v => {
      a.password = v;
      // Live password meter update
      const meter = document.querySelector(".password-meter-wrap");
      if (meter) {
        const str = getPasswordStrength(v);
        const bars = meter.querySelectorAll(".strength-bars .bar");
        bars.forEach((bar, idx) => {
          bar.className = `bar ${str.score > idx ? 'is-' + str.color : ''}`;
        });
        const lbl = meter.querySelector(".strength-label strong");
        if (lbl) lbl.textContent = str.label;
        const lis = meter.querySelectorAll(".pwd-criteria-list li");
        if (lis[0]) lis[0].className = str.checks.length ? 'met' : '';
        if (lis[1]) lis[1].className = str.checks.upperLower ? 'met' : '';
        if (lis[2]) lis[2].className = str.checks.number ? 'met' : '';
        if (lis[3]) lis[3].className = str.checks.special ? 'met' : '';
      }
    });
    bindInput("f_admin_confirm", v => { a.confirmPassword = v; });

    const adminPosSelect = document.getElementById("f_admin_position");
    if (adminPosSelect) adminPosSelect.addEventListener("change", e => { a.position = e.target.value; });

    const termsCb = document.getElementById("f_terms");
    if (termsCb) termsCb.addEventListener("change", e => { state.formData.termsAccepted = e.target.checked; });

    // Subject Checkboxes
    document.querySelectorAll(".subject-checkbox").forEach(cb => {
      cb.addEventListener("change", e => {
        const val = e.target.value;
        if (e.target.checked) {
          if (!m.subjects.includes(val)) m.subjects.push(val);
        } else {
          m.subjects = m.subjects.filter(s => s !== val);
        }
        const card = e.target.closest(".subject-chip-card");
        if (card) card.classList.toggle("is-selected", e.target.checked);

        const otherWrap = document.getElementById("other_subject_box");
        if (otherWrap) {
          otherWrap.classList.toggle("is-visible", m.subjects.includes("Other"));
        }
      });
    });

    // Age Group Checkboxes
    document.querySelectorAll(".age-checkbox").forEach(cb => {
      cb.addEventListener("change", e => {
        const val = e.target.value;
        if (e.target.checked) {
          if (!m.ageGroups.includes(val)) m.ageGroups.push(val);
        } else {
          m.ageGroups = m.ageGroups.filter(ag => ag !== val);
        }
        const card = e.target.closest(".age-pill-card");
        if (card) card.classList.toggle("is-selected", e.target.checked);
      });
    });

    // Dropzone logic
    const dropzone = document.getElementById("logo_dropzone");
    const fileInput = document.getElementById("f_logo_upload");

    if (dropzone && fileInput) {
      dropzone.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) handleLogoFile(e.target.files[0]);
      });

      ["dragenter", "dragover"].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add("drag-over");
        });
      });

      ["dragleave", "drop"].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove("drag-over");
        });
      });

      dropzone.addEventListener("drop", (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleLogoFile(e.dataTransfer.files[0]);
        }
      });
    }

    // Change Logo Button in preview mode
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) handleLogoFile(e.target.files[0]);
      });
    }

    // Mobile nav toggle
    const toggle = document.querySelector(".menu-toggle");
    const menu = document.getElementById("mobile-reg-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        menu.setAttribute("aria-hidden", String(!open));
        document.body.classList.toggle("menu-open", open);
      });
    }

    // Client-side routing interceptor for [data-route]
    document.querySelectorAll("[data-route]").forEach(link => {
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
    else if (field === "confirm") state.showConfirmPassword = !state.showConfirmPassword;
    render();
  }

  function copyRefCode(code) {
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
      showToast("Reference ID copied to clipboard!");
    }).catch(() => {
      showToast("Reference ID: " + code);
    });
  }

  function showToast(msg) {
    const cont = document.getElementById("toast-container");
    if (!cont) return;
    const t = document.createElement("div");
    t.className = "edusphere-toast";
    t.innerHTML = `<span>${icons.check}</span> ${escapeHtml(msg)}`;
    cont.appendChild(t);
    setTimeout(() => {
      t.classList.add("fade-out");
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
    if (e && e.target && !e.target.classList.contains("modal-backdrop") && !e.target.classList.contains("modal-close-btn") && !e.target.closest(".modal-close-btn")) {
      return;
    }
    state.statusModal.open = false;
    render();
  }

  function handleStatusSearchSubmit(e) {
    e.preventDefault();
    const ref = document.getElementById("st_ref") ? document.getElementById("st_ref").value : "";
    const phone = document.getElementById("st_phone") ? document.getElementById("st_phone").value : "";
    state.statusModal.referenceQuery = ref;
    state.statusModal.phoneQuery = phone;
    checkStatusLookup(ref, phone);
  }

  function openTermsModal(type) {
    state.termsModalOpen = true;
    render();
  }

  function closeTermsModal(e) {
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
    return String(str || "")
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
      // A deep link or a reload lands here with an empty module: rebuild the
      // madrasa details from the saved draft so the guard on the
      // administrator page sees the information that was already entered.
      // Only ever done while the form is still untouched, so an in-progress
      // edit is never overwritten by a stale draft.
      const pristine = state.currentStep === 1 && !state.formData.madrasa.name.trim();
      if (pristine && stepFromPath(window.location.pathname) > 1) restoreDraft();
      syncFromUrl();
      // The live state list, then a re-render only if the select was still on
      // the offline fallback and the stored state is not in it.
      loadLocationStates().then(async () => {
        const m = state.formData.madrasa;
        if (m.state && !locationOptions.states.includes(m.state)) {
          m.state = locationOptions.states.includes("Ogun") ? "Ogun" : (locationOptions.states[0] || "");
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
    reset() {
      state = getInitialState();
      clearDraft();
      syncUrl(1, true);
      render();
    }
  };
})();
