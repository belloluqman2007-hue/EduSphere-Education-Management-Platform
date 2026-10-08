"use strict";

/* EduSphere public education platform application & client router */
(function () {
  const app = document.getElementById("app");
  if (!app) return;

  const icons = {
    arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`,
    arrowUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>`,
    menu: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
    close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
    check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19.5 6.5"/></svg>`,
    book: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.7A3.7 3.7 0 0 1 7.7 2H12v18H7.7A3.7 3.7 0 0 0 4 23V5.7ZM20 5.7A3.7 3.7 0 0 0 16.3 2H12v18h4.3A3.7 3.7 0 0 1 20 23V5.7Z"/></svg>`,
    compass: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m15.8 8.2-2.3 5.3-5.3 2.3 2.3-5.3 5.3-2.3Z"/></svg>`,
    school: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-5 9 5-9 5-9-5Z"/><path d="M6 12.2V17c2.9 2.7 9.1 2.7 12 0v-4.8M21 10v6"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10.2c0 5.2-8 10.3-8 10.3s-8-5.1-8-10.3a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10.2" r="2.6"/></svg>`,
    search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4"/><path d="m16 16 4.4 4.4"/></svg>`,
    spark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3ZM19 16l.6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z"/></svg>`,
    globe: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.3 3.5 5.1 3.5 8.5S14.3 18.2 12 20.5C9.7 18.2 8.5 15.4 8.5 12S9.7 5.8 12 3.5Z"/></svg>`,
    users: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-2.1A4.9 4.9 0 0 1 8.4 13h1.2a4.9 4.9 0 0 1 4.9 4.9V20M16 5.5a3 3 0 0 1 0 5.8M18.3 13.4a4.7 4.7 0 0 1 2.2 4V20"/></svg>`,
    instagram: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor" stroke="none"/></svg>`,
    linkedin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5V18M6.5 6.5v.1M10.5 18v-5a3.5 3.5 0 0 1 7 0v5M10.5 10v8"/><circle cx="6.5" cy="6.5" r="1"/></svg>`,
    facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 21v-8h3l.5-3H14V8.1c0-.9.3-1.6 1.7-1.6h2V3.8c-.4-.1-1.2-.2-2.2-.2-2.3 0-3.8 1.4-3.8 4V10H9v3h2.7v8"/></svg>`,
    graduation: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 9 9-5 9 5-9 5-9-5Z"/><path d="M7 11.3v4.4c2.6 2.2 7.4 2.2 10 0v-4.4M21 9v5"/></svg>`,
    calculator: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>`,
    pen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.1-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3M4 20l4-4"/></svg>`,
    flask: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6l-5.5 8.6A2.2 2.2 0 0 0 6.3 21h11.4a2.2 2.2 0 0 0 1.8-3.4L14 9V3"/><path d="M7.4 15h9.2"/></svg>`,
    code: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>`,
    monitor: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    briefcase: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/></svg>`,
    palette: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.3a1.7 1.7 0 0 0 1.4-2.7 1.7 1.7 0 0 1 1.4-2.7H18A3 3 0 0 0 21 12 9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="12" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r=".8" fill="currentColor" stroke="none"/></svg>`,
    chart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-7"/></svg>`,
    languages: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2c0 5-2.4 8.1-5.5 10M5.5 10h6M14 19l3.5-9 3.5 9M15.2 16h4.6"/></svg>`,
    shieldCheck: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 6v5.4c0 4.2-2.8 7.8-7 9.6-4.2-1.8-7-5.4-7-9.6V6l7-3Z"/><path d="m8.5 12 2.2 2.2 4.7-4.7"/></svg>`,
    rocket: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.2c2.7-.7 4.5-.2 5.3.5.7.7 1.2 2.5.5 5.3-.7 2.7-2.4 5.5-5.1 8.2l-3.1-3.1c-1.3-1.3-2.3-2.8-3.1-4.4 2.7-2.7 5.5-4.4 8.2-5.1Z"/><path d="m9 10.7-4.2.4-1.8 1.8 4.2 1.4M13.3 15l-.4 4.2-1.8 1.8-1.4-4.2M12.5 7.2h.01"/><path d="m9.5 14.5-4 4"/></svg>`,
    building: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5l8-2v18M20 21V9l-8-2M8 7h1M8 11h1M8 15h1M14 11h1M18 11h1M14 15h1M18 15h1M2 21h20"/></svg>`,
    filter: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`,
    /* Icons used by the individual school websites (public/js/app.js →
       renderSchoolPublic). Kept in this one shared map so no module needs a
       second icon set. */
    chev: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
    chevLeft: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>`,
    chevRight: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
    phone: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3h2.2l1.6 4-2 1.3a11 11 0 0 0 5.3 5.3l1.3-2 4 1.6v2.2A2.6 2.6 0 0 1 16.4 18C9.9 17.6 4.4 12.1 4 5.6A2.6 2.6 0 0 1 6.6 3Z"/></svg>`,
    mail: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>`,
    chat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12.4c0 4-3.9 7.2-8.7 7.2a10 10 0 0 1-2.6-.3L4 21l1.3-3.6A6.9 6.9 0 0 1 3.3 12.4C3.3 8.4 7.2 5 12 5s8 3.4 8 7.4Z"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.3 2"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/></svg>`,
    play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 7.8 17 12l-7.5 4.2V7.8Z"/></svg>`,
    image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.6" cy="9.8" r="1.6"/><path d="m4 17 5-4.6 3.6 3.2L16 12l4 4.5"/></svg>`,
    youtube: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="3.4"/><path d="m10.5 9.6 4.8 2.4-4.8 2.4V9.6Z" fill="currentColor" stroke="none"/></svg>`,
    twitter: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l7 8.4L4.4 20h2.3l5.4-6 4.8 6H21l-7.2-9L20 4h-2.3l-4.8 5.4L8.6 4H4Z"/></svg>`,
    tiktok: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.2 3.5c.4 2 1.7 3.4 3.8 3.7v2.5c-1.4.1-2.7-.3-3.9-1.1v5.6a5.2 5.2 0 1 1-5.2-5.2c.4 0 .7 0 1 .1v2.6a2.6 2.6 0 1 0 1.8 2.5V3.5h2.5Z"/></svg>`
  };

  let scrollHandler = null;

  function brandMarkup() {
    return `
      <a class="brand" href="/" data-route="/" aria-label="EduSphere home">
        <span class="brand-logo"><img src="/assets/edusphere-logo.png" alt="EduSphere logo"></span>
        <span class="brand-words"><strong>EduSphere</strong><small>Education Platform</small></span>
      </a>`;
  }

  function navLink(label, href, active) {
    return `<a${active ? " class=\"active\" aria-current=\"page\"" : ""} href="${href}" data-route="${href}">${label}</a>`;
  }

  function headerMarkup(active) {
    return `
      <header class="site-header" id="top">
        <div class="nav-shell">
          ${brandMarkup()}
          <nav class="desktop-nav platform-nav" aria-label="Primary navigation">
            ${navLink("Home", "/", active === "home")}
            ${navLink("Islamic Schools", "/islamic-schools", active === "islamic")}
            ${navLink("Western Academies", "/western-schools", active === "western")}
            <a href="/#how-it-works" data-route="/#how-it-works">How EduSphere Works</a>
          </nav>
          <div class="nav-actions">
            <a class="login-link" href="/login">Sign In</a>
            <a class="login-link" href="/#institution-future" data-route="/#institution-future">For institutions</a>
            <a class="button button-small" href="#get-started" data-route="/#get-started">Get Started <span>${icons.arrow}</span></a>
          </div>
          <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open menu">
            <span class="open-icon">${icons.menu}</span><span class="close-icon">${icons.close}</span>
          </button>
        </div>
        <nav class="mobile-nav" id="mobile-menu" aria-label="Mobile navigation" aria-hidden="true">
          ${navLink("Home", "/", active === "home")}
          ${navLink("Islamic Schools", "/islamic-schools", active === "islamic")}
          ${navLink("Western Academies", "/western-schools", active === "western")}
          <a href="/#how-it-works" data-route="/#how-it-works">How EduSphere Works</a>
          <a href="/#institution-future" data-route="/#institution-future">For institutions</a>
          <a href="/login">Sign In</a>
          <a class="button" href="#get-started" data-route="/#get-started">Get Started <span>${icons.arrow}</span></a>
        </nav>
      </header>`;
  }

  function footerMarkup() {
    return `
      <footer class="site-footer" id="footer">
        <div class="container footer-grid">
          <div class="footer-brand">
            ${brandMarkup()}
            <p>EduSphere helps educational institutions manage their operations, academics, communication and digital presence — on one worldwide education management platform.</p>
            <div class="socials"><a href="#footer" aria-label="EduSphere on Instagram">${icons.instagram}</a><a href="#footer" aria-label="EduSphere on LinkedIn">${icons.linkedin}</a><a href="#footer" aria-label="EduSphere on Facebook">${icons.facebook}</a></div>
          </div>
          <div class="footer-col"><h3>Explore</h3><a href="/islamic-schools" data-route="/islamic-schools">Islamic Schools</a><a href="/western-schools" data-route="/western-schools">Western Academies</a><a href="/#how-it-works" data-route="/#how-it-works">How EduSphere works</a></div>
          <div class="footer-col"><h3>For institutions</h3><a href="/register-madrasa" data-route="/register-madrasa">Register an Islamic School</a><a href="/register-academy" data-route="/register-academy">Register a Western Academy</a><a href="/login">Sign In</a></div>
          <div class="footer-col"><h3>Portals</h3><a href="/teacher">Teacher workspace</a><a href="/student">Student portal</a><a href="/parent">Parent portal</a><a href="/parent/meetings" data-route="/parent/meetings">Parents: book a meeting</a></div>
          <div class="footer-col"><h3>Platform</h3><a href="/#institution-future" data-route="/#institution-future">Independent school sites</a><a href="#footer">Contact</a><a href="#footer">Privacy &amp; Terms</a></div>
        </div>
        <div class="container footer-bottom"><span>© <span id="year"></span> EduSphere Education Platform. All rights reserved.</span><span>Manage <i></i> Teach <i></i> Learn <i></i> Grow <i></i></span></div>
      </footer>`;
  }

  function schoolChoiceCard(kind) {
    const islamic = kind === "islamic";
    const title = islamic ? "Islamic School" : "Western Academy";
    const description = islamic
      ? "Discover madrasas, Arabic schools, Qur'an schools, and Islamic learning institutions."
      : "Discover modern academic schools offering quality education and a wide range of programmes.";
    const href = islamic ? "/islamic-schools" : "/western-schools";
    const image = islamic ? "/assets/islamic-school-learning.jpg" : "/assets/western-academy-learning.jpg";
    const alt = islamic ? "Students learning together in an Islamic school" : "Students collaborating in a modern academy";
    const label = islamic ? "Faith-led learning" : "Modern academic learning";
    const button = islamic ? "Explore Islamic Schools" : "Explore Western Academies";
    return `
      <article class="education-choice education-choice--${kind} reveal">
        <a class="choice-image" href="${href}" data-route="${href}" aria-label="${button}">
          <img src="${image}" alt="${alt}">
          <span class="choice-image-overlay"></span>
          <span class="choice-image-label">${islamic ? icons.book : icons.school} ${label}</span>
        </a>
        <div class="choice-content">
          <div class="choice-icon">${islamic ? icons.book : icons.school}</div>
          <h3>${title}</h3>
          <p>${description}</p>
          <a class="button choice-button" href="${href}" data-route="${href}">${button} <span>${icons.arrow}</span></a>
        </div>
      </article>`;
  }

  /* What EduSphere helps institutions manage — the platform capability grid
     shown on the global homepage. International and category-neutral. */
  const platformCapabilities = [
    ["Students", "Admissions, profiles, attendance and progress for every learner.", "users"],
    ["Teachers", "Staff accounts, teaching assignments and professional records.", "graduation"],
    ["Classes", "Classes, levels, student groups and timetables.", "school"],
    ["Attendance", "Daily registers for students and teachers, with reports.", "check"],
    ["Academic Activities", "Lessons, assignments, examinations, results and report cards.", "book"],
    ["Admissions", "Online applications, requirements and review workflows.", "pen"],
    ["Communication", "Announcements, messages, notifications and parent communication.", "globe"],
    ["Finance", "Fees, payments, expenses, budgets and financial reports.", "calculator"],
    ["Payroll", "Salary structures, pay periods, payslips, advances and loans.", "briefcase"],
    ["Library", "Book catalogue, loans, returns, overdue tracking and fines.", "compass"],
    ["Reports", "Academic, financial and operational reporting in one place.", "chart"],
    ["Public School Websites", "A professional, independently branded website for every institution.", "building"],
    ["Student Portal", "A personal workspace where every student learns and tracks progress.", "monitor"],
    ["Parent Portal", "Results, payments, messages and meetings for every family.", "shieldCheck"],
  ];

  function renderHomepage() {
    document.body.classList.remove("western-experience", "western-menu-open", "islamic-experience");
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = "#220b40";
    document.title = "EduSphere — Education Management Platform";
    app.innerHTML = `
      ${headerMarkup("home")}
      <main id="main-content" class="platform-home">
        <section class="platform-hero section-pattern" aria-labelledby="hero-title">
          <div class="hero-orb hero-orb-one"></div><div class="hero-orb hero-orb-two"></div>
          <div class="container">
            <div class="platform-hero-intro reveal">
              <img class="hero-logo" src="/assets/edusphere-logo.png" alt="EduSphere logo" width="96" height="96">
              <p class="eyebrow"><span class="eyebrow-dot"></span>EduSphere — Education Management Platform</p>
              <h1 id="hero-title">Smarter Management for <em>Modern Education</em></h1>
              <p class="platform-hero-copy">EduSphere helps schools and educational institutions manage their operations, academics, communication and digital presence in one platform — so every institution can focus on teaching, and every family stays connected.</p>
              <div class="hero-actions">
                <a class="button button-primary" href="#get-started" data-route="/#get-started">Get Started <span>${icons.arrow}</span></a>
                <a class="button button-secondary" href="/login">Sign In</a>
              </div>
            </div>
            <p class="hero-reassurance platform-reassurance reveal"><span class="mini-check">${icons.check}</span><span>One secure platform for institution administrators, teachers, students and parents.</span></p>
          </div>
        </section>

        <section class="platform-intro-section" id="how-it-works" aria-labelledby="how-title">
          <div class="container platform-intro-grid">
            <div class="platform-intro-copy reveal">
              <p class="section-kicker">One platform for modern education</p>
              <h2 id="how-title">Everything your institution <em>runs on, in one place.</em></h2>
              <p>EduSphere brings the whole school together — administration, academics, finance and communication — while giving every institution its own independently branded public website.</p>
              <a class="text-link platform-text-link" href="#get-started" data-route="/#get-started">Get started today <span>${icons.arrow}</span></a>
            </div>
            <ol class="journey-steps reveal" aria-label="How the EduSphere education platform works">
              <li><span class="journey-number">01</span><div><strong>Create your institution</strong><small>Register your school or academy and get your own branded public website</small></div></li>
              <li><span class="journey-number">02</span><div><strong>Manage everything in one place</strong><small>Students, teachers, classes, attendance, academics, finance and communication</small></div></li>
              <li><span class="journey-number">03</span><div><strong>Connect your community</strong><small>Parents, students and teachers sign in and go straight to their workspaces</small></div></li>
            </ol>
          </div>
        </section>

        <section class="promo-video-section" id="watch-video" aria-labelledby="promo-video-title">
          <div class="container">
            <div class="section-heading centered reveal">
              <p class="section-kicker">Watch how EduSphere works</p>
              <h2 id="promo-video-title">One school. One platform. <em>Everything connected.</em></h2>
              <p>A three-minute tour of the real EduSphere platform — from the Super Admin console to the parent portal.</p>
            </div>
            <div class="promo-video-wrap reveal">
              <div class="promo-video-frame" data-promo-frame>
                <video class="promo-video" data-promo-video controls preload="none" playsinline
                  poster="/assets/promo/edusphere-promo-poster.jpg"
                  crossorigin="anonymous" controlsList="nodownload"
                  aria-label="EduSphere platform promotional video">
                  <track kind="subtitles" src="/assets/promo/edusphere-promo.vtt" srclang="en" label="English" default>
                </video>
                <div class="promo-video-ended" data-promo-ended hidden aria-hidden="true">
                  <p class="promo-ended-title">Ready to bring your school <em>online?</em></p>
                  <p class="promo-ended-copy">Register your institution — it takes minutes, and your public website goes live automatically.</p>
                  <div class="promo-ended-actions">
                    <a class="button button-primary" href="/register-madrasa" data-route="/register-madrasa">Register an Islamic School</a>
                    <a class="button button-secondary" href="/register-academy" data-route="/register-academy">Register a Western Academy</a>
                  </div>
                  <button type="button" class="promo-replay" data-promo-replay>Watch again</button>
                </div>
              </div>
              <div class="promo-video-meta">
                <span class="promo-chip">${icons.monitor} 3 min tour</span>
                <span class="promo-chip">Captions available</span>
                <a class="promo-quality-note" href="/assets/promo/edusphere-promo-1080p.mp4" target="_blank" rel="noopener">Watch in Full HD</a>
              </div>
              <div class="promo-video-cta">
                <a class="button button-primary" href="#get-started" data-route="/#get-started">Get Started <span>${icons.arrow}</span></a>
                <a class="button button-secondary" href="/register-academy" data-route="/register-academy">Register Your Institution</a>
              </div>
            </div>
          </div>
        </section>

        <section class="category-purpose-section platform-capabilities" aria-labelledby="capabilities-title">
          <div class="container">
            <div class="section-heading centered reveal">
              <p class="section-kicker">Built for educational institutions</p>
              <h2 id="capabilities-title">One platform. <em>Every part of the school.</em></h2>
              <p>From the front office to the classroom to the family at home, EduSphere keeps the whole institution connected.</p>
            </div>
            <div class="category-feature-grid platform-capability-grid">${platformCapabilities.map(([title, copy, icon]) => `<article class="category-feature-card reveal"><span class="category-feature-icon">${icons[icon]}</span><h3>${title}</h3><p>${copy}</p></article>`).join("")}</div>
          </div>
        </section>

        <section class="institution-future-section" id="institution-future" aria-labelledby="institution-title">
          <div class="container">
            <div class="institution-future-card reveal">
              <div class="future-copy">
                <p class="section-kicker light-kicker">Built for independent institutions</p>
                <h2 id="institution-title">Every school can grow with its <em>own identity.</em></h2>
                <p>EduSphere is the technology behind the experience — not the identity of the school. Each institution gets its own website, logo, colours, content, news, events, gallery and admissions.</p>
              </div>
              <div class="identity-path" aria-label="The EduSphere platform architecture">
                <div class="identity-node identity-node--edusphere"><span>${icons.spark}</span><strong>EduSphere</strong><small>Platform</small></div>
                <i class="identity-connector" aria-hidden="true">${icons.arrow}</i>
                <div class="identity-node"><span>${icons.compass}</span><strong>Institution</strong><small>Tenant</small></div>
                <i class="identity-connector" aria-hidden="true">${icons.arrow}</i>
                <div class="identity-node identity-node--school"><span>${icons.globe}</span><strong>School website</strong><small>yourschool.edusphere.site</small></div>
              </div>
            </div>
          </div>
        </section>

        <section class="platform-choice-section" id="get-started" aria-labelledby="get-started-title">
          <div class="container">
            <div class="choice-heading reveal">
              <span class="choice-heading-line"></span>
              <div class="choice-heading-text">
                <h2 id="get-started-title">Get started with your institution</h2>
                <p>EduSphere supports faith-led schools and modern academic academies alike — each with its own branding, content and community.</p>
              </div>
              <span class="choice-heading-line"></span>
            </div>
            <div class="education-choice-grid">
              ${schoolChoiceCard("islamic")}
              ${schoolChoiceCard("western")}
            </div>
            <div class="cta-actions platform-choice-actions reveal"><a class="button button-primary" href="/register-madrasa" data-route="/register-madrasa">Register an Islamic School <span>${icons.arrow}</span></a><a class="button button-secondary" href="/register-academy" data-route="/register-academy">Register a Western Academy</a></div>
          </div>
        </section>

        <section class="platform-cta-section" aria-labelledby="start-title">
          <div class="container platform-cta-content reveal">
            <p class="section-kicker">Made for the next generation of schools</p>
            <h2 id="start-title">Ready to bring your school <em>online?</em></h2>
            <p>Join EduSphere and give your institution a professional digital home — plus the tools to manage it all.</p>
            <div class="cta-actions"><a class="button button-primary" href="#get-started" data-route="/#get-started">Get Started <span>${icons.arrow}</span></a><a class="button button-secondary" href="/login">Sign In</a></div>
          </div>
        </section>
      </main>
      ${footerMarkup()}`;
    initPageEvents();
    initPromoVideo();
  }

  /* Promo video: picks the right stream for the device (720p mobile /
     1080p desktop), wires the post-video call-to-action overlay and replay. */
  function initPromoVideo() {
    const frame = document.querySelector("[data-promo-frame]");
    const video = document.querySelector("[data-promo-video]");
    const ended = document.querySelector("[data-promo-ended]");
    const replay = document.querySelector("[data-promo-replay]");
    if (!frame || !video) return;

    const hd = window.innerWidth >= 1280;
    const src = document.createElement("source");
    src.src = hd ? "/assets/promo/edusphere-promo-1080p.mp4" : "/assets/promo/edusphere-promo-720p.mp4";
    src.type = "video/mp4";
    video.insertBefore(src, video.firstChild);

    const showEnded = () => {
      frame.classList.add("promo-finished");
      if (ended) { ended.hidden = false; ended.setAttribute("aria-hidden", "false"); }
    };
    const hideEnded = () => {
      frame.classList.remove("promo-finished");
      if (ended) { ended.hidden = true; ended.setAttribute("aria-hidden", "true"); }
    };
    video.addEventListener("ended", showEnded);
    video.addEventListener("play", hideEnded);
    video.addEventListener("seeking", hideEnded);
    if (replay) replay.addEventListener("click", () => { hideEnded(); video.currentTime = 0; video.play(); });
  }


  /* Western Academy is intentionally rendered as a dedicated public experience.
     The directory data below is presentation-only until the academy API is ready. */
  const westernAcademies = [
    {
      name: "Northbridge Academy", mark: "N", tone: "northbridge", location: "Lekki, Lagos", state: "Lagos", city: "Lekki", type: "Independent School", level: "Secondary", verified: true,
      description: "A future-focused secondary school where strong academics meet creativity, technology and leadership.", programs: ["STEAM", "Arts", "Leadership"]
    },
    {
      name: "Crestfield College", mark: "C", tone: "crestfield", location: "Ibadan, Oyo", state: "Oyo", city: "Ibadan", type: "College / Sixth Form", level: "College / Sixth Form", verified: true,
      description: "Helping ambitious learners prepare for university, professional study and life beyond the classroom.", programs: ["A-Level", "Business", "Sciences"]
    },
    {
      name: "Brighton Gate School", mark: "B", tone: "brighton", location: "Wuse, Abuja", state: "FCT", city: "Abuja", type: "Private School", level: "Primary", verified: false,
      description: "A warm, curious learning community built around confident foundations and whole-child development.", programs: ["Primary", "Digital Skills", "Creative Arts"]
    }
  ];

  const westernWhyCards = [
    ["Academic Excellence", "Rigorous learning pathways that help students think deeply, achieve strongly and keep progressing.", "graduation"],
    ["Qualified Teachers", "Discover academies led by knowledgeable educators who bring subjects to life.", "users"],
    ["Modern Learning", "Explore schools that balance strong foundations with relevant, engaging classroom experiences.", "monitor"],
    ["Technology", "Find learning environments where digital confidence is part of every student’s future.", "code"],
    ["Student Development", "See how academies support confidence, collaboration, wellbeing and individual potential.", "spark"],
    ["Career Preparation", "Connect with programmes that turn ambition into practical next steps and opportunities.", "rocket"]
  ];

  const westernLevels = [
    ["Primary", "A confident beginning for curious young learners.", "01", "school"],
    ["Secondary", "Academic depth, discovery and direction.", "02", "graduation"],
    ["College / Sixth Form", "Advanced study for ambitious next steps.", "03", "book"],
    ["Vocational & Professional", "Practical, career-ready learning pathways.", "04", "briefcase"],
    ["Other", "Alternative academies and specialist education.", "05", "compass"]
  ];

  function westernBrandMarkup() {
    return `
      <a class="western-brand" href="#western-top" aria-label="EduSphere Western Academies home">
        <span class="western-brand-icon" aria-hidden="true"><img src="/assets/edusphere-logo.png" alt="EduSphere logo"></span>
        <span class="western-brand-name"><strong>EduSphere</strong><small>Education Platform</small></span>
        <span class="western-brand-divider" aria-hidden="true"></span>
        <span class="western-brand-section">Western Academy</span>
      </a>`;
  }

  function westernHeaderMarkup() {
    return `
      <header class="western-header" id="western-top">
        <div class="western-nav-shell">
          ${westernBrandMarkup()}
          <nav class="western-desktop-nav" aria-label="Western Academy navigation">
            <a class="active" href="#western-top" aria-current="page">Home</a>
            <a href="#academies">Schools</a>
            <a href="#education-levels">Programs</a>
            <a href="#about">About</a>
            <a href="#western-contact">Contact</a>
          </nav>
          <div class="western-nav-actions">
            <a class="western-login" href="/login">Login</a>
            <a class="western-register-button" href="/register-academy" data-route="/register-academy">Register Your Academy <span>${icons.arrow}</span></a>
          </div>
          <button class="western-menu-toggle" type="button" aria-expanded="false" aria-controls="western-mobile-menu" aria-label="Open menu">
            <span class="western-open-icon">${icons.menu}</span><span class="western-close-icon">${icons.close}</span>
          </button>
        </div>
        <nav class="western-mobile-nav" id="western-mobile-menu" aria-label="Western Academy mobile navigation" aria-hidden="true">
          <a href="#western-top">Home</a><a href="#academies">Schools</a><a href="#education-levels">Programs</a><a href="#about">About</a><a href="#western-contact">Contact</a>
          <a class="western-mobile-login" href="/login">Login</a>
          <a class="western-register-button" href="/register-academy" data-route="/register-academy">Register Your Academy <span>${icons.arrow}</span></a>
        </nav>
      </header>`;
  }

  function westernFooterMarkup() {
    return `
      <footer class="western-footer" id="western-contact">
        <div class="western-container western-footer-grid">
          <div class="western-footer-intro">
            ${westernBrandMarkup()}
            <p>Helping families discover modern academic education, and giving every academy a confident online home.</p>
            <div class="western-footer-socials"><a href="#western-contact" aria-label="EduSphere Western Academies on LinkedIn">${icons.linkedin}</a><a href="#western-contact" aria-label="EduSphere Western Academies on Instagram">${icons.instagram}</a><a href="#western-contact" aria-label="EduSphere Western Academies on Facebook">${icons.facebook}</a></div>
          </div>
          <div class="western-footer-column"><h3>Explore</h3><a href="#academies">Schools</a><a href="#education-levels">Programs</a><a href="#about">About</a></div>
          <div class="western-footer-column"><h3>For academies</h3><a href="/register-academy" data-route="/register-academy">Register Your Academy</a><a href="#about">Your school website</a><a href="/login">Login</a><a href="#western-contact">Contact</a></div>
          <div class="western-footer-column"><h3>Portals</h3><a href="/teacher">Teacher workspace</a><a href="/student">Student portal</a><a href="/parent">Parent portal</a></div>
          <div class="western-footer-column"><h3>Platform</h3><a href="#western-contact">Contact</a><a href="#western-contact">Privacy Policy</a><a href="#western-contact">Terms</a><a href="/" data-route="/">EduSphere Education Platform</a></div>
        </div>
        <div class="western-container western-footer-bottom"><span>© <span id="western-year"></span> EduSphere — Western Academies. All rights reserved.</span><span>Powered by EduSphere Education Platform</span></div>
      </footer>`;
  }

  function westernIconCard(items, cardClass) {
    return items.map(([title, copy, icon, tone]) => `
      <article class="${cardClass} reveal">
        <span class="western-icon ${tone ? `western-icon--${tone}` : ""}">${icons[icon]}</span>
        <h3>${title}</h3><p>${copy}</p>
      </article>`).join("");
  }

  function westernAcademyCard(academy) {
    const searchTerms = [academy.name, academy.location, academy.type, academy.level, ...academy.programs].join(" ").toLowerCase();
    return `
      <article class="academy-card reveal" data-academy-card data-search="${searchTerms}" data-state="${academy.state}" data-city="${academy.city}" data-type="${academy.type}" data-level="${academy.level}" data-programs="${academy.programs.join("|")}">
        <div class="academy-card-top">
          <span class="academy-logo academy-logo--${academy.tone}" aria-label="${academy.name} logo">${academy.mark}</span>
          <div class="academy-card-top-copy"><span class="academy-location">${icons.pin}${academy.location}</span>${academy.verified ? `<span class="academy-verified">${icons.shieldCheck} Verified Academy</span>` : `<span class="academy-type">${academy.type}</span>`}</div>
        </div>
        <h3>${academy.name}</h3>
        <p>${academy.description}</p>
        <div class="academy-programs"><span>Programs</span><div>${academy.programs.map((program) => `<b>${program}</b>`).join("")}</div></div>
        <a class="academy-view-link" href="#find-academy">View Academy <span>${icons.arrow}</span></a>
      </article>`;
  }

  function renderWesternAcademy() {
    document.body.classList.add("western-experience");
    document.title = "Western Academies — EduSphere";
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = "#0A2342";
    app.innerHTML = `
      ${westernHeaderMarkup()}
      <main id="main-content" class="western-site">
        <section class="western-hero" aria-labelledby="western-hero-title">
          <div class="western-hero-grid western-container">
            <div class="western-hero-copy reveal">
              <p class="western-eyebrow"><span></span>EduSphere Education Platform <i></i> Western Academies</p>
              <h1 id="western-hero-title">Discover the Right Academy <em>for Your Future</em></h1>
              <p class="western-hero-text">Explore quality academic institutions, discover educational programs, and connect with schools that help students build a successful future.</p>
              <div class="western-hero-actions"><a class="western-button western-button--sky" href="#academies">Explore Schools <span>${icons.arrow}</span></a><a class="western-button western-button--ghost" href="/register-academy" data-route="/register-academy">Register Your Academy</a></div>
              <div class="western-hero-trust"><span>${icons.shieldCheck}</span><p>A modern academic space for families, students and independent schools.</p></div>
            </div>
            <div class="western-hero-visual reveal reveal-delay">
              <div class="western-photo-frame"><img src="/assets/western-academy-learning.jpg" alt="Students and a teacher collaborating in a modern science classroom"><span class="western-photo-shade"></span><span class="western-photo-label"><i></i> Modern academic learning</span></div>
              <div class="western-float-card western-float-card--program"><span class="western-float-icon">${icons.code}</span><div><small>Explore pathways</small><strong>Programs for every goal</strong></div></div>
              <div class="western-float-card western-float-card--future"><span class="western-future-orbit">↗</span><div><small>Built for tomorrow</small><strong>Learn. Grow. Lead.</strong></div></div>
            </div>
          </div>
        </section>

        <section class="western-proof-strip" aria-label="Western Academy benefits"><div class="western-container western-proof-grid"><div>${icons.school}<span><strong>Explore academies</strong><small>with clarity and confidence</small></span></div><div>${icons.book}<span><strong>Discover programs</strong><small>that fit every ambition</small></span></div><div>${icons.globe}<span><strong>Build connections</strong><small>with a new generation of schools</small></span></div></div></section>

        <section class="western-section western-why" aria-labelledby="why-western-title">
          <div class="western-container">
            <div class="western-section-heading centered reveal"><p class="western-kicker">Why Western Academy</p><h2 id="why-western-title">Quality Education. <em>Greater Opportunities.</em></h2><p>Every student deserves an environment where strong teaching, modern resources and ambitious ideas come together.</p></div>
            <div class="western-why-grid">${westernIconCard(westernWhyCards, "western-why-card")}</div>
          </div>
        </section>

        <section class="western-section western-featured" id="academies" aria-labelledby="featured-academies-title">
          <div class="western-container">
            <div class="western-section-heading western-heading-row reveal"><div><p class="western-kicker">Discover your next school</p><h2 id="featured-academies-title">Featured Academies</h2></div><a class="western-inline-link" href="#find-academy">Find an Academy <span>${icons.arrow}</span></a></div>
            <div class="academy-grid">${westernAcademies.map(westernAcademyCard).join("")}</div>
            <p class="western-demo-note">Featured academies are demo content for this public directory design.</p>
          </div>
        </section>

        <section class="western-find-section" id="find-academy" aria-labelledby="find-academy-title">
          <div class="western-container">
            <div class="western-find-shell reveal">
              <div class="western-find-heading"><p class="western-kicker western-kicker--light">Find a school</p><h2 id="find-academy-title">Find an Academy</h2><p>Search by what matters to your family, then narrow the directory to the right fit.</p></div>
              <form class="western-search-form" id="academy-search-form" novalidate>
                <div class="western-search-grid">
                  <label><span>School name</span><span class="western-input-wrap">${icons.search}<input id="academy-name-search" type="search" placeholder="e.g. Northbridge Academy" autocomplete="off"></span></label>
                  <label><span>Location</span><span class="western-input-wrap">${icons.pin}<input id="academy-location-search" type="search" placeholder="City or area" autocomplete="off"></span></label>
                  <label><span>Program</span><span class="western-select-wrap"><select id="academy-program-search"><option value="">Any program</option><option>STEAM</option><option>Arts</option><option>Leadership</option><option>A-Level</option><option>Business</option><option>Sciences</option><option>Primary</option><option>Digital Skills</option></select></span></label>
                </div>
                <div class="western-filter-row"><span class="western-filter-title">${icons.filter} Filters</span><label><span class="sr-only">State</span><select id="academy-state-filter"><option value="">State</option><option>Lagos</option><option>Oyo</option><option>FCT</option></select></label><label><span class="sr-only">City</span><select id="academy-city-filter"><option value="">City</option><option>Lekki</option><option>Ibadan</option><option>Abuja</option></select></label><label><span class="sr-only">School Type</span><select id="academy-type-filter"><option value="">School Type</option><option>Independent School</option><option>College / Sixth Form</option><option>Private School</option></select></label><label><span class="sr-only">Education Level</span><select id="academy-level-filter"><option value="">Education Level</option><option>Primary</option><option>Secondary</option><option>College / Sixth Form</option></select></label><label><span class="sr-only">Programs</span><select id="academy-program-filter"><option value="">Programs</option><option>STEAM</option><option>A-Level</option><option>Primary</option><option>Digital Skills</option></select></label></div>
                <div class="western-search-actions"><button class="western-button western-button--sky" type="submit">Search Academies ${icons.search}</button><button class="western-clear-search" type="button" id="academy-search-reset">Clear filters</button><p id="academy-search-result" aria-live="polite">Showing 3 featured academies</p></div>
              </form>
            </div>
          </div>
        </section>

        <section class="western-section western-levels" id="education-levels" aria-labelledby="education-levels-title">
          <div class="western-container">
            <div class="western-section-heading centered reveal"><p class="western-kicker">Explore by stage</p><h2 id="education-levels-title">Education Levels</h2><p>Find a school at the stage that is right for your learner now.</p></div>
            <div class="western-level-grid">${westernLevels.map(([title, copy, num, icon]) => `<a class="western-level-card reveal" href="#find-academy"><span class="western-level-number">${num}</span><span class="western-level-icon">${icons[icon]}</span><h3>${title}</h3><p>${copy}</p><span class="western-level-arrow">${icons.arrow}</span></a>`).join("")}</div>
          </div>
        </section>

        <section class="western-identity-section" id="about" aria-labelledby="academy-identity-title">
          <div class="western-container western-identity-grid">
            <div class="western-identity-copy reveal"><p class="western-kicker western-kicker--light">For independent academies</p><h2 id="academy-identity-title">Your academy. <em>Your online identity.</em></h2><p>EduSphere provides the technology behind your public presence while your academy stays unmistakably yours.</p><ul><li>${icons.check}<span>Use your logo, school name and colors</span></li><li>${icons.check}<span>Share programs, teachers, classes and admissions</span></li><li>${icons.check}<span>Publish your gallery, news, contact details and more</span></li></ul></div>
            <div class="academy-site-preview reveal reveal-delay" aria-label="Example independent academy public website"><div class="academy-browser-top"><span><i></i><i></i><i></i></span><b>northbridge.edusphere.site</b><span>${icons.globe}</span></div><div class="academy-preview-page"><div class="academy-preview-nav"><strong><i>N</i> NORTHBRIDGE</strong><span>About&nbsp;&nbsp; Programs&nbsp;&nbsp; Admissions</span></div><div class="academy-preview-hero"><small>WELCOME TO NORTHBRIDGE ACADEMY</small><h3>Learn with purpose.<br><em>Lead with confidence.</em></h3><button type="button">Explore our school</button></div><div class="academy-preview-stats"><span><b>24</b> Classrooms</span><span><b>9</b> Programs</span><span><b>1</b> Unique identity</span></div></div></div>
          </div>
        </section>

        <section class="western-registration-section" id="academy-registration" aria-labelledby="academy-registration-title">
          <div class="western-container"><div class="western-registration-card reveal"><div><p class="western-kicker">For academies</p><h2 id="academy-registration-title">Bring Your Academy Online</h2><p>EduSphere gives schools the tools they need to build their online presence, manage their institution, and connect with students and parents.</p></div><a class="western-button western-button--navy" href="/register-academy" data-route="/register-academy">Register Your Academy <span>${icons.arrow}</span></a></div></div>
        </section>
      </main>
      ${westernFooterMarkup()}`;
    initPageEvents();
    initWesternAcademyEvents();
  }

  function initWesternAcademyEvents() {
    const year = document.getElementById("western-year");
    if (year) year.textContent = new Date().getFullYear();

    const toggle = document.querySelector(".western-menu-toggle");
    const menu = document.getElementById("western-mobile-menu");
    if (toggle && menu) {
      const closeMenu = () => { toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-label", "Open menu"); menu.setAttribute("aria-hidden", "true"); document.body.classList.remove("western-menu-open"); };
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu"); menu.setAttribute("aria-hidden", String(!open)); document.body.classList.toggle("western-menu-open", open);
      });
      menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
    }

    const form = document.getElementById("academy-search-form");
    const cards = Array.from(document.querySelectorAll("[data-academy-card]"));
    const result = document.getElementById("academy-search-result");
    const input = (id) => document.getElementById(id);
    const values = ["academy-name-search", "academy-location-search", "academy-program-search", "academy-state-filter", "academy-city-filter", "academy-type-filter", "academy-level-filter", "academy-program-filter"].map(input).filter(Boolean);
    const value = (id) => String((input(id) || {}).value || "").trim().toLowerCase();
    const applySearch = () => {
      const name = value("academy-name-search"); const location = value("academy-location-search"); const program = value("academy-program-search");
      const state = value("academy-state-filter"); const city = value("academy-city-filter"); const type = value("academy-type-filter"); const level = value("academy-level-filter"); const programs = value("academy-program-filter");
      let visible = 0;
      cards.forEach((card) => {
        const matches = (!name || card.dataset.search.includes(name)) && (!location || card.dataset.search.includes(location)) && (!program || card.dataset.programs.toLowerCase().includes(program)) && (!state || card.dataset.state.toLowerCase() === state) && (!city || card.dataset.city.toLowerCase() === city) && (!type || card.dataset.type.toLowerCase() === type) && (!level || card.dataset.level.toLowerCase() === level) && (!programs || card.dataset.programs.toLowerCase().includes(programs));
        card.hidden = !matches;
        if (matches) visible += 1;
      });
      if (result) result.textContent = visible ? `Showing ${visible} featured ${visible === 1 ? "academy" : "academies"}` : "No featured academies match those filters yet.";
    };
    if (form) form.addEventListener("submit", (event) => { event.preventDefault(); applySearch(); });
    values.forEach((control) => control.addEventListener(control.tagName === "SELECT" ? "change" : "input", applySearch));
    const reset = document.getElementById("academy-search-reset");
    if (reset) reset.addEventListener("click", () => { if (form) form.reset(); applySearch(); });
  }


  const categoryData = {
    islamic: {
      active: "islamic",
      shortName: "Islamic Schools",
      title: "Islamic education, ready to discover.",
      copy: "A dedicated EduSphere destination for madrasas, Arabic schools, Qur'an schools, and Islamic learning institutions.",
      image: "/assets/islamic-school-learning.jpg",
      imageAlt: "Students studying the Qur'an and Arabic books together",
      eyebrow: "EduSphere / Islamic Schools",
      theme: "islamic",
      audienceTitle: "A home for every Islamic learning path.",
      audienceCopy: "We are preparing a thoughtful public directory that makes it easier for learners and families to discover the institutions and programmes that meet their needs.",
      types: ["Madrasa", "Arabic School", "Qur'an School", "Islamic Learning Centre"],
      typeIcon: "book",
      listingTitle: "The Islamic school directory is taking shape.",
      listingCopy: "Search, location, featured institutions and school registration will live here as the EduSphere Islamic Schools network grows.",
      registerTitle: "Bring your Islamic school to EduSphere.",
      registerCopy: "Create your institution profile today and join the foundation of a connected Islamic education community.",
      registerLabel: "Register an Islamic School",
      registerHref: "/register-madrasa",
      registerRoute: "/register-madrasa",
      featureCards: [["Find institutions", "Discover schools in the communities that matter to you.", "search"], ["Explore programmes", "See the learning paths each school offers.", "book"], ["Connect with confidence", "Get to know an institution before taking the next step.", "users"]],
    },
    western: {
      active: "western",
      shortName: "Western Academies",
      title: "Modern education, ready to discover.",
      copy: "A dedicated EduSphere destination for independent academic schools, programmes and learning communities.",
      image: "/assets/western-academy-learning.jpg",
      imageAlt: "Students and a teacher collaborating in a modern academy",
      eyebrow: "EduSphere / Western Academies",
      theme: "western",
      audienceTitle: "A home for every academic journey.",
      audienceCopy: "We are preparing a clear public directory that will help families find modern schools and discover the classes and programmes that suit their goals.",
      types: ["Primary School", "Secondary School", "College", "Other Academy"],
      typeIcon: "school",
      listingTitle: "The Western Academy directory is taking shape.",
      listingCopy: "Search, location, featured schools and academy registration will live here as the EduSphere Western Academies network grows.",
      registerTitle: "Bring your academy to EduSphere.",
      registerCopy: "Create your academy profile today, publish your programs and education levels, and manage your school from one dashboard.",
      registerLabel: "Register a Western Academy",
      registerHref: "/register-academy",
      registerRoute: "/register-academy",
      featureCards: [["Find schools", "Discover academic institutions in the places that work for your family.", "search"], ["Explore programmes", "See the classes and learning opportunities on offer.", "school"], ["Plan with clarity", "Get the information you need before connecting with a school.", "compass"]],
    }
  };

  function categoryFeatureCards(data) {
    return data.featureCards.map(([title, copy, icon]) => `
      <article class="category-feature-card reveal"><span class="category-feature-icon">${icons[icon]}</span><h3>${title}</h3><p>${copy}</p></article>`).join("");
  }

  function categoryTypeCards(data) {
    return data.types.map((type, index) => `
      <article class="institution-type-card reveal"><span>${String(index + 1).padStart(2, "0")}</span><div class="institution-type-icon">${icons[data.typeIcon]}</div><h3>${type}</h3><p>Built to be discoverable through EduSphere.</p></article>`).join("");
  }

  function renderCategory(kind) {
    document.body.classList.remove("western-experience", "western-menu-open");
    document.body.classList.toggle("islamic-experience", kind === "islamic");
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = kind === "islamic" ? "#200A3D" : "#0A2342";
    const data = categoryData[kind];
    if (!data) return renderHomepage();
    document.title = `EduSphere — ${data.shortName}`;
    app.innerHTML = `
      ${headerMarkup(data.active)}
      <main id="main-content" class="category-page category-page--${data.theme}">
        <section class="category-hero section-pattern" aria-labelledby="category-title">
          <div class="hero-orb hero-orb-one"></div><div class="hero-orb hero-orb-two"></div>
          <div class="container category-hero-grid">
            <div class="category-hero-copy reveal">
              <p class="eyebrow"><span class="eyebrow-dot"></span>${data.eyebrow}</p>
              <a class="breadcrumb" href="/" data-route="/">EduSphere <span>/</span> ${data.shortName}</a>
              <h1 id="category-title">${data.title}</h1>
                            <p>${data.copy}</p>
                            <div class="hero-actions"><a class="button button-primary" href="#directory-preview">Explore the directory <span>${icons.arrow}</span></a><a class="button button-secondary" href="/" data-route="/">Choose another path</a></div>
            </div>
            <div class="category-hero-image reveal reveal-delay">
              <img src="${data.image}" alt="${data.imageAlt}">
              <span class="category-hero-image-shade"></span>
              <span class="category-image-badge">${icons.spark} A growing EduSphere community</span>
            </div>
          </div>
        </section>

        <section class="category-purpose-section" aria-labelledby="purpose-title">
          <div class="container">
            <div class="section-heading centered reveal">
              <p class="section-kicker">Public directory, in progress</p>
              <h2 id="purpose-title">${data.audienceTitle}</h2>
                            <p>${data.audienceCopy}</p>
            </div>
            <div class="category-feature-grid">${categoryFeatureCards(data)}</div>
          </div>
        </section>

        <section class="institution-types-section" aria-labelledby="types-title">
          <div class="container">
            <div class="section-heading split-heading reveal"><div><p class="section-kicker">Built for the community</p><h2 id="types-title">Explore by institution type.</h2></div><p>Each school will have the space to be discovered on its own terms, with its own story and public identity.</p></div>
            <div class="institution-type-grid">${categoryTypeCards(data)}</div>
          </div>
        </section>

        <section class="directory-preview-section" id="directory-preview" aria-labelledby="directory-title">
          <div class="container directory-preview-card reveal">
            <div class="directory-preview-icon">${icons.search}</div>
            <div><p class="section-kicker">Coming next</p><h2 id="directory-title">${data.listingTitle}</h2><p>${data.listingCopy}</p></div>
            <a class="text-link directory-home-link" href="/" data-route="/">Return to EduSphere <span>${icons.arrow}</span></a>
          </div>
        </section>

        <section class="category-register-section" id="${kind === "western" ? "western-registration" : "register-islamic-school"}" aria-labelledby="register-title">
          <div class="container category-register-card reveal">
            <div><p class="section-kicker light-kicker">For school leaders</p><h2 id="register-title">${data.registerTitle}</h2><p>${data.registerCopy}</p></div>
            <a class="button button-gold" href="${data.registerHref}"${data.registerRoute.startsWith("/") ? ` data-route="${data.registerRoute}"` : ""}>${data.registerLabel} ${data.registerRoute.startsWith("/") ? `<span>${icons.arrow}</span>` : ""}</a>
          </div>
        </section>
      </main>
      ${footerMarkup()}`;
    initPageEvents();
  }

  function initPageEvents() {
    const toggle = document.querySelector(".menu-toggle");
    const menu = document.querySelector(".mobile-nav");
    const header = document.querySelector(".site-header");

    if (toggle && menu) {
      const closeMenu = () => {
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open menu");
        menu.setAttribute("aria-hidden", "true");
        document.body.classList.remove("menu-open");
      };
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        menu.setAttribute("aria-hidden", String(!open));
        document.body.classList.toggle("menu-open", open);
      });
      menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
    }

    if (scrollHandler) window.removeEventListener("scroll", scrollHandler);
    if (header) {
      scrollHandler = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
      scrollHandler();
      window.addEventListener("scroll", scrollHandler, { passive: true });
    }

    const year = document.getElementById("year");
    if (year) year.textContent = new Date().getFullYear();

    if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }), { threshold: 0.12 });
      document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
    } else {
      document.querySelectorAll(".reveal").forEach((element) => element.classList.add("is-visible"));
    }

    document.querySelectorAll("[data-route]").forEach((link) => {
      link.addEventListener("click", (event) => {
        const route = link.getAttribute("data-route");
        if (!route) return;
        event.preventDefault();
        window.BelloRouter.navigate(route);
      });
    });
  }

  function renderRegistration() {
    document.body.classList.remove("western-experience", "western-menu-open");
    document.body.classList.add("islamic-experience");
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = "#200A3D";
    if (window.BelloRegister && typeof window.BelloRegister.mount === "function") {
      window.BelloRegister.mount();
    }
  }

  /* Western Academy onboarding. Pressing "Register Your Academy" anywhere in
     the Western experience lands here — its OWN registration information
     centre, not the Madrasa one — and the navy/sky Western identity is kept
     by staying on body.western-experience. */
  function renderAcademyRegistration() {
    document.body.classList.remove("islamic-experience", "western-menu-open");
    document.body.classList.add("western-experience");
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = "#0A2342";
    document.title = "Register Your Academy — EduSphere";
    if (window.BelloAcademyRegister && typeof window.BelloAcademyRegister.mount === "function") {
      window.BelloAcademyRegister.mount();
    } else {
      // The academy module failed to load — keep the visitor inside the
      // Western experience rather than dropping them on the Madrasa form.
      renderWesternAcademy();
    }
  }


  /* Public institution page -------------------------------------------------
     `/s/<slug>` is the share link an administrator sees in the dashboard.
     It must render that tenant's actual data — never the platform homepage. */
  function safe(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function publicPageCopy(pages, key, fallbackTitle, fallbackBody) {
    return {
      title: pages[`website_${key}_title`] || fallbackTitle,
      body: pages[`website_${key}_content`] || fallbackBody || "",
    };
  }

  /* ------------------------------------------------------------------ *
     TENANT PUBLIC WEBSITE — helpers
     ------------------------------------------------------------------
     Every school gets its own complete website on /schools/:slug. The
     building blocks below keep the renderer readable: colour safety,
     readable dates, statistics, and the shared page furniture (header,
     sub-navigation, footer, floating action dock).
     ------------------------------------------------------------------ */

  /** Only accept a real hex colour; anything else falls back. */
  function schoolHex(value, fallback) {
    const v = String(value || "").trim();
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : fallback;
  }

  /* Font stacks are written with SINGLE quotes around family names: they are
     injected into a double-quoted style="" attribute, so a double quote here
     would end the attribute early and silently drop every variable after it. */
  const SCHOOL_FONTS = {
    system: "Inter, ui-sans-serif, system-ui, 'Segoe UI', Roboto, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', 'Iowan Old Style', serif",
    rounded: "'Trebuchet MS', 'Segoe UI', ui-rounded, system-ui, sans-serif",
    humanist: "Optima, Candara, 'Segoe UI', system-ui, sans-serif",
  };

  /** First letters of a school name, for logo-less crests. */
  function schoolInitials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "S";
    return (parts[0][0] + (parts.length > 1 ? parts[1][0] : "")).toUpperCase();
  }

  function schoolDate(value, withYear) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString("en-GB", {
      day: "numeric", month: "short", ...(withYear === false ? {} : { year: "numeric" }),
    });
  }

  function schoolDateParts(value) {
    const d = new Date(value || "");
    if (isNaN(d.getTime())) return null;
    return {
      day: d.toLocaleDateString("en-GB", { day: "numeric" }),
      month: d.toLocaleDateString("en-GB", { month: "short" }),
      year: d.toLocaleDateString("en-GB", { year: "numeric" }),
    };
  }

  /** Headline numbers the school actually has. Zero-value rows are dropped. */
  function schoolStats(m) {
    const rows = [
      { label: "Students", value: Number(m.students) || 0 },
      { label: "Teachers", value: Number(m.teachers) || 0 },
      { label: "Classes", value: Number(m.classes) || 0 },
      { label: "Subjects", value: Number(m.subjects) || 0 },
    ].filter((row) => row.value > 0);
    return rows;
  }

  /** Social profiles the school published, as icon buttons. */
  function schoolSocials(contact) {
    const socials = (contact && contact.socials) || {};
    return Object.entries(socials)
      .filter(([, url]) => Boolean(url))
      .map(([key, url]) => {
        const icon = icons[key] || icons.globe;
        return `<a class="ss-social" href="${safe(url)}" target="_blank" rel="noopener" aria-label="${safe(key)}">${icon}</a>`;
      })
      .join("");
  }

  /** Sub-navigation + sticky section links, fed by the sections that exist. */
  function schoolSubnav(nav) {
    if (nav.length < 3) return "";
    return `<nav class="ss-subnav" id="school-subnav" aria-label="Page sections">
      <div class="ss-shell ss-subnav__inner">
        ${nav.map((item, index) => `<a class="ss-subnav__link${index === 0 ? " is-active" : ""}" href="#${safe(item.id)}" data-school-link="${safe(item.id)}">${safe(item.label)}</a>`).join("")}
      </div>
    </nav>`;
  }

  /** Site header: brand, published page menu, sign-in and the apply CTA. */
  function schoolHeaderMarkup(m, look, nav, customPages) {
    const name = safe(m.nameEn || "Institution");
    const logo = m.logoPath
      ? `<img src="${safe(m.logoPath)}" alt="${name} logo">`
      : safe(schoolInitials(m.nameEn));
    const coreLinks = nav.slice(0, 6);
    const moreLinks = customPages.filter((p) => p.inNavigation !== false);
    return `<header class="ss-header school-site-header" id="school-top" data-header="${safe(look.header_style || "solid")}">
      <div class="ss-shell ss-header__inner">
        <a class="ss-brand school-site-brand" href="#home" aria-label="${name} home">
          <span class="ss-brand__mark school-site-mark">${logo}</span>
          <span class="ss-brand__text"><strong>${name}</strong>${m.tagline ? `<small>${safe(m.tagline)}</small>` : m.mottoEn ? `<small>${safe(m.mottoEn)}</small>` : `<small>${safe(m.institutionType || "School website")}</small>`}</span>
        </a>
        <nav class="ss-nav school-site-menu" id="school-menu" aria-label="Institution website navigation">
          <div class="ss-nav__links">
          ${coreLinks.map((item) => `<a class="ss-nav__link" href="#${safe(item.id)}" data-school-link="${safe(item.id)}">${safe(item.label)}</a>`).join("")}
          ${moreLinks.length ? `<div class="ss-more">
            <button class="ss-more__btn" type="button" id="schoolMoreBtn" aria-expanded="false" aria-controls="schoolMoreMenu">More${icons.chev}</button>
            <div class="ss-more__menu" id="schoolMoreMenu">
              ${moreLinks.map((p) => `<a href="#${safe(p.id)}" data-school-link="${safe(p.id)}">${safe(p.title)}</a>`).join("")}
            </div>
          </div>` : ""}
          </div>
          <div class="ss-nav__cta">
            <a class="ss-nav__login" href="${safe(m.loginUrl || "/login")}">Sign in</a>
            ${m.canApply && m.admissionsOpen ? `<a class="ss-btn" href="#admissions" data-school-link="admissions">Apply now ${icons.arrow}</a>` : ""}
          </div>
        </nav>
        <button class="ss-burger school-menu-toggle" type="button" id="schoolMenuToggle" aria-expanded="false" aria-controls="schoolDrawer" aria-label="Open institution menu">
          <span class="ss-burger__open">${icons.menu}</span>
        </button>
      </div>
    </header>`;
  }

  /** Slide-in drawer for narrow screens — same links, thumb friendly. */
  function schoolDrawerMarkup(m, nav, customPages) {
    return `<div class="ss-drawer" id="schoolDrawer" hidden>
      <div class="ss-drawer__panel" role="dialog" aria-modal="true" aria-label="Institution menu">
        <div class="ss-drawer__head">
          <strong>${safe(m.nameEn || "Menu")}</strong>
          <button class="ss-drawer__close" type="button" id="schoolDrawerClose" aria-label="Close menu">${icons.close}</button>
        </div>
        <div class="ss-drawer__links">
          ${nav.map((item) => `<a href="#${safe(item.id)}" data-school-link="${safe(item.id)}">${safe(item.label)}</a>`).join("")}
          ${customPages.filter((p) => p.inNavigation !== false).map((p) => `<a href="#${safe(p.id)}" data-school-link="${safe(p.id)}">${safe(p.title)}</a>`).join("")}
        </div>
        <div class="ss-drawer__foot">
          ${m.canApply && m.admissionsOpen ? `<a class="ss-btn ss-btn--block" href="#admissions" data-school-link="admissions">Apply now ${icons.arrow}</a>` : ""}
          <a class="ss-btn ss-btn--ghost ss-btn--block" href="${safe(m.loginUrl || "/login")}">School sign in</a>
        </div>
      </div>
    </div>`;
  }

  /** Floating dock: the two actions visitors actually came for. */
  function schoolDockMarkup(m) {
    const call = m.phone ? `<a class="ss-dock__btn ss-dock__btn--ghost" href="tel:${safe(m.phone)}">${icons.phone}<span>Call</span></a>` : "";
    const whatsapp = m.whatsapp
      ? `<a class="ss-dock__btn ss-dock__btn--ghost" href="https://wa.me/${safe(String(m.whatsapp).replace(/[^\d]/g, ""))}" target="_blank" rel="noopener">${icons.chat}<span>WhatsApp</span></a>`
      : "";
    return `<div class="ss-dock" aria-label="Quick actions">
      ${call}${whatsapp}
      ${m.canApply && m.admissionsOpen ? `<a class="ss-dock__btn ss-dock__btn--accent" href="#admissions" data-school-link="admissions">${icons.pen}<span>Apply now</span></a>` : ""}
      <button class="ss-totop" type="button" id="schoolToTop" aria-label="Back to top"><span>${icons.arrowUp}</span></button>
    </div>`;
  }

  /** Footer — detailed / simple / minimal, always credited to EduSphere. */
  function schoolFooterMarkup(m, look, nav, customPages) {
    const name = safe(m.nameEn || "Institution");
    const logo = m.logoPath
      ? `<img src="${safe(m.logoPath)}" alt="${name} logo">`
      : safe(schoolInitials(m.nameEn));
    const legalSlugs = ["privacy", "terms", "policies"];
    const legal = customPages.filter((p) => legalSlugs.includes(String(p.slug).toLowerCase()));
    const contactLines = [
      m.address ? `<span>${safe(m.address)}${m.city ? `, ${safe(m.city)}` : ""}${m.state ? `, ${safe(m.state)}` : ""}</span>` : "",
      m.phone ? `<a href="tel:${safe(m.phone)}">${safe(m.phone)}</a>` : "",
      m.email ? `<a href="mailto:${safe(m.email)}">${safe(m.email)}</a>` : "",
      m.website ? `<a href="${safe(m.website)}" target="_blank" rel="noopener">${safe(String(m.website).replace(/^https?:\/\//, ""))}</a>` : "",
    ].filter(Boolean);
    const style = String(look.footer_style || "detailed");
    return `<footer class="ss-footer school-site-footer ss-footer--${safe(style)}">
      <div class="ss-shell ss-footer__grid">
        <div>
          <a class="ss-footer__brand school-site-brand" href="#home">
            <span class="ss-brand__mark school-site-mark">${logo}</span>
            <span class="ss-brand__text"><strong>${name}</strong><small>${safe(m.mottoEn || m.tagline || m.institutionType || "Our school")}</small></span>
          </a>
          <p style="margin-top:16px;max-width:360px;">${safe(m.shortDescription || m.descriptionEn || "")}</p>
          <div class="ss-footer__badges">
            ${m.foundedYear ? `<span>Established ${safe(m.foundedYear)}</span>` : ""}
            ${m.institutionType ? `<span>${safe(m.institutionType)}</span>` : ""}
            ${m.currentSession ? `<span>Session ${safe(m.currentSession)}</span>` : ""}
            ${m.city ? `<span>${safe(m.city)}${m.state ? `, ${safe(m.state)}` : ""}</span>` : ""}
          </div>
          ${schoolSocials(m.contact) ? `<div class="ss-socials">${schoolSocials(m.contact)}</div>` : ""}
        </div>
        <div>
          <h3>Explore</h3>
          <div class="ss-footer__links">
            ${nav.slice(0, 6).map((item) => `<a href="#${safe(item.id)}" data-school-link="${safe(item.id)}">${safe(item.label)}</a>`).join("")}
          </div>
        </div>
        ${style === "minimal" ? "" : `<div>
          <h3>School life</h3>
          <div class="ss-footer__links">
            ${nav.slice(6).map((item) => `<a href="#${safe(item.id)}" data-school-link="${safe(item.id)}">${safe(item.label)}</a>`).join("")}
            ${customPages.map((p) => `<a href="#${safe(p.id)}" data-school-link="${safe(p.id)}">${safe(p.title)}</a>`).join("")}
            <a href="${safe(m.loginUrl || "/login")}">School sign in</a>
          </div>
        </div>`}
        <div>
          <h3>Contact</h3>
          <div class="ss-footer__contact">
            ${contactLines.map((line) => line).join("")}
          </div>
        </div>
      </div>
      <div class="ss-shell ss-footer__bottom">
        <span>© ${new Date().getFullYear()} ${name}. All rights reserved.</span>
        <span class="ss-footer__bottom-links">
          ${legal.map((p) => `<a href="#${safe(p.id)}" data-school-link="${safe(p.id)}">${safe(p.title)}</a>`).join('<i aria-hidden="true">·</i>')}
          <a class="ss-footer__powered" href="/" data-route="/"><img src="/assets/edusphere-logo.png" alt="">Powered by EduSphere</a>
        </span>
      </div>
    </footer>`;
  }

  /* ------------------------------------------------------------------ *
     TENANT PUBLIC WEBSITE — renderer
     ------------------------------------------------------------------ */

  async function renderSchoolPublic(slug) {
    document.body.classList.remove("western-experience", "western-menu-open", "islamic-experience", "menu-open");
    document.body.classList.add("school-site-active");
    app.innerHTML = `<main id="main-content" class="school-public"><div class="school-public-loading">Loading the school website…</div></main>`;
    try {
      const data = await window.API.public.get(`/schools/${encodeURIComponent(slug)}`);
      const m = data.madrasa || {};
      const look = m.appearance || {};
      const profile = m.profile || {};
      const info = m.information || {};
      const contact = m.contact || {};
      const pages = data.pages || {};
      const admissions = data.admissions || {};
      const classes = data.classes || [];
      const programs = data.programs || [];
      const teachers = data.teachers || [];
      const achievements = data.achievements || [];
      const news = data.news || data.notices || [];
      const events = data.events || [];
      const gallery = data.gallery || { albums: [], media: [] };
      const publishedPage = (slugPart) => (data.sitePages || []).find((p) => String(p.slug).toLowerCase() === slugPart) || null;

      /* ---- identity, theme and behaviour flags --------------------------- */
      const isWestern = String(m.category || "islamic") === "western";
      const brand = schoolHex(look.brand_color || m.brandColor, isWestern ? "#0A2342" : "#200A3D");
      const accent = schoolHex(look.secondary_color, isWestern ? "#39A5E7" : "#C8952C");
      const islamicAccent = schoolHex(look.islamic_color, "#200A3D");
      const westernAccent = schoolHex(look.western_color, "#0A2342");
      const paper = schoolHex(look.background_color, "");
      const ink = schoolHex(look.text_color, "");
      const theme = ["light", "warm", "dark"].includes(String(look.website_theme)) ? String(look.website_theme) : "light";
      const layout = ["hero-stats", "hero-split", "classic"].includes(String(look.homepage_layout)) ? String(look.homepage_layout) : "hero-stats";
      const cardStyle = ["elevated", "outlined", "flat"].includes(String(look.card_style)) ? String(look.card_style) : "elevated";
      const btnRadius = look.button_style === "pill" ? "999px" : look.button_style === "square" ? "6px" : "12px";
      const radius = cardStyle === "flat" ? "14px" : "20px";
      const styleVars = [
        `--ss-brand:${safe(brand)}`,
        `--ss-accent:${safe(accent)}`,
        `--ss-islamic:${safe(islamicAccent)}`,
        `--ss-western:${safe(westernAccent)}`,
        `--ss-font:${SCHOOL_FONTS[look.font_family] || SCHOOL_FONTS.system}`,
        `--ss-btn-radius:${btnRadius}`,
        `--ss-radius:${radius}`,
        `--ss-radius-sm:${cardStyle === "flat" ? "12px" : "14px"}`,
        paper ? `--ss-bg:${safe(paper)}` : "",
        ink ? `--ss-ink:${safe(ink)}` : "",
        /* Legacy variables: keep the older template variables resolving too. */
        `--school-brand:${safe(brand)}`, `--school-secondary:${safe(accent)}`,
        `--school-islamic:${safe(islamicAccent)}`, `--school-western:${safe(westernAccent)}`,
        `--school-btn-radius:${btnRadius}`,
        `--school-ink:${safe(ink || "#25202c")}`,
      ].filter(Boolean).join(";");

      const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "");
      const todayIso = new Date().toISOString().slice(0, 10);
      const windowOpen = (() => {
        const opens = isoDate(admissions.startDate);
        const closes = isoDate(admissions.closingDate);
        if (opens && todayIso < opens) return false;
        if (closes && todayIso > closes) return false;
        return admissions.open !== false;
      })();
      const admissionsClosed = String(admissions.status || "").toLowerCase() === "closed" || String(info.admissionStatus || "").toLowerCase() === "closed";
      // The public site takes applications only when the school, the platform
      // switch AND the published dates all allow it — the same rule the API
      // enforces, so a visitor never fills a form that will be rejected.
      m.admissionsOpen = Boolean(m.canApply) && !admissionsClosed && windowOpen;
      m.loginUrl = data.loginUrl || "/login";
      const stats = schoolStats(m);

      /* ---- published Website Pages: copy for the core sections ----------- */
      const pageCopy = (slugPart, fallbackTitle, fallbackBody) => {
        const page = publishedPage(slugPart);
        if (page) return { title: page.title || fallbackTitle, body: page.body || fallbackBody || "" };
        return publicPageCopy(pages, slugPart === "about-us" ? "about" : slugPart, fallbackTitle, fallbackBody);
      };
      const aboutCopy = pageCopy("about-us", "About our school", "");
      const programmesCopy = pageCopy("programs", "Programmes & courses", "");
      const admissionsCopy = pageCopy("admissions", "Admissions", "Begin your application with our admissions team.");

      /* ---- sections that are rendered + the navigation they feed --------- */
      const nav = [{ id: "home", label: "Home" }];
      const blocks = [];

      /* ================================ HERO ============================= */
      const heroImage = m.heroImagePath || (gallery.media.find((item) => item.type !== "video" && item.path) || {}).path || "";
      const crest = m.logoPath
        ? `<img src="${safe(m.logoPath)}" alt="${safe(m.nameEn || "School")} logo">`
        : `<span>${safe(schoolInitials(m.nameEn))}</span>`;
      const heroChips = [
        m.city || m.state ? `<span class="ss-chip">${icons.pin}${safe([m.city, m.state].filter(Boolean).join(", "))}</span>` : "",
        m.institutionType ? `<span class="ss-chip">${icons.school}${safe(m.institutionType)}</span>` : "",
        info.boardingStatus ? `<span class="ss-chip">${safe(info.boardingStatus)}</span>` : "",
        m.foundedYear ? `<span class="ss-chip">Since ${safe(m.foundedYear)}</span>` : "",
        m.admissionsOpen ? `<span class="ss-chip ss-chip--live">Admissions open</span>` : "",
      ].filter(Boolean).join("");
      const heroActions = [
        m.admissionsOpen ? `<a class="ss-btn ss-btn--accent ss-btn--lg" href="#admissions" data-school-link="admissions">Apply now ${icons.arrow}</a>` : "",
        programs.length ? `<a class="ss-btn ss-btn--outline ss-btn--lg" href="#programs" data-school-link="programs">Explore programmes</a>` : "",
        m.canCheckResults && Number(data.publishedTermCount) > 0 ? `<a class="ss-btn ss-btn--outline ss-btn--lg" href="#results" data-school-link="results">Check results</a>` : "",
        !m.admissionsOpen || (!programs.length && !(m.canCheckResults && Number(data.publishedTermCount) > 0)) ? `<a class="ss-btn ss-btn--outline ss-btn--lg" href="#contact" data-school-link="contact">Contact the school</a>` : "",
      ].filter(Boolean).join("");
      const statsMarkup = stats.length
        ? `<div class="ss-stats${layout !== "hero-stats" ? " ss-stats--paper" : ""}" role="list">
            ${stats.map((row) => `<div class="ss-stat" role="listitem"><strong data-school-count="${row.value}">${row.value}</strong><span>${safe(row.label)}</span></div>`).join("")}
          </div>`
        : "";
      const heroMedia = `<div class="ss-hero__media">
          <div class="ss-hero__frame${heroImage ? "" : " ss-hero__frame--crest"}">
            ${heroImage ? `<img src="${safe(heroImage)}" alt="${safe(m.nameEn || "School")}" loading="lazy">` : `${crest}<strong>${safe(m.nameEn || "")}</strong><small>${safe(m.mottoEn || m.institutionType || "Welcome")}</small>`}
          </div>
          ${m.foundedYear ? `<div class="ss-hero__float"><strong>${safe(m.foundedYear)}</strong><small>Established</small></div>` : (stats[0] ? `<div class="ss-hero__float"><strong>${safe(stats[0].value)}</strong><small>${safe(stats[0].label)}</small></div>` : "")}
        </div>`;
      blocks.push(`<section class="ss-hero school-hero" id="home" data-layout="${safe(layout)}" style="${styleVars}">
        ${heroImage ? `<div class="ss-hero__bg school-hero-image"><img src="${safe(heroImage)}" alt="" aria-hidden="true"></div>` : ""}
        <div class="ss-hero__scrim school-hero-overlay"></div>
        <div class="ss-hero__pattern" aria-hidden="true"></div>
        <div class="ss-shell ss-hero__inner">
          <div class="ss-hero__copy">
            ${m.logoPath ? `<div class="ss-hero__badge school-logo"><img src="${safe(m.logoPath)}" alt=""><div><strong>${safe(m.nameEn || "Our school")}</strong><small>${safe(m.mottoEn || m.institutionType || "Welcome")}</small></div></div>` : ""}
            <div class="ss-hero__meta school-kicker">${heroChips || `<span class="ss-chip">${safe(m.institutionType || "School website")}</span>`}</div>
            <h1 class="ss-hero__title">${safe(m.nameEn || "Welcome to our school")}</h1>
            ${m.nameAr ? `<p class="ss-hero__ar ss-ar school-ar" lang="ar" dir="rtl">${safe(m.nameAr)}</p>` : ""}
            ${m.mottoEn ? `<p class="ss-hero__motto school-motto">${safe(m.mottoEn)}</p>` : ""}
            <p class="ss-hero__lead school-lead">${safe(m.shortDescription || m.descriptionEn || (m.tagline || "Welcome to our school."))}</p>
            <div class="ss-hero__actions school-actions">${heroActions}</div>
          </div>
          ${layout === "hero-split" ? heroMedia : ""}
        </div>
        ${layout === "hero-stats" && statsMarkup ? `<div class="ss-shell ss-hero__stats">${statsMarkup}</div>` : ""}
      </section>`);
      if (layout !== "hero-stats" && statsMarkup) {
        // hero-split and classic keep the hero clean and let the numbers sit
        // on paper just underneath it.
        blocks.push(`<section class="ss-section ss-section--tight ss-stats-band" aria-label="Key numbers"><div class="ss-shell">${statsMarkup}</div></section>`);
      }

      /* =============================== ABOUT ============================= */
      nav.push({ id: "about", label: "About" });
      const aboutBody = [m.descriptionEn || "", profile.history || "", aboutCopy.body && aboutCopy.body !== m.descriptionEn ? aboutCopy.body : ""].filter(Boolean);
      const values = [
        profile.mission ? { title: "Our mission", body: profile.mission } : null,
        profile.vision ? { title: "Our vision", body: profile.vision } : null,
        profile.coreValues ? { title: "Core values", body: profile.coreValues } : null,
        profile.philosophy ? { title: "Our philosophy", body: profile.philosophy } : null,
        info.islamicEducation ? { title: "Islamic education", body: info.islamicEducation } : null,
        info.westernEducation ? { title: "Western education", body: info.westernEducation } : null,
      ].filter(Boolean);
      const facts = [
        profile.ownershipType ? { icon: "building", label: "Ownership", value: profile.ownershipType } : null,
        profile.registrationNo ? { icon: "book", label: "Registration", value: profile.registrationNo } : null,
        profile.accreditationBody ? { icon: "shieldCheck", label: "Accreditation", value: profile.accreditationBody } : null,
        info.levelsOffered ? { icon: "graduation", label: "Levels offered", value: info.levelsOffered } : null,
        info.languages ? { icon: "languages", label: "Languages", value: info.languages } : null,
        info.studentCapacity ? { icon: "users", label: "Capacity", value: `${info.studentCapacity} students` } : null,
        info.boardingStatus ? { icon: "pin", label: "Boarding", value: info.boardingStatus } : null,
        m.currentSession ? { icon: "calendar", label: "Session", value: m.currentSession } : null,
      ].filter(Boolean);
      const headCard = profile.headName
        ? `<aside class="ss-head-card school-principal-card">
            <div class="ss-head-card__avatar">${safe(schoolInitials(profile.headName))}</div>
            <small>${safe(profile.headTitle || "Head of school")}</small>
            <h3>${safe(profile.headName)}</h3>
            ${profile.accreditationDetails ? `<p>${safe(profile.accreditationDetails)}</p>` : `<p>Meet the leadership of ${safe(m.nameEn || "our school")}.</p>`}
          </aside>`
        : `<aside class="ss-head-card school-principal-card">
            <div class="ss-head-card__avatar">${safe(schoolInitials(m.nameEn))}</div>
            <small>Our commitment</small>
            <h3>Learning with purpose. Growing with confidence.</h3>
            <p>${safe([m.city, m.state].filter(Boolean).join(", ") || "Every learner is known, guided and challenged.")}</p>
          </aside>`;
      blocks.push(`<section class="ss-section school-section school-welcome" id="about">
        <div class="ss-shell">
          <div class="ss-about school-two-col">
            <div class="school-reveal">
              <p class="ss-eyebrow section-kicker">Welcome to ${safe(m.nameEn || "our school")}</p>
              <h2 class="ss-title school-title">${safe(aboutCopy.title || "About our school")}</h2>
              <div class="ss-rule"></div>
              ${aboutBody.map((paragraph) => `<p class="ss-copy school-copy">${safe(paragraph)}</p>`).join("")}
              ${facts.length ? `<div class="ss-facts">${facts.map((fact) => `<div class="ss-fact">${icons[fact.icon] || icons.compass}<div><strong>${safe(fact.label)}</strong><small>Verified by the school</small></div><span>${safe(fact.value)}</span></div>`).join("")}</div>` : ""}
            </div>
            <div style="display:grid;gap:18px" class="school-reveal" data-school-delay="120">${headCard}</div>
          </div>
          ${values.length ? `<div class="ss-grid ss-grid--3 school-values-grid" style="margin-top:44px">${values.map((value, index) => `<article class="ss-value school-reveal" data-school-delay="${index * 70}"><h3><span>${String(index + 1).padStart(2, "0")}</span>${safe(value.title)}</h3><p>${safe(value.body)}</p></article>`).join("")}</div>` : ""}
        </div>
      </section>`);

      /* ============================= PROGRAMMES ========================== */
      if (programs.length) {
        nav.push({ id: "programs", label: "Programmes" });
        const groups = ["islamic", "western", "both"].map((track) => ({
          track,
          title: track === "islamic" ? "Islamic education" : track === "western" ? "Western education" : "Programmes for every learner",
          blurb: track === "islamic" ? "Qur'an, Arabic and Islamic sciences" : track === "western" ? "The academic curriculum, taught with care" : "Open to all our students",
          items: programs.filter((p) => (p.educationTrack || "both") === track),
        })).filter((group) => group.items.length);
        blocks.push(`<section class="ss-section ss-section--alt school-section school-section-muted" id="programs">
          <div class="ss-shell">
            <div class="ss-head school-reveal">
              <p class="ss-eyebrow section-kicker">What we offer</p>
              <h2 class="ss-title">${safe(programmesCopy.title || "Programmes & courses")}</h2>
              <div class="ss-rule"></div>
              ${programmesCopy.body ? `<p class="ss-lead">${safe(programmesCopy.body)}</p>` : `<p class="ss-lead">Every programme is taught by qualified staff and reviewed each session.</p>`}
            </div>
            <div class="ss-programs" style="margin-top:34px">
              ${groups.map((group) => `
                <div class="ss-program${group.track !== "both" ? ` ss-program--${group.track}` : ""}">
                  <div class="ss-program-head school-reveal">
                    <span>${group.track === "islamic" ? icons.book : group.track === "western" ? icons.school : icons.spark}</span>
                    <div><h3>${safe(group.title)}</h3><small>${safe(group.blurb)}</small></div>
                  </div>
                  <div class="ss-grid ss-grid--3 school-program-grid">
                    ${group.items.map((program, index) => `
                      <article class="ss-card ss-card--hover ss-program-card school-program-card${program.featured ? " ss-program-card--featured is-featured" : ""} school-reveal" data-school-delay="${index * 70}">
                        ${program.imagePath ? `<img src="${safe(program.imagePath)}" alt="" loading="lazy">` : ""}
                        <div class="ss-program-card__body">
                          <h4>${safe(program.title)}</h4>
                          <div class="ss-program-card__tags">
                            ${program.category ? `<span class="ss-tag">${safe(program.category)}</span>` : ""}
                            ${program.level ? `<span class="ss-tag ss-tag--accent">${safe(program.level)}</span>` : ""}
                            ${program.duration ? `<span class="ss-tag">${safe(program.duration)}</span>` : ""}
                          </div>
                          ${program.description ? `<p>${safe(program.description)}</p>` : ""}
                        </div>
                      </article>`).join("")}
                  </div>
                </div>`).join("")}
            </div>
            ${admissions.availablePrograms && admissions.availablePrograms.length ? `<div class="ss-pillrow" style="margin-top:30px">${admissions.availablePrograms.map((item) => `<span class="ss-pill">${icons.check}${safe(item)}</span>`).join("")}</div>` : ""}
          </div>
        </section>`);
      }

      /* ============================== TEACHERS =========================== */
      if (teachers.length) {
        nav.push({ id: "teachers", label: "Teachers" });
        blocks.push(`<section class="ss-section school-section" id="teachers">
          <div class="ss-shell">
            <div class="ss-head ss-head--center school-reveal">
              <p class="ss-eyebrow section-kicker">Meet our educators</p>
              <h2 class="ss-title">The people who teach your child</h2>
              <div class="ss-rule"></div>
              <p class="ss-lead">Only staff profiles the school approved for publication appear here — never private records.</p>
            </div>
            <div class="ss-teachers school-teacher-grid" style="margin-top:34px">
              ${teachers.map((teacher, index) => `
                <article class="ss-card ss-card--hover ss-teacher school-teacher-card school-reveal" data-school-delay="${index * 60}">
                  ${teacher.photoPath
                    ? `<img class="ss-teacher__photo" src="${safe(teacher.photoPath)}" alt="${safe(teacher.name)}" loading="lazy">`
                    : `<span class="ss-teacher__initials school-teacher-avatar">${safe(schoolInitials(teacher.name))}</span>`}
                  <div>
                    <h3>${safe(teacher.name)}</h3>
                    ${teacher.position ? `<p class="ss-teacher__role school-teacher-role">${safe(teacher.position)}</p>` : ""}
                  </div>
                  ${teacher.qualification || teacher.specialization || teacher.subjects || teacher.department ? `<div class="ss-teacher__meta">
                    ${teacher.qualification ? `<div><strong>Qualification:</strong> ${safe(teacher.qualification)}</div>` : ""}
                    ${teacher.specialization ? `<div><strong>Specialises in:</strong> ${safe(teacher.specialization)}</div>` : ""}
                    ${teacher.subjects ? `<div><strong>Subjects:</strong> ${safe(teacher.subjects)}</div>` : ""}
                    ${teacher.department ? `<div><strong>Department:</strong> ${safe(teacher.department)}</div>` : ""}
                  </div>` : ""}
                  ${teacher.biography ? `<p>${safe(teacher.biography)}</p>` : ""}
                </article>`).join("")}
            </div>
          </div>
        </section>`);
      }

      /* ============================ ACHIEVEMENTS ========================= */
      if (achievements.length) {
        nav.push({ id: "achievements", label: "Achievements" });
        blocks.push(`<section class="ss-section ss-section--alt school-section" id="achievements">
          <div class="ss-shell">
            <div class="ss-head school-reveal">
              <p class="ss-eyebrow section-kicker">Celebrating progress</p>
              <h2 class="ss-title">Achievements</h2>
              <div class="ss-rule"></div>
            </div>
            <div class="ss-achievements school-achievement-grid" style="margin-top:30px">
              ${achievements.map((item, index) => `
                <article class="ss-card ss-card--hover ss-achievement school-reveal" data-school-delay="${index * 70}">
                  ${item.imagePath ? `<img src="${safe(item.imagePath)}" alt="" loading="lazy">` : ""}
                  <div class="ss-achievement__body">
                    ${item.date ? `<small>${safe(schoolDate(item.date))}</small>` : ""}
                    <h3>${safe(item.title)}</h3>
                    ${item.description ? `<p>${safe(item.description)}</p>` : ""}
                  </div>
                </article>`).join("")}
            </div>
          </div>
        </section>`);
      }

      /* ============================= ADMISSIONS ========================== */
      nav.push({ id: "admissions", label: "Admissions" });
      const processText = admissions.process || admissionsCopy.body || "";
      const processSteps = String(processText).split(/\n+/).map((line) => line.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim()).filter(Boolean).slice(0, 6);
      const faqs = String(admissions.faqs || "").split(/\n{2,}/).map((block) => {
        const [question, ...rest] = block.split("\n");
        return { question: String(question || "").replace(/^\s*(?:Q[:.]|FAQ[:.])\s*/i, "").trim(), answer: rest.join(" ").trim() };
      }).filter((item) => item.question && item.answer).slice(0, 6);
      const applyForm = m.admissionsOpen ? `
        <form id="publicApplicationForm" class="ss-form school-form" novalidate>
          <h3>Apply online</h3>
          <p style="margin:-4px 0 8px" class="ss-form__note">Two minutes is all it takes — the school receives the application immediately.</p>
          <div class="ss-form__grid school-form-grid">
            <div class="ss-field"><label for="paFirst">Student first name <span class="req">*</span></label><input id="paFirst" name="first_name" required maxlength="100"></div>
            <div class="ss-field"><label for="paLast">Last name</label><input id="paLast" name="last_name" maxlength="100"></div>
            <div class="ss-field"><label for="paParent">Parent / guardian <span class="req">*</span></label><input id="paParent" name="parent_name" required maxlength="150"></div>
            <div class="ss-field"><label for="paPhone">Phone <span class="req">*</span></label><input id="paPhone" name="parent_phone" type="tel" required maxlength="40"></div>
            <div class="ss-field"><label for="paEmail">Email</label><input id="paEmail" name="parent_email" type="email" maxlength="150"></div>
            <div class="ss-field"><label for="paProgram">Preferred programme</label><input id="paProgram" name="program" maxlength="120" list="schoolProgramList"></div>
            ${admissions.availablePrograms && admissions.availablePrograms.length ? `<datalist id="schoolProgramList">${admissions.availablePrograms.map((item) => `<option value="${safe(item)}"></option>`).join("")}</datalist>` : ""}
            <div class="ss-field full"><label for="paMessage">Anything we should know?</label><textarea id="paMessage" name="message" rows="3"></textarea></div>
            <label class="ss-honeypot school-honeypot" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
          </div>
          <div class="ss-actions"><button class="ss-btn ss-btn--lg" type="submit">Submit application ${icons.arrow}</button></div>
          <p class="ss-form__note">You will receive a reference number to track this application. No payment is taken online.</p>
          <p id="publicApplicationOutput" class="ss-result school-form-result" aria-live="polite"></p>
        </form>` : `
        <div class="ss-form-card">
          <h3>${admissionsClosed ? "Admissions are closed" : isoDate(admissions.startDate) && todayIso < isoDate(admissions.startDate) ? "Online applications open soon" : "Start your application"}</h3>
          <p>${(() => {
            if (admissionsClosed) return `Applications for the next session will open soon.${admissions.closingDate ? ` The last cycle closed on ${safe(schoolDate(admissions.closingDate))}.` : ""}`;
            const opens = isoDate(admissions.startDate);
            const closes = isoDate(admissions.closingDate);
            if (opens && todayIso < opens) return `Online applications for ${safe(admissions.session || "the coming session")} open on ${safe(schoolDate(opens))}. Contact the admissions office for guidance in the meantime.`;
            if (closes && todayIso > closes) return `The application window closed on ${safe(schoolDate(closes))}. Contact the admissions office about late or waiting-list places.`;
            return "Contact the admissions office for guidance, requirements and important dates.";
          })()}</p>
          <div class="ss-actions">
            ${m.email ? `<a class="ss-btn" href="mailto:${safe(m.email)}">Email admissions ${icons.arrow}</a>` : ""}
            ${m.phone ? `<a class="ss-btn ss-btn--ghost" href="tel:${safe(m.phone)}">Call the school</a>` : ""}
          </div>
        </div>`;
      blocks.push(`<section class="ss-section ss-section--alt school-section school-section-muted" id="admissions">
        <div class="ss-shell">
          <div class="ss-admissions school-two-col">
            <div class="school-reveal">
              <p class="ss-eyebrow section-kicker">Join our community</p>
              <h2 class="ss-title">${safe(admissionsCopy.title || "Admissions")}</h2>
              <div class="ss-rule"></div>
              ${String(admissions.process || "").trim() ? "" : `<p class="ss-copy school-copy">${safe(admissionsCopy.body || "Begin your application with our admissions team.")}</p>`}
              <div class="ss-dates">
                ${admissions.session ? `<div class="ss-date-chip ss-admission-meta"><small>Current session</small><strong>${safe(admissions.session)}</strong></div>` : ""}
                ${admissions.startDate ? `<div class="ss-date-chip ss-admission-meta"><small>Applications open</small><strong>${safe(schoolDate(admissions.startDate))}</strong></div>` : ""}
                ${admissions.closingDate ? `<div class="ss-date-chip ss-admission-meta"><small>Applications close</small><strong>${safe(schoolDate(admissions.closingDate))}</strong></div>` : ""}
                ${admissions.applicationFee ? `<div class="ss-date-chip ss-admission-meta"><small>Application fee</small><strong>${safe(admissions.applicationFee)}</strong></div>` : ""}
              </div>
              ${processSteps.length > 1 ? `<div class="ss-steps">${processSteps.map((step, index) => `<div class="ss-step"><span>${index + 1}</span><div><strong>Step ${index + 1}</strong><p>${safe(step)}</p></div></div>`).join("")}</div>` : ""}
              ${admissions.requirements ? `<h3 class="ss-title ss-title--sm" style="margin-top:30px">What you will need</h3><p class="ss-copy school-copy">${safe(admissions.requirements)}</p>` : ""}
              ${admissions.availablePrograms && admissions.availablePrograms.length ? `<div class="ss-pillrow">${admissions.availablePrograms.map((item) => `<span class="ss-pill">${icons.check}${safe(item)}</span>`).join("")}</div>` : ""}
              ${faqs.length ? `<div class="ss-steps" style="margin-top:26px">${faqs.map((faq) => `<details class="ss-step" style="display:block"><summary style="font-weight:800;cursor:pointer">${safe(faq.question)}</summary><p>${safe(faq.answer)}</p></details>`).join("")}</div>` : ""}
            </div>
            ${m.admissionsOpen ? `<div class="ss-form-card school-reveal" id="apply" data-school-delay="120">${applyForm}</div>` : applyForm}
          </div>
        </div>
      </section>`);

      /* ============================== GALLERY ============================ */
      if (gallery.media.length) {
        nav.push({ id: "gallery", label: "Gallery" });
        const albums = gallery.albums || [];
        blocks.push(`<section class="ss-section school-section" id="gallery">
          <div class="ss-shell">
            <div class="ss-head school-reveal">
              <p class="ss-eyebrow section-kicker">Campus life</p>
              <h2 class="ss-title">Life at ${safe(m.nameEn || "our school")}</h2>
              <div class="ss-rule"></div>
              <p class="ss-lead">Classrooms, assemblies, competitions and the everyday moments that make this school what it is.</p>
            </div>
            ${albums.length ? `<div class="ss-albums" id="schoolAlbums" style="margin-top:24px">
              <button class="ss-album is-active" type="button" data-album="all">All photos <span>${gallery.media.length}</span></button>
              ${albums.map((album) => `<button class="ss-album" type="button" data-album="${safe(album.id)}">${safe(album.title)} <span>${gallery.media.filter((item) => String(item.albumId) === String(album.id)).length}</span></button>`).join("")}
            </div>` : ""}
            <div class="ss-gallery school-gallery-item" id="schoolGallery" style="margin-top:24px">
              ${gallery.media.slice(0, 12).map((item, index) => {
                const isVideo = item.type === "video" && item.videoUrl;
                return `<figure class="ss-shot school-reveal${index % 5 === 0 ? " ss-shot--wide" : ""}" data-album="${safe(item.albumId || "all")}" data-school-delay="${(index % 4) * 60}" data-media-index="${index}" ${isVideo ? `data-video="${safe(item.videoUrl)}"` : `data-src="${safe(item.path)}"`} tabindex="0" role="button" aria-label="${safe(item.caption || (isVideo ? "Play video" : "View photo"))}">
                  ${item.path ? `<img src="${safe(item.path)}" alt="${safe(item.caption || "")}" loading="lazy">` : ""}
                  ${isVideo ? `<span class="ss-shot__play">${icons.play}</span>` : ""}
                  ${item.caption ? `<figcaption>${safe(item.caption)}</figcaption>` : ""}
                </figure>`;
              }).join("")}
            </div>
          </div>
        </section>`);
      }

      /* ========================== NEWS AND EVENTS ======================== */
      if (news.length || events.length) {
        nav.push({ id: "news-events", label: "News & events" });
        blocks.push(`<section class="ss-section ss-section--alt school-section school-section-muted" id="news-events">
          <div class="ss-shell">
            <div class="ss-head school-reveal">
              <p class="ss-eyebrow section-kicker">Stay informed</p>
              <h2 class="ss-title">News &amp; events</h2>
              <div class="ss-rule"></div>
            </div>
            ${news.length ? `<div class="ss-news school-news-grid" style="margin-top:30px">
              ${news.slice(0, 6).map((item, index) => `
                <article class="ss-card ss-card--hover ss-news-card school-news-card school-reveal" data-school-delay="${index * 60}">
                  ${item.image_path ? `<img src="${safe(item.image_path)}" alt="" loading="lazy">` : ""}
                  <div class="ss-news-card__body">
                    <time>${icons.calendar}${safe(schoolDate(item.created_at))}${item.category ? ` · ${safe(item.category)}` : ""}</time>
                    <h3>${safe(item.title)}</h3>
                    <p>${safe(item.body)}</p>
                    ${item.author_name ? `<footer>By ${safe(item.author_name)}</footer>` : ""}
                  </div>
                </article>`).join("")}
            </div>` : ""}
            ${events.length ? `<div class="ss-events">
              ${events.slice(0, 6).map((event, index) => {
                const parts = schoolDateParts(event.event_date || event.created_at);
                return `<article class="ss-card ss-event school-event-card school-reveal" data-school-delay="${index * 60}">
                  ${parts ? `<div class="ss-event__date"><strong>${safe(parts.day)}</strong><span>${safe(parts.month)}</span></div>` : `<div class="ss-event__date"><strong>${icons.calendar}</strong><span>Event</span></div>`}
                  <div>
                    <h3>${safe(event.title)}</h3>
                    ${event.body ? `<p>${safe(event.body)}</p>` : ""}
                    <div class="ss-event__meta">
                      ${parts ? `<span>${icons.calendar}${safe(parts.day)} ${safe(parts.month)} ${safe(parts.year)}</span>` : ""}
                      ${event.event_location ? `<span>${icons.pin}${safe(event.event_location)}</span>` : ""}
                    </div>
                  </div>
                </article>`;
              }).join("")}
            </div>` : ""}
          </div>
        </section>`);
      }

      /* ============================ CUSTOM PAGES ========================= */
      const CORE_PAGE_SLUGS = ["home", "about-us", "programs", "teachers", "admissions", "gallery", "news", "events", "announcements", "achievements", "contact-us", "privacy", "terms", "policies"];
      const customPages = (data.sitePages || [])
        .filter((page) => page.slug && !CORE_PAGE_SLUGS.includes(String(page.slug).toLowerCase()))
        .map((page) => Object.assign({}, page, { id: `page-${String(page.slug).toLowerCase()}` }));
      customPages.forEach((page) => {
        nav.push({ id: page.id, label: page.title });
        blocks.push(`<section class="ss-section school-section" id="${safe(page.id)}">
          <div class="ss-shell">
            <div class="ss-head school-reveal">
              <p class="ss-eyebrow section-kicker">${safe(m.nameEn || "Our school")}</p>
              <h2 class="ss-title school-page-title">${safe(page.title)}</h2>
              <div class="ss-rule"></div>
              ${page.summary ? `<p class="ss-lead">${safe(page.summary)}</p>` : ""}
            </div>
            ${page.body ? `<div class="ss-page-body ss-copy school-copy" style="margin-top:22px">${safe(page.body)}</div>` : ""}
          </div>
        </section>`);
      });

      /* ========================= RESULTS CHECKING ======================== */
      if (m.canCheckResults && Number(data.publishedTermCount) > 0) {
        nav.push({ id: "results", label: "Results" });
        blocks.push(`<section class="ss-section ss-results school-section school-results" id="results">
          <div class="ss-shell ss-results__inner">
            <div class="school-reveal">
              <p class="ss-eyebrow section-kicker">Published results</p>
              <h2 class="ss-title">Check your child's results</h2>
              <div class="ss-rule"></div>
              <p class="ss-lead">Enter the admission number and either the surname or date of birth on the school record. Report cards open as printable pages and the link expires after 15 minutes.</p>
              <div class="ss-insight">
                <div><strong>${Number(data.publishedTermCount)}</strong><small>Published results</small></div>
                <div><strong>${stats.find((row) => row.label === "Students") ? stats.find((row) => row.label === "Students").value : (Number(m.students) || 0)}</strong><small>Students on record</small></div>
                <div><strong>Secure</strong><small>Verified per student</small></div>
              </div>
            </div>
            <div class="ss-form-card school-reveal" data-school-delay="120">
              <h3>Result checker</h3>
              <p>Only results the school has published are shown.</p>
              <form id="schoolResultsForm" class="ss-form" novalidate>
                <div class="ss-field"><label for="rsAdmission">Admission number <span class="req">*</span></label><input id="rsAdmission" name="admissionNo" required autocomplete="off"></div>
                <div class="ss-form__grid">
                  <div class="ss-field"><label for="rsSurname">Surname</label><input id="rsSurname" name="surname" autocomplete="off"></div>
                  <div class="ss-field"><label for="rsDob">Date of birth</label><input id="rsDob" name="dateOfBirth" type="date"></div>
                </div>
                <div class="ss-actions"><button class="ss-btn ss-btn--block" type="submit">Check results ${icons.arrow}</button></div>
                <p class="ss-form__note">Either the surname or the date of birth must match the school record.</p>
                <p id="schoolResultsOutput" class="ss-result" aria-live="polite"></p>
                <div id="schoolResultsBody"></div>
              </form>
            </div>
          </div>
        </section>`);
      }

      /* ============================ SCHOOL APP =========================== */
      nav.push({ id: "school-app", label: "School app" });
      blocks.push(`<section class="ss-section ss-app school-app-section school-section" id="school-app">
        <div class="ss-shell">
          <div class="ss-app__card school-app-card school-reveal">
            <div>
              <p class="ss-eyebrow section-kicker">Stay connected with our school</p>
              <h2 class="ss-title">Open the School App</h2>
              <div class="ss-rule"></div>
              <p class="ss-copy school-copy">Students, parents and teachers sign in to this school's workspace from any phone, tablet or computer. It runs in the browser — add it to your home screen for an app-like experience, with attendance, results, fees and messages in one place.</p>
              <ul class="ss-app__list">
                <li>${icons.check}<span>Report cards and term results</span></li>
                <li>${icons.check}<span>Attendance and timetable</span></li>
                <li>${icons.check}<span>Fee statements and announcements</span></li>
              </ul>
            </div>
            <div class="ss-app__actions school-app-actions">
              <a class="ss-btn ss-btn--lg" href="${safe(m.loginUrl || "/login")}">Open School App ${icons.arrow}</a>
              <a class="ss-btn ss-btn--ghost" href="#contact" data-school-link="contact">Contact the school</a>
            </div>
          </div>
        </div>
      </section>`);

      /* ============================== CONTACT ============================ */
      nav.push({ id: "contact", label: "Contact" });
      const contactTiles = [
        m.address ? `<div class="ss-tile"><span class="ss-tile__icon">${icons.pin}</span><div><small>Visit us</small><p>${safe(m.address)}${m.city ? `<br>${safe(m.city)}` : ""}${m.state ? `, ${safe(m.state)}` : ""}${m.country ? `<br>${safe(m.country)}` : ""}</p></div></div>` : "",
        m.phone || m.altPhone ? `<div class="ss-tile"><span class="ss-tile__icon">${icons.phone}</span><div><small>Call the school</small>${m.phone ? `<a href="tel:${safe(m.phone)}">${safe(m.phone)}</a>` : ""}${m.altPhone ? `<p>${safe(m.altPhone)}</p>` : ""}</div></div>` : "",
        m.email || m.admissionsEmail ? `<div class="ss-tile"><span class="ss-tile__icon">${icons.mail}</span><div><small>Email</small>${m.email ? `<a href="mailto:${safe(m.email)}">${safe(m.email)}</a>` : ""}${m.admissionsEmail ? `<p>Admissions: <a href="mailto:${safe(m.admissionsEmail)}">${safe(m.admissionsEmail)}</a></p>` : ""}</div></div>` : "",
        m.whatsapp ? `<div class="ss-tile"><span class="ss-tile__icon">${icons.chat}</span><div><small>WhatsApp</small><a href="https://wa.me/${safe(String(m.whatsapp).replace(/[^\d]/g, ""))}" target="_blank" rel="noopener">${safe(m.whatsapp)}</a></div></div>` : "",
        info.openingTime && info.closingTime ? `<div class="ss-tile"><span class="ss-tile__icon">${icons.clock}</span><div><small>Opening hours</small><p>${safe(info.openingTime)} – ${safe(info.closingTime)}${info.schoolDays ? `<br>${safe(info.schoolDays)}` : ""}</p></div></div>` : "",
        contact.emergency ? `<div class="ss-tile"><span class="ss-tile__icon">${icons.shieldCheck}</span><div><small>Emergency line</small><p>${safe(contact.emergency)}</p></div></div>` : "",
        classes.length ? `<div class="ss-tile"><span class="ss-tile__icon">${icons.graduation}</span><div><small>Classes on offer</small><p>${safe(classes.map((c) => c.name_en).slice(0, 8).join(" · "))}</p></div></div>` : "",
      ].filter(Boolean);
      const contactForm = contact.formEnabled !== false ? `
        <form id="schoolContactForm" class="ss-form school-form" novalidate>
          <div class="ss-form__grid school-form-grid">
            <div class="ss-field"><label for="cfName">Your name <span class="req">*</span></label><input id="cfName" name="name" required maxlength="150"></div>
            <div class="ss-field"><label for="cfEmail">Email <span class="req">*</span></label><input id="cfEmail" name="email" type="email" required maxlength="150"></div>
            <div class="ss-field"><label for="cfPhone">Phone</label><input id="cfPhone" name="phone" type="tel" maxlength="40"></div>
            <div class="ss-field"><label for="cfSubject">Subject</label><input id="cfSubject" name="subject" maxlength="150"></div>
            <div class="ss-field full"><label for="cfMessage">Message <span class="req">*</span></label><textarea id="cfMessage" name="message" required maxlength="2000"></textarea></div>
            <label class="ss-honeypot school-honeypot" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
          </div>
          <div class="ss-actions"><button class="ss-btn ss-btn--lg" type="submit">Send message ${icons.arrow}</button></div>
          <p id="schoolContactOutput" class="ss-result school-form-result" aria-live="polite"></p>
        </form>` : `<div class="ss-form-card"><h3>Contact the school directly</h3><p>Use the details beside this card — the school answers enquiries during working hours.</p>${m.phone ? `<a class="ss-btn" href="tel:${safe(m.phone)}">Call ${safe(m.phone)}</a>` : ""}</div>`;
      blocks.push(`<section class="ss-section school-section" id="contact">
        <div class="ss-shell">
          <div class="ss-contact school-two-col">
            <div class="school-reveal">
              <p class="ss-eyebrow section-kicker">Get in touch</p>
              <h2 class="ss-title">Contact ${safe(m.nameEn || "us")}</h2>
              <div class="ss-rule"></div>
              <div class="ss-contact__tiles">${contactTiles.join("")}</div>
              ${schoolSocials(contact) ? `<div class="ss-socials">${schoolSocials(contact)}</div>` : ""}
              ${m.mapsLink ? `<div class="ss-map"><strong>Find us on the map</strong><p>${safe([m.address, m.city, m.state].filter(Boolean).join(", "))}</p><a class="ss-btn ss-btn--ghost" href="${safe(m.mapsLink)}" target="_blank" rel="noopener">Open directions ${icons.arrowUp}</a></div>` : ""}
            </div>
            <div class="ss-form-card school-reveal" data-school-delay="120">
              <h3>Send a message</h3>
              <p>Questions about admissions, fees or a visit? The school replies directly.</p>
              ${contactForm}
            </div>
          </div>
        </div>
      </section>`);

      /* -------------------------------- assemble -------------------------- */
      const headerNav = nav.filter((item) => item.id !== "school-app");
      const seoTitle = `${(m.seo && m.seo.title) || (m.nameEn || "Institution")}${m.mottoEn ? ` — ${m.mottoEn}` : ""}`;
      document.title = seoTitle;
      const seoDescription = String((m.seo && m.seo.description) || m.shortDescription || m.descriptionEn || `Welcome to ${m.nameEn || "our institution"}.`).slice(0, 300);
      const setMeta = (selector, attr, value) => { const el = document.querySelector(selector); if (el) el.setAttribute(attr, value); };
      setMeta('meta[name="description"]', "content", seoDescription);
      setMeta('meta[property="og:title"]', "content", seoTitle);
      setMeta('meta[property="og:description"]', "content", seoDescription);
      setMeta('meta[property="og:image"]', "content", m.logoPath || m.heroImagePath || "/assets/edusphere-logo.png");
      setMeta('meta[property="og:site_name"]', "content", m.nameEn || "School website");
      const fav = document.querySelector('link[rel="icon"]');
      if (fav) fav.setAttribute("href", m.faviconPath || m.logoPath || "/assets/edusphere-logo.png");
      const canonical = document.querySelector('link[rel="canonical"]');
      if (canonical && data.publicWebsite && data.publicWebsite.url) canonical.setAttribute("href", data.publicWebsite.url);
      const themeColor = document.querySelector('meta[name="theme-color"]');
      if (themeColor) themeColor.setAttribute("content", theme === "dark" ? "#141122" : brand);

      app.innerHTML = `<div class="school-site-root${theme !== "light" ? " school-theme-" + theme : ""}" data-theme="${safe(theme)}" data-cards="${safe(cardStyle)}" style="${styleVars}">
        <a class="skip-link" href="#main-content">Skip to content</a>
        ${schoolHeaderMarkup(m, look, headerNav, customPages)}
        <main id="main-content" class="ss-main school-public" style="${styleVars}">
          ${schoolSubnav(headerNav)}
          ${blocks.join("")}
        </main>
        ${schoolFooterMarkup(m, look, headerNav, customPages)}
        ${schoolDrawerMarkup(m, nav, customPages)}
        <div class="ss-lightbox" id="schoolLightbox" hidden>
          <button class="ss-lightbox__btn ss-lightbox__close" type="button" id="schoolLightboxClose" aria-label="Close">${icons.close}</button>
          <div class="ss-lightbox__stage">
            <div id="schoolLightboxMedia"></div>
            <p class="ss-lightbox__caption" id="schoolLightboxCaption"></p>
          </div>
          <div class="ss-lightbox__bar">
            <button class="ss-lightbox__btn" type="button" id="schoolLightboxPrev" aria-label="Previous">${icons.chevLeft}</button>
            <span id="schoolLightboxCount"></span>
            <button class="ss-lightbox__btn" type="button" id="schoolLightboxNext" aria-label="Next">${icons.chevRight}</button>
          </div>
        </div>
        ${schoolDockMarkup(m)}
      </div>`;

      document.body.style.backgroundColor = theme === "dark" ? "#141122" : (paper || (theme === "warm" ? "#fdfaf5" : ""));
      initSchoolSite({ slug, m, contact, layout });
      initPageEvents();
    } catch (err) {
      document.body.classList.remove("school-site-active");
      const message = err && err.status === 404 ? "Institution not found" : (err.message || "This institution website is unavailable");
      app.innerHTML = `<main id="main-content" class="school-public"><div class="container school-not-found">
        <p class="section-kicker">Public website</p>
        <h1>${safe(message)}</h1>
        <p>This institution may be unpublished or the address may be incorrect.</p>
        <a href="/" data-route="/" class="ss-btn">Return to EduSphere ${icons.arrow}</a>
      </div></main>`;
      initPageEvents();
    }
  }

  /* ------------------------------------------------------------------ *
     TENANT PUBLIC WEBSITE — behaviour
     ------------------------------------------------------------------
     Everything interactive on a school website lives here: the mobile
     drawer, active-section highlighting, scroll reveals, number counters,
     the gallery lightbox and the three public forms. All of it degrades
     safely (no IntersectionObserver → content simply shows).
     ------------------------------------------------------------------ */
  function initSchoolSite(context) {
    const root = document.querySelector(".school-site-root");
    if (!root) return;
    try {
      initSchoolSiteInner(root, context);
    } catch (error) {
      /* A school website must never look broken because one interaction
         failed to bind: reveal everything and keep the page readable. */
      root.classList.remove("school-jmotion");
      root.querySelectorAll("[data-school-count]").forEach((el) => {
        if (!el.textContent || el.textContent === "0") el.textContent = el.getAttribute("data-school-count") || "0";
      });
      if (window.console && console.warn) console.warn("School website interaction failed:", error);
    }
  }

  function initSchoolSiteInner(root, context) {

    const header = root.querySelector(".ss-header");
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ---- smooth in-page navigation with a header-aware offset ---------- */
    const headerOffset = () => (header ? header.getBoundingClientRect().height + 16 : 90);
    const goToSection = (id, updateHash) => {
      const target = document.getElementById(id);
      if (!target) return;
      const top = target.getBoundingClientRect().top + window.scrollY - headerOffset();
      window.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
      if (updateHash) { try { history.replaceState(null, "", `#${id}`); } catch (e) { /* file:// */ } }
    };
    root.querySelectorAll("[data-school-link]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const id = link.getAttribute("data-school-link");
        goToSection(id, true);
        closeDrawer();
        const more = root.querySelector("#schoolMoreMenu");
        if (more) more.classList.remove("is-open");
        const moreBtn = root.querySelector("#schoolMoreBtn");
        if (moreBtn) moreBtn.setAttribute("aria-expanded", "false");
      });
    });

    /* ---- sticky header shadow ----------------------------------------- */
    const onScroll = () => {
      if (header) header.classList.toggle("is-scrolled", window.scrollY > 10);
      const toTop = root.querySelector("#schoolToTop");
      if (toTop) toTop.classList.toggle("is-visible", window.scrollY > 620);
      // Active section: the last one whose top has passed the header.
      const marks = root.querySelectorAll(".ss-section[id], .ss-hero[id]");
      const fromTop = headerOffset() + 40;
      let activeId = null;
      marks.forEach((section) => {
        if (section.getBoundingClientRect().top <= fromTop) activeId = section.id;
      });
      if (activeId) {
        root.querySelectorAll("[data-school-link]").forEach((link) => {
          if (!link.classList.contains("ss-nav__link") && !link.classList.contains("ss-subnav__link")) return;
          const isActive = link.getAttribute("data-school-link") === activeId;
          link.classList.toggle("is-active", isActive);
          if (isActive && link.classList.contains("ss-subnav__link") && link.parentElement) {
            const box = link.parentElement;
            const target = link.offsetLeft - box.clientWidth / 2 + link.clientWidth / 2;
            if (Math.abs(box.scrollLeft - target) > 40) box.scrollTo({ left: Math.max(0, target), behavior: reduced ? "auto" : "smooth" });
          }
        });
      }
    };
    let scrollTick = false;
    window.addEventListener("scroll", () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => { scrollTick = false; onScroll(); });
    }, { passive: true });
    onScroll();

    /* ---- mobile drawer ------------------------------------------------ */
    const drawer = root.querySelector("#schoolDrawer");
    const burger = root.querySelector("#schoolMenuToggle");
    function closeDrawer() {
      if (!drawer || !drawer.classList.contains("is-open")) return;
      drawer.classList.remove("is-open");
      drawer.setAttribute("hidden", "");
      document.body.classList.remove("school-nav-open");
      if (burger) burger.setAttribute("aria-expanded", "false");
    }
    if (drawer && burger) {
      burger.addEventListener("click", () => {
        drawer.removeAttribute("hidden");
        drawer.classList.add("is-open");
        document.body.classList.add("school-nav-open");
        burger.setAttribute("aria-expanded", "true");
        const first = drawer.querySelector("a, button");
        if (first) first.focus({ preventScroll: true });
      });
      const close = root.querySelector("#schoolDrawerClose");
      if (close) close.addEventListener("click", closeDrawer);
      drawer.addEventListener("click", (event) => { if (event.target === drawer) closeDrawer(); });
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });
    }

    /* ---- "More" page menu -------------------------------------------- */
    const moreBtn = root.querySelector("#schoolMoreBtn");
    const moreMenu = root.querySelector("#schoolMoreMenu");
    if (moreBtn && moreMenu) {
      moreBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = moreBtn.getAttribute("aria-expanded") === "true";
        moreBtn.setAttribute("aria-expanded", String(!open));
        moreMenu.classList.toggle("is-open", !open);
      });
      document.addEventListener("click", (event) => {
        if (!moreMenu.classList.contains("is-open")) return;
        if (moreMenu.contains(event.target) || moreBtn.contains(event.target)) return;
        moreMenu.classList.remove("is-open");
        moreBtn.setAttribute("aria-expanded", "false");
      });
    }

    /* ---- scroll reveals + stat counters ------------------------------ */
    const revealTargets = root.querySelectorAll(".school-reveal");
    const countTargets = root.querySelectorAll("[data-school-count]");
    const showAll = () => {
      revealTargets.forEach((el) => el.classList.add("is-visible"));
      countTargets.forEach((el) => { el.textContent = el.getAttribute("data-school-count"); });
    };
    if (reduced || !("IntersectionObserver" in window)) {
      showAll();
    } else {
      // Progressive enhancement: the hidden state is only applied now that
      // the observer below is certain to hand it back on scroll.
      root.classList.add("school-jmotion");
      const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        });
      }, { threshold: 0.14, rootMargin: "0px 0px -40px 0px" });
      revealTargets.forEach((el) => {
        const delay = el.getAttribute("data-school-delay");
        if (delay) el.style.setProperty("--school-delay", `${delay}ms`);
        revealObserver.observe(el);
      });
      const countObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          countObserver.unobserve(el);
          const end = Number(el.getAttribute("data-school-count")) || 0;
          if (end <= 0) { el.textContent = String(end); return; }
          const started = performance.now();
          const duration = 900;
          const tick = (now) => {
            const progress = Math.min(1, (now - started) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = String(Math.round(end * eased));
            if (progress < 1) requestAnimationFrame(tick);
          };
          el.textContent = "0";
          requestAnimationFrame(tick);
        });
      }, { threshold: 0.4 });
      countTargets.forEach((el) => countObserver.observe(el));
    }

    const toTop = root.querySelector("#schoolToTop");
    if (toTop) toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }));

    /* ---- gallery: album filter + lightbox ---------------------------- */
    const shots = Array.from(root.querySelectorAll(".ss-shot[data-media-index]"));
    const lightbox = root.querySelector("#schoolLightbox");
    let current = 0;
    const openLightbox = (index) => {
      if (!lightbox || !shots.length) return;
      current = Math.max(0, Math.min(shots.length - 1, index));
      const shot = shots[current];
      const media = lightbox.querySelector("#schoolLightboxMedia");
      const video = shot.getAttribute("data-video");
      media.innerHTML = video
        ? `<video src="${safe(video)}" controls autoplay playsinline></video>`
        : `<img src="${safe(shot.getAttribute("data-src"))}" alt="${safe(shot.getAttribute("aria-label") || "")}">`;
      lightbox.querySelector("#schoolLightboxCaption").textContent = shot.getAttribute("aria-label") || "";
      lightbox.querySelector("#schoolLightboxCount").textContent = `${current + 1} / ${shots.length}`;
      lightbox.removeAttribute("hidden");
      lightbox.classList.add("is-open");
      document.body.classList.add("school-nav-open");
    };
    const closeLightbox = () => {
      if (!lightbox) return;
      lightbox.classList.remove("is-open");
      lightbox.setAttribute("hidden", "");
      lightbox.querySelector("#schoolLightboxMedia").innerHTML = "";
      document.body.classList.remove("school-nav-open");
    };
    shots.forEach((shot, index) => {
      shot.addEventListener("click", () => openLightbox(index));
      shot.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openLightbox(index); }
      });
    });
    if (lightbox) {
      lightbox.querySelector("#schoolLightboxClose").addEventListener("click", closeLightbox);
      lightbox.addEventListener("click", (event) => { if (event.target === lightbox) closeLightbox(); });
      lightbox.querySelector("#schoolLightboxPrev").addEventListener("click", () => openLightbox(current - 1));
      lightbox.querySelector("#schoolLightboxNext").addEventListener("click", () => openLightbox(current + 1));
      document.addEventListener("keydown", (event) => {
        if (!lightbox.classList.contains("is-open")) return;
        if (event.key === "Escape") closeLightbox();
        if (event.key === "ArrowRight") openLightbox(current + 1);
        if (event.key === "ArrowLeft") openLightbox(current - 1);
      });
    }
    const albumBar = root.querySelector("#schoolAlbums");
    if (albumBar) {
      albumBar.addEventListener("click", (event) => {
        const button = event.target.closest("[data-album]");
        if (!button) return;
        const wanted = button.getAttribute("data-album");
        albumBar.querySelectorAll("[data-album]").forEach((el) => el.classList.toggle("is-active", el === button));
        shots.forEach((shot) => {
          const album = shot.getAttribute("data-album");
          const show = wanted === "all" || album === wanted;
          shot.style.display = show ? "" : "none";
        });
      });
    }

    /* ---- the three public forms -------------------------------------- */
    const setResult = (el, message, kind) => {
      if (!el) return;
      el.textContent = message;
      el.classList.toggle("is-ok", kind === "ok");
      el.classList.toggle("is-error", kind === "error");
    };
    const submitTo = async (form, path, onSuccess, extra) => {
      const button = form.querySelector('button[type="submit"]');
      const label = button ? button.textContent : "";
      if (button) { button.disabled = true; button.textContent = "Sending…"; }
      try {
        const payload = Object.assign(Object.fromEntries(new FormData(form)), extra || {});
        const result = await window.API.public.post(path, payload);
        form.reset();
        await onSuccess(result);
      } catch (error) {
        const output = form.querySelector(".ss-result");
        setResult(output, error.message || "We could not send that just now. Please try again.", "error");
      } finally {
        if (button) { button.disabled = false; button.textContent = label; }
      }
    };
    const applicationForm = root.querySelector("#publicApplicationForm");
    if (applicationForm) {
      applicationForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const output = root.querySelector("#publicApplicationOutput");
        setResult(output, "Submitting your application…", null);
        submitTo(applicationForm, `/schools/${encodeURIComponent(context.slug)}/apply`, (result) => {
          setResult(output, `Application received. Keep this reference: ${result.reference}`, "ok");
        });
      });
    }
    const contactForm = root.querySelector("#schoolContactForm");
    if (contactForm) {
      contactForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const output = root.querySelector("#schoolContactOutput");
        setResult(output, "Sending your message…", null);
        submitTo(contactForm, `/schools/${encodeURIComponent(context.slug)}/contact`, () => {
          setResult(output, "Thank you — your message has been sent to the school.", "ok");
        });
      });
    }
    /** Report-card links come back as /api/... paths; honour a custom API base. */
    const reportHref = (url) => {
      const raw = String(url || "");
      const base = (window.__APP_CONFIG__ && window.__APP_CONFIG__.apiBase) || "/api";
      return base !== "/api" && raw.startsWith("/api/") ? base + raw.slice(4) : raw;
    };
    const resultsForm = root.querySelector("#schoolResultsForm");
    if (resultsForm) {
      resultsForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const output = root.querySelector("#schoolResultsOutput");
        const body = root.querySelector("#schoolResultsBody");
        body.innerHTML = "";
        setResult(output, "Checking the school records…", null);
        submitTo(resultsForm, "/results/verify", (result) => {
          if (!result || !result.verified) { setResult(output, "No matching record was found.", "error"); return; }
          setResult(output, `Verified: ${result.student.name}${result.student.className ? ` · ${result.student.className}` : ""}`, "ok");
          const terms = result.terms || [];
          if (!terms.length) {
            body.innerHTML = `<div class="ss-result-card"><p>${safe(result.message || "No results have been published for this student yet.")}</p></div>`;
            return;
          }
          body.innerHTML = `<div class="ss-result-card">
            <h4>${safe(result.student.name)}</h4>
            <small>${safe(result.student.admissionNo || "")}${result.student.className ? ` · ${safe(result.student.className)}` : ""}</small>
            ${terms.map((term) => `
              <div class="ss-term-row">
                <div>
                  <strong>${safe(term.name_en || "Term")}</strong>
                  <span>${safe(term.session_label || "")}${term.average !== undefined && term.average !== null ? ` · Average ${safe(String(term.average))}%` : ""}${term.position ? ` · Position ${safe(String(term.position))}` : ""}</span>
                </div>
                <a class="ss-btn ss-btn--ghost" href="${safe(reportHref(term.reportUrl))}" target="_blank" rel="noopener">Open report card ${icons.arrowUp}</a>
              </div>`).join("")}
          </div>`;
        }, { madrasaSlug: context.slug });
      });
    }
  }

  /* Institution admin dashboard (Islamic + Western) — a self-contained
     module (public/js/dashboard.js) mounted into its own container so it
     never shares markup or styles with the public marketing site. */
  function renderDashboard() {
    // Already mounted: let dashboard.js's own hashchange listener handle
    // in-dashboard navigation instead of tearing the whole shell down.
    if (document.getElementById("dash-app")) return;
    document.body.classList.remove("western-experience", "western-menu-open", "islamic-experience");
    if (scrollHandler) { window.removeEventListener("scroll", scrollHandler); scrollHandler = null; }
    document.title = "EduSphere";
    document.getElementById("app").innerHTML = '<div id="dash-app"></div>';
    if (window.BelloDashboard && typeof window.BelloDashboard.boot === "function") {
      window.BelloDashboard.boot();
    }
  }

  /* Parent portal booking section (public/js/parent-ptm.js). It is a separate
     module mounted into the same #app container, exactly like the admin
     dashboard and the registration flows, so this router keeps one hook
     instead of a second application. */
  function renderParentMeetings() {
    document.body.classList.remove("western-experience", "western-menu-open", "islamic-experience");
    if (scrollHandler) { window.removeEventListener("scroll", scrollHandler); scrollHandler = null; }
    if (window.BelloParentMeetings && typeof window.BelloParentMeetings.mount === "function") {
      window.BelloParentMeetings.mount();
      return;
    }
    renderHomepage();
  }

  /* Teacher / Student / Parent portals (public/js/portal*.js). Each is a
     complete workspace that mounts into the same #app container through the
     shared portal shell — one routing hook here, not a second application. */
  function renderPortal(role) {
    // Already mounted in the same role: portal.js's own hashchange listener
    // handles in-portal navigation instead of tearing the whole shell down.
    const existing = document.getElementById("portalRoot");
    if (existing && existing.getAttribute("data-portal-role") === role) return;
    document.body.classList.remove("western-experience", "western-menu-open", "islamic-experience");
    if (scrollHandler) { window.removeEventListener("scroll", scrollHandler); scrollHandler = null; }
    if (window.BelloPortal && typeof window.BelloPortal.mount === "function") {
      window.BelloPortal.mount(role);
      return;
    }
    renderHomepage();
  }

  function renderRoute() {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    const hash = window.location.hash;

    // Leaving a school website must not leave its paper colour (or its
    // scroll-lock class) behind on the platform pages.
    document.body.classList.remove("school-site-active", "school-nav-open");
    document.body.style.backgroundColor = "";

    if (hash.startsWith("#/app") || hash === "#/login" || hash.startsWith("#/login") ||
        // The admin section has real addresses of its own — /login is the
        // unified sign-in page (it always asks for a password), /admin the
        // section itself, which falls back to the sign-in page when
        // unauthenticated. /forgot-password and /reset-password are the
        // self-service recovery pages handled by the same module.
        path === "/login" || path === "/admin" || path === "/admin/login" ||
        path === "/forgot-password" || path === "/reset-password") {
      renderDashboard();
    // Every onboarding stage is its own page (…/administrator, …/review,
    // …/submitted), so the whole subtree routes into the matching module.
    } else if (/^\/(?:schools|s|school|m)\/[^/]+(?:\/[^/]+)?$/.test(path)) {
      const schoolParts = path.split("/");
      renderSchoolPublic(decodeURIComponent(schoolParts[2]));
    // Teacher and Student portals have real addresses of their own, exactly
    // like /admin — they fall back to their own sign-in when the visitor is
    // not authenticated.
    } else if (path === "/teacher" || hash.startsWith("#/teacher/")) {
      renderPortal("teacher");
    } else if (path === "/student" || hash.startsWith("#/student/")) {
      renderPortal("student");
    // Parent portal — the family dashboard at /parent, with the meeting
    // booking flow kept as its own bookmarkable address.
    } else if (path === "/parent" || hash === "#/parent" || hash.startsWith("#/parent/")) {
      renderPortal("parent");
    } else if (path === "/parent/meetings" || hash === "#/parent/meetings") {
      renderParentMeetings();
    } else if (path === "/register-academy" || path.startsWith("/register-academy/") || hash === "#/register-academy" || hash === "#register-academy") {
      renderAcademyRegistration();
    } else if (path === "/register-madrasa" || path.startsWith("/register-madrasa/") || hash === "#/register-madrasa" || hash === "#register-madrasa") {
      renderRegistration();
    } else if (path === "/islamic-schools") {
      renderCategory("islamic");
    } else if (path === "/western-schools") {
      renderWesternAcademy();
    } else if (path === "/" && window.__APP_CONFIG__ && window.__APP_CONFIG__.schoolSlug) {
      // A configured custom domain resolves to the same tenant projection as
      // /schools/:slug, without making the public page global.
      renderSchoolPublic(window.__APP_CONFIG__.schoolSlug);
    } else {
      renderHomepage();
    }
  }

  window.BelloRouter = {
    navigate(route) {
      if (route.startsWith("/#") || route.startsWith("#")) {
        const targetId = route.replace(/^\/#|^#/, "");
        if (window.location.pathname !== "/") {
          history.pushState(null, "", "/");
          renderRoute();
        }
        requestAnimationFrame(() => {
          const target = document.getElementById(targetId);
          if (target) target.scrollIntoView({ behavior: "smooth" });
        });
        return;
      }

      const [pathname, fragment] = route.split("#");
      history.pushState(null, "", pathname || "/");
      renderRoute();
      requestAnimationFrame(() => {
        if (fragment) {
          const target = document.getElementById(fragment);
          if (target) target.scrollIntoView({ behavior: "smooth" });
        } else {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
    }
  };

  window.addEventListener("popstate", renderRoute);
  window.addEventListener("hashchange", renderRoute);
  renderRoute();

  /* Small compatibility surface kept for existing integrations. */
  window.App = {
    mount: renderRoute,
    routeTo: async (path) => window.BelloRouter.navigate("/" + String(path).replace(/^\//, "")),
    refreshMe: async () => {
      try {
        const me = await window.API.me();
        window.App.me = me && me.loggedIn ? me : null;
        return window.App.me;
      } catch (e) {
        window.App.me = null;
        return null;
      }
    },
    me: null
  };
})();
