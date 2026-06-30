/**
 * Focus Lock AI - analytics dashboard.
 * Requests the aggregated analytics from the background (all derived from the
 * user's real local history) and renders charts, a heatmap, insights and
 * achievements. No external chart libraries — everything is plain DOM/CSS.
 */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (r) => resolve(r || {}));
  });
}

const ACH_ICONS = {
  first_focus: "🎯",
  focus_5h: "⏳",
  focus_25h: "🔥",
  streak_3: "📅",
  streak_7: "🗓️",
  level_5: "⭐",
  zero_distraction: "🛡️",
  deep_work_2h: "🧠",
  extreme_done: "💪",
  early_bird: "🌅",
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function el(id) {
  return document.getElementById(id);
}

function levelBounds(level) {
  const start = Math.pow(level - 1, 2) * 100;
  const next = Math.pow(level, 2) * 100;
  return { start, next };
}

function render(a) {
  const { stats, totals } = a;

  // Level + XP
  el("level").textContent = `Lv ${stats.level}`;
  const { start, next } = levelBounds(stats.level);
  const pct = next > start ? ((stats.xp - start) / (next - start)) * 100 : 0;
  el("xp-fill").style.width = `${Math.min(100, Math.max(0, pct))}%`;
  el("xp-text").textContent = `${stats.xp} XP`;

  // Headline stats
  el("s-hours").textContent = totals.focusedHours;
  el("s-sessions").textContent = totals.totalSessions;
  el("s-rate").textContent = `${totals.completionRate}%`;
  el("s-attempts").textContent = totals.totalAttempts;
  el("s-streak").textContent = stats.streak.current;
  el("s-longest").textContent = stats.streak.longest;

  // Insights
  const insights = el("insights");
  insights.innerHTML = "";
  a.insights.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    insights.appendChild(li);
  });

  // 7-day bar chart
  const chart = el("bar-chart");
  chart.innerHTML = "";
  const maxMin = Math.max(1, ...a.last7.map((d) => d.minutes));
  a.last7.forEach((d) => {
    const col = document.createElement("div");
    col.className = "bar-col";
    const val = document.createElement("span");
    val.className = "bar-val";
    val.textContent = d.minutes ? d.minutes : "";
    const bar = document.createElement("div");
    bar.className = "bar" + (d.minutes ? "" : " empty");
    bar.style.height = `${(d.minutes / maxMin) * 100}%`;
    const day = document.createElement("span");
    day.className = "bar-day";
    day.textContent = DOW[new Date(d.day + "T00:00:00").getDay()];
    col.append(val, bar, day);
    chart.appendChild(col);
  });

  // Top distracting sites
  const top = el("top-sites");
  top.innerHTML = "";
  if (!a.topSites.length) {
    top.innerHTML = '<p class="empty-note">No distraction attempts recorded yet.</p>';
  } else {
    const maxC = Math.max(...a.topSites.map((s) => s.count));
    a.topSites.forEach((s) => {
      const row = document.createElement("div");
      row.className = "site-row";
      row.innerHTML = `
        <span class="site-name">${escapeHtml(s.site)}</span>
        <span class="site-bar-track"><span class="site-bar-fill" style="width:${(s.count / maxC) * 100}%"></span></span>
        <span class="site-count">${s.count}</span>`;
      top.appendChild(row);
    });
  }

  // Hour-of-day heatmap
  const heat = el("heatmap");
  heat.innerHTML = "";
  const maxH = Math.max(1, ...a.focusByHour);
  a.focusByHour.forEach((mins, hour) => {
    const cell = document.createElement("div");
    cell.className = "heat-cell";
    const intensity = mins / maxH;
    if (mins > 0) {
      cell.style.background = `rgba(61, 220, 151, ${0.15 + intensity * 0.85})`;
      cell.style.borderColor = "transparent";
    }
    cell.title = `${String(hour).padStart(2, "0")}:00 — ${mins} min`;
    heat.appendChild(cell);
  });

  // Achievements
  const ach = el("achievements");
  ach.innerHTML = "";
  a.achievements.forEach((item) => {
    const div = document.createElement("div");
    div.className = "ach" + (item.unlockedAt ? " unlocked" : "");
    const date = item.unlockedAt
      ? new Date(item.unlockedAt).toLocaleDateString()
      : "Locked";
    div.innerHTML = `
      <div class="ach-icon">${ACH_ICONS[item.id] || "🏅"}</div>
      <div class="ach-name">${escapeHtml(item.name)}</div>
      <div class="ach-date">${date}</div>`;
    ach.appendChild(div);
  });

  // Weekly report (computed narrative)
  el("report-body").textContent = buildReport(a);
}

function buildReport(a) {
  const { stats, totals } = a;
  const weekMin = a.last7.reduce((sum, d) => sum + d.minutes, 0);
  const weekHrs = (weekMin / 60).toFixed(1);
  if (totals.totalSessions === 0) {
    return "You haven't completed any focus sessions yet. Start your first session from the popup — your weekly report will fill in with real data as you go.";
  }
  const parts = [];
  parts.push(`This week you focused for about ${weekHrs} hours across your sessions.`);
  if (a.bestHour !== null) {
    parts.push(`Your most productive time of day is around ${String(a.bestHour).padStart(2, "0")}:00.`);
  }
  parts.push(`You complete ${totals.completionRate}% of the sessions you start.`);
  if (a.topSites.length) {
    parts.push(`Your top distraction is ${a.topSites[0].site} with ${a.topSites[0].count} blocked attempts.`);
  }
  if (stats.streak.current >= 1) {
    parts.push(`Current streak: ${stats.streak.current} day(s); your best is ${stats.streak.longest}.`);
  }
  parts.push("Reward consistency over intensity — small, repeated sessions compound.");
  return parts.join(" ");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function load() {
  const res = await send({ type: "getAnalytics" });
  if (res.ok) render(res.analytics);
}

load();
