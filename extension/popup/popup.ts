/**
 * v0.5.2 Popup — Tab Controllable Management.
 *
 * Lists all tabs in the current window with controllable toggle buttons.
 * Reads controllable state from background via runtime message.
 */
/// <reference types="firefox-webext-browser" />

async function loadTabs(): Promise<void> {
  const listEl = document.getElementById("tab-list")!;
  listEl.innerHTML = "";

  try {
    const [tabs, controllable] = await Promise.all([
      browser.tabs.query({ currentWindow: true }),
      getControllableSet(),
    ]);

    if (tabs.length === 0) {
      listEl.innerHTML = '<div class="empty">No tabs in this window</div>';
      return;
    }

    for (const tab of tabs) {
      if (!tab.id) continue;
      const isControllable = controllable.has(tab.id);

      const item = document.createElement("div");
      item.className = "tab-item";

      // favicon
      const img = document.createElement("img");
      img.src = tab.favIconUrl || "";
      img.onerror = () => { img.src = ""; };

      // title
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = tab.title || tab.url || "(untitled)";
      title.title = tab.url || "";

      // toggle button
      const toggle = document.createElement("button");
      toggle.className = `toggle ${isControllable ? "on" : "off"}`;
      toggle.textContent = isControllable ? "On" : "Off";
      toggle.addEventListener("click", () => {
        void toggleControllable(tab.id!, !isControllable, toggle);
      });

      item.appendChild(img);
      item.appendChild(title);
      item.appendChild(toggle);
      listEl.appendChild(item);
    }
  } catch (e: unknown) {
    listEl.innerHTML = `<div class="empty">Error: ${e instanceof Error ? e.message : String(e)}</div>`;
  }
}

async function getControllableSet(): Promise<Set<number>> {
  try {
    const resp = await browser.runtime.sendMessage({ action: "__brp_get_controllable_tabs__" });
    if (resp && Array.isArray(resp.controllable)) {
      return new Set(resp.controllable);
    }
  } catch { /* background may not respond immediately */ }
  return new Set();
}

async function toggleControllable(
  tabId: number,
  makeControllable: boolean,
  toggleBtn: HTMLButtonElement,
): Promise<void> {
  try {
    // Set via tab.setControllable (reuses the existing method)
    await browser.runtime.sendMessage({
      jsonrpc: "2.0",
      method: "tab.setControllable",
      params: { tabId, controllable: makeControllable },
    });
    // Update button style
    toggleBtn.className = `toggle ${makeControllable ? "on" : "off"}`;
    toggleBtn.textContent = makeControllable ? "On" : "Off";
  } catch (e: unknown) {
    console.error("Failed to toggle controllable:", e);
  }
}

loadTabs();
