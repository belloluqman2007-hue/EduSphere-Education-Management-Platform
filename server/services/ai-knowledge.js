"use strict";
/* ============================================================================
   EDUSPHERE AI — the curated knowledge base, per space
   ----------------------------------------------------------------------------
   Every entry belongs to exactly one SPACE (see `ai-spaces.js`):

     public      what a visitor on the website may be told
     super_admin the platform operator's console
     admin       a school administrator's dashboard
     teacher     the teacher workspace
     student     the student portal
     parent      the parent portal
     whatsapp    the WhatsApp line (short answers)
     all         true everywhere (what EduSphere is, security, languages)

   WHY THIS IS A SEPARATE FILE
   The answers ARE the product on a deployment with no model key. Keeping them
   in one reviewable place means a school is never told a price, a limit or a
   step that the code does not actually implement. Prices and tier contents are
   NOT written here — they are generated from `plan-catalogue.js` at the bottom
   of this file, so the assistant can never quote a benefit the server would
   refuse.

   Editing rules:
   • A question is the unique key inside a scope. The seeder leaves an existing
     row alone, so an operator's edits are never overwritten — but that also
     means the wording of an entry already in a database is not updated by
     changing this file. To publish new wording, add a NEW question or edit it
     in Platform → AI Assistant.
   • Never write a promise about money, discounts, timelines or data retention
     that the platform cannot keep. When in doubt, point to a screen or a human.
   ========================================================================== */
const catalogue = require("./plan-catalogue");

