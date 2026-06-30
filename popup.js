/**
 * Focus Lock - popup logic.
 * Renders one of three views (idle / active / ended) based on session phase,
 * and talks to the background service worker via chrome.runtime.sendMessage.
 */

// --- Small helper around chrome.runtime.sendMessage (promise-based) ---------
function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response || {}));
  });
}

// --- Element references ------------------------------------------------------
const views = {
  idle: document.getElementById("view-idle"),
  active: document.getElementById("view-active"),
  ended: document.getElementById("view-ended"),
};

const siteInput = document.getElementById("site-input");
const addSiteBtn = document.getElementById("add-site");
const siteList = document.getElementById("site-list");
const durationButtons = document.querySelectorAll(".duration-btn");
const customRow = document.getElementById("custom-row");
const customMinutes = document.getElementById("custom-minutes");
const startBtn = document.getElementById("start-focus");
const idleError = document.getElementById("idle-error");

const countdownEl = document.getElementById("countdown");
const progressBar = document.getElementById("progress-bar");
const activeSiteList = document.getElementById("active-site-list");
const showEmergencyBtn = document.getElementById("show-emergency");
const emergencyBox = document.getElementById("emergency-box");
const emergencyInput = document.getElementById("emergency-input");
const emergencySubmit = document.getElementById("emergency-submit");
const emergencyError = document.getElementById("emergency-error");

const revealedPassword = document.getElementById("revealed-password");
const copyPasswordBtn = document.getElementById("copy-password");
const disableBlockingBtn = document.getElementById("disable-blocking");
const historyList = document.getElementById("history-list");
const openSettingsBtn = document.getElementById("open-settings");

// --- Local UI state ----------------------------------------------------------
let selectedMinutes = null; // chosen duration (idle view)
let countdownTimer = null; // setInterval handle for the active view

// ============================================================================
// Rendering
// ============================================================================

function showView(phase) {
  Object.entries(views).forEach(([name, el]) => {
    el.classList.toggle("hidden", name !== phase);
  });
}

/** Render the editable blocked-site list (idle view). */
function renderSiteList(sites) {
  siteList.innerHTML = "";
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites added yet";
    siteList.appendChild(li);
    return;
  }
  sites.forEach((site) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = site;
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.textContent = "\u00d7"; // ×
    btn.title = "Remove";
    btn.addEventListener("click", () => removeSite(site));
    li.append(span, btn);
    siteList.appendChild(li);
  });
}

/** Render the read-only locked list (active view). */
function renderActiveSiteList(sites) {
  activeSiteList.innerHTML = "";
  sites.forEach((site) => {
    const li = document.createElement("li");
    li.textContent = site;
    activeSiteList.appendChild(li);
  });
}

