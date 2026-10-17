"use strict";
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, clampNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { requirePermission, requireStaffPermission } = require("../services/permissions");
const { effectiveTenantId } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const { imageUploader } = require("../middleware/upload");
const csv = require("../services/csv");

const router = express.Router();
router.use(requireAuth, requireTenant);
// Library & loans are included from Basic upwards.
router.use(requireFeature("library"));
const STAFF = requireRole("madrasa_admin", "teacher");
const ADMIN = requireRole("madrasa_admin");
const TYPES = new Set(["student", "teacher"]);
function tenantId(req, res) { const id = effectiveTenantId(req); if (!id) { err(res, 400, "Madrasa context required."); return null; } return id; }
function iso(v) { return validDate(v) || null; }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function overdueDays(due, asOf = today()) { return due && due < asOf ? Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(due)) / 86400000)) : 0; }
async function setting(tid, key, fallback) { const row = await db.get("SELECT value FROM settings WHERE madrasa_id=? AND key_name=?", [tid, key]); const value = row && Number(row.value); return Number.isFinite(value) && value >= 0 ? value : fallback; }
async function subjectExists(tid, id) { return !id || !!(await db.get("SELECT id FROM subjects WHERE id=? AND madrasa_id=?", [id, tid])); }
async function borrower(tid, userId, type) {
  if (!TYPES.has(type)) return null;
  return db.get(`SELECT u.id,u.role,u.full_name,u.email,u.phone,u.student_id FROM users u WHERE u.id=? AND u.madrasa_id=? AND u.is_active=1 AND u.role=?`, [userId, tid, type]);
}
const bookSelect = `SELECT b.*,s.name_en AS subject_name FROM library_books b LEFT JOIN subjects s ON s.id=b.subject_id AND s.madrasa_id=b.madrasa_id`;