const SEED_KNOWLEDGE = [
  /* ======================================================================
     PUBLIC WEBSITE — registration, guides and general information
     ====================================================================== */
  {
    scope: "public", topic: "Getting started",
    keywords: "start signup register registration sign up create account institution school academy apply application enrol enroll onboarding setup",
    question: "How do I get started with EduSphere?",
    answer:
      "Getting started takes four short steps.\n\n" +
      "1. Open the registration page: an Islamic school uses /register-madrasa, a Western academy uses /register-academy.\n" +
      "2. Fill in your institution's details — name, country, state, city, full address and an official phone number. A logo, email, WhatsApp number and website are optional but help.\n" +
      "3. Create the administrator account: the full name, position, email, phone and a password of at least 6 characters. This is the login the school will use.\n" +
      "4. Review everything and submit. You receive a registration reference.\n\n" +
      "The EduSphere team reviews the application. Once it is approved, your institution is created with your administrator login and you sign in at /login with the credentials you chose.",
  },
  {
    scope: "public", topic: "Getting started",
    keywords: "register school madrasa academy sign up signup create account how to register apply application steps link",
    question: "How do I register my school?",
    answer:
      "Register online in four steps.\n\n" +
      "1. Open **/register-madrasa** for an Islamic school or madrasa, or **/register-academy** for a Western academy.\n" +
      "2. Enter your institution's details: name, country, state, city or town, full address and an official phone number. " +
      "A logo, email, WhatsApp number and website are optional.\n" +
      "3. Create the administrator account: full name, position, email, phone and a password of at least 6 characters. " +
      "This becomes the login the school uses.\n" +
      "4. Review the summary and submit. You receive a registration reference (like REG-2026-XXXXXX).\n\n" +
      "The EduSphere team reviews the application. When it is approved, the institution is created with your administrator login " +
      "and you sign in at **/login** with the details you chose. Nothing is charged at registration — you start on the Free plan. " +
      "You can check progress with the registration status checker on the same page.",
  },
  {
    scope: "public", topic: "Getting started",
    keywords: "register school madrasa academy step by step steps form how long what do i need information required",
    question: "What information do I need to register my school?",
    answer:
      "You need two sets of details.\n\n" +
      "About the institution: its name, country, state, city or town, full address and an official phone number. Email, WhatsApp, website, year founded, logo and a short description are optional.\n" +
      "About the administrator: full name, position or role at the school, email address, phone number and a password (at least 6 characters).\n\n" +
      "You will also tick the box accepting the Terms of Service and Privacy Policy. Have these ready and the form takes only a few minutes.",
  },
  {
    scope: "public", topic: "Getting started",
    keywords: "after submit application review approval approve pending how long wait status track reference",
    question: "What happens after I submit my registration?",
    answer:
      "Your application is queued for review by the EduSphere team, and you get a registration reference (it looks like REG-2026-XXXXXX).\n\n" +
      "When it is approved, the platform creates your institution together with the administrator account you described, and you can sign in at /login with the email or username and password you chose. Nothing is charged at registration — you start on the Free plan and can move up whenever you are ready.\n\n" +
      "You can check progress on the registration page's status checker with your reference and the phone number used on the form.",
  },
  {
    scope: "public", topic: "Getting started",
    keywords: "track check registration status reference where is my application pending approved",
    question: "How do I check the status of my registration?",
    answer:
      "Open the registration page you applied through and use the **View Registration Status** checker. Enter the registration reference from your confirmation and the phone number you supplied, and it will show whether the application is Pending, Approved or Rejected.\n\n" +
      "If you cannot find your reference, send us the institution name on WhatsApp or email and the team will look it up for you.",
  },
  {
    scope: "public", topic: "Getting started",
    keywords: "sign in login log in password username forgot signin dashboard",
    question: "How do I sign in after my school is approved?",
    answer:
      "Everyone signs in at the same page: /login. There is no role picker — the server reads your account's real role and takes you to the right place automatically: the platform console, your school dashboard, or the teacher, student or parent portal.\n\n" +
      "Use the email or username and password you chose at registration. If you forget the password, use **Forgot password?** on the sign-in page — a reset link is sent, and the school's administrators can also see reset requests in the dashboard.",
  },
  {
    scope: "public", topic: "Pricing",
    keywords: "price cost how much naira plan plans subscription fee pricing free trial discount yearly monthly",
    question: "How much does EduSphere cost?",
    answer:
      "EduSphere is priced in Naira and billed per institution, not per user. There are three tiers: **Free** (₦0 forever, up to 50 students and 3 teachers), **Basic** (₦8,000 per month or ₦80,000 per year, up to 300 students and 15 teachers) and **Premium** (₦20,000 per month or ₦200,000 per year, unlimited students and teachers).\n\n" +
      "Current prices, the full comparison and the yearly saving are always shown on the Plans & Pricing page and inside the dashboard under Subscription → Plans. Annual billing always costs less than paying monthly for twelve months, and nothing is charged at registration.",
  },
  {
    scope: "public", topic: "Pricing",
    keywords: "free plan free forever trial card payment pay online no money start small",
    question: "Is there a free plan?",
    answer:
      "Yes. The **Free** plan is ₦0 forever and covers up to 50 students and 3 teachers, with attendance, student and teacher records, printable report cards, announcements and community support. No card is required to start.\n\n" +
      "When you outgrow it you can request an upgrade from Subscription → Plans; your existing records are never deleted or hidden while a payment is pending.",
  },
  {
    scope: "public", topic: "Features",
    keywords: "features what does it do modules includes attendance results fees whatsapp platform capabilities",
    question: "What can EduSphere do?",
    answer:
      "EduSphere runs the whole institution in one place: students, teachers, classes, subjects, academic sessions and terms, daily attendance, a configurable results engine with printable report cards, admissions, fees and finance, expenses and budgets, payroll, staff leave, library, timetables, parent-teacher meetings, ID cards, certificates, online examinations, announcements and messaging.\n\n" +
      "It also gives every institution its own branded public website with notices, a searchable directory and an online admission form, plus dedicated **student, parent and teacher portals** — and an AI copilot for schools on Premium.",
  },
  {
    scope: "public", topic: "Portals",
    keywords: "parent portal student portal teacher portal parents students access login children results fees",
    question: "Do parents and students get their own portal?",
    answer:
      "Yes. Every institution gets three portals:\n\n" +
      "• **Student portal** — results and printable report cards, attendance, timetable, assignments, online exams, fee statement, library loans and Qur'an progress for Islamic schools.\n" +
      "• **Parent portal** — a family dashboard for every linked child, results, attendance, fees with online payment, parent-teacher meeting booking and messages to teachers.\n" +
      "• **Teacher workspace** — assigned classes, attendance, gradebook, assignments and exams.\n\n" +
      "The school creates these accounts from the student's profile under Portal access. Parents and students cannot register themselves; their school issues the login.",
  },
  {
    scope: "public", topic: "Website",
    keywords: "website own site custom domain school website publish online presence branding colours logo",
    question: "Does my school get its own website?",
    answer:
      "Yes. Each institution gets its own branded public website with its logo, colours, copy, gallery, notices, classes and programmes, an online admission form, a contact form and a share link in the form /s/your-school. You can publish or unpublish it from School → Website, and on Premium you can point a custom domain at it.\n\n" +
      "Families can also check published results and verify certificates and ID cards from the same site.",
  },
  {
    scope: "public", topic: "Admissions",
    keywords: "admission apply parent application form enrolment enroll child school place",
    question: "Can parents apply for admission online?",
    answer:
      "Yes — for institutions that switch it on. The school's own website has an **Apply** form where a family submits the child's details; the application goes straight into the school's Admissions queue with a reference number, and the family can check its status from the same page.\n\n" +
      "The school reviews each application, then approves, holds or rejects it. Approving creates the student record and, if the school chooses, the student and parent logins.",
  },
  {
    scope: "public", topic: "Results",
    keywords: "check results online parent result checker report card verify certificate",
    question: "How can parents check results online?",
    answer:
      "The school publishes each term's results when they are ready. Parents then sign in to the parent portal and open Results for the child, or print the report card. Institutions that enable public result checking also let a family verify a published result from the school's website, and every ID card and certificate carries a QR code that opens a verification page.\n\n" +
      "If a result is not visible, it has not been published yet — the school office can confirm when it will be.",
  },
  {
    scope: "public", topic: "Payments",
    keywords: "pay fees online payment paystack flutterwave transfer bank card parent",
    question: "How do parents pay school fees?",
    answer:
      "When the school has a payment provider connected, a parent signs in to the parent portal, opens **Fees → Pay online**, sees the outstanding amount per fee item and pays by card or transfer. A payment is only recorded as successful once the provider confirms it, and the receipt appears immediately.\n\n" +
      "Schools that collect fees by cash or bank transfer still record the payment in the dashboard and the receipt appears in the parent portal.",
  },
  {
    scope: "public", topic: "Support",
    keywords: "contact support help email phone whatsapp talk to human demo walkthrough sales",
    question: "How do I contact EduSphere?",
    answer:
      "You are talking to EduSphere AI right now. For a person, use **Chat on WhatsApp** on this page, or the contact email on the website, and the team will reply. Once you have a school account, **Chat & Support** inside your dashboard opens a ticket with your full history attached.\n\n" +
      "If you would like a guided walkthrough before registering, ask for a demo and leave the institution name and a phone number or email.",
  },
  {
    scope: "public", topic: "Support",
    keywords: "demo walkthrough tour see it before i buy request demo talk to sales",
    question: "Can I get a demo before registering?",
    answer:
      "Yes. Ask me for a demo and give the institution name plus a phone number or email, and the EduSphere team will arrange a walkthrough. You can also register first — the Free plan needs no card, so you can explore the real dashboard with your own data and decide afterwards.",
  },
  {
    scope: "public", topic: "Platform",
    keywords: "requirements install app download browser phone tablet works offline internet",
    question: "What do I need to use EduSphere?",
    answer:
      "Nothing to install. EduSphere runs in any modern browser on a laptop, tablet or phone, and it is built mobile-first. You need an internet connection; there is no separate desktop application.\n\n" +
      "The interface works in English, and each school can keep its own Arabic or bilingual identity on its own public website and in Arabic names and report cards.",
  },
  {
    scope: "public", topic: "Security",
    keywords: "data safe security privacy isolation other schools see my data backup gdpr",
    question: "Is my school's data private?",
    answer:
      "Yes. Every request is scoped to the signed-in account's institution on the server, so a school can never read another school's students, results, fees or staff. Passwords are hashed, sessions are server-side, uploads are validated, sign-in is rate-limited and every sensitive action is written to an audit log.\n\n" +
      "The platform takes scheduled backups, and the operator can export or restore them. Data belonging to one institution is never mixed with another's.",
  },
  {
    scope: "public", topic: "Platform",
    keywords: "language arabic english rtl bilingual translation",
    question: "Which languages does EduSphere support?",
    answer:
      "The platform interface is in international English, with an English/Arabic toggle and right-to-left layout. Every institution can store Arabic names alongside English and keep its own Arabic copy, motto and bilingual report cards. The school's public website can present either or both.",
  },
  {
    scope: "public", topic: "Platform",
    keywords: "who is it for islamic school madrasa western academy college primary secondary nursery",
    question: "Does EduSphere work for both Islamic schools and Western academies?",
    answer:
      "Yes. There are two registration paths — an Islamic school or madrasa, and a Western academy — and each gets the dashboard worded for its own context, including Qur'an progress and Arabic subjects for Islamic institutions and programmes, education levels and tracks for academies.\n\n" +
      "Both share the same core: students, staff, attendance, academics, finance, communication and portals, and both get their own public website.",
  },
  {
    scope: "public", topic: "AI",
    keywords: "ai assistant chatbot chatgpt what can you do help me",
    question: "What can EduSphere AI do?",
    answer:
      "On this website I answer questions about registering a school, the plans and prices, and how the platform works — and I can take a demo request. Inside a school account the same assistant changes: an administrator's assistant can read that school's plan, usage and invoices, while the student and parent portals get an assistant that only sees their own results, attendance and fees.\n\n" +
      "I never guess a price and I never change a record. Anything that needs a person is handed to the EduSphere team.",
  },
  {
    scope: "public", topic: "Platform",
    keywords: "export data csv excel report download my data",
    question: "Can I export my school's data?",
    answer:
      "Yes. Students, results, term summaries, attendance, fees and the admission queue all export to CSV files that open correctly in Excel, and report cards, timetables, receipts, ID cards and certificates print as real documents. The platform operator can also take a full JSON backup of the database.",
  },
  {
    scope: "public", topic: "Platform",
    keywords: "multiple campuses branches one account several schools group",
    question: "Can one organisation run several schools?",
    answer:
      "Each institution is its own tenant with its own data, staff, website and subscription, so a group that runs several schools registers each one separately and its administrators sign in to the school they belong to. A super administrator cannot be shared between schools; each school has its own administrator account.",
  },

  /* ======================================================================
     SUPER ADMIN — the platform console
     ====================================================================== */
  {
    scope: "super_admin", topic: "Console",
    keywords: "what can i do console platform super admin sections screens modules",
    question: "What can I do in the platform console?",
    answer:
      "The console is the operator's side of EduSphere. From it you can:\n\n" +
      "• **Institutions** — create, view, suspend or reinstate a school, and open its administrator account.\n" +
      "• **Registrations** — review applications from the public website and approve or reject them.\n" +
      "• **Plans** — edit the Free, Basic and Premium tiers: prices, limits and included features.\n" +
      "• **Subscriptions & payments** — see every institution's plan and state, and approve or reject payment requests.\n" +
      "• **Analytics** — platform-wide growth, plan mix, enrolment and activity.\n" +
      "• **Support tickets** — the shared queue from all institutions.\n" +
      "• **AI Assistant** — write the answers the assistant is allowed to give, per space.\n" +
      "• **Settings, activity log, backups and diagnostics** — billing details, the audit trail and storage health.\n\n" +
      "Ask me for any of those numbers and I will read them for you.",
  },
  {
    scope: "super_admin", topic: "Registrations",
    keywords: "approve registration application school pending review create institution administrator",
    question: "How do I approve a school registration?",
    answer:
      "Open **Platform Console → Registrations**, filter to *Pending*, and open the application. Check the institution details and the administrator's name and contact, then press **Approve**. The platform creates the institution, its subscription row and its first administrator account using the password the applicant chose, and links the registration to the new institution.\n\n" +
      "If something is wrong with the application, use **Reject** with a note; the note is shown to the applicant when they check their status.",
  },
  {
    scope: "super_admin", topic: "Registrations",
    keywords: "reject registration application decline note reason",
    question: "How do I reject a registration?",
    answer:
      "Open the application under **Platform Console → Registrations** and choose **Reject**, then write a short reason. The status becomes Rejected and the applicant sees the note when they check the registration reference.\n\n" +
      "Only a Pending application can be approved or rejected; an already-approved registration cannot be reversed from that screen.",
  },
  {
    scope: "super_admin", topic: "Institutions",
    keywords: "create institution school add madrasa suspend deactivate reinstate status",
    question: "How do I create, suspend or reinstate an institution?",
    answer:
      "**Create** — Platform Console → Institutions → New institution. Supply the name, category (Islamic or Western), contact details and plan, and the administrator's details; the account is created with them.\n" +
      "**Suspend or reinstate** — open the institution and change its status. A suspended institution cannot sign in, but nothing is deleted.\n\n" +
      "Institution data belongs to the school, so treat status changes carefully: the school's records remain intact and become available again when it is reinstated.",
  },
  {
    scope: "super_admin", topic: "Billing",
    keywords: "payment request invoice approve subscription money transfer receipt awaiting approval reject",
    question: "How do I approve a subscription payment?",
    answer:
      "Open **Platform Console → Subscriptions → Payment requests**. A request appears there once the institution has attached proof of payment; it carries the invoice number, plan, cycle, amount and the reference. Check that the transfer matches, then press **Approve** — this extends the subscription period and applies the plan. **Reject** asks for a reason, which the school sees on the invoice.\n\n" +
      "Approving is a money action, so it stays in your hands: neither I nor any institution can approve a payment.",
  },
  {
    scope: "super_admin", topic: "Billing",
    keywords: "billing settings bank account transfer details grace days warning percent configure",
    question: "How do I configure billing details?",
    answer:
      "**Platform Console → Settings → Billing & Payments**. There you set the bank name, account number and account name shown on every upgrade screen and invoice, the transfer instructions, the contact email and phone, the grace-period days after expiry, the usage warning percentage and the master switch for enforcement.\n\n" +
      "With the bank details blank the upgrade screen says so rather than inventing an account, so fill them in before inviting schools to upgrade.",
  },
  {
    scope: "super_admin", topic: "Plans",
    keywords: "change plan price limits features tiers free basic premium edit plan catalogue",
    question: "How do I change a plan or a price?",
    answer:
      "**Platform Console → Plans** lists the tiers. Open one to change its name, description, monthly and yearly price, student and teacher limits, trial days and which features it carries. The seed, the pricing page, the feature gate and the assistant's plan answers all read the same catalogue, so an edit takes effect everywhere on the next request.\n\n" +
      "The **Free** tier's code should not be renamed — the platform and every existing institution reference it.",
  },
  {
    scope: "super_admin", topic: "Analytics",
    keywords: "analytics stats numbers growth revenue mrr students teachers plan mix dashboard",
    question: "How do I see platform analytics?",
    answer:
      "**Platform Console → Analytics** shows tenant growth, enrolment, plan mix, fee collection and activity volume over a selectable window. The console home has the live totals: institutions (total and active), students, teachers, parent and administrator accounts, pending applications and the plan breakdown.\n\n" +
      "Ask me for a snapshot and I will read the current numbers, including the plan mix and subscription states.",
  },
  {
    scope: "super_admin", topic: "Support",
    keywords: "ticket support queue institution issue reply internal note priority",
    question: "How do I handle support tickets?",
    answer:
      "**Platform Console → Support tickets** is the shared queue. Filter by status or priority, open a ticket and reply publicly (the institution sees it) or add an internal note (it never leaves the console). You can set status, priority and assignment. Every action is audited.\n\n" +
      "Institutions raise tickets from their own **Chat & Support** page, and WhatsApp escalations can be linked to the same team.",
  },
  {
    scope: "super_admin", topic: "Operations",
    keywords: "backup restore storage diagnostics persistent disk data lost snapshot",
    question: "How do I manage backups and storage?",
    answer:
      "**Platform Console → Backups & storage** shows whether the host has a persistent disk, when the last snapshot was written, and what the next one is. The platform snapshots every table before a migration, on a timer and on graceful shutdown. From the command line, `npm run backup` can create, list, restore or import a snapshot.\n\n" +
      "If the diagnostics warn that the filesystem is ephemeral, fix the host configuration — no amount of backing up keeps a container filesystem alive across a deploy.",
  },
  {
    scope: "super_admin", topic: "Operations",
    keywords: "activity log audit who did what history",
    question: "How do I review the activity log?",
    answer:
      "**Platform Console → Activity** lists audited actions across the platform with the user, the institution, the entity and the time. It is append-only, so it is the record to check when something changed and nobody admits it.",
  },
  {
    scope: "super_admin", topic: "AI",
    keywords: "ai assistant knowledge base edit answers scope conversation review",
    question: "How do I edit what the AI assistant says?",
    answer:
      "**Platform Console → AI Assistant** lists every answer in the knowledge base, grouped by the space it applies to: the public website, the platform console, the school dashboard, the teacher workspace, the student portal, the parent portal and WhatsApp — plus answers marked *Everywhere*. Add, edit, hide or delete an entry and it applies to the next question with no deployment.\n\n" +
      "The assistant also reads live data through read-only tools, so you do not need an entry for numbers like the institution count or an invoice status.",
  },
  {
    scope: "super_admin", topic: "AI",
    keywords: "what can you do ai limits approve payment change plan assistant boundaries",
    question: "What can you do for me in the console?",
    answer:
      "I can read and explain: platform totals, the institution list, pending and awaiting-approval invoices, pending registrations, open support tickets, the plan catalogue, recent activity and how each console screen works.\n\n" +
      "I cannot approve a payment, change a plan, create or suspend an institution, or edit the knowledge base — there are no tools for those, by design. I will name the screen and you press the button. That separation is what stops a cleverly worded message from costing an institution money.",
  },
  {
    scope: "super_admin", topic: "Subscriptions",
    keywords: "subscription status active grace expired suspended meaning",
    question: "What do the subscription statuses mean?",
    answer:
      "• **active** — paid up, or never billed yet; writes are allowed.\n" +
      "• **grace** — past the end date but inside the courtesy period; writes are allowed with a banner.\n" +
      "• **expired** — past the end date and the grace period; adding new students or teachers is paused, but existing records stay fully readable.\n" +
      "• **suspended** — an operator action; the same pause on new records.\n\n" +
      "The status is derived from the dates on every check, not read from a stale column, so a subscription expires at midnight even if nobody opened the console.",
  },
  {
    scope: "super_admin", topic: "Institutions",
    keywords: "institution usage students teachers count plan expiring soon lapsed",
    question: "Which schools need my attention?",
    answer:
      "The usual order is: payment requests awaiting approval, then registrations still pending, then subscriptions that are expired, suspended or inside their last week, then institutions that have hit a student or teacher limit, then open support tickets.\n\n" +
      "Ask me to check any of those and I will read the live lists rather than guessing from memory.",
  },
  {
    scope: "super_admin", topic: "Institutions",
    keywords: "create administrator login for institution admin account password",
    question: "How do I create an administrator for an institution?",
    answer:
      "Open the institution under **Platform Console → Institutions** and use **Add administrator**. Supply the name, email or username, phone and a password; the account is created inside that institution with the administrator role.\n\n" +
      "If the administrator has lost the password, the sign-in page's **Forgot password?** flow or `npm run reset-admin-password` for the super admin account are the supported routes. Passwords are hashed and are never shown to you.",
  },

  /* ======================================================================
     INSTITUTION ADMIN — the school dashboard
     ====================================================================== */
  {
    scope: "admin", topic: "Subscription",
    keywords: "subscription plan upgrade renew expiry expire price pay invoice billing limit",
    question: "How do I upgrade or renew my subscription?",
    answer:
      "Go to **Subscription → Plans**, choose the plan and the billing cycle (monthly or yearly), and click **Upgrade**. You receive an invoice with EduSphere's bank details and a payment reference. Make the transfer, then attach a photo of your receipt on the invoice.\n\n" +
      "The EduSphere team verifies the payment and your plan is extended — usually the same day. Nothing is activated until the payment is confirmed, and your data is never deleted while a payment is pending.",
  },
  {
    scope: "admin", topic: "Limits",
    keywords: "limit reached full cannot add student teacher blocked capacity 80 percent warning",
    question: "What happens when I reach my plan limit?",
    answer:
      "You get a notification at 80% of the limit and another when you reach it. At the limit, adding new students or teachers is paused until you upgrade; everything you already have stays intact and fully readable.\n\n" +
      "Upgrading takes effect as soon as the payment is confirmed. You can see exactly how much of each limit you have used under Subscription → Plans or by asking me.",
  },
  {
    scope: "admin", topic: "Payments",
    keywords: "paid payment proof receipt transfer bank reference approved pending how long",
    question: "I have paid — how long until my plan activates?",
    answer:
      "After you upload proof of payment the request shows as **Awaiting approval**. The EduSphere team checks the transfer against the reference on your invoice and approves it, usually the same day. The plan and its limits change at that moment.\n\n" +
      "If the transfer used a different reference, reply in **Chat & Support** with the account name you paid from and they will match it manually.",
  },
  {
    scope: "admin", topic: "Getting started",
    keywords: "setup set up institution begin start first steps onboarding add classes teachers students",
    question: "How do I set up my institution?",
    answer:
      "Work in this order:\n\n" +
      "1. **My Institution** — name, logo, motto, contact details and the public website copy.\n" +
      "2. **Academics** — create the academic session and its terms, then classes and subjects.\n" +
      "3. **Teachers** — add staff accounts and assign each one their classes and subjects.\n" +
      "4. **Students** — add learners (or approve them from Admissions), then assign classes.\n" +
      "5. **Fees** — create the fee items for the term and record or collect payments.\n\n" +
      "Report cards, ID cards and portals work as soon as students and classes exist.",
  },
  {
    scope: "admin", topic: "Students",
    keywords: "add student new admission number register learner profile",
    question: "How do I add a student?",
    answer:
      "Open **Students → Add student**. Enter the name, gender, date of birth, class and guardian details; the admission number is generated automatically from your school's prefix. You can also attach a photo, documents and health notes from the student's profile.\n\n" +
      "To add many learners at once, use **Admissions** for applications, or the CSV import where available. A student can be enrolled without a portal login — the two are separate.",
  },
  {
    scope: "admin", topic: "Teachers",
    keywords: "add teacher staff account create temporary password assignments",
    question: "How do I add a teacher?",
    answer:
      "Open **Teachers → Add teacher**. Supply the name, contact details and a username; the password is optional. If you leave it blank the API generates a temporary password and shows it once — hand it to the teacher and ask them to change it. Then assign their classes and subjects from the teacher's page.\n\n" +
      "Staff who are not teachers — accountant, librarian, admissions officer, HR officer, receptionist — are teacher accounts with a permission template applied under **Settings → Roles & Permissions**.",
  },
  {
    scope: "admin", topic: "Portals",
    keywords: "portal access student login parent login username password create account link children",
    question: "How do I give a student or parent a portal login?",
    answer:
      "Open the student's profile and use the **Portal access** tab.\n\n" +
      "• **Student login** — choose a username and a password of at least 8 characters and press Create student login; the same button resets it later on the same account.\n" +
      "• **Parent login** — set a username, password, display name and phone. The new account is linked to that child immediately, and one parent account can cover several children.\n\n" +
      "You can also tick the boxes to create both logins while converting an admission application.",
  },
  {
    scope: "admin", topic: "Admissions",
    keywords: "admission application review approve hold reject convert student portal account",
    question: "How do I review and convert an admission application?",
    answer:
      "**Admissions → Applications** lists every application from your website with its reference and status. Open one to see the details, then **Approve**, **Hold** or **Reject** with a note the family can see.\n\n" +
      "Approving a place is followed by **Convert to student**, which creates the student record with the next admission number. The conversion dialog also offers to create the student and parent logins in the same step, with one shared password.",
  },
  {
    scope: "admin", topic: "Attendance",
    keywords: "attendance mark register present absent late excused correct edit today",
    question: "How do I mark or correct attendance?",
    answer:
      "Open **Attendance → Mark register**, pick the class and date, and mark each learner present, absent, late or excused. Saving writes the register for that day.\n\n" +
      "To correct an earlier day, reopen that date and change the entry — the change is audited. **Attendance → Scan & Mark** turns an ID-card scan at the gate into a register entry, and the reports screen shows daily rates and per-student history.",
  },
  {
    scope: "admin", topic: "Results",
    keywords: "results report card enter marks gradebook publish approve ca exam grade bands",
    question: "How do I enter results and publish report cards?",
    answer:
      "1. **Academics → Grading** — confirm the CA and exam maxima, the pass mark and the grade bands.\n" +
      "2. **Academics → Results → Gradebook** — enter CA and exam scores per class and subject. Results move through draft → submitted for review → approved.\n" +
      "3. **Report cards** — once the term's results are approved, compute the class summaries (totals, average, grade, position, attendance).\n" +
      "4. **Publish** — publishing is what makes a report card visible in the student and parent portals. Nothing reaches a portal before that.\n\n" +
      "Printing uses the school's own logo, colours and comments.",
  },
  {
    scope: "admin", topic: "Academics",
    keywords: "class subject session term create academic year setup",
    question: "How do I set up classes, subjects, sessions and terms?",
    answer:
      "**Academics → Sessions & terms** creates the academic year and each term inside it, marking one session as current. **Academics → Classes** creates the classes (each with English and Arabic names) and their subjects; **Academics → Subjects** keeps the school's own subject list, so nothing is hard-coded.\n\n" +
      "Class-subject links and teacher assignments determine who teaches what and which results columns exist.",
  },
  {
    scope: "admin", topic: "Fees",
    keywords: "fees fee item payment balance outstanding record cash transfer receipt reminder",
    question: "How do I record a fee payment and see balances?",
    answer:
      "Create the fee items for the term under **Fees → Fee items** (amount, class, due date). Record a payment under **Fees → Payments** by choosing the student and the fee item; the receipt is generated and appears in the parent portal.\n\n" +
      "**Fees → Balances** shows billed, paid and outstanding per student, and can send a reminder to the family. Online payments made by parents are recorded automatically once the provider confirms them.",
  },
  {
    scope: "admin", topic: "Communication",
    keywords: "announcement message parents broadcast sms email whatsapp communication send",
    question: "How do I send a message or announcement to parents?",
    answer:
      "Use **Communication → Announcements** for something the whole audience should see (everyone, staff, students and parents, or a class), or **Communication → Parent communication** to message one family or a whole audience.\n\n" +
      "In-app notifications are always delivered. Email, SMS and WhatsApp delivery activate only when the platform operator has connected a provider; every attempt is written to the delivery log, and nothing is reported as sent when it was not.",
  },
  {
    scope: "admin", topic: "PTM",
    keywords: "parent teacher meeting ptm schedule session slots book cancel",
    question: "How do I schedule a parent-teacher meeting?",
    answer:
      "Open **Communication → PTM sessions** and create a meeting day: start time, end time and slot length. The platform generates the slot grid and enrols every active teacher, each of whom can opt out until a parent books them.\n\n" +
      "Parents book from their portal at **Meetings**, choosing a child, one of that child's teachers and a free slot. Double bookings are prevented server-side. You can see the whole day as a grid, cancel a slot, print it or export it.",
  },
  {
    scope: "admin", topic: "Payroll",
    keywords: "payroll salary payslip staff pay period advance expenses budget leave",
    question: "How do I run payroll and manage staff leave?",
    answer:
      "**Payroll → Salary structures** holds each staff member's basic pay and allowances. Create a pay period, generate the payslips, review them and mark the period paid; each payslip prints as a real document.\n\n" +
      "**Staff → Leave** manages leave types, requests and balances. Staff apply from their own workspace and the administrator approves or declines; the balance updates automatically. Expenses and budgets sit under **Finance → Expenses / Budgets**.",
  },
  {
    scope: "admin", topic: "Library",
    keywords: "library book loan borrow return fine catalogue",
    question: "How do I manage the library?",
    answer:
      "**Library → Catalogue** holds the books (title, author, copies). Issue a loan to a student or staff member, set the due date, and record the return — overdue loans and fines are tracked automatically.\n\n" +
      "Students and teachers can browse and request from their own portals, and the dashboard shows active and overdue loans.",
  },
  {
    scope: "admin", topic: "Documents",
    keywords: "id card certificate design print qr verify template",
    question: "How do I design ID cards and certificates?",
    answer:
      "**Documents → ID cards** and **Certificates** each have a designer: choose the template, colours, logo and which fields appear, then issue to one person or a whole class. Every card carries a QR code that opens a verification page; a revoked card fails verification automatically.\n\n" +
      "Printing is real: the print stylesheet hides the dashboard and prints the document with the school's heading.",
  },
  {
    scope: "admin", topic: "Website",
    keywords: "website publish unpublish public page copy gallery notices custom domain share link",
    question: "How do I publish or edit my school's public website?",
    answer:
      "Open **School → Website**. There you edit the hero and page copy, contact details, gallery, achievements and programmes, and decide what the public can see — the listing, results checking and online admissions are separate switches. **Publish** makes the site live; unpublishing hides it without deleting anything.\n\n" +
      "The share link takes the form /s/your-school, and on Premium you can attach a custom domain.",
  },
  {
    scope: "admin", topic: "Analytics",
    keywords: "analytics insights dashboard trends attention risk students performance",
    question: "How do I see analytics and who needs attention?",
    answer:
      "**Analytics** shows enrolment trends, students per class, gender and age distribution, daily attendance, fee collection and method mix, grade distribution and per-class averages over a selectable window. The **needs attention** list flags students below the pass mark or with low attendance.\n\n" +
      "On Premium the AI copilot can turn that into drafted report comments, at-risk alerts with a parent message, exam questions and a plain-language summary.",
  },
  {
    scope: "admin", topic: "Permissions",
    keywords: "permissions roles staff access template accountant librarian receptionist restrict",
    question: "How do I control what my staff can see?",
    answer:
      "**Settings → Roles & Permissions** lists every staff account and the permissions it holds. Apply a template — Accountant, Librarian, Admissions Officer, Academic Officer, HR Officer or Receptionist — to grant exactly that role's permissions and revoke the teacher defaults it does not include, then fine-tune individual permissions.\n\n" +
      "Permissions are enforced on the server, not just hidden in the menu.",
  },
  {
    scope: "admin", topic: "AI",
    keywords: "ai copilot premium report comments at risk questions insights what does it do",
    question: "What is the AI copilot?",
    answer:
      "The copilot is the Premium AI layer. It can draft a report comment for every student in a class from their real marks and attendance, list at-risk students with reasons and a ready-to-send parent message, generate exam questions from your own question bank first, and summarise your analytics in plain language.\n\n" +
      "Everything it produces is a **draft** — nothing is written into a report card or sent to a parent without you. On a lower tier the button still appears with a padlock and the plan that includes it.",
  },
  {
    scope: "admin", topic: "Data",
    keywords: "backup restore export data safety lost records persistence",
    question: "How do I back up or restore my data?",
    answer:
      "The platform snapshots every table on a timer, before each migration and on graceful shutdown, and the operator can list or restore those snapshots from the console or with `npm run backup`. You can export students, results, attendance and fees to CSV at any time from the relevant screen.\n\n" +
      "If something looks missing after a deploy, it is almost always a host with a throwaway filesystem — contact the EduSphere team rather than re-entering records.",
  },
  {
    scope: "admin", topic: "Institution",
    keywords: "logo colours contact details name motto change branding profile",
    question: "How do I change my school's logo, colours or contact details?",
    answer:
      "Open **My Institution**. The profile tab holds the name, Arabic name, motto, phone, email, WhatsApp, website and address; the appearance tab holds the logo, favicon and colours used on your public website and printed documents.\n\n" +
      "Saved changes apply immediately to the dashboard, the public site and new print-outs. Existing printed documents keep what they were printed with.",
  },
  {
    scope: "admin", topic: "Exams",
    keywords: "online exam create question bank exam timetable marks release results",
    question: "How do I create an online exam?",
    answer:
      "Open **Academics → Online exams** and create the paper: subject, class, duration and the questions. Questions can be written directly or drawn from **Question Bank**, and each has a mark, type, difficulty and correct answer. Set the window, then publish it to the class.\n\n" +
      "Students take it in their portal, with autosave and a timer; you grade any subjective answers and release the results when you are ready.",
  },
  {
    scope: "admin", topic: "Finance",
    keywords: "expense budget category receipt approve report",
    question: "How do I record expenses and budgets?",
    answer:
      "**Finance → Expenses** records each expense against a category with the amount, date, payee and an optional receipt; expenses can require approval before they count. **Finance → Budgets** allocates an amount per category and period, and the reports compare budget with actual spend.\n\n" +
      "Every figure is scoped to your institution and included in the finance exports.",
  },
  {
    scope: "admin", topic: "Exports",
    keywords: "export csv excel download report spreadsheet",
    question: "How do I export data to Excel?",
    answer:
      "Most list screens have an **Export** button: students, results, term summaries, attendance, fee balances and payments, and the admission queue. The files are UTF-8 CSV with a byte-order mark and CRLF line endings, so Excel opens them cleanly, and cells are guarded against formula injection.",
  },

  /* ======================================================================
     TEACHER
     ====================================================================== */
  {
    scope: "teacher", topic: "Today",
    keywords: "today timetable next class what do i teach schedule periods",
    question: "What do I teach today?",
    answer:
      "Open **My day** in the teacher workspace: it lists today's periods with the class, subject, room and time, and highlights the next one. The same timetable is on **My week**, where you can see the whole week at a glance.\n\n" +
      "Ask me \"what do I teach today?\" and I will read your own timetable rather than a generic one.",
  },
  {
    scope: "teacher", topic: "Attendance",
    keywords: "attendance register mark present absent late which classes pending today",
    question: "How do I mark attendance?",
    answer:
      "Open **Attendance** in the teacher workspace, choose the class that is meeting, and mark each learner present, absent, late or excused. Save once — the register is written for that day.\n\n" +
      "The dashboard lists any of your classes that meet today and still have no register, so nothing is missed. If a day was marked wrongly, reopen that date and correct it; the change is audited.",
  },
  {
    scope: "teacher", topic: "Results",
    keywords: "enter results marks gradebook ca exam draft submit review pending",
    question: "How do I enter results?",
    answer:
      "Open **Results → Gradebook**, pick the class and subject you teach, and enter the CA and exam scores. The total, grade and remark are calculated from the school's grading configuration as you type.\n\n" +
      "Save as a draft while you are working, then **Submit for review**. An administrator approves or returns it; once approved and published, the result appears in the student and parent portals. You cannot publish on your own.",
  },
  {
    scope: "teacher", topic: "Results",
    keywords: "submit results review returned approved published what next status",
    question: "What do the result statuses mean?",
    answer:
      "• **Draft** — yours to edit; nobody else sees it.\n" +
      "• **Submitted** — waiting for the administrator's review; you cannot change it now.\n" +
      "• **Returned** — the administrator sent it back with a note; fix it and submit again.\n" +
      "• **Approved** — accepted; it can be included in the report cards.\n" +
      "• **Published** — visible in the portals and on printed report cards.\n\n" +
      "Only an administrator moves a result to approved or published.",
  },
  {
    scope: "teacher", topic: "Assignments",
    keywords: "assignment homework create grade submission score feedback due",
    question: "How do I create or grade an assignment?",
    answer:
      "Open **Class work → Assignments → New assignment**: choose the class and subject, write the instructions, set the due date and attach a file if needed, then publish it. Students see it in their portal and can submit until it is graded.\n\n" +
      "Open an assignment to see every submission, download the file, enter a score and feedback, and mark it graded. Ungraded submissions are listed on your dashboard so nothing is forgotten.",
  },
  {
    scope: "teacher", topic: "Exams",
    keywords: "online exam question bank create paper duration publish attempts grade release",
    question: "How do I set up an online exam?",
    answer:
      "Open **Examinations → Online exams → New paper**. Set the subject, class and duration, add questions (typed or picked from **Question Bank**) with marks and the correct answer, then publish it to the class.\n\n" +
      "Students take it in their portal with a timer and autosave. Multiple-choice questions are marked automatically; you grade subjective answers and release the results when ready.",
  },
  {
    scope: "teacher", topic: "Leave",
    keywords: "leave apply request balance approve staff absence",
    question: "How do I apply for leave?",
    answer:
      "Open **Leave → New request** in the teacher workspace: choose the leave type, the dates and a reason, and submit. It goes to the administrator, who approves or declines, and your balance updates when it is approved.\n\n" +
      "You can see your remaining days per leave type on the same page. I cannot approve leave or submit the request for you.",
  },
  {
    scope: "teacher", topic: "Library",
    keywords: "library book borrow loan return due fines",
    question: "How do I borrow a book from the library?",
    answer:
      "Open **Library** in your workspace to browse the catalogue and request a title. The librarian issues the loan with a due date; you can see your active loans and their due dates, and a fine is recorded automatically if a book comes back late.",
  },
  {
    scope: "teacher", topic: "Messages",
    keywords: "message parent admin contact communicate inbox",
    question: "How do I message a parent or the administrator?",
    answer:
      "Open **Messages** and start a conversation with a colleague or a parent you are allowed to contact, or reply to one you already have. Notifications for announcements and approvals arrive in the bell menu.\n\n" +
      "For something that needs a decision — a timetable change, a payment query, a family issue — message the school office; they hold the record.",
  },
  {
    scope: "teacher", topic: "Access",
    keywords: "cannot see class missing class assignment permission not assigned why",
    question: "Why can't I see a class?",
    answer:
      "You only see the classes and subjects assigned to you by the school administrator. If a class is missing, the assignment is missing too — ask the administrator to add you to it under **Teachers → your profile → Teaching assignments**.\n\n" +
      "From this workspace you can never open another teacher's class or another class's marks, and the server enforces that, not just the menu.",
  },
  {
    scope: "teacher", topic: "AI",
    keywords: "what can you do ai assistant help teacher workspace",
    question: "What can you do for me here?",
    answer:
      "I can read your own timetable, the classes that still need attendance today, your ungraded submissions and your result workflow counts, and I can explain how any teacher screen works.\n\n" +
      "I cannot mark attendance, enter or submit marks, grade a submission or approve leave — those stay with you (and, for approval, with your administrator).",
  },
  {
    scope: "teacher", topic: "Announcements",
    keywords: "announcement news calendar event school notice",
    question: "Where do I see announcements and school events?",
    answer:
      "Your dashboard shows the latest announcements and the school calendar. **Announcements** in the sidebar keeps the full list, and **Calendar** shows holidays, exam weeks, meetings and events targeted at staff.",
  },

  /* ======================================================================
     STUDENT
     ====================================================================== */
  {
    scope: "student", topic: "Results",
    keywords: "results last result marks grades report card average position term",
    question: "What were my last results?",
    answer:
      "Open **Results** in your portal to see every published term with your average, grade and position. Choose a term to see each subject's CA, exam, total, percentage and grade, and print the report card from the same page.\n\n" +
      "Ask me and I will read your latest published term. A term that has not been published by the school will not appear yet.",
  },
  {
    scope: "student", topic: "Results",
    keywords: "report card print download pdf result not showing missing why",
    question: "How do I see or print my report card?",
    answer:
      "Open **Results**, choose the term and press **Report card**. It opens a printable version with the school's logo and your photo, marks, grade, position and attendance, ready to print or save as PDF.\n\n" +
      "If a term is missing it has not been published yet. Only the school can publish results — ask your class teacher.",
  },
  {
    scope: "student", topic: "Attendance",
    keywords: "attendance present absent late record percentage how many days",
    question: "What is my attendance?",
    answer:
      "Open **Attendance** in your portal to see the register day by day — present, absent, late or excused — with your attendance percentage for the term.\n\n" +
      "Ask me and I will give you the totals. If a day is wrong, tell your class teacher; only the school can correct a register.",
  },
  {
    scope: "student", topic: "Fees",
    keywords: "fees balance owe outstanding amount due receipt payment statement",
    question: "How much school fees do I still owe?",
    answer:
      "Open **Fees** in your portal: it lists each fee item with the amount due, what has been paid, what is outstanding and the next due date, and every receipt you have.\n\n" +
      "Ask me and I will read the balance on your record. Payments are recorded by the school office — if you have paid and it is not showing, take the receipt to them.",
  },
  {
    scope: "student", topic: "Fees",
    keywords: "receipt proof payment paid print",
    question: "How do I get a fee receipt?",
    answer:
      "Open **Fees**, find the payment in the receipts list and press **Print**. The receipt carries the school's name, the amount, the date and the reference, and it prints as a real document.\n\n" +
      "If a payment is missing, the school office can check the record and add it.",
  },
  {
    scope: "student", topic: "Timetable",
    keywords: "timetable today classes periods my week schedule subject room",
    question: "What is my timetable today?",
    answer:
      "Your dashboard shows today's periods with the subject, teacher, room and time, and **Timetable → My week** shows the whole week.\n\n" +
      "Ask me \"what is my timetable today?\" and I will read your class's own timetable.",
  },
  {
    scope: "student", topic: "Assignments",
    keywords: "assignment homework due submit submission pending resubmit",
    question: "What assignments are due?",
    answer:
      "Open **Assignments** to see the published work for your class, with due dates and your submission state. Open one to download the brief and submit your work; if it comes back ungraded you can resubmit, and once it is graded you can read the score and feedback.\n\n" +
      "The dashboard lists what is still pending. Ask me and I will read it for you.",
  },
  {
    scope: "student", topic: "Assignments",
    keywords: "submit assignment upload file attachment how to turn in",
    question: "How do I submit an assignment?",
    answer:
      "Open the assignment and press **Submit**, then attach your file (or type your answer where that is allowed) and confirm. The status changes to submitted, and you can replace it until the teacher grades it.\n\n" +
      "A late submission is still accepted unless the teacher has closed the work; the due date is shown on the assignment.",
  },
  {
    scope: "student", topic: "Exams",
    keywords: "online exam take start timer submit review marks release",
    question: "How do I take an online exam?",
    answer:
      "Open **Online exams**, choose a paper that is open to your class and press **Start**. The timer begins immediately, answers autosave, and the question navigator shows what you have answered. Press **Submit** and confirm before the time runs out.\n\n" +
      "Once the school releases the results you can open the paper again to review your marked answers.",
  },
  {
    scope: "student", topic: "Exams",
    keywords: "upcoming exams exam timetable when is my exam date time hall",
    question: "What exams are coming up?",
    answer:
      "Open **Exams** to see the exam timetable for your class: subject, date, start and end time and the hall or room. Your dashboard highlights the next ones.\n\n" +
      "Ask me and I will read the upcoming exams for your class.",
  },
  {
    scope: "student", topic: "Library",
    keywords: "library book borrow loan return due fine",
    question: "How do I borrow a library book?",
    answer:
      "Open **Library** to browse the catalogue and request a title. The librarian issues the loan and sets the due date; your active loans and any overdue fines appear on the same page.\n\n" +
      "Return the book to the library before the due date to avoid a fine.",
  },
  {
    scope: "student", topic: "Qur'an",
    keywords: "quran qur'an surah memorisation hifz progress islamic",
    question: "What is my Qur'an progress?",
    answer:
      "If your school is an Islamic institution, **Qur'an progress** in your portal shows the surahs and portions recorded for you, with your teacher's notes and the date of each entry.\n\n" +
      "Ask me and I will read your latest entries. Only your teacher can add or change a progress record.",
  },
  {
    scope: "student", topic: "Messages",
    keywords: "message teacher admin contact ask question inbox",
    question: "How do I message my teacher?",
    answer:
      "Open **Messages** and start a conversation with a teacher or administrator, or reply to one you already have. Announcements and notifications arrive in the bell menu.\n\n" +
      "Use Messages for a question about your work; for anything about fees, attendance or your records, the school office is the right place.",
  },
  {
    scope: "student", topic: "Account",
    keywords: "password change account login security sign out",
    question: "How do I change my password?",
    answer:
      "Open **Account** in your portal and choose **Change password**. Enter your current password and the new one twice. Your other sessions are signed out after the change.\n\n" +
      "If you cannot sign in at all, use **Forgot password?** on the sign-in page, or ask the school office — your school created your login and can reset it.",
  },
  {
    scope: "student", topic: "AI",
    keywords: "what can you do ai assistant help portal",
    question: "What can you do for me here?",
    answer:
      "I can read your own record — your class, latest published results, attendance, fee balance, timetable, pending assignments, upcoming exams and library loans — and explain how any page in your portal works.\n\n" +
      "I cannot change a mark, add an attendance day, record a payment or submit your assignment, and I will never show another student's information.",
  },
  {
    scope: "student", topic: "Results",
    keywords: "result not published hidden cannot see why teacher",
    question: "Why can't I see my result?",
    answer:
      "Results appear in your portal only after the school has approved and **published** that term. If the term has not been published yet, nothing is wrong with your account.\n\n" +
      "Ask your class teacher when the results will be released. I will never guess or calculate a mark.",
  },
  {
    scope: "student", topic: "Announcements",
    keywords: "announcement notice news calendar event holiday",
    question: "Where do I see announcements?",
    answer:
      "Your dashboard shows the latest announcements and upcoming events, and **Announcements** in the sidebar keeps the full list. Anything targeted at your class or at students appears there.",
  },

  /* ======================================================================
     PARENT
     ====================================================================== */
  {
    scope: "parent", topic: "Children",
    keywords: "children how are they doing progress overview family dashboard child",
    question: "How are my children doing?",
    answer:
      "Your dashboard shows every child linked to your account with their class, latest published result, attendance percentage, fee balance and what is due next. Use the child switcher on any page to look at one child in detail.\n\n" +
      "Ask me about a child and I will read their own record — results, attendance and fees.",
  },
  {
    scope: "parent", topic: "Results",
    keywords: "results report card marks grades position term print child",
    question: "How do I see my child's results?",
    answer:
      "Open **Results**, choose the child and the term, and you will see each subject's CA, exam, total, percentage and grade, plus the average and position. **Report card** opens the printable version.\n\n" +
      "Only published terms appear. If a term is missing, the school has not released it yet.",
  },
  {
    scope: "parent", topic: "Attendance",
    keywords: "attendance absent late present percentage child school days",
    question: "How do I check my child's attendance?",
    answer:
      "Open **Attendance**, choose the child and the date range: it lists each day's status — present, absent, late or excused — and the attendance percentage for the term.\n\n" +
      "If a day looks wrong, contact the school office; only the school can change a register.",
  },
  {
    scope: "parent", topic: "Fees",
    keywords: "fees balance owe outstanding amount due child statement",
    question: "How much school fees do I owe?",
    answer:
      "Open **Fees** and choose the child: it lists each fee item, the amount due, what has already been paid, the outstanding balance and the next due date, with every receipt.\n\n" +
      "Ask me and I will read the balance on your children's records.",
  },
  {
    scope: "parent", topic: "Fees",
    keywords: "pay online payment card transfer paystack flutterwave receipt how to pay",
    question: "How do I pay school fees online?",
    answer:
      "Open **Fees → Pay online**, choose the child and the fee item, and pay by card or transfer through the school's payment provider. When the provider confirms the payment it is recorded automatically and the receipt appears in your portal.\n\n" +
      "If the school collects fees by cash or bank transfer instead, the office records it and the receipt appears here. A payment is never marked successful just because a page was opened.",
  },
  {
    scope: "parent", topic: "Fees",
    keywords: "receipt proof print paid payment history",
    question: "How do I get a receipt for a payment?",
    answer:
      "Open **Fees** and find the payment under receipts, then press **Print**. The receipt shows the school, the child, the amount, the date and the reference.\n\n" +
      "If a payment you made is missing, take the proof to the school office and they will record it.",
  },
  {
    scope: "parent", topic: "PTM",
    keywords: "parent teacher meeting ptm book slot appointment cancel reschedule",
    question: "How do I book a parent-teacher meeting?",
    answer:
      "Open **Meetings** in the parent portal, choose the child, choose one of that child's teachers and pick a free slot. You get an immediate confirmation with the date, time and location, and the teacher is notified.\n\n" +
      "Double booking is prevented — a teacher and a parent cannot be in two places at once, and the same meeting cannot be made twice. If you need to change it, cancel from the same page and choose another free slot.",
  },
  {
    scope: "parent", topic: "Timetable",
    keywords: "timetable exams schedule week child classes",
    question: "How do I see my child's timetable or exams?",
    answer:
      "Open **Timetable** for the weekly grid, or **Exams** for the exam timetable of the selected child, showing subject, date, time and venue. The child switcher changes whose timetable you are looking at.\n\n" +
      "The dashboard also shows what is coming up for each child.",
  },
  {
    scope: "parent", topic: "Assignments",
    keywords: "assignments homework due pending submitted child",
    question: "What assignments are due?",
    answer:
      "Open **Assignments** and choose the child to see the published work for their class, the due dates and whether it has been submitted or graded.\n\n" +
      "I can read the pending list for a child; submitting the work is done by the student in their own portal.",
  },
  {
    scope: "parent", topic: "Children",
    keywords: "link another child add child account sibling missing child not showing",
    question: "How do I link another child to my account?",
    answer:
      "A parent account can cover several children, but the link is created by the school — usually on the student's profile under **Portal access → Create a parent login**, where several children can be selected for one account.\n\n" +
      "If a child is missing from your dashboard, contact the school office with the child's name and admission number. For privacy I cannot see or confirm a child who is not already linked to you.",
  },
  {
    scope: "parent", topic: "Messages",
    keywords: "message teacher school contact communicate question",
    question: "How do I message my child's teacher?",
    answer:
      "Open **Messages** and start a conversation with one of your children's teachers or the school office, or reply to an existing thread. Announcements and notifications arrive in the bell menu.\n\n" +
      "For fees, records or anything private, the school office is the right contact.",
  },
  {
    scope: "parent", topic: "AI",
    keywords: "what can you do ai assistant help parent portal",
    question: "What can you do for me here?",
    answer:
      "I can read the children linked to your account — their latest published results, attendance, fee balance, upcoming exams and meeting bookings — and explain how any page in the parent portal works.\n\n" +
      "I cannot change a record, book or cancel a meeting, or see another family's child. Those stay with the school office and with you.",
  },
  {
    scope: "parent", topic: "Results",
    keywords: "result not showing missing why not published",
    question: "Why can't I see my child's result?",
    answer:
      "A term appears only after the school approves and **publishes** it. If it is not there, the results have not been released yet — nothing is wrong with your account.\n\n" +
      "Ask the class teacher or the school office when the term will be published. I will not guess a mark.",
  },
  {
    scope: "parent", topic: "Account",
    keywords: "password change account login sign in forgot",
    question: "How do I change my password?",
    answer:
      "Open **Account** in the parent portal and choose **Change password**; enter the current password and the new one twice. Your other sessions are signed out afterwards.\n\n" +
      "If you cannot sign in, use **Forgot password?** on the sign-in page, or ask the school office — they created your login and can reset it.",
  },
  {
    scope: "parent", topic: "Qur'an",
    keywords: "quran qur'an surah memorisation hifz progress islamic child",
    question: "How do I see my child's Qur'an progress?",
    answer:
      "For Islamic institutions, open **Qur'an progress** and choose the child. It shows each recorded surah or portion with the teacher's note and the date.\n\n" +
      "Only the child's teacher can add or change a record; ask them if something needs updating.",
  },

  /* ======================================================================
     WHATSAPP — short answers
     ====================================================================== */
  {
    scope: "whatsapp", topic: "Support",
    keywords: "human agent person talk someone help support escalate real",
    question: "Can I speak to a human?",
    answer:
      "Yes. Reply *human* or *agent* and this conversation — including everything you have already told me — is handed to the EduSphere team, who will continue right here.",
  },
  {
    scope: "whatsapp", topic: "Registration",
    keywords: "register school madrasa academy sign up start application",
    question: "How do I register my school?",
    answer:
      "Register on our website: *edusphere* → Register. An Islamic school uses /register-madrasa, a Western academy uses /register-academy. You will enter the school's details and the administrator's name, email, phone and password, then submit. Our team reviews it, and once approved you sign in at /login with the details you chose.",
  },
  {
    scope: "whatsapp", topic: "Pricing",
    keywords: "price cost how much naira plans free basic premium",
    question: "How much does EduSphere cost?",
    answer:
      "There is a *Free* plan (up to 50 students and 3 teachers), then *Basic* and *Premium* with higher limits and more features. Prices are in Naira and shown on the Plans page of our website. Reply *plans* and I will send the current tiers.",
  },
  {
    scope: "whatsapp", topic: "Features",
    keywords: "what does it do features modules platform",
    question: "What does EduSphere do?",
    answer:
      "It runs a whole school in one place — students, staff, classes, attendance, results and report cards, fees, payroll, library, timetables, messaging — plus a website for your school and portals for students, parents and teachers.",
  },
  {
    scope: "whatsapp", topic: "Demo",
    keywords: "demo walkthrough tour see show me sales",
    question: "I want a demo",
    answer:
      "Happy to arrange one. Send the school name, a contact name and a phone number or email, and our team will reach out to schedule a walkthrough. Or reply *human* and I will hand you over now.",
  },
  {
    scope: "whatsapp", topic: "Login",
    keywords: "login sign in password username access portal",
    question: "Where do I sign in?",
    answer:
      "Everyone signs in at the same /login page with the username or email and password the school gave them. Parents and students get their login from the school office, not from us.",
  },
  {
    scope: "whatsapp", topic: "Pricing",
    keywords: "free plan trial free forever no card",
    question: "Do you have a free plan?",
    answer:
      "Yes — *Free*, up to 50 students and 3 teachers, no card needed. You can start there and upgrade later from your dashboard without losing anything.",
  },

  /* ======================================================================
     EVERYWHERE
     ====================================================================== */
  {
    scope: "all", topic: "About",
    keywords: "what is edusphere platform about company",
    question: "What is EduSphere?",
    answer:
      "EduSphere is an education management platform for schools and academies. One account runs students, staff, classes, attendance, academics and report cards, admissions, fees and finance, payroll, library, timetables and communication — and gives every institution its own branded public website plus student, parent and teacher portals.",
  },
  {
    scope: "all", topic: "Accounts",
    keywords: "account types roles super admin madrasa admin teacher student parent five roles who signs in",
    question: "What account types does EduSphere have?",
    answer:
      "There are five roles: **Super Admin** (the platform operator), **Madrasa Admin** (a school's administrator), **Teacher**, **Student** and **Parent**. Everyone signs in at the same /login page and the server routes each person to their own workspace.\n\n" +
      "Staff such as an accountant, librarian or receptionist are teacher accounts with a permission template applied — they are not separate roles.",
  },
  {
    scope: "all", topic: "Security",
    keywords: "data safe security privacy isolation tenant backup passwords",
    question: "Is my data safe?",
    answer:
      "Yes. Every request is scoped server-side to the signed-in account's institution, so one school can never read another's records. Passwords are hashed, sessions are server-side, sign-in is rate-limited, uploads are validated and sensitive actions are audited. The platform takes scheduled backups.",
  },
  {
    scope: "all", topic: "Platform",
    keywords: "language arabic english rtl bilingual",
    question: "Does EduSphere support Arabic?",
    answer:
      "Yes. The interface has an English/Arabic toggle with right-to-left layout, every record can hold Arabic as well as English names, and each school can keep its own Arabic copy, motto and bilingual report cards.",
  },
  {
    scope: "all", topic: "Platform",
    keywords: "phone mobile tablet app browser install offline",
    question: "Does EduSphere work on a phone?",
    answer:
      "Yes. It is built mobile-first and runs in any modern browser on a phone, tablet or laptop — nothing to install. An internet connection is required.",
  },
  {
    scope: "all", topic: "Support",
    keywords: "help support contact question stuck",
    question: "How do I get help?",
    answer:
      "Ask me first — I answer from the platform's own help content. If you need a person, use **Chat & Support** in your dashboard (EduSphere team), the school's WhatsApp line for school matters, or **Chat on WhatsApp** on the public website.",
  },
];

