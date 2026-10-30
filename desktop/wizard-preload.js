"use strict";
/* ============================================================================
   EduSphere desktop — preload for the wizard / Desktop settings window only.
   Exposes the smallest possible surface: read the current choice, submit a new
   one, cancel. No token access, no printing, no filesystem.
   ========================================================================== */
const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, payload) {
  try {
    const result = ipcRenderer.invoke(channel, payload);
    if (result && typeof result.catch === "function") result.catch(() => {});
    return result;
  } catch (e) {
    return Promise.resolve({ ok: false, error: "The EduSphere shell is not responding." });
  }
}

contextBridge.exposeInMainWorld("__EDUSPHERE_WIZARD__", Object.freeze({
  getState: () => invoke("edusphere:wizard:get-state"),
  submit: (payload) => invoke("edusphere:wizard:submit", payload || {}),
  cancel: () => invoke("edusphere:wizard:cancel"),
}));
