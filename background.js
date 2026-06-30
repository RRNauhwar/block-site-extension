/**
 * Focus Lock AI - background service worker (Manifest V3)
 * =======================================================
 * The "brain" of the extension. Everything here runs locally; there is no
 * backend and no telemetry (privacy-first by design).
 *
 * Responsibilities:
 *   - Manage block lists (unlimited, named) in chrome.storage.
 *   - Run focus sessions with three modes: soft / hard / extreme.
 *   - Apply/clear chrome.declarativeNetRequest dynamic rules that redirect
 *     blocked sites to a local blocked page.
 *   - Track REAL distraction attempts (each blocked navigation = one attempt).
 *   - Drive a rule-based behavioral "coach" (the AI Intervention Engine),
 *     with an optional hook to a user-supplied LLM endpoint.
 *   - Support goal-based unlocking (timer / goal / both).
 *   - Record completed sessions and compute analytics, XP, levels, streaks
 *     and achievements from that real history.
 *
 * Storage layout (chrome.storage.local unless noted):
 *   - "settings"  : user settings (optionally mirrored to storage.sync)
 *   - "session"   : the current/most-recent session object
 *   - "stats"     : gamification + lifetime aggregates
 *   - "history"   : array of completed/aborted session records (newest first)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALARM_END = "focusLock:end";
const ALARM_CHECK = "focusLock:check";

const PHASE_IDLE = "idle";
const PHASE_ACTIVE = "active";
const PHASE_ENDED = "ended";

const MODE_SOFT = "soft";
const MODE_HARD = "hard";
const MODE_EXTREME = "extreme";

// How long a Hard-mode user must wait after requesting to quit early.
const HARD_MODE_DELAY_MS = 2 * 60 * 1000; // 2 minutes
// How long an Extreme-mode recovery unlock takes before it can be confirmed.
const EXTREME_RECOVERY_DELAY_MS = 10 * 60 * 1000; // 10 minutes

// Intervention thresholds (number of distraction attempts in a session).
const INTERVENTION_THRESHOLDS = [5, 10, 20, 35];

const DEFAULT_SITES = [
  "youtube.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "netflix.com",
];

const DEFAULT_SETTINGS = {
  // Unlimited, named block lists. The active one is used for new sessions.
  lists: [{ id: "default", name: "Default", sites: [...DEFAULT_SITES] }],
  activeListId: "default",
  // Behavioral coach configuration.
  coach: {
    enabled: true,
    // Optional: plug in your own OpenAI-compatible endpoint for richer
    // coaching. Disabled by default; the local rule-based coach is always used
    // as the baseline so the feature is fully functional with no network.
    llm: { enabled: false, baseUrl: "", model: "", apiKey: "" },
  },
  // Mirror lists + settings across devices via chrome.storage.sync.
  syncEnabled: false,
};

const DEFAULT_SESSION = {
  phase: PHASE_IDLE,
  mode: MODE_SOFT,
  startTime: null,
  endTime: null,
  durationMs: null,
  // Snapshot of the sites blocked for this session.
  sites: [],
  listId: null,
  // Goal-based unlocking.
  goal: { text: "", requireTimer: true, requireGoal: false, completed: false },
  // Real distraction tracking.
  attempts: { total: 0, perSite: {}, timeline: [] },
  // Which intervention thresholds we've already fired (avoid repeats).
  interventionsFired: [],
  // Latest coach message shown to the user.
  coachMessage: null,
  // Hard mode: timestamp when the user is allowed to quit (after the delay).
  hardUnlockAt: null,
  // Extreme mode: recovery unlock process.
  recovery: { code: null, requestedAt: null, unlockAt: null },
  // Outcome bookkeeping.
  completed: false,
  endedReason: null, // "timer" | "goal" | "soft-quit" | "hard-quit" | "recovery"
};

const DEFAULT_STATS = {
  xp: 0,
  level: 1,
  streak: { current: 0, longest: 0, lastDay: null }, // lastDay = YYYY-MM-DD
  achievements: {}, // id -> unlockedAt (epoch ms)
  totalFocusedMs: 0,
  sessionsCompleted: 0,
  sessionsStarted: 0,
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return settings && typeof settings === "object"
    ? { ...DEFAULT_SETTINGS, ...settings }
    : { ...DEFAULT_SETTINGS };
}

async function setSettings(settings) {
  await chrome.storage.local.set({ settings });
  // Optionally mirror lists + coach config (not the LLM key) across devices.
  if (settings.syncEnabled) {
    try {
      await chrome.storage.sync.set({
        focusLockSettings: {
          lists: settings.lists,
          activeListId: settings.activeListId,
          coach: { ...settings.coach, llm: { enabled: false } },
        },
      });
    } catch (_) {
      /* sync quota or availability issues are non-fatal */
    }
  }
}

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  return session && typeof session === "object"
    ? session
    : { ...DEFAULT_SESSION };
}