/** Format milliseconds as HH:MM:SS. */
function formatTime(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** Drive the live countdown + progress bar in the active view. */
function startCountdown(session) {
  if (countdownTimer) clearInterval(countdownTimer);

  const tick = async () => {
    const remaining = session.endTime - Date.now();
    countdownEl.textContent = formatTime(remaining);
    const elapsed = session.durationMs - remaining;
    const pct = Math.min(100, Math.max(0, (elapsed / session.durationMs) * 100));
    progressBar.style.width = `${pct}%`;

    // When time runs out, refresh from the background to flip into ended view.
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      await refresh();
    }
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

/** Render the session-complete history list (ended view). */
function renderHistory(history) {
  historyList.innerHTML = "";
  if (!history.length) {
    const li = document.createElement("li");
    li.textContent = "No past sessions yet.";
    historyList.appendChild(li);
    return;
  }
  history.slice(0, 10).forEach((h) => {
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "h-top";
    const when = new Date(h.completedAt || h.endTime).toLocaleString();
    const mins = Math.round((h.durationMs || 0) / 60000);
    top.innerHTML = `<span>${when}</span><span>${mins} min</span>`;
    const pw = document.createElement("div");
    pw.innerHTML = `Password: <code>${h.password || "&mdash;"}</code>`;
    li.append(top, pw);
    if (h.unlockedEarly) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "unlocked early";
      li.appendChild(badge);
    }
    historyList.appendChild(li);
  });
}

// ============================================================================
// Actions
// ============================================================================

async function refresh() {
  const state = await send({ type: "getState" });
  if (!state.ok) return;
  const { session, blockedSites, history } = state;

  if (session.phase === "active") {
    showView("active");
    renderActiveSiteList(blockedSites);
    startCountdown(session);
  } else if (session.phase === "ended") {
    if (countdownTimer) clearInterval(countdownTimer);
    showView("ended");
    revealedPassword.textContent = session.password || "\u2014";
    renderHistory(history);
  } else {
    if (countdownTimer) clearInterval(countdownTimer);
    showView("idle");
    renderSiteList(blockedSites);
  }
}

async function addSite() {
  const value = siteInput.value.trim();
  if (!value) return;
  const res = await send({ type: "addSite", site: value });
  if (res.ok) {
    siteInput.value = "";
    renderSiteList(res.blockedSites);
  } else {
    showIdleError(errorText(res.reason));
  }
}

async function removeSite(site) {
  const res = await send({ type: "removeSite", site });
  if (res.ok) renderSiteList(res.blockedSites);
}

async function startFocus() {
  hideIdleError();
  if (!selectedMinutes) {
    showIdleError("Please choose a focus duration.");
    return;
  }
  const durationMs = selectedMinutes * 60 * 1000;
  const res = await send({ type: "startSession", durationMs });
  if (res.ok) {
    await refresh();
  } else {
    showIdleError(errorText(res.reason));
  }
}

async function submitEmergency() {
  emergencyError.classList.add("hidden");
  const password = emergencyInput.value;
  const res = await send({ type: "verifyPassword", password });
  if (res.ok) {
    emergencyInput.value = "";
    await refresh();
  } else {
    emergencyError.textContent =
      res.reason === "wrong-password"
        ? "Incorrect password. The session stays locked."
        : "Unable to unlock.";
    emergencyError.classList.remove("hidden");
  }
}

async function disableBlocking() {
  const res = await send({ type: "disableBlocking" });
  if (res.ok) await refresh();
}

// ============================================================================
// Helpers
// ============================================================================

function showIdleError(msg) {
  idleError.textContent = msg;
  idleError.classList.remove("hidden");
}
function hideIdleError() {
  idleError.classList.add("hidden");
}

function errorText(reason) {
  switch (reason) {
    case "no-sites":
      return "Add at least one website to block first.";
    case "session-active":
      return "You can't change the list while a session is active.";
    case "invalid-duration":
      return "Please enter a valid duration.";
    case "invalid-site":
      return "That doesn't look like a valid website.";
    default:
      return "Something went wrong. Please try again.";
  }
}

// ============================================================================
// Event wiring
// ============================================================================

addSiteBtn.addEventListener("click", addSite);
siteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

durationButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    durationButtons.forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    if (btn.dataset.custom) {
      customRow.classList.remove("hidden");
      selectedMinutes = Number(customMinutes.value) || null;
      customMinutes.focus();
    } else {
      customRow.classList.add("hidden");
      selectedMinutes = Number(btn.dataset.minutes);
    }
  });
});

customMinutes.addEventListener("input", () => {
  selectedMinutes = Number(customMinutes.value) || null;
});

startBtn.addEventListener("click", startFocus);

showEmergencyBtn.addEventListener("click", () => {
  emergencyBox.classList.toggle("hidden");
});
emergencySubmit.addEventListener("click", submitEmergency);
emergencyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitEmergency();
});

copyPasswordBtn.addEventListener("click", async () => {
  const text = revealedPassword.textContent;
  if (text && text !== "\u2014") {
    try {
      await navigator.clipboard.writeText(text);
      copyPasswordBtn.textContent = "\u2713"; // ✓
      setTimeout(() => (copyPasswordBtn.textContent = "\uD83D\uDCCB"), 1200);
    } catch (_) {
      /* clipboard may be unavailable; ignore */
    }
  }
});

disableBlockingBtn.addEventListener("click", disableBlocking);

openSettingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Initial render when the popup opens.
refresh();
