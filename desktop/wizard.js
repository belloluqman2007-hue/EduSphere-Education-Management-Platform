"use strict";
/* ============================================================================
   EduSphere desktop — first-run wizard / Desktop settings page
   ----------------------------------------------------------------------------
   Runs inside the wizard window with contextIsolation ON and no Node access.
   The ONLY privileged surface is the frozen `window.__EDUSPHERE_WIZARD__`
   bridge exposed by wizard-preload.js: read the current state, submit a choice,
   cancel. All validation is repeated in the main process, so a tampered page
   cannot store an unvalidated URL or mode.
   ========================================================================== */
(function () {
  const bridge = window.__EDUSPHERE_WIZARD__ || null;
  const form = document.getElementById("form");
  const cloudRadio = document.getElementById("mode-cloud");
  const hubRadio = document.getElementById("mode-hub");
  const cloudPanel = document.getElementById("cloud-panel");
  const hubPanel = document.getElementById("hub-panel");
  const baseUrl = document.getElementById("base-url");
  const adminUsername = document.getElementById("admin-username");
  const adminPassword = document.getElementById("admin-password");
  const passwordHint = document.getElementById("password-hint");
  const errorBox = document.getElementById("error");
  const submit = document.getElementById("submit");
  const cancel = document.getElementById("cancel");
  const title = document.getElementById("title");
  const subtitle = document.getElementById("subtitle");
  const meta = document.getElementById("meta");

  let state = { mode: "cloud", cloudBaseUrl: "", adminUsername: "admin", firstRun: true };

  function showError(message) {
    if (!message) {
      errorBox.hidden = true;
      errorBox.textContent = "";
      return;
    }
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function currentMode() {
    return hubRadio.checked ? "hub" : "cloud";
  }

  function render() {
    const mode = currentMode();
    cloudPanel.hidden = mode !== "cloud";
    hubPanel.hidden = mode !== "hub";
    for (const card of document.querySelectorAll(".card")) {
      card.classList.toggle("selected", card.getAttribute("data-mode") === mode);
    }
  }

  function applyState(next) {
    state = Object.assign(state, next || {});
    cloudRadio.checked = state.mode !== "hub";
    hubRadio.checked = state.mode === "hub";
    baseUrl.value = state.cloudBaseUrl || "";
    adminUsername.value = state.adminUsername || "admin";
    if (!state.firstRun) {
      title.textContent = "Desktop settings";
      subtitle.textContent = "Change how this computer runs EduSphere. Switching modes restarts the workspace.";
      submit.textContent = "Save changes";
      cancel.hidden = false;
      document.getElementById("password-label").textContent = "Reset the administrator password (optional)";
      passwordHint.textContent = "Leave blank to keep the current password. Only used when this computer hosts the school's own database.";
    }
    meta.textContent = "EduSphere " + (state.appVersion || "") + " · " + (state.platform || "") +
      (state.encryptionAvailable === false ? " · OS keychain unavailable: the device token is kept for this session only" : "");
    render();
  }

  if (!bridge) {
    showError("This window cannot talk to the EduSphere shell. Please restart the app.");
    submit.disabled = true;
  } else {
    bridge.getState().then(applyState).catch(() => showError("Could not read the current settings."));
  }

  cloudRadio.addEventListener("change", render);
  hubRadio.addEventListener("change", render);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    const mode = currentMode();
    const payload = {
      mode,
      baseUrl: baseUrl.value.trim(),
      adminUsername: adminUsername.value.trim() || "admin",
      adminPassword: adminPassword.value,
    };
    if (mode === "cloud") {
      if (!payload.baseUrl) return showError("Enter the address of your EduSphere server.");
      if (!/^https?:\/\/[^\s]+$/i.test(payload.baseUrl)) {
        return showError("That address does not look like a web address. It should start with https://");
      }
    }
    if (mode === "hub" && payload.adminPassword && payload.adminPassword.length < 8) {
      return showError("Use at least 8 characters for the administrator password.");
    }
    submit.disabled = true;
    try {
      const result = await bridge.submit(payload);
      if (!result || !result.ok) {
        showError((result && result.error) || "These settings could not be saved.");
        submit.disabled = false;
      }
    } catch (e) {
      showError("These settings could not be saved.");
      submit.disabled = false;
    }
  });

  cancel.addEventListener("click", () => {
    if (bridge) bridge.cancel();
  });
})();