async function setSession(session) {
  await chrome.storage.local.set({ session });
}

async function getStats() {
  const { stats } = await chrome.storage.local.get("stats");
  return stats && typeof stats === "object"
    ? { ...DEFAULT_STATS, ...stats }
    : { ...DEFAULT_STATS };
}

async function setStats(stats) {
  await chrome.storage.local.set({ stats });
}

async function getHistory() {
  const { history } = await chrome.storage.local.get("history");
  return Array.isArray(history) ? history : [];
}

async function pushHistory(entry) {
  const history = await getHistory();
  history.unshift(entry);
  // Keep a generous but bounded local history.
  await chrome.storage.local.set({ history: history.slice(0, 500) });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** "https://www.youtube.com/feed" -> "youtube.com" */
function normalizeSite(input) {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^www\./, "");
  return s;
}

/** Cryptographically strong recovery code (used by Extreme mode records). */
function generateCode(length = 10) {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += charset[bytes[i] % charset.length];
  return out;
}

/** Local YYYY-MM-DD key for a timestamp. */
function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getActiveList(settings) {
  return (
    settings.lists.find((l) => l.id === settings.activeListId) ||
    settings.lists[0] ||
    null
  );
}

// ---------------------------------------------------------------------------
// declarativeNetRequest dynamic rules
// ---------------------------------------------------------------------------

function buildRules(sites) {
  return sites.map((site, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { extensionPath: `/blocked.html?site=${encodeURIComponent(site)}` },
    },
    condition: { urlFilter: `||${site}^`, resourceTypes: ["main_frame"] },
  }));
}

async function applyRules(sites) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: buildRules(sites),
  });
}

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
  chrome.alarms.create(ALARM_END, { when: endTime });
  chrome.alarms.create(ALARM_CHECK, { periodInMinutes: 1 });
}

function clearAllAlarms() {
  chrome.alarms.clear(ALARM_END);
  chrome.alarms.clear(ALARM_CHECK);
}

// ---------------------------------------------------------------------------
// The AI Intervention Engine (rule-based behavioral coach)
// ---------------------------------------------------------------------------
//
// This is intentionally NOT a motivational-quote randomizer. Each message is
// derived from the user's real, in-session behaviour: how many times they've
// tried to open a blocked site, which site, and how recently. Messages avoid
// guilt and instead prompt reflection and re-engagement.

/** Count attempts that happened within the last `windowMs`. */
function attemptsInWindow(timeline, windowMs) {
  const cutoff = Date.now() - windowMs;
  return timeline.filter((a) => a.t >= cutoff).length;
}

/** The single most-attempted site this session, with its count. */
function topAttemptSite(perSite) {
  let top = null;
  let max = 0;
  for (const [site, count] of Object.entries(perSite)) {
    if (count > max) {
      max = count;
      top = site;
    }
  }
  return top ? { site: top, count: max } : null;
}

/**
 * Produce a coach message for the current attempt count, escalating with
 * severity. Returns null if no new threshold was crossed.
 */
