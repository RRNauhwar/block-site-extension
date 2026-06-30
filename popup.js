/**
 * Focus Lock AI - popup control center.
 * Three views (idle / active / ended) driven by the session phase reported by
 * the background service worker. All data shown here is real.
 */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (r) => resolve(r || {}));
  });
}

// --- Elements ---------------------------------------------------------------
const views = {
  idle: document.getElementById("view-idle"),
  active: document.getElementById("view-active"),
  ended: document.getElementById("view-ended"),
};

const msLevel = document.getElementById("ms-level");
const msStreak = document.getElementById("ms-streak");
const msHours = document.getElementById("ms-hours");

const listSelect = document.getElementById("list-select");
const listSummary = document.getElementById("list-summary");
const manageLists = document.getElementById("manage-lists");
const goalText = document.getElementById("goal-text");
const unlockSeg = document.getElementById("unlock-seg");
const durationButtons = document.querySelectorAll(".duration-btn");
const customRow = document.getElementById("custom-row");
const customMinutes = document.getElementById("custom-minutes");
const modeList = document.getElementById("mode-list");
const startBtn = document.getElementById("start-focus");
const idleError = document.getElementById("idle-error");

const activeMode = document.getElementById("active-mode");
const attemptsPill = document.getElementById("attempts-pill");
const countdownEl = document.getElementById("countdown");
const progressBar = document.getElementById("progress-bar");
const activeGoal = document.getElementById("active-goal");
const coachCard = document.getElementById("coach-card");
const coachTitle = document.getElementById("coach-title");
const coachBody = document.getElementById("coach-body");
const completeGoalBtn = document.getElementById("complete-goal");
const quitBtn = document.getElementById("quit-btn");
const quitNote = document.getElementById("quit-note");
const recoveryBtn = document.getElementById("recovery-btn");

const doneEmoji = document.getElementById("done-emoji");
const doneTitle = document.getElementById("done-title");
const doneSub = document.getElementById("done-sub");
const doneFocus = document.getElementById("done-focus");
const doneAttempts = document.getElementById("done-attempts");
const doneXp = document.getElementById("done-xp");
const disableBlockingBtn = document.getElementById("disable-blocking");
const viewReportBtn = document.getElementById("view-report");
const openDashboard = document.getElementById("open-dashboard");
const openSettings = document.getElementById("open-settings");

// --- Local UI state ---------------------------------------------------------
let selectedMinutes = null;
let selectedMode = "soft";
let unlockMode = "timer"; // timer | goal | both
let countdownTimer = null;
let pollTimer = null;
let xpBefore = 0; // to compute XP earned on the ended screen

// ============================================================================
// Rendering helpers
// ============================================================================
function showView(phase) {
  Object.entries(views).forEach(([name, el]) =>
    el.classList.toggle("hidden", name !== phase)
  );
}

function formatTime(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function renderMiniStats(stats) {
  msLevel.textContent = stats.level;
  msStreak.textContent = stats.streak.current;
  msHours.textContent = (stats.totalFocusedMs / 3600000).toFixed(1);
}

function renderLists(settings) {
  listSelect.innerHTML = "";
  settings.lists.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = `${l.name} (${l.sites.length})`;
    if (l.id === settings.activeListId) opt.selected = true;
    listSelect.appendChild(opt);
  });
  const active = settings.lists.find((l) => l.id === settings.activeListId);
  listSummary.textContent = active
    ? active.sites.slice(0, 4).join(", ") + (active.sites.length > 4 ? "…" : "")
    : "No list selected";
}

function renderCoach(message) {
  if (message) {
    coachTitle.textContent = message.title || "Coach";
    coachBody.textContent = message.body || "";
    coachCard.classList.remove("hidden");
  } else {
    coachCard.classList.add("hidden");
  }
}