router.get("/books", STAFF,requireStaffPermission("library.view"), asyncHandler(async (req, res) => {
  const tid=tenantId(req,res); if(!tid)return; const where=["b.madrasa_id=?","b.is_archived=0"], p=[tid];
  if(req.query.search){const q=`%${cleanStr(req.query.search,120).toLowerCase()}%`;where.push("(LOWER(b.title) LIKE ? OR LOWER(b.author) LIKE ? OR LOWER(b.isbn) LIKE ?)");p.push(q,q,q);}
  if(req.query.category){where.push("b.category=?");p.push(cleanStr(req.query.category,100));}
  if(req.query.subjectId){where.push("b.subject_id=?");p.push(toNum(req.query.subjectId,0));}
  if(["available","1","true"].includes(String(req.query.availability))){where.push("b.available_copies>0");}
  const books=await db.all(`${bookSelect} WHERE ${where.join(" AND ")} ORDER BY b.title,b.id`,p); ok(res,{books});
}));
router.post("/books", requirePermission("library.manage"), asyncHandler(async(req,res)=>{
  const tid=tenantId(req,res);if(!tid)return;const b=req.body||{},title=cleanStr(b.title,240),subjectId=b.subject_id?toNum(b.subject_id,0):null,total=Math.floor(clampNum(b.total_copies,0,100000,1));
  if(!title)return err(res,400,"Title is required.");if(!(await subjectExists(tid,subjectId)))return err(res,400,"Unknown subject.");
  const r=await db.run("INSERT INTO library_books (madrasa_id,title,author,isbn,publisher,year,subject_id,category,language,total_copies,available_copies,description,edition,shelf_location,barcode,replacement_cost_ngn,acquisition_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[tid,title,cleanStr(b.author,180),cleanStr(b.isbn,40),cleanStr(b.publisher,160),b.year?toNum(b.year,0):null,subjectId,cleanStr(b.category,100),cleanStr(b.language,60),total,total,cleanStr(b.description,10000),cleanStr(b.edition,80),cleanStr(b.shelf_location,120),cleanStr(b.barcode,80),clampNum(b.replacement_cost_ngn,0,99999999,0),validDate(b.acquisition_date)]);
  await logActivity(db,{madrasaId:tid,userId:req.user.id,action:"library.book.create",entity:"library_book",entityId:String(r.lastInsertRowid),ip:req.ip});ok(res,{ok:true,id:Number(r.lastInsertRowid)});
}));
router.patch("/books/:id", requirePermission("library.manage"), asyncHandler(async(req,res)=>{
  const tid=tenantId(req,res);if(!tid)return;const id=toNum(req.params.id,0),book=await db.get("SELECT * FROM library_books WHERE id=? AND madrasa_id=?",[id,tid]);if(!book)return err(res,404,"Book not found.");const b=req.body||{},sets=[],p=[];
  const strings={title:240,author:180,isbn:40,publisher:160,category:100,language:60,description:10000,edition:80,shelf_location:120,barcode:80};for(const [k,max] of Object.entries(strings))if(b[k]!==undefined){const v=cleanStr(b[k],max);if(k==="title"&&!v)return err(res,400,"Title is required.");sets.push(`${k}=?`);p.push(v);}
  if(b.year!==undefined){sets.push("year=?");p.push(b.year?toNum(b.year,0):null);}if(b.replacement_cost_ngn!==undefined){sets.push("replacement_cost_ngn=?");p.push(clampNum(b.replacement_cost_ngn,0,99999999,0));}if(b.acquisition_date!==undefined){sets.push("acquisition_date=?");p.push(validDate(b.acquisition_date));}if(b.subject_id!==undefined){const sid=b.subject_id?toNum(b.subject_id,0):null;if(!(await subjectExists(tid,sid)))return err(res,400,"Unknown subject.");sets.push("subject_id=?");p.push(sid);}
  if(b.total_copies!==undefined){const total=Math.floor(clampNum(b.total_copies,0,100000,book.total_copies));const onLoan=Number(book.total_copies)-Number(book.available_copies);if(total<onLoan)return err(res,409,`${onLoan} copies are currently on loan.`);sets.push("total_copies=?,available_copies=?");p.push(total,total-onLoan);}
  if(sets.length){p.push(id,tid);await db.run(`UPDATE library_books SET ${sets.join(",")} WHERE id=? AND madrasa_id=?`,p);}ok(res,{ok:true});
}));
router.delete("/books/:id", requirePermission("library.manage"), asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const id=toNum(req.params.id,0);const active=await db.get("SELECT id FROM library_loans WHERE madrasa_id=? AND book_id=? AND status='active'",[tid,id]);if(active)return err(res,409,"Return active copies before archiving this book.");const r=await db.run("UPDATE library_books SET is_archived=1 WHERE id=? AND madrasa_id=?",[id,tid]);if(!r.changes)return err(res,404,"Book not found.");ok(res,{ok:true,archived:true});}));
router.post("/books/:id/cover",ADMIN,requireStaffPermission("library.manage"),imageUploader("library-covers","cover"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const id=toNum(req.params.id,0);if(!req.file)return err(res,400,"Cover image is required.");const path=`/uploads/library-covers/${req.file.filename}`;const r=await db.run("UPDATE library_books SET cover_image_path=? WHERE id=? AND madrasa_id=? AND is_archived=0",[path,id,tid]);if(!r.changes)return err(res,404,"Book not found.");ok(res,{ok:true,coverImagePath:path});}));

router.post("/loans", requirePermission("library.issue"), asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const b=req.body||{},bookId=toNum(b.book_id,0),userId=toNum(b.borrower_user_id,0),type=cleanStr(b.borrower_type,20);const person=await borrower(tid,userId,type);if(!person)return err(res,400,"Borrower is not an active user of the selected type in this institution.");const issue=iso(b.issue_date)||today(),period=await setting(tid,"library_loan_period_days",14),due=iso(b.due_date)||addDays(issue,period);if(due<issue)return err(res,400,"Due date cannot precede issue date.");
  let loanId;await db.transaction(async tx=>{const book=await tx.get("SELECT id,available_copies FROM library_books WHERE id=? AND madrasa_id=? AND is_archived=0",[bookId,tid]);if(!book)throw Object.assign(new Error("Book not found."),{status:404});const changed=await tx.run("UPDATE library_books SET available_copies=available_copies-1 WHERE id=? AND madrasa_id=? AND available_copies>0",[bookId,tid]);if(!changed.changes)throw Object.assign(new Error("No copy is currently available."),{status:409});const r=await tx.run("INSERT INTO library_loans (madrasa_id,book_id,borrower_user_id,borrower_type,issued_by,issue_date,due_date,status,notes) VALUES (?,?,?,?,?,?,?,'active',?)",[tid,bookId,userId,type,req.user.id,issue,due,cleanStr(b.notes,5000)]);loanId=Number(r.lastInsertRowid);});ok(res,{ok:true,id:loanId,dueDate:due});
}));
/**
 * Renews an active loan, extending the due date by the institution's loan
 * period. Renewals are capped so a book cannot be kept indefinitely, and a
 * loan that is already closed cannot be renewed back to life.
 */
