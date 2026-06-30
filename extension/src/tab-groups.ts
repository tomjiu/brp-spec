/**
 * v0.8.0 tabGroups — Three fixed groups, tabs move between them
 *
 * Uses Firefox v139+ browser.tabGroups API. Falls back silently to
 * page-indicator (v0.5.1) when API is unavailable.
 *
 * Design:
 * - At most 3 BRP groups per window:  idle (blue) / active (green) / error (yellow)
 * - Groups are identified by title: "BRP-idle", "BRP-active", "BRP-error"
 * - updateGroupColor ungroups the tab then moves it into the target group
 * - Empty groups survive (Firefox keeps them) — no new-group proliferation
 * - All operations are try-catch (never block main flow)
 */

const COLOR_IDLE = "blue";
const COLOR_ACTIVE = "green";
const COLOR_ERROR = "yellow";

const TITLE_IDLE = "BRP-idle";
const TITLE_ACTIVE = "BRP-active";
const TITLE_ERROR = "BRP-error";

function titleFor(status: "idle" | "active" | "error"): string {
  switch (status) {
    case "active": return TITLE_ACTIVE;
    case "error":  return TITLE_ERROR;
    default:       return TITLE_IDLE;
  }
}

function colorFor(status: "idle" | "active" | "error"): string {
  switch (status) {
    case "active": return COLOR_ACTIVE;
    case "error":  return COLOR_ERROR;
    default:       return COLOR_IDLE;
  }
}

/** Check if the tabGroups API is available in this runtime. */
export function isTabGroupsSupported(): boolean {
  return typeof browser.tabGroups !== "undefined";
}

/**
 * Find an existing BRP group in the same window by title.
 * Returns the group ID if found, otherwise null.
 */
async function findGroupByTitle(
  tabId: number,
  title: string,
): Promise<number | null> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.windowId) return null;
    const groups = await browser.tabGroups.query({ windowId: tab.windowId });
    const found = groups.find(g => g.title === title);
    return found ? found.id : null;
  } catch {
    return null;
  }
}

/**
 * Get or create the group for a given status, using `tabId` to locate
 * the correct window.  Returns the group ID on success, null on error.
 */
async function ensureGroup(
  tabId: number,
  status: "idle" | "active" | "error",
): Promise<number | null> {
  const title = titleFor(status);
  const existing = await findGroupByTitle(tabId, title);
  if (existing !== null) return existing;

  // Ungroup first so we don't steal another group's tab
  try { await browser.tabs.ungroup(tabId); } catch { /* ignore */ }

  const groupId = await browser.tabs.group({ tabIds: [tabId] });
  await browser.tabGroups.update(groupId, {
    title,
    color: colorFor(status) as any,
  });
  return groupId;
}

/**
 * Add tab(s) to the idle (blue) group.
 * Silent no-op when tabGroups is unsupported or on error.
 */
export async function addToGroup(tabIds: number | number[]): Promise<void> {
  if (!isTabGroupsSupported()) return;
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  if (ids.length === 0) return;

  try {
    const groupId = await ensureGroup(ids[0]!, "idle");
    if (groupId === null) return;

    // Add all tabs at once — Firefox lets us specify groupId
    await browser.tabs.group({ tabIds: ids, groupId });
  } catch {
    // silent fallback
  }
}

/**
 * Move a tab into the coloured group that matches its status.
 *
 * - idle  → blue   — AI not currently operating on this tab
 * - active → green  — AI request in progress
 * - error  → yellow — permission denied / error
 *
 * Silent no-op when tabGroups is unsupported or on error.
 */
export async function updateGroupColor(
  tabId: number,
  status: "idle" | "active" | "error",
): Promise<void> {
  if (!isTabGroupsSupported()) return;

  try {
    const groupId = await ensureGroup(tabId, status);
    if (groupId !== null) {
      // Move the tab into the right group (ungroup then re-group)
      await browser.tabs.ungroup(tabId);
      await browser.tabs.group({ tabIds: [tabId], groupId });
    }
  } catch {
    // silent fallback
  }
}

/**
 * Remove a tab from its group (demote to not-controllable).
 * Silent no-op when tabGroups is unsupported or on error.
 */
export async function removeFromGroup(tabId: number): Promise<void> {
  if (!isTabGroupsSupported()) return;

  try {
    await browser.tabs.ungroup(tabId);
  } catch {
    // silent fallback
  }
}
