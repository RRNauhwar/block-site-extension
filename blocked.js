/**
 * Focus Lock - blocked page logic.
 * This page is shown whenever a blocked site is opened during a focus session.
 * It displays the blocked site name, a live countdown, and a motivational
 * quote. There is no early unlock: the page only offers an "unlock" button
 * after the session has ended.
 */

// A small rotating set of motivational study quotes.
const QUOTES = [
  "The secret of getting ahead is getting started.",
  "Focus on being productive instead of busy.",
  "Discipline is choosing between what you want now and what you want most.",
  "Your future is created by what you do today, not tomorrow.",
  "Small steps every day add up to big results.",
  "Don't watch the clock; do what it does. Keep going.",
  "Success is the sum of small efforts repeated day in and day out.",
  "The expert in anything was once a beginner.",
  "Concentrate all your thoughts upon the work at hand.",
  "Stay focused. The distraction will still be there later.",
];

// --- Helpers ----------------------------------------------------------------
function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response || {}));
  });
}

function formatTime(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// --- Elements ---------------------------------------------------------------
const siteNameEl = document.getElementById("site-name");
const countdownEl = document.getElementById("countdown");
const quoteEl = document.getElementById("quote");
const endedBox = document.getElementById("ended-box");
const disableBtn = document.getElementById("disable-btn");

let countdownTimer = null;

// --- Init -------------------------------------------------------------------

// Show which site was blocked (passed as ?site= in the redirect URL).
const params = new URLSearchParams(location.search);
const site = params.get("site");
if (site) siteNameEl.textContent = site;

// Pick a random quote.
quoteEl.textContent = `\u201C${QUOTES[Math.floor(Math.random() * QUOTES.length)]}\u201D`;

/** Read session state and update the countdown / ended state. */
async function syncState() {
  const state = await send({ type: "getState" });
  if (!state.ok) return;
  const session = state.session;

  if (session.phase === "active") {
    endedBox.classList.add("hidden");
    startCountdown(session.endTime);
  } else {
    // Session is no longer active (ended or disabled). Allow the user to leave.
    if (countdownTimer) clearInterval(countdownTimer);
    countdownEl.textContent = "00:00:00";
    endedBox.classList.remove("hidden");
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
      // Re-sync to flip into the ended state once the worker updates phase.
      setTimeout(syncState, 1200);
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// --- Disable blocking after the session ends --------------------------------
disableBtn.addEventListener("click", async () => {
  const res = await send({ type: "disableBlocking" });
  if (res.ok) location.reload();
});

// Kick things off.
syncState();