const MAX_RENEWALS = 2;
router.post("/loans/:id/renew", requirePermission("library.return"), asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const id = toNum(req.params.id, 0);
  const loan = await db.get("SELECT * FROM library_loans WHERE id=? AND madrasa_id=?", [id, tid]);
  if (!loan) return err(res, 404, "Loan not found.");
  if (loan.status !== "active" && loan.status !== "overdue") {
    return err(res, 409, "Only an open loan can be renewed.", { code: "INVALID_STATUS_TRANSITION", current: loan.status });
  }
  const renewals = Number(loan.renewal_count || 0);
  if (renewals >= MAX_RENEWALS) {
    return err(res, 409, `This loan has already been renewed ${renewals} times and must be returned.`, { code: "RENEWAL_LIMIT" });
  }
  const period = await setting(tid, "library_loan_period_days", 14);
  const base = String(loan.due_date).slice(0, 10) > today() ? String(loan.due_date).slice(0, 10) : today();
  const due = iso(req.body && req.body.due_date) || addDays(base, period);
  if (due <= String(loan.due_date).slice(0, 10)) return err(res, 400, "A renewal must extend the due date.");
  await db.run(
    "UPDATE library_loans SET due_date=?, renewal_count=?, status='active' WHERE id=? AND madrasa_id=?",
    [due, renewals + 1, id, tid]
  );
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "library.loan.renew", entity: "library_loan", entityId: String(id), meta: { due, renewals: renewals + 1 }, ip: req.ip });
  ok(res, { ok: true, due_date: due, renewal_count: renewals + 1 });
}));
router.post("/loans/:id/return",requirePermission("library.return"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const id=toNum(req.params.id,0),returned=iso(req.body&&req.body.return_date)||today(),rate=await setting(tid,"library_fine_per_day_ngn",0);let result;await db.transaction(async tx=>{const loan=await tx.get("SELECT * FROM library_loans WHERE id=? AND madrasa_id=?",[id,tid]);if(!loan)throw Object.assign(new Error("Loan not found."),{status:404});if(loan.status!=="active"&&loan.status!=="overdue")throw Object.assign(new Error("This loan has already been closed."),{status:409});const days=overdueDays(String(loan.due_date).slice(0,10),returned),fine=days*rate;await tx.run("UPDATE library_loans SET return_date=?,status='returned',fine_ngn=?,notes=? WHERE id=? AND madrasa_id=?",[returned,fine,cleanStr((req.body&&req.body.notes)||loan.notes,5000),id,tid]);await tx.run("UPDATE library_books SET available_copies=available_copies+1 WHERE id=? AND madrasa_id=? AND available_copies<total_copies",[loan.book_id,tid]);if(fine>0){const u=await tx.get("SELECT student_id FROM users WHERE id=? AND madrasa_id=?",[loan.borrower_user_id,tid]);await tx.run("INSERT INTO library_fines (madrasa_id,loan_id,student_id,amount_ngn,paid) VALUES (?,?,?,?,0)",[tid,id,u&&u.student_id||null,fine]);}result={daysOverdue:days,fineNgn:fine};});ok(res,{ok:true,...result});}));
const loanJoin=`SELECT l.*,b.title,b.author,u.full_name AS borrower_name,u.email AS borrower_email,u.phone AS borrower_phone,u.student_id FROM library_loans l JOIN library_books b ON b.id=l.book_id AND b.madrasa_id=l.madrasa_id JOIN users u ON u.id=l.borrower_user_id AND u.madrasa_id=l.madrasa_id`;
router.get("/loans",STAFF,requireStaffPermission("library.view"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const where=["l.madrasa_id=?"],p=[tid];if(req.query.status){where.push("l.status=?");p.push(cleanStr(req.query.status,20));}const loans=await db.all(`${loanJoin} WHERE ${where.join(" AND ")} ORDER BY l.due_date,l.id DESC`,p);const rate=await setting(tid,"library_fine_per_day_ngn",0);ok(res,{loans:loans.map(x=>({...x,days_overdue:overdueDays(String(x.due_date).slice(0,10)),fine_preview:overdueDays(String(x.due_date).slice(0,10))*rate}))});}));
router.get("/overdue",STAFF,requireStaffPermission("library.view"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const loans=await db.all(`${loanJoin} WHERE l.madrasa_id=? AND l.status IN ('active','overdue') AND l.due_date<? ORDER BY l.due_date`,[tid,today()]);const rate=await setting(tid,"library_fine_per_day_ngn",0);ok(res,{loans:loans.map(x=>({...x,days_overdue:overdueDays(String(x.due_date).slice(0,10)),fine_preview:overdueDays(String(x.due_date).slice(0,10))*rate}))});}));
router.get("/history",STAFF,requireStaffPermission("library.view"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const userId=toNum(req.query.userId,0),type=cleanStr(req.query.type,20);if(!userId||!TYPES.has(type))return err(res,400,"userId and type (student or teacher) are required.");const loans=await db.all(`${loanJoin} WHERE l.madrasa_id=? AND l.borrower_user_id=? AND l.borrower_type=? ORDER BY l.issue_date DESC,l.id DESC`,[tid,userId,type]);ok(res,{loans});}));
router.get("/borrowers",STAFF,requireStaffPermission("library.view"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const type=cleanStr(req.query.type,20);if(!TYPES.has(type))return err(res,400,"type must be student or teacher.");const q=`%${cleanStr(req.query.search,100).toLowerCase()}%`;const borrowers=await db.all("SELECT id,full_name,email,phone,student_id,role FROM users WHERE madrasa_id=? AND role=? AND is_active=1 AND LOWER(full_name) LIKE ? ORDER BY full_name LIMIT 30",[tid,type,q]);ok(res,{borrowers});}));
router.get("/fines",STAFF,requireStaffPermission("library.view"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const fines=await db.all("SELECT f.*,b.title,u.full_name AS borrower_name FROM library_fines f JOIN library_loans l ON l.id=f.loan_id AND l.madrasa_id=f.madrasa_id JOIN library_books b ON b.id=l.book_id AND b.madrasa_id=f.madrasa_id JOIN users u ON u.id=l.borrower_user_id AND u.madrasa_id=f.madrasa_id WHERE f.madrasa_id=? ORDER BY f.paid,f.created_at DESC",[tid]);ok(res,{fines});}));
router.post("/fines/:id/pay",ADMIN,requireStaffPermission("library.manage"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const r=await db.run("UPDATE library_fines SET paid=1,paid_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=? AND paid=0",[toNum(req.params.id,0),tid]);if(!r.changes){const found=await db.get("SELECT id,paid FROM library_fines WHERE id=? AND madrasa_id=?",[toNum(req.params.id,0),tid]);if(!found)return err(res,404,"Fine not found.");return err(res,409,"Fine is already paid.");}ok(res,{ok:true});}));
router.get("/reports",STAFF,requireStaffPermission("library.view"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const [books,borrowers,fines]=await Promise.all([db.all("SELECT b.id,b.title,b.author,COUNT(l.id) AS borrow_count FROM library_books b LEFT JOIN library_loans l ON l.book_id=b.id AND l.madrasa_id=b.madrasa_id WHERE b.madrasa_id=? GROUP BY b.id,b.title,b.author ORDER BY borrow_count DESC,b.title LIMIT 10",[tid]),db.all("SELECT u.id,u.full_name,l.borrower_type,COUNT(l.id) AS loan_count FROM library_loans l JOIN users u ON u.id=l.borrower_user_id AND u.madrasa_id=l.madrasa_id WHERE l.madrasa_id=? GROUP BY u.id,u.full_name,l.borrower_type ORDER BY loan_count DESC,u.full_name LIMIT 10",[tid]),db.get("SELECT COALESCE(SUM(amount_ngn),0) AS assessed,COALESCE(SUM(CASE WHEN paid=1 THEN amount_ngn ELSE 0 END),0) AS collected,COALESCE(SUM(CASE WHEN paid=0 THEN amount_ngn ELSE 0 END),0) AS outstanding FROM library_fines WHERE madrasa_id=?",[tid])]);ok(res,{topBooks:books,activeBorrowers:borrowers,fines});}));
router.get("/export/:kind.csv",STAFF,requireStaffPermission("library.view"),asyncHandler(async(req,res)=>{const tid=tenantId(req,res);if(!tid)return;const kind=req.params.kind;let rows,cols;if(kind==="books"){rows=await db.all(`${bookSelect} WHERE b.madrasa_id=? AND b.is_archived=0 ORDER BY b.title`,[tid]);cols=[{label:"Title",key:"title"},{label:"Author",key:"author"},{label:"ISBN",key:"isbn"},{label:"Subject",key:"subject_name"},{label:"Category",key:"category"},{label:"Language",key:"language"},{label:"Total copies",key:"total_copies"},{label:"Available copies",key:"available_copies"}];}else if(kind==="loans"){rows=await db.all(`${loanJoin} WHERE l.madrasa_id=? ORDER BY l.issue_date DESC`,[tid]);cols=[{label:"Book",key:"title"},{label:"Borrower",key:"borrower_name"},{label:"Type",key:"borrower_type"},{label:"Issue date",key:"issue_date"},{label:"Due date",key:"due_date"},{label:"Return date",key:"return_date"},{label:"Status",key:"status"},{label:"Fine NGN",key:"fine_ngn"}];}else return err(res,404,"Export not found.");csv.sendCsv(res,`library-${kind}-${today()}.csv`,csv.toCsv(rows,cols));}));

