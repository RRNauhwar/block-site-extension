/**
 * Focus Lock - background service worker (Manifest V3)
 * -----------------------------------------------------
 * Responsibilities:
 *  - Persist all state in chrome.storage.local (survives browser restarts).
 *  - Manage the focus session lifecycle (idle -> active -> ended -> idle).
 *  - Apply / remove chrome.declarativeNetRequest dynamic rules that redirect
 *    blocked websites to a local blocked.html page.
 *  - Use chrome.alarms (with a periodic fallback) to detect when the timer ends.
 *  - Re-apply rules on startup if a session is still active.
 *
 * There is intentionally NO early-unlock mechanism: once a session starts it
 * is fully locked until the timer ends. The block list and timer cannot be
 * changed or stopped while active.
 *
 * All persistent data lives under three storage keys:
 *  - "blockedSites": string[]  (bare domains, e.g. "instagram.com")
 *  - "session":      object    (current session state, see DEFAULT_SESSION)
 *  - "history":      object[]  (past sessions)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALARM_END = "focusLock:end"; // fires exactly when the session should end
const ALARM_CHECK = "focusLock:check"; // periodic safety-net check (every minute)

// Session "phase" values.
const PHASE_IDLE = "idle"; // no session running, sites are not blocked
const PHASE_ACTIVE = "active"; // timer running, sites blocked, locked down
const PHASE_ENDED = "ended"; // timer finished, awaiting the user to unlock

// Default seed list so a new user immediately sees how it works.
const DEFAULT_SITES = [
  "instagram.com",
  "youtube.com",
  "hotstar.com",
  "facebook.com",
  "reddit.com",
];

const DEFAULT_SESSION = {
  phase: PHASE_IDLE,
  startTime: null, // epoch ms when the session started
  endTime: null, // epoch ms when the session is scheduled to end
  durationMs: null, // total planned duration in ms
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getBlockedSites() {
  const { blockedSites } = await chrome.storage.local.get("blockedSites");
  return Array.isArray(blockedSites) ? blockedSites : [];
}

async function setBlockedSites(sites) {
  await chrome.storage.local.set({ blockedSites: sites });
}

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  return session && typeof session === "object" ? session : { ...DEFAULT_SESSION };
}

async function setSession(session) {
  await chrome.storage.local.set({ session });
}

async function getHistory() {
  const { history } = await chrome.storage.local.get("history");
  return Array.isArray(history) ? history : [];
}

async function pushHistory(entry) {
  const history = await getHistory();
  history.unshift(entry); // newest first
  // Keep the list bounded so storage doesn't grow forever.
  await chrome.storage.local.set({ history: history.slice(0, 50) });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Normalize user input into a bare domain.
 * "https://www.youtube.com/feed" -> "youtube.com"
 */