/* ------------------------- the three tier offers ------------------------- */
/* Written from the SAME catalogue the seed, the feature gates and the pricing
   page use, so the assistant can never quote a benefit the server would
   refuse. Regenerated on every boot: if the operator changes a plan's copy the
   answers follow, and an answer the operator wrote themselves is never
   touched (matching is on scope + question). */
function tierKnowledge() {
  const out = [];
  for (const code of catalogue.TIER_ORDER) {
    const tier = catalogue.TIERS[code];
    const keys = catalogue.tierFeatureKeys(code);
    const included = keys.map((k) => catalogue.FEATURES[k].label);
    out.push({
      scope: "public",
      topic: "Plans",
      keywords: `${code} plan tier ${tier.name.toLowerCase()} include includes features benefits what do i get`,
      question: `What is included in the ${tier.name} plan?`,
      answer: `${tier.name} — "${tier.tagline}". ${tier.promise} It includes ${included.join(", ")}. ` +
        `Quick win: ${tier.quick_win} Current prices, student/teacher limits and the full comparison are on the Plans & Pricing page.`,
    });
  }
  const free = catalogue.TIERS.free;
  const basic = catalogue.TIERS.basic;
  const premium = catalogue.TIERS.premium;
  const onlyIn = (code, below) => catalogue.tierFeatureKeys(code)
    .filter((k) => !catalogue.tierFeatureKeys(below).includes(k))
    .map((k) => catalogue.FEATURES[k].label);
  out.push({
    scope: "public",
    topic: "Plans",
    keywords: "difference between plans compare free basic premium which plan should i choose upgrade worth it",
    question: "What is the difference between the Free, Basic and Premium plans?",
    answer:
      `Free — "${free.tagline}": ${free.limits_copy.students}, ${free.limits_copy.teachers}, ` +
      `${onlyIn("free", "").slice(0, 6).join(", ")}. ${free.quick_win}\n` +
      `Basic — "${basic.tagline}": ${basic.limits_copy.students}, ${basic.limits_copy.teachers}, and it adds ` +
      `${onlyIn("basic", "free").join(", ")}. ${basic.quick_win}\n` +
      `Premium — "${premium.tagline}": ${premium.limits_copy.students} and ${premium.limits_copy.teachers.toLowerCase()}, and it adds ` +
      `${onlyIn("premium", "basic").join(", ")}. ${premium.quick_win}\n` +
      `Prices and the year-by-year saving are on the Plans & Pricing page; upgrading takes effect as soon as your payment is confirmed.`,
  });
  out.push({
    scope: "admin",
    topic: "Plans",
    keywords: "feature locked not included upgrade which plan do i need premium basic gated",
    question: "A feature says it is not included in my plan. What do I do?",
    answer:
      "That message names the plan that includes the feature. Open Subscription → Plans to see exactly what each tier gets and what it costs, then choose the plan and click Upgrade: you will get an invoice with our bank details and a payment reference. Attach your receipt and the team confirms it — usually the same day. Nothing you already have is ever removed while a payment is pending, and your administrator can also ask EduSphere AI to create the upgrade request.",
  });
  out.push({
    scope: "whatsapp",
    topic: "Plans",
    keywords: "plans tiers free basic premium difference which plan",
    question: "What plans do you have?",
    answer:
      "*Free* — 50 students, 3 teachers, attendance and report cards.\n*Basic* — 300 students, 15 teachers, plus fees, portals, messaging and library.\n*Premium* — unlimited students and teachers, plus the AI copilot, online exams, payroll and branding.\nPrices in Naira are on the Plans page of our website.",
  });
  return out;
}

module.exports = { SEED_KNOWLEDGE, tierKnowledge };