// ============================================================================
// Active session rendering
// ============================================================================
function renderActive(session) {
  activeMode.textContent =
    session.mode.charAt(0).toUpperCase() + session.mode.slice(1) + " mode";
  attemptsPill.textContent = `${session.attempts.total} attempts`;
  renderCoach(session.coachMessage);

  // Goal
  const needGoal = session.goal.requireGoal;
  if (session.goal.text || needGoal) {
    activeGoal.classList.remove("hidden");
    activeGoal.innerHTML = session.goal.completed
      ? `Goal: <b>${escapeHtml(session.goal.text || "done")}</b> &#9989;`
      : `Goal: <b>${escapeHtml(session.goal.text || "(set)")}</b>`;
  } else {
    activeGoal.classList.add("hidden");
  }
  completeGoalBtn.classList.toggle(
    "hidden",
    !needGoal || session.goal.completed
  );

  // Quit / recovery controls by mode
  if (session.mode === "extreme") {
    quitBtn.classList.add("hidden");
    recoveryBtn.classList.remove("hidden");
  } else {
    quitBtn.classList.remove("hidden");
    recoveryBtn.classList.add("hidden");
  }

  // Mode-specific quit note (hard wait / recovery pending)
  updateQuitNote(session);
}

function updateQuitNote(session) {
  const now = Date.now();
  if (session.mode === "hard" && session.hardUnlockAt) {
    const remaining = session.hardUnlockAt - now;
    if (remaining > 0) {
      quitNote.classList.remove("hidden");
      quitNote.textContent = `Hard mode: you can quit in ${formatTime(remaining)}.`;
      quitBtn.textContent = "End session";
    } else {
      quitNote.classList.remove("hidden");
      quitNote.textContent = "Wait period over — press again to confirm quit.";
      quitBtn.textContent = "Confirm quit";
    }
  } else if (session.mode === "extreme" && session.recovery.requestedAt) {
    const remaining = session.recovery.unlockAt - now;
    if (remaining > 0) {
      quitNote.classList.remove("hidden");
      quitNote.textContent = `Recovery unlock available in ${formatTime(remaining)}.`;
      recoveryBtn.textContent = "Recovery in progress…";
    } else {
      quitNote.classList.remove("hidden");
      quitNote.textContent = "Recovery ready — press to unlock.";
      recoveryBtn.textContent = "Confirm recovery unlock";
    }
  } else {
    quitNote.classList.add("hidden");
  }
}

function startCountdown(session) {
  if (countdownTimer) clearInterval(countdownTimer);
  const tick = async () => {
    const remaining = session.endTime - Date.now();
    countdownEl.textContent = formatTime(remaining);
    const elapsed = session.durationMs - remaining;
    progressBar.style.width = `${Math.min(100, Math.max(0, (elapsed / session.durationMs) * 100))}%`;
    updateQuitNote(session);
    if (remaining <= 0 && !session.goal.requireGoal) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      await refresh();
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// Poll the background while active so attempts + coach updates appear live.
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const state = await send({ type: "getState" });
    if (!state.ok) return;
    if (state.session.phase !== "active") {
      await refresh();
      return;
    }
    attemptsPill.textContent = `${state.session.attempts.total} attempts`;
    renderCoach(state.session.coachMessage);
    Object.assign(activeSession, state.session);
    updateQuitNote(state.session);
  }, 2500);
}

let activeSession = {}; // shared reference for the countdown/poll loops

// ============================================================================
// Main refresh
// ============================================================================
async function refresh() {
  const state = await send({ type: "getState" });
  if (!state.ok) return;
  const { session, settings, stats } = state;
  renderMiniStats(stats);
  xpBefore = stats.xp;

  if (session.phase === "active") {
    activeSession = session;
    showView("active");
    renderActive(session);
    startCountdown(session);
    startPolling();
  } else if (session.phase === "ended") {
    if (countdownTimer) clearInterval(countdownTimer);
    if (pollTimer) clearInterval(pollTimer);
    showView("ended");
    renderEnded(session, stats);
  } else {
    if (countdownTimer) clearInterval(countdownTimer);
    if (pollTimer) clearInterval(pollTimer);
    showView("idle");
    renderLists(settings);
  }
}