function buildInterventionMessage(session) {
  const { attempts } = session;
  const total = attempts.total;
  const recent = attemptsInWindow(attempts.timeline, 20 * 60 * 1000);
  const top = topAttemptSite(attempts.perSite);
  const goal = session.goal.text;

  if (total >= 35) {
    return {
      level: "reflect",
      title: "Let's reset together",
      body:
        `That's ${total} attempts this session` +
        (top ? `, mostly ${top.site}` : "") +
        ". This isn't about willpower right now. A 5-minute walk or some water often resets focus better than pushing through. Your session is still running when you're ready.",
    };
  }
  if (total >= 20) {
    return {
      level: "reflect",
      title: "A quick check-in",
      body:
        `You've reached for a blocked site ${total} times` +
        (recent ? ` (${recent} in the last 20 min)` : "") +
        ". Sometimes that urge is really task-avoidance. " +
        (goal
          ? `What's the very next small step on "${goal}"?`
          : "What's the smallest next step you could take right now?"),
    };
  }
  if (total >= 10) {
    return {
      level: "accountability",
      title: "Staying accountable",
      body:
        `${total} distraction attempts so far` +
        (top ? ` — ${top.site} is pulling hardest (${top.count}x).` : ".") +
        " You chose this session for a reason. Back to the work that matters.",
    };
  }
  if (total >= 5) {
    return {
      level: "gentle",
      title: "Gentle nudge",
      body:
        `That's ${total} tries at a blocked site. Totally normal — the habit loop is strong. ` +
        (goal ? `Refocus on "${goal}".` : "Take a breath and refocus."),
    };
  }
  return null;
}

/**
 * Optionally enrich the message via a user-configured LLM endpoint. This is a
 * best-effort enhancement; on any failure we keep the local message so the
 * coach is always functional offline.
 */
async function maybeEnhanceWithLLM(message, session, settings) {
  const llm = settings.coach?.llm;
  if (!llm?.enabled || !llm.apiKey || !llm.baseUrl || !llm.model) return message;
  try {
    const top = topAttemptSite(session.attempts.perSite);
    const prompt =
      `You are a concise, high-performance focus coach. Avoid guilt. ` +
      `The user is in a focus session${session.goal.text ? ` working on: "${session.goal.text}"` : ""}. ` +
      `They have attempted to open blocked sites ${session.attempts.total} times` +
      (top ? ` (most: ${top.site}).` : ".") +
      ` Write one short, direct, supportive sentence to re-focus them.`;
    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
        temperature: 0.7,
      }),
    });
    if (!res.ok) return message;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (text) return { ...message, body: text, source: "llm" };
  } catch (_) {
    /* network/parse errors are non-fatal; fall back to local message */
  }
  return message;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession({ durationMs, mode, goal }) {
  const settings = await getSettings();
  const list = getActiveList(settings);
  const sites = list ? [...list.sites] : [];
  const now = Date.now();

  const session = {
    ...DEFAULT_SESSION,
    phase: PHASE_ACTIVE,
    mode: [MODE_SOFT, MODE_HARD, MODE_EXTREME].includes(mode) ? mode : MODE_SOFT,
    startTime: now,
    endTime: now + durationMs,
    durationMs,
    sites,
    listId: list ? list.id : null,
    goal: {
      text: (goal?.text || "").trim(),
      requireTimer: goal?.requireTimer !== false,
      requireGoal: !!goal?.requireGoal,
      completed: false,
    },
    attempts: { total: 0, perSite: {}, timeline: [] },
    interventionsFired: [],
    coachMessage: null,
    hardUnlockAt: null,
    recovery: {
      code: mode === MODE_EXTREME ? generateCode(10) : null,
      requestedAt: null,
      unlockAt: null,
    },
    completed: false,
    endedReason: null,
  };

  await setSession(session);
  await applyRules(sites);
  scheduleAlarms(session.endTime);

  const stats = await getStats();
  stats.sessionsStarted += 1;
  await setStats(stats);

  return session;
}

/** Whether the timer-based requirement is satisfied right now. */
function timerSatisfied(session) {
  return Date.now() >= session.endTime;
}

/** Whether all unlock requirements for this session are met. */
function unlockRequirementsMet(session) {
  const needTimer = session.goal.requireTimer;
  const needGoal = session.goal.requireGoal;
  const timerOk = !needTimer || timerSatisfied(session);
  const goalOk = !needGoal || session.goal.completed;
  // If neither is explicitly required, fall back to the timer.
  if (!needTimer && !needGoal) return timerSatisfied(session);
  return timerOk && goalOk;
}

/**
 * Finalize a session: record history, update gamification, optionally clear
 * rules. `completed` indicates whether it ended successfully vs aborted early.
 */
