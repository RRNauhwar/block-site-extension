/**
 * Focus Lock AI - settings page logic.
 * Manages block lists, focus-mode docs, coach/LLM config, sync and privacy.
 * Block-list editing is disabled while a session is active.
 */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (r) => resolve(r || {}));
  });
}

// Elements
const activeWarning = document.getElementById("active-warning");
const listPicker = document.getElementById("list-picker");
const addListBtn = document.getElementById("add-list");
const renameListBtn = document.getElementById("rename-list");
const deleteListBtn = document.getElementById("delete-list");
const siteInput = document.getElementById("site-input");
const addSiteBtn = document.getElementById("add-site");
const siteList = document.getElementById("site-list");

const coachEnabled = document.getElementById("coach-enabled");
const llmEnabled = document.getElementById("llm-enabled");
const llmBase = document.getElementById("llm-base");
const llmModel = document.getElementById("llm-model");
const llmKey = document.getElementById("llm-key");
const syncEnabled = document.getElementById("sync-enabled");
const saveBtn = document.getElementById("save");
const savedNote = document.getElementById("saved-note");

let settings = null;
let sessionActive = false;

function currentList() {
  return settings.lists.find((l) => l.id === listPicker.value) || settings.lists[0];
}

function renderListPicker() {
  listPicker.innerHTML = "";
  settings.lists.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = `${l.name} (${l.sites.length})`;
    if (l.id === settings.activeListId) opt.selected = true;
    listPicker.appendChild(opt);
  });
}

function renderSites() {
  const list = currentList();
  siteList.innerHTML = "";
  if (!list || !list.sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites in this list yet";
    siteList.appendChild(li);
    return;
  }
  list.sites.forEach((site) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = site;
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.textContent = "\u00d7";
    btn.disabled = sessionActive;
    btn.addEventListener("click", () => removeSite(site));
    li.append(span, btn);
    siteList.appendChild(li);
  });
}

function renderCoach() {
  coachEnabled.checked = settings.coach?.enabled !== false;
  const llm = settings.coach?.llm || {};
  llmEnabled.checked = !!llm.enabled;
  llmBase.value = llm.baseUrl || "";
  llmModel.value = llm.model || "";
  llmKey.value = llm.apiKey || "";
  syncEnabled.checked = !!settings.syncEnabled;
}

function applyLockState() {
  activeWarning.classList.toggle("hidden", !sessionActive);
  [addListBtn, deleteListBtn, siteInput, addSiteBtn].forEach((el) => {
    el.disabled = sessionActive;
  });
}

async function load() {
  const state = await send({ type: "getState" });
  if (!state.ok) return;
  settings = state.settings;
  sessionActive = state.session.phase === "active";
  renderListPicker();
  renderSites();
  renderCoach();
  applyLockState();
}

// --- List operations (persisted immediately via background) -----------------
async function refreshSettings(res) {
  if (res && res.ok && res.settings) {
    settings = res.settings;
    renderListPicker();
    renderSites();
  }
}

addListBtn.addEventListener("click", async () => {
  const name = prompt("Name your new block list:", "New list");
  if (name === null) return;
  await refreshSettings(await send({ type: "lists", action: "addList", payload: { name } }));
});

renameListBtn.addEventListener("click", async () => {
  const list = currentList();
  if (!list) return;
  const name = prompt("Rename list:", list.name);
  if (name === null) return;
  await refreshSettings(
    await send({ type: "lists", action: "renameList", payload: { id: list.id, name } })
  );
});

deleteListBtn.addEventListener("click", async () => {
  const list = currentList();
  if (!list) return;
  if (!confirm(`Delete list "${list.name}"?`)) return;
  const res = await send({ type: "lists", action: "deleteList", payload: { id: list.id } });
  if (res.ok) await refreshSettings(res);
  else if (res.reason === "need-one-list") alert("Keep at least one list.");
  else if (res.reason === "session-active") alert("Can't delete during an active session.");
});

listPicker.addEventListener("change", async () => {
  await send({ type: "lists", action: "setActiveList", payload: { id: listPicker.value } });
  renderSites();
});

async function addSite() {
  const value = siteInput.value.trim();
  if (!value) return;
  const list = currentList();
  const res = await send({
    type: "lists", action: "addSite", payload: { id: list.id, site: value },
  });
  if (res.ok) {
    siteInput.value = "";
    await refreshSettings(res);
  }
}
addSiteBtn.addEventListener("click", addSite);
siteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addSite(); });

async function removeSite(site) {
  const list = currentList();
  const res = await send({
    type: "lists", action: "removeSite", payload: { id: list.id, site },
  });
  if (res.ok) await refreshSettings(res);
}

// --- Save coach / sync settings ---------------------------------------------
saveBtn.addEventListener("click", async () => {
  const updated = {
    ...settings,
    coach: {
      enabled: coachEnabled.checked,
      llm: {
        enabled: llmEnabled.checked,
        baseUrl: llmBase.value.trim(),
        model: llmModel.value.trim(),
        apiKey: llmKey.value,
      },
    },
    syncEnabled: syncEnabled.checked,
  };
  const res = await send({ type: "saveSettings", settings: updated });
  if (res.ok) {
    settings = res.settings;
    savedNote.classList.remove("hidden");
    setTimeout(() => savedNote.classList.add("hidden"), 1800);
  }
});

// Keep in sync if state changes elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.session || changes.settings)) load();
});

load();