function renderEnded(session, stats) {
  const completed = session.completed;
  doneEmoji.textContent = completed ? "🎉" : "🌱";
  doneTitle.textContent = completed ? "Session complete!" : "Session ended";
  doneSub.textContent = completed
    ? "Great work. Consistency compounds — your stats updated below."
    : "No guilt — what matters is starting again. Consistency beats intensity.";
  const focusedMin = Math.round(
    (Math.min(Date.now(), session.endTime) - session.startTime) / 60000
  );
  doneFocus.textContent = Math.max(0, focusedMin);
  doneAttempts.textContent = session.attempts.total;
  // XP earned can't be recomputed precisely here; show level/streak via mini-stats.
  doneXp.textContent = completed ? `Lv ${stats.level}` : "—";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ============================================================================
// Actions
// ============================================================================
async function startFocus() {
  idleError.classList.add("hidden");
  if (!selectedMinutes) {
    showError("Pick a duration first.");
    return;
  }
  const res = await send({
    type: "startSession",
    durationMs: selectedMinutes * 60000,
    mode: selectedMode,
    goal: {
      text: goalText.value,
      requireTimer: unlockMode === "timer" || unlockMode === "both",
      requireGoal: unlockMode === "goal" || unlockMode === "both",
    },
  });
  if (res.ok) await refresh();
  else showError(errorText(res.reason));
}

async function onQuit() {
  const res = await send({ type: "requestStop" });
  if (res.ok && res.stopped) {
    await refresh();
  } else if (res.reason === "hard-wait") {
    // Note will update via the countdown loop; pull fresh state.
    const s = await send({ type: "getState" });
    if (s.ok) {
      Object.assign(activeSession, s.session);
      updateQuitNote(s.session);
    }
  } else if (res.reason === "extreme-locked") {
    quitNote.classList.remove("hidden");
    quitNote.textContent = "Extreme mode is locked. Use recovery unlock.";
  }
}

async function onRecovery() {
  const res = await send({ type: "requestRecovery" });
  if (res.ok && res.stopped) {
    await refresh();
  } else {
    const s = await send({ type: "getState" });
    if (s.ok) {
      Object.assign(activeSession, s.session);
      updateQuitNote(s.session);
    }
  }
}

async function onCompleteGoal() {
  const res = await send({ type: "completeGoal" });
  if (res.ok) await refresh();
}

function showError(msg) {
  idleError.textContent = msg;
  idleError.classList.remove("hidden");
}
function errorText(reason) {
  switch (reason) {
    case "no-sites": return "Your active block list is empty. Add sites in Settings.";
    case "invalid-duration": return "Enter a valid duration.";
    case "already-active": return "A session is already running.";
    default: return "Something went wrong.";
  }
}

// ============================================================================
// Event wiring
// ============================================================================
listSelect.addEventListener("change", async () => {
  await send({ type: "lists", action: "setActiveList", payload: { id: listSelect.value } });
  await refresh();
});
manageLists.addEventListener("click", () => chrome.runtime.openOptionsPage());

unlockSeg.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    unlockSeg.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    unlockMode = btn.dataset.unlock;
  });
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

modeList.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    modeList.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedMode = btn.dataset.mode;
  });
});

startBtn.addEventListener("click", startFocus);
quitBtn.addEventListener("click", onQuit);
recoveryBtn.addEventListener("click", onRecovery);
completeGoalBtn.addEventListener("click", onCompleteGoal);
disableBlockingBtn.addEventListener("click", async () => {
  const res = await send({ type: "disableBlocking" });
  if (res.ok) await refresh();
});
viewReportBtn.addEventListener("click", openAnalytics);
openDashboard.addEventListener("click", openAnalytics);
openSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());

function openAnalytics() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
}

refresh();
