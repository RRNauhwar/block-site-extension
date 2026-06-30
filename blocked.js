/**
 * Focus Lock AI - blocked page.
 * Shown whenever a blocked site is opened during a session. It reports the
 * attempt to the background (which drives the real attempt counter and the AI
 * intervention engine), then shows the live countdown, attempt count, and any
 * coach message. There is no early unlock here — quitting is handled in the
 * popup per the session's mode.
 */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (r) => resolve(r || {}));
  });
}

function formatTime(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const siteNameEl = document.getElementById("site-name");
const countdownEl = document.getElementById("countdown");
const attemptCountEl = document.getElementById("attempt-count");
const coachEl = document.getElementById("coach");
const coachTitleEl = document.getElementById("coach-title");
const coachBodyEl = document.getElementById("coach-body");
const goalLineEl = document.getElementById("goal-line");
const endedBox = document.getElementById("ended-box");
const disableBtn = document.getElementById("disable-btn");
const modeBadge = document.getElementById("mode-badge");
const modeNote = document.getElementById("mode-note");

let countdownTimer = null;

// Which site triggered this block (from the redirect query param).
const params = new URLSearchParams(location.search);
const site = params.get("site") || "this site";
siteNameEl.textContent = site;

const MODE_NOTES = {
  soft: "Soft mode: you can end this session anytime from the extension popup.",
  hard: "Hard mode: ending early requires a short waiting period.",
  extreme: "Extreme mode: this session is locked. Recovery unlock takes 10 minutes.",
};

function renderCoach(message) {
  if (message && message.body) {
    coachTitleEl.textContent = message.title || "Your coach";
    coachBodyEl.textContent = message.body;
    coachEl.classList.remove("hidden");
  } else {
    coachEl.classList.add("hidden");
  }
}

function startCountdown(endTime) {
  if (countdownTimer) clearInterval(countdownTimer);
  const tick = () => {
    const remaining = endTime - Date.now();
    countdownEl.textContent = formatTime(remaining);
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      setTimeout(syncState, 1500);
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function init() {
  // Record this attempt first — this is the real signal the engine uses.
  const res = await send({ type: "recordAttempt", site });

  if (res.ok) {
    attemptCountEl.textContent = res.attempts;
    renderCoach(res.coachMessage);
    if (res.mode) {
      modeBadge.textContent = res.mode.charAt(0).toUpperCase() + res.mode.slice(1) + " mode";
      modeNote.textContent = MODE_NOTES[res.mode] || "";
    }
    startCountdown(res.endTime);
  }

  // Pull goal + ended state.
  await syncState();
}

async function syncState() {
  const state = await send({ type: "getState" });
  if (!state.ok) return;
  const session = state.session;

  if (session.phase === "active") {
    endedBox.classList.add("hidden");
    attemptCountEl.textContent = session.attempts.total;
    renderCoach(session.coachMessage);
    if (session.goal && (session.goal.text || session.goal.requireGoal)) {
      goalLineEl.classList.remove("hidden");
      goalLineEl.textContent = session.goal.text
        ? `Your goal: ${session.goal.text}`
        : "This session unlocks on goal completion.";
    }
    startCountdown(session.endTime);
  } else {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownEl.textContent = "00:00:00";
    endedBox.classList.remove("hidden");
    coachEl.classList.add("hidden");
  }
}

disableBtn.addEventListener("click", async () => {
  const res = await send({ type: "disableBlocking" });
  if (res.ok) location.reload();
});

init();