async function finalizeSession(reason, completed) {
  const session = await getSession();
  if (session.phase !== PHASE_ACTIVE) return session;

  const now = Date.now();
  const focusedMs = Math.max(0, Math.min(now, session.endTime) - session.startTime);

  const ended = {
    ...session,
    phase: PHASE_ENDED,
    completed,
    endedReason: reason,
  };
  await setSession(ended);

  // Record history (real data only).
  await pushHistory({
    startTime: session.startTime,
    endTime: now,
    plannedEndTime: session.endTime,
    durationMs: session.durationMs,
    focusedMs,
    mode: session.mode,
    completed,
    endedReason: reason,
    goal: session.goal,
    attempts: {
      total: session.attempts.total,
      perSite: session.attempts.perSite,
    },
    recoveryCode: session.recovery.code, // for the user's own records
  });

  await updateGamification({ session, focusedMs, completed });

  chrome.alarms.clear(ALARM_CHECK);
  return ended;
}

/** Natural end (timer elapsed). May still require a goal in goal/both modes. */
async function endByTimer() {
  const session = await getSession();
  if (session.phase !== PHASE_ACTIVE) return session;

  // If a goal is still required and not done, keep the session active and
  // surface a coach prompt instead of ending.
  if (session.goal.requireGoal && !session.goal.completed) {
    session.coachMessage = {
      level: "accountability",
      title: "Timer done — goal pending",
      body: session.goal.text
        ? `Time's up, but your unlock is tied to: "${session.goal.text}". Finish it (or mark it done) to unlock.`
        : "Time's up, but this session unlocks on goal completion. Mark your goal done to unlock.",
    };
    await setSession(session);
    return session;
  }

  return finalizeSession("timer", true);
}

// ---------------------------------------------------------------------------
// Gamification: XP, levels, streaks, achievements (all from real history)
// ---------------------------------------------------------------------------

function levelForXp(xp) {
  // Smooth-ish curve: each level needs progressively more XP.
  return Math.max(1, Math.floor(Math.sqrt(xp / 100)) + 1);
}

async function updateGamification({ session, focusedMs, completed }) {
  const stats = await getStats();
  const minutes = Math.round(focusedMs / 60000);

  stats.totalFocusedMs += focusedMs;

  if (completed) {
    stats.sessionsCompleted += 1;
    // XP: focused minutes + completion bonus + mode multiplier.
    const modeBonus =
      session.mode === MODE_EXTREME ? 1.5 : session.mode === MODE_HARD ? 1.25 : 1;
    stats.xp += Math.round((minutes + 25) * modeBonus);
    stats.level = levelForXp(stats.xp);

    // Streak: count today once.
    const today = dayKey(Date.now());
    if (stats.streak.lastDay !== today) {
      const yesterday = dayKey(Date.now() - 24 * 60 * 60 * 1000);
      stats.streak.current =
        stats.streak.lastDay === yesterday ? stats.streak.current + 1 : 1;
      stats.streak.lastDay = today;
      stats.streak.longest = Math.max(stats.streak.longest, stats.streak.current);
    }
  }

  await evaluateAchievements(stats, session, completed);
  await setStats(stats);
}

const ACHIEVEMENTS = [
  { id: "first_focus", name: "First Focus", test: (s) => s.sessionsCompleted >= 1 },
  { id: "focus_5h", name: "5 Hours Deep", test: (s) => s.totalFocusedMs >= 5 * 3600000 },
  { id: "focus_25h", name: "25 Hours Deep", test: (s) => s.totalFocusedMs >= 25 * 3600000 },
  { id: "streak_3", name: "3-Day Streak", test: (s) => s.streak.current >= 3 },
  { id: "streak_7", name: "7-Day Streak", test: (s) => s.streak.current >= 7 },
  { id: "level_5", name: "Level 5", test: (s) => s.level >= 5 },
];

// Per-session achievements depend on the session object too.
const SESSION_ACHIEVEMENTS = [
  {
    id: "zero_distraction",
    name: "Untouchable",
    test: (sess, completed) => completed && sess.attempts.total === 0,
  },
  {
    id: "deep_work_2h",
    name: "Deep Worker",
    test: (sess, completed) => completed && sess.durationMs >= 2 * 3600000,
  },
  {
    id: "extreme_done",
    name: "Extreme Warrior",
    test: (sess, completed) => completed && sess.mode === MODE_EXTREME,
  },
  {
    id: "early_bird",
    name: "Early Bird",
    test: (sess, completed) =>
      completed && new Date(sess.startTime).getHours() < 8,
  },
];

