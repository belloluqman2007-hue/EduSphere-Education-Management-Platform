"use strict";
/* ============================================================================
   EduSphere Desktop — native printing & PDF export (works with no internet)
   ----------------------------------------------------------------------------
   Report cards, receipts and ID cards are ordinary pages of the platform. On a
   desktop they should not depend on the browser's print dialog, and they must
   still work when the school has no internet:

     • `printWindow(win)`      the native print dialog for what is on screen
     • `savePdfFromWindow(win)` Chromium's own `printToPDF` → a real PDF file
     • `exportUrl(url)`         render a page off-screen and save it as PDF
                                (e.g. a batch of report sheets) without
                                disturbing the window the user is looking at

   In School LAN Hub mode every one of these is served by the local server, so
   printing keeps working during an internet outage. In Cloud mode the
   off-screen window carries the same `Authorization: Bearer` device token the
   app uses, so protected report pages render too.

   Nothing is written anywhere except the path the user picks in the native
   save dialog, and no HTML from the page is ever executed in the main process.
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const PRINT_PARTITION = "persist:edusphere-print";
const DEFAULT_PAGE_SIZE = "A4";

function sanitizeFilename(name) {
  const base = String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base || "EduSphere-document";
}

function pdfFilename(name) {
  const base = sanitizeFilename(name).replace(/\.pdf$/i, "");
  return base + ".pdf";
}

function createPrintService(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const dialog = options.dialog;
  const logger = options.logger || console;
  const getMainWindow = options.getMainWindow || (() => null);
  const getBaseUrl = options.getBaseUrl || (() => "");
  const getDeviceToken = options.getDeviceToken || (() => "");
  const userDataDir = options.userDataDir || (() => process.cwd());
  const session = options.session || null;
  const printOptions = options.printOptions || {};

  function describeError(err) {
    return err && err.message ? err.message : String(err);
  }

  /** Native print dialog for a window. */
  function printWindow(win, opts = {}) {
    return new Promise((resolve) => {
      const target = win || getMainWindow();
      if (!target || !target.webContents || typeof target.webContents.print !== "function") {
        return resolve({ ok: false, error: "There is no window to print." });
      }
      try {
        target.webContents.print(
          Object.assign({
            silent: false,
            printBackground: true,
            color: true,
            margins: { marginType: "default" },
            pageSize: (opts.pageSize || DEFAULT_PAGE_SIZE),
          }, printOptions, opts.printOptions || {}),
          (success, failureReason) => {
            if (!success && failureReason && failureReason !== "cancelled") {
              logger.warn && logger.warn("Print failed:", failureReason);
              return resolve({ ok: false, error: failureReason });
            }
            resolve({ ok: true, cancelled: !success });
          }
        );
      } catch (err) {
        resolve({ ok: false, error: describeError(err) });
      }
    });
  }

  /** Ask for a destination, then write the PDF. */
  async function writePdf(buffer, opts = {}) {
    const name = pdfFilename(opts.filename || "EduSphere-document");
    let target = opts.filePath || "";
    if (!target) {
      if (!dialog || typeof dialog.showSaveDialog !== "function") {
        // No dialog available (headless/test): write next to the user data.
        target = path.join(userDataDir(), name);
      } else {
        const result = await dialog.showSaveDialog({
          title: "Save as PDF",
          defaultPath: path.join(userDataDir(), name),
          filters: [{ name: "PDF document", extensions: ["pdf"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        if (!result || result.canceled || !result.filePath) return { ok: false, cancelled: true };
        target = result.filePath;
      }
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer, { mode: 0o600 });
      return { ok: true, filePath: target, bytes: buffer.length };
    } catch (err) {
      logger.warn && logger.warn("Could not write the PDF:", err);
      return { ok: false, error: describeError(err) };
    }
  }

  /** `webContents.printToPDF` for a window (report card / receipt on screen). */
  async function savePdfFromWindow(win, opts = {}) {
    const target = win || getMainWindow();
    if (!target || !target.webContents || typeof target.webContents.printToPDF !== "function") {
      return { ok: false, error: "There is no window to export." };
    }
    try {
      const buffer = await target.webContents.printToPDF({
        printBackground: true,
        pageSize: opts.pageSize || DEFAULT_PAGE_SIZE,
        landscape: Boolean(opts.landscape),
        margins: { marginType: "default" },
        ...opts.printOptions,
      });
      if (!buffer || !buffer.length) return { ok: false, error: "The page produced an empty PDF." };
      return await writePdf(buffer, opts);
    } catch (err) {
      logger.warn && logger.warn("PDF export failed:", err);
      return { ok: false, error: describeError(err) };
    }
  }

  /** Render an off-screen page (batch report sheets) and save it as PDF. */
  async function exportUrl(url, opts = {}) {
    if (typeof BrowserWindow !== "function") return { ok: false, error: "Printing is unavailable." };
    const token = String(getDeviceToken() || "");
    let origin = "";
    try {
      origin = new URL(String(url)).origin;
    } catch (e) {
      return { ok: false, error: "That page could not be opened for printing." };
    }

    let hidden = null;
    try {
      hidden = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: PRINT_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          javascript: false,
          webviewTag: false,
        },
      });

      // Protected report pages need the Bearer device token, exactly as the
      // visible window sends it. Cookies are not used by the native app.
      if (token && session && typeof session.fromPartition === "function") {
        try {
          const ses = session.fromPartition(PRINT_PARTITION);
          if (ses && ses.webRequest && typeof ses.webRequest.onBeforeSendHeaders === "function") {
            ses.webRequest.onBeforeSendHeaders({ urls: [origin + "/*"] }, (details, callback) => {
              const headers = Object.assign({}, details.requestHeaders, { Authorization: "Bearer " + token });
              callback({ requestHeaders: headers });
            });
          }
        } catch (e) {
          logger.warn && logger.warn("Could not attach the device token to the print window:", e);
        }
      }

      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => done(reject, new Error("The page took too long to load.")), Number(opts.timeoutMs) || 30000);
        if (hidden.webContents && typeof hidden.webContents.once === "function") {
          hidden.webContents.once("did-finish-load", () => done(resolve, true));
          hidden.webContents.once("did-fail-load", (_e, code, desc) => done(reject, new Error(code + " " + desc)));
        } else {
          done(resolve, true);
        }
        hidden.loadURL(String(url));
      });

      const buffer = await hidden.webContents.printToPDF({
        printBackground: true,
        pageSize: opts.pageSize || DEFAULT_PAGE_SIZE,
        landscape: Boolean(opts.landscape),
        margins: { marginType: "default" },
      });
      const saved = await writePdf(buffer, opts);
      return saved;
    } catch (err) {
      return { ok: false, error: describeError(err) };
    } finally {
      try {
        if (hidden && typeof hidden.destroy === "function") {
          if (hidden.isDestroyed && !hidden.isDestroyed()) hidden.destroy();
          else if (!hidden.isDestroyed) hidden.destroy();
        }
      } catch (e) { /* ignore */ }
    }
  }

  return { PRINT_PARTITION, exportUrl, printWindow, savePdfFromWindow, writePdf };
}

module.exports = { DEFAULT_PAGE_SIZE, PRINT_PARTITION, createPrintService, pdfFilename, sanitizeFilename };
