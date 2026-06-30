# Focus Lock AI — Architecture & Roadmap

This document is deliberately honest about **what is built today** (a fully
working Chrome extension) and **what the full "global productivity platform"
vision requires** beyond a browser extension. Nothing here is mocked or faked —
features that need native apps, a backend, or billing are listed as roadmap, not
shipped as empty UI.

---

## 1. What ships today (this repository)

A complete, privacy-first **Manifest V3 Chrome extension**. Everything runs
locally; there is no backend and no telemetry.

| Area | Status | Notes |
|------|--------|-------|
| Intelligent focus sessions (15m / 30m / 1h / 2h / custom) | ✅ Done | `background.js` |
| Website blocking via `declarativeNetRequest` | ✅ Done | dynamic redirect rules |
| Unlimited custom block lists | ✅ Done | named lists, active-list selection |
| Focus modes: Soft / Hard / Extreme | ✅ Done | Hard = 2-min quit delay; Extreme = 10-min recovery unlock |
| Extreme recovery code | ✅ Done | crypto-random, stored in local history |
| Real distraction-attempt tracking | ✅ Done | each blocked navigation = 1 attempt |
| AI Intervention Engine | ✅ Done (rule-based) | escalates at 5 / 10 / 20 / 35 attempts, non-guilt |
| Optional LLM coaching | ✅ Done (opt-in) | user supplies an OpenAI-compatible endpoint + key |
| Goal-based unlocking (timer / goal / both) | ✅ Done | self-reported goal completion |
| Productivity analytics dashboard | ✅ Done | focus hours, completion rate, attempts, top sites, best hours, streaks, 7-day chart, hour-of-day heatmap |
| Weekly report (computed) | ✅ Done | narrative generated from real data |
| Gamification: XP, levels, streaks, achievements | ✅ Done | all derived from real history |
| Privacy-first storage | ✅ Done | `chrome.storage.local`; optional `chrome.storage.sync` for lists/settings |
| Cross-device sync (Chrome profile) | ✅ Partial | lists + settings only, via Chrome sync; analytics stay local |
| Strict-mode / enterprise guidance | ✅ Done | documented in Settings |

### Honest limitations of the extension layer
A Chrome extension is sandboxed to the browser. It **cannot**:
- Block desktop applications, mobile applications, or OS notifications.
- Prevent its own uninstall/disable (only enterprise policy can).
- Sync analytics across *different* browsers/devices without a backend.

These are physical platform boundaries, not missing code. The strongest
technically-possible alternatives (force-install policy, managed Chrome,
restricted OS accounts) are documented in the Settings page.

---

## 2. Target platform architecture (roadmap)

To deliver the full multi-device, AI-accountability platform, the extension
becomes one **client** among several around a shared sync + AI core.

```
        ┌──────────────────────────────────────────────────────┐
        │                     Clients                           │
        │  Chrome ext │ Windows │ macOS │ Android │ iOS │ Web    │
        └──────┬───────────┬────────┬───────┬───────┬───────────┘
               │ local-first store (SQLite / IndexedDB)          │
               │ end-to-end encrypted sync envelope              │
        ┌──────▼──────────────────────────────────────────────┐
        │                Sync & API Gateway                    │
        │  Auth (OIDC/SAML) │ Sync service │ Rate limiting      │
        └──────┬───────────────────────┬──────────────────────┘
               │                       │
     ┌─────────▼────────┐     ┌────────▼─────────┐
     │  Data services   │     │   AI services    │
     │  Postgres (multi-│     │  Coaching/report │
     │  tenant) + Redis │     │  LLM + RAG over  │
     │  + object store  │     │  user's own data │
     └──────────────────┘     └──────────────────┘
```

### 2.1 Native enforcement (desktop & mobile)
The capabilities a browser cannot provide:
- **Windows**: a background service + WFP/filter driver or a lightweight proxy
  to block apps/domains; lock via a signed service the user can't kill.
- **macOS**: Network Extension (content filter) + Screen Time / Family Controls
  APIs; managed via MDM for uninstall protection.
- **Android**: `VpnService`-based local filter + `UsageStatsManager`;
  Device Owner / Family Link for enforcement.
- **iOS**: Screen Time `ManagedSettings` + `DeviceActivity` + `FamilyControls`
  (the only Apple-sanctioned way to block apps).

These share session/goal/blocklist state with the extension through the sync
core, so a session started on the phone also locks the browser.

### 2.2 Sync core
- **Local-first**: each client owns the source of truth and works offline.
- **Conflict resolution**: per-record CRDT or last-writer-wins with vector
  clocks for sessions/goals/lists.
- **End-to-end encryption**: client-side keys; the server stores only encrypted
  blobs. Privacy stays a competitive advantage.

### 2.3 AI services
- The in-extension rule engine remains the **offline baseline**.
- A server-side coach uses an LLM with retrieval over the user's *own*
  (consented, encrypted) history to produce reports and interventions.
- Strict guardrails: no guilt-based messaging, no dark patterns.

### 2.4 Accountability groups (Team/Business tiers)
- Shared sessions, leaderboards, group goals, challenges.
- Multi-tenant data model with org → team → member hierarchy.
- Admin dashboards and department reporting for Business/Enterprise.

### 2.5 Billing & plans
- Free / Premium ($1/mo) / Team ($3/user, min 5) / Business ($5/user) / Enterprise.
- Stripe (or similar) for self-serve; invoicing + SSO (SAML/OIDC) for Enterprise.
- Entitlements enforced server-side; clients degrade gracefully offline.

### 2.6 Scale
- Stateless API behind a gateway; horizontal autoscaling.
- Postgres with read replicas + partitioning by tenant; Redis for hot state.
- Sync designed so the bulk of reads/writes stay on-device, keeping
  server load proportional to *sync deltas*, not total usage — this is what
  makes "tens of millions of users" tractable.

---

## 3. Guiding principles (apply to every layer)

- **Every metric is real.** No fake counters, users, reviews, or stats.
- **No dark patterns.** Interventions encourage reflection, not guilt.
- **Privacy-first.** Local-first by default; encrypt anything that leaves the device.
- **Reward consistency, not addiction.** Gamification celebrates streaks and
  completion, never compulsive usage.

---

## 4. Suggested build order

1. ✅ Chrome extension (this repo) — validate the core loop & UX.
2. Sync core + auth + encrypted storage (unlocks real cross-device).
3. Desktop apps (Windows/macOS) for app-level blocking + uninstall protection.
4. Mobile apps (Android/iOS) using OS-sanctioned focus APIs.
5. Server-side AI coach & automated weekly/monthly reports.
6. Teams/groups + admin dashboards.
7. Billing, SSO, compliance, Enterprise deployment.