async function evaluateAchievements(stats, session, completed) {
  const now = Date.now();
  for (const a of ACHIEVEMENTS) {
    if (!stats.achievements[a.id] && a.test(stats)) stats.achievements[a.id] = now;
  }
  for (const a of SESSION_ACHIEVEMENTS) {
    if (!stats.achievements[a.id] && a.test(session, completed))
      stats.achievements[a.id] = now;
  }
}

// ---------------------------------------------------------------------------
// Analytics aggregation (computed on demand from real history)
// ---------------------------------------------------------------------------

async function buildAnalytics() {
  const [history, stats] = await Promise.all([getHistory(), getStats()]);

  const focusByHour = new Array(24).fill(0); // focused minutes per hour-of-day
  const focusByDay = {}; // YYYY-MM-DD -> focused minutes
  const attemptsBySite = {}; // domain -> attempts
  let totalAttempts = 0;
  let completedCount = 0;

  for (const h of history) {
    const startHour = new Date(h.startTime).getHours();
    const mins = Math.round((h.focusedMs || 0) / 60000);
    focusByHour[startHour] += mins;
    focusByDay[dayKey(h.startTime)] = (focusByDay[dayKey(h.startTime)] || 0) + mins;
    if (h.completed) completedCount += 1;
    const per = h.attempts?.perSite || {};
    for (const [site, c] of Object.entries(per)) {
      attemptsBySite[site] = (attemptsBySite[site] || 0) + c;
      totalAttempts += c;
    }
  }

  // Last 7 days (oldest -> newest) for the trend chart.
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(Date.now() - i * 24 * 60 * 60 * 1000);
    last7.push({ day: key, minutes: focusByDay[key] || 0 });
  }

  // Top distracting sites.
  const topSites = Object.entries(attemptsBySite)
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Best productivity hour = hour with most focused minutes.
  let bestHour = null;
  let bestHourMins = 0;
  focusByHour.forEach((m, h) => {
    if (m > bestHourMins) {
      bestHourMins = m;
      bestHour = h;
    }
  });

  const totalSessions = history.length;
  const completionRate = totalSessions
    ? Math.round((completedCount / totalSessions) * 100)
    : 0;

  // Real, derived insights (clearly computed, never invented).
  const insights = [];
  if (bestHour !== null && bestHourMins > 0) {
    const label = `${String(bestHour).padStart(2, "0")}:00`;
    insights.push(`You focus best around ${label} (${bestHourMins} min logged there).`);
  }
  if (topSites.length) {
    insights.push(
      `Your biggest pull is ${topSites[0].site} (${topSites[0].count} attempts blocked).`
    );
  }
  if (totalSessions >= 3) {
    insights.push(`You complete ${completionRate}% of the sessions you start.`);
  }
  if (stats.streak.current >= 2) {
    insights.push(`You're on a ${stats.streak.current}-day streak — keep it alive.`);
  }
  if (!insights.length) {
    insights.push("Finish a few sessions and your personalized insights will appear here.");
  }

  return {
    stats,
    totals: {
      focusedHours: +(stats.totalFocusedMs / 3600000).toFixed(1),
      totalSessions,
      completedCount,
      completionRate,
      totalAttempts,
    },
    focusByHour,
    last7,
    topSites,
    bestHour,
    insights,
    achievements: [...ACHIEVEMENTS, ...SESSION_ACHIEVEMENTS].map((a) => ({
      id: a.id,
      name: a.name,
      unlockedAt: stats.achievements[a.id] || null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Distraction attempt handling
// ---------------------------------------------------------------------------

async function recordAttempt(rawSite) {
  const session = await getSession();
  if (session.phase !== PHASE_ACTIVE) {
    return { ok: false, reason: "no-active-session" };
  }
  const site = normalizeSite(rawSite) || "unknown";
  session.attempts.total += 1;
  session.attempts.perSite[site] = (session.attempts.perSite[site] || 0) + 1;
  session.attempts.timeline.push({ t: Date.now(), site });
  // Keep the timeline bounded.
  if (session.attempts.timeline.length > 1000) {
    session.attempts.timeline = session.attempts.timeline.slice(-1000);
  }

  // Fire an intervention if a new threshold was crossed.
  const settings = await getSettings();
  let message = session.coachMessage;
  if (settings.coach?.enabled) {
    const crossed = INTERVENTION_THRESHOLDS.filter(
      (t) => session.attempts.total >= t && !session.interventionsFired.includes(t)
    );
    if (crossed.length) {
      session.interventionsFired.push(...crossed);
      const local = buildInterventionMessage(session);
      if (local) message = await maybeEnhanceWithLLM(local, session, settings);
    }
  }
  session.coachMessage = message;
  await setSession(session);

  return {
    ok: true,
    attempts: session.attempts.total,
    perSite: session.attempts.perSite,
    coachMessage: message,
    mode: session.mode,
    endTime: session.endTime,
  };
}

// ---------------------------------------------------------------------------
// Quit / unlock flows (mode-dependent)
// ---------------------------------------------------------------------------

async function requestStop() {
  const session = await getSession();
  if (session.phase !== PHASE_ACTIVE) {
    // Already ended — allow disabling blocking.
    await disableBlocking();
    return { ok: true, stopped: true };
  }

  // Goal/both mode: if the goal is required and met (plus timer if needed), allow.
  if (unlockRequirementsMet(session)) {
    await finalizeSession("goal", true);
    return { ok: true, stopped: true };
  }

  if (session.mode === MODE_SOFT) {
    await finalizeSession("soft-quit", false);
    await clearRules();
    await chrome.storage.local.set({ session: { ...DEFAULT_SESSION } });
    return { ok: true, stopped: true };
  }

  if (session.mode === MODE_HARD) {
    const now = Date.now();
    if (!session.hardUnlockAt) {
      session.hardUnlockAt = now + HARD_MODE_DELAY_MS;
      await setSession(session);
      return { ok: false, reason: "hard-wait", unlockAt: session.hardUnlockAt };
    }
    if (now < session.hardUnlockAt) {
      return { ok: false, reason: "hard-wait", unlockAt: session.hardUnlockAt };
    }
    await finalizeSession("hard-quit", false);
    await clearRules();
    await chrome.storage.local.set({ session: { ...DEFAULT_SESSION } });
    return { ok: true, stopped: true };
  }

  // Extreme: no normal stop. Must use the delayed recovery process.
  return { ok: false, reason: "extreme-locked" };
}

/** Extreme-mode delayed recovery unlock. */
async function requestRecovery() {
  const session = await getSession();
  if (session.phase !== PHASE_ACTIVE || session.mode !== MODE_EXTREME) {
    return { ok: false, reason: "not-applicable" };
  }
  const now = Date.now();
  if (!session.recovery.requestedAt) {
    session.recovery.requestedAt = now;
    session.recovery.unlockAt = now + EXTREME_RECOVERY_DELAY_MS;
    await setSession(session);
    return { ok: false, reason: "recovery-pending", unlockAt: session.recovery.unlockAt };
  }
  if (now < session.recovery.unlockAt) {
    return { ok: false, reason: "recovery-pending", unlockAt: session.recovery.unlockAt };
  }
  // Delay satisfied — allow the unlock.
  await finalizeSession("recovery", false);
  await clearRules();
  await chrome.storage.local.set({ session: { ...DEFAULT_SESSION } });
  return { ok: true, stopped: true };
}

async function completeGoal() {
  const session = await getSession();
  if (session.phase !== PHASE_ACTIVE) return { ok: false };
  session.goal.completed = true;
  await setSession(session);
  // If completing the goal satisfies all requirements, end successfully.
  if (unlockRequirementsMet(session)) {
    await finalizeSession("goal", true);
    return { ok: true, completedSession: true };
  }
  return { ok: true, completedSession: false };
}

async function disableBlocking() {
  const session = await getSession();
  if (session.phase === PHASE_ACTIVE) {
    return { ok: false, reason: "session-active" };
  }
  await clearRules();
  clearAllAlarms();
  await chrome.storage.local.set({ session: { ...DEFAULT_SESSION } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Block list management
// ---------------------------------------------------------------------------

async function listsApi(type, payload) {
  const settings = await getSettings();
  const session = await getSession();
  const locked = session.phase === PHASE_ACTIVE;

  switch (type) {
    case "addList": {
      const name = (payload.name || "").trim() || "Untitled";
      const id = "list_" + generateCode(6).toLowerCase();
      settings.lists.push({ id, name, sites: [] });
      settings.activeListId = id;
      break;
    }
    case "deleteList": {
      if (locked) return { ok: false, reason: "session-active" };
      if (settings.lists.length <= 1) return { ok: false, reason: "need-one-list" };
      settings.lists = settings.lists.filter((l) => l.id !== payload.id);
      if (settings.activeListId === payload.id)
        settings.activeListId = settings.lists[0].id;
      break;
    }
    case "renameList": {
      const l = settings.lists.find((x) => x.id === payload.id);
      if (l) l.name = (payload.name || "").trim() || l.name;
      break;
    }
    case "setActiveList": {
      if (locked) return { ok: false, reason: "session-active" };
      if (settings.lists.some((l) => l.id === payload.id))
        settings.activeListId = payload.id;
      break;
    }
    case "addSite": {
      if (locked) return { ok: false, reason: "session-active" };
      const l = settings.lists.find((x) => x.id === payload.id);
      const site = normalizeSite(payload.site);
      if (l && site && !l.sites.includes(site)) l.sites.push(site);
      break;
    }
    case "removeSite": {
      if (locked) return { ok: false, reason: "session-active" };
      const l = settings.lists.find((x) => x.id === payload.id);
      const site = normalizeSite(payload.site);
      if (l) l.sites = l.sites.filter((s) => s !== site);
      break;
    }
  }
  await setSettings(settings);
  return { ok: true, settings };
}

// ---------------------------------------------------------------------------
// Startup / recovery
// ---------------------------------------------------------------------------

async function init() {
  const stored = await chrome.storage.local.get(["settings", "session", "stats"]);
  if (!stored.settings) {
    // Pull synced settings if present, else defaults.
    let initial = { ...DEFAULT_SETTINGS };
    try {
      const { focusLockSettings } = await chrome.storage.sync.get("focusLockSettings");
      if (focusLockSettings) initial = { ...initial, ...focusLockSettings, syncEnabled: true };
    } catch (_) {
      /* ignore */
    }
    await chrome.storage.local.set({ settings: initial });
  }
  if (!stored.stats) await setStats({ ...DEFAULT_STATS });
  if (!stored.session) await setSession({ ...DEFAULT_SESSION });

  const session = await getSession();
  if (session.phase === PHASE_ACTIVE) {
    if (Date.now() >= session.endTime && !session.goal.requireGoal) {
      await endByTimer();
    } else {
      await applyRules(session.sites);
      scheduleAlarms(session.endTime);
    }
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_END || alarm.name === ALARM_CHECK) {
    const session = await getSession();
    if (session.phase === PHASE_ACTIVE && Date.now() >= session.endTime) {
      await endByTimer();
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "getState": {
          const [settings, session, stats] = await Promise.all([
            getSettings(),
            getSession(),
            getStats(),
          ]);
          sendResponse({ ok: true, settings, session, stats });
          break;
        }
        case "getAnalytics": {
          sendResponse({ ok: true, analytics: await buildAnalytics() });
          break;
        }
        case "saveSettings": {
          await setSettings({ ...(await getSettings()), ...message.settings });
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        }
        case "lists": {
          sendResponse(await listsApi(message.action, message.payload || {}));
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
          const settings = await getSettings();
          const list = getActiveList(settings);
          if (!list || list.sites.length === 0) {
            sendResponse({ ok: false, reason: "no-sites" });
            break;
          }
          const started = await startSession({
            durationMs,
            mode: message.mode,
            goal: message.goal,
          });
          sendResponse({ ok: true, session: started });
          break;
        }
        case "recordAttempt": {
          sendResponse(await recordAttempt(message.site));
          break;
        }
        case "completeGoal": {
          sendResponse(await completeGoal());
          break;
        }
        case "requestStop": {
          sendResponse(await requestStop());
          break;
        }
        case "requestRecovery": {
          sendResponse(await requestRecovery());
          break;
        }
        case "disableBlocking": {
          sendResponse(await disableBlocking());
          break;
        }
        default:
          sendResponse({ ok: false, reason: "unknown-message" });
      }
    } catch (err) {
      sendResponse({ ok: false, reason: "error", error: String(err) });
    }
  })();
  return true;
});

init();