/* --------------------------- self-service loans ------------------------- */
/*
 * GET /api/library/my-loans — the caller's own borrowing record.
 *   • student → loans on their own portal account
 *   • parent  → loans on every linked child's portal account
 *   • teacher → loans on their own staff account
 * Read-only: nobody can alter their own loans from the portal.
 */
router.get("/my-loans", asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  let borrowerUserIds = [];
  if (req.user.role === "student" || req.user.role === "teacher") {
    borrowerUserIds = [Number(req.user.id)];
  } else if (req.user.role === "parent") {
    const children = await db.all(
      `SELECT u.id FROM users u
        JOIN parent_links pl ON pl.student_id = u.student_id AND pl.madrasa_id = u.madrasa_id
       WHERE pl.madrasa_id = ? AND pl.user_id = ? AND u.role = 'student' AND u.is_active = 1`,
      [tid, req.user.id]
    );
    borrowerUserIds = children.map((c) => Number(c.id));
  } else if (req.user.role === "madrasa_admin" || req.user.role === "super_admin") {
    return err(res, 403, "Use the library loans register.");
  }
  if (!borrowerUserIds.length) return ok(res, { loans: [], summary: { active: 0, overdue: 0, fines: 0 } });
  const um = borrowerUserIds.map(() => "?").join(",");
  const loans = await db.all(
    `SELECT l.id, l.book_id, b.title, b.author, b.isbn, l.issue_date, l.due_date, l.return_date, l.status,
            l.renewal_count, l.fine_ngn, u.student_id AS borrower_student_id, u.full_name AS borrower_name
       FROM library_loans l
       JOIN library_books b ON b.id = l.book_id AND b.madrasa_id = l.madrasa_id
       JOIN users u ON u.id = l.borrower_user_id AND u.madrasa_id = l.madrasa_id
      WHERE l.madrasa_id = ? AND l.borrower_user_id IN (${um})
      ORDER BY l.issue_date DESC, l.id DESC LIMIT 200`,
    [tid].concat(borrowerUserIds)
  );
  const loansWithOverdue = loans.map((x) => Object.assign({}, x, { days_overdue: overdueDays(String(x.due_date).slice(0, 10)) }));
  const fineRows = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN f.paid = 0 THEN f.amount_ngn ELSE 0 END), 0) AS unpaid
       FROM library_fines f JOIN library_loans l ON l.id = f.loan_id AND l.madrasa_id = f.madrasa_id
      WHERE f.madrasa_id = ? AND l.borrower_user_id IN (${um})`,
    [tid].concat(borrowerUserIds)
  );
  ok(res, {
    loans: loansWithOverdue,
    summary: {
      active: loansWithOverdue.filter((l) => l.status === "active" || l.status === "overdue").length,
      overdue: loansWithOverdue.filter((l) => (l.status === "active" || l.status === "overdue") && l.days_overdue > 0).length,
      fines: Number(fineRows && fineRows.unpaid || 0),
    },
  });
}));

router.use((error,req,res,next)=>{if(error&&Number(error.status)>=400&&Number(error.status)<500)return err(res,Number(error.status),error.message);if(error&&(/file|image|JPG|PNG|WEBP|limit/i.test(error.message||"")))return err(res,400,error.message);next(error);});
module.exports=router;