function normalizeSite(input) {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  // Strip protocol.
  s = s.replace(/^[a-z]+:\/\//, "");
  // Strip everything after the first slash, ?, or #.
  s = s.split(/[/?#]/)[0];
  // Strip a leading "www."
  s = s.replace(/^www\./, "");
  return s;
}

// ---------------------------------------------------------------------------
// declarativeNetRequest dynamic rules
// ---------------------------------------------------------------------------

/**
 * Build one redirect rule per blocked site. Each rule redirects top-level
 * navigations to our local blocked.html, passing the site name as a query
 * param so the blocked page can show which site was blocked.
 */
function buildRules(sites) {
  return sites.map((site, index) => ({
    id: index + 1, // dynamic rule ids must be positive integers
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath: `/blocked.html?site=${encodeURIComponent(site)}`,
      },
    },
    condition: {
      // "||domain^" matches the domain and its subdomains.
      urlFilter: `||${site}^`,
      // Only redirect real page loads, not images/scripts/etc.
      resourceTypes: ["main_frame"],
    },
  }));
}

/** Replace all current dynamic rules with rules for the given sites. */
async function applyRules(sites) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = buildRules(sites);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

/** Remove every dynamic rule (fully unblocks all sites). */
async function clearRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  if (removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

function scheduleAlarms(endTime) {
  // Precise one-shot alarm at the exact end time.
  chrome.alarms.create(ALARM_END, { when: endTime });
  // Periodic safety-net in case the precise alarm is missed (e.g. machine asleep).
  chrome.alarms.create(ALARM_CHECK, { periodInMinutes: 1 });
}

function clearAlarms() {
  chrome.alarms.clear(ALARM_END);
  chrome.alarms.clear(ALARM_CHECK);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a focus session for the given duration (ms).
 * Applies blocking rules and schedules alarms. There is no way to stop early.
 */
async function startSession(durationMs) {
  const sites = await getBlockedSites();
  const now = Date.now();
  const session = {
    phase: PHASE_ACTIVE,
    startTime: now,
    endTime: now + durationMs,
    durationMs,
  };
  await setSession(session);
  await applyRules(sites);
  scheduleAlarms(session.endTime);
  return session;
}

/**
 * Called when the timer reaches its end naturally.
 * Moves to the ENDED phase and records history. Blocking rules stay active
 * until the user explicitly disables blocking from the popup/blocked page.
 */
async function endSession() {
  const session = await getSession();
  if (session.phase !== PHASE_ACTIVE) return session;

  const sites = await getBlockedSites();
  const ended = { ...session, phase: PHASE_ENDED };
  await setSession(ended);

  await pushHistory({
    startTime: session.startTime,
    endTime: session.endTime,
    durationMs: session.durationMs,
    sites: [...sites],
    completedAt: Date.now(),
  });

  // The precise alarm has fired; stop the periodic check.
  chrome.alarms.clear(ALARM_CHECK);
  return ended;
}

/**
 * Disable blocking after a session has ended. Removes all rules and resets
 * the session back to idle. Only allowed when the session is NOT active.
 */
async function disableBlocking() {
  const session = await getSession();
  if (session.phase === PHASE_ACTIVE) {
    return { success: false, reason: "session-active" };
  }
  await clearRules();
  clearAlarms();
  await setSession({ ...DEFAULT_SESSION });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Startup / recovery
// ---------------------------------------------------------------------------

/**
 * Run on every service-worker wake-up. If a session is still active, either
 * re-apply its rules (and re-schedule alarms) or end it if time has passed.
 */
async function init() {
  // Seed defaults the first time we ever run.
  const stored = await chrome.storage.local.get(["blockedSites", "session"]);
  if (!Array.isArray(stored.blockedSites)) {
    await setBlockedSites([...DEFAULT_SITES]);
  }
  if (!stored.session) {
    await setSession({ ...DEFAULT_SESSION });
  }

  const session = await getSession();
  if (session.phase === PHASE_ACTIVE) {
    if (Date.now() >= session.endTime) {
      // Timer already elapsed while the browser was closed.
      await endSession();
    } else {
      // Still running: make sure rules and alarms are in place.
      const sites = await getBlockedSites();
      await applyRules(sites);
      scheduleAlarms(session.endTime);
    }
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  init();
});

chrome.runtime.onStartup.addListener(() => {
  init();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_END || alarm.name === ALARM_CHECK) {
    const session = await getSession();
    if (session.phase === PHASE_ACTIVE && Date.now() >= session.endTime) {
      await endSession();
    }
  }
});

/**
 * Central message router for the popup, options, and blocked pages.
 * Always returns true to keep the sendResponse channel open for async work.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "getState": {
          const [blockedSites, session, history] = await Promise.all([
            getBlockedSites(),
            getSession(),
            getHistory(),
          ]);
          sendResponse({ ok: true, blockedSites, session, history });
          break;
        }

        case "addSite": {
          const session = await getSession();
          if (session.phase === PHASE_ACTIVE) {
            sendResponse({ ok: false, reason: "session-active" });
            break;
          }
          const site = normalizeSite(message.site);
          if (!site) {
            sendResponse({ ok: false, reason: "invalid-site" });
            break;
          }
          const sites = await getBlockedSites();
          if (!sites.includes(site)) sites.push(site);
          await setBlockedSites(sites);
          sendResponse({ ok: true, blockedSites: sites });
          break;
        }

        case "removeSite": {
          // Cannot remove sites while a session is active (strict lock).
          const session = await getSession();
          if (session.phase === PHASE_ACTIVE) {
            sendResponse({ ok: false, reason: "session-active" });
            break;
          }
          const site = normalizeSite(message.site);
          let sites = await getBlockedSites();
          sites = sites.filter((s) => s !== site);
          await setBlockedSites(sites);
          sendResponse({ ok: true, blockedSites: sites });
          break;
        }

        case "startSession": {
          const session = await getSession();
          if (session.phase === PHASE_ACTIVE) {
            sendResponse({ ok: false, reason: "already-active" });
            break;
          }
          const durationMs = Number(message.durationMs);
          if (!Number.isFinite(durationMs) || durationMs <= 0) {
            sendResponse({ ok: false, reason: "invalid-duration" });
            break;
          }
          const sites = await getBlockedSites();
          if (sites.length === 0) {
            sendResponse({ ok: false, reason: "no-sites" });
            break;
          }
          const started = await startSession(durationMs);
          sendResponse({ ok: true, session: started });
          break;
        }

        case "disableBlocking": {
          const result = await disableBlocking();
          sendResponse({ ok: result.success, reason: result.reason });
          break;
        }

        default:
          sendResponse({ ok: false, reason: "unknown-message" });
      }
    } catch (err) {
      sendResponse({ ok: false, reason: "error", error: String(err) });
    }
  })();

  return true; // keep the message channel open for the async response
});

// Run init as soon as the service worker is (re)started.
init();
