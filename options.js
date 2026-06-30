/**
 * Focus Lock - options/settings page logic.
 * Lets the user manage the block list (only when no session is active) and
 * explains strict-mode / enterprise enforcement options.
 */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response || {}));
  });
}

const siteInput = document.getElementById("site-input");
const addSiteBtn = document.getElementById("add-site");
const siteList = document.getElementById("site-list");
const activeWarning = document.getElementById("active-warning");

let sessionActive = false;

/** Render the block list, disabling edits while a session is active. */
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
    btn.disabled = sessionActive;
    btn.addEventListener("click", () => removeSite(site));
    li.append(span, btn);
    siteList.appendChild(li);
  });
}

async function load() {
  const state = await send({ type: "getState" });
  if (!state.ok) return;
  sessionActive = state.session.phase === "active";

  activeWarning.classList.toggle("hidden", !sessionActive);
  siteInput.disabled = sessionActive;
  addSiteBtn.disabled = sessionActive;

  renderSiteList(state.blockedSites);
}

async function addSite() {
  const value = siteInput.value.trim();
  if (!value) return;
  const res = await send({ type: "addSite", site: value });
  if (res.ok) {
    siteInput.value = "";
    renderSiteList(res.blockedSites);
  }
}

async function removeSite(site) {
  const res = await send({ type: "removeSite", site });
  if (res.ok) renderSiteList(res.blockedSites);
}

addSiteBtn.addEventListener("click", addSite);
siteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

// Keep the page in sync if the session state changes in another tab/popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.session || changes.blockedSites)) {
    load();
  }
});

load();
