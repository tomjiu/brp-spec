/**
 * v0.6.0 tabGroups Coloring (Experimental)
 *
 * Uses Firefox v139+ browser.tabGroups API to colorize browser tabs.
 * Falls back silently to page-indicator (v0.5.1) when API is unavailable.
 *
 * Design:
 * - Only coloring — no lifecycle management (no move/restore tabs)
 * - All operations are try-catch (never block main flow)
 * - Experimental: may not work on Zen or Firefox < v139
 */

const BRP_GROUP_TITLE = "BRP";
const COLOR_IDLE = "blue";
const COLOR_ACTIVE = "green";
const COLOR_ERROR = "yellow";

/** Check if the tabGroups API is available in this runtime. */
/** Check if the tabGroups API is available in this runtime. */
export function isTabGroupsSupported(): boolean {
  return typeof browser.tabGroups !== "undefined";
}

/**
 * Add tab(s) to the BRP group with idle (blue) color.
 * Silent no-op when tabGroups is unsupported or on error.
 */
export async function addToGroup(tabIds: number | number[]): Promise<void> {
  if (!isTabGroupsSupported()) return;
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  if (ids.length === 0) return;

  try {
    const groupId = await browser.tabs.group({ tabIds: ids });
    // biome-ignore lint/suspicious/noExplicitAny: Firefox color enum not in @types
    await browser.tabGroups.update(groupId, {
      title: BRP_GROUP_TITLE,
      color: COLOR_IDLE as any,
    });
  } catch {
    // silent fallback — browser.tabGroups may not be fully supported
  }
}

/**
 * Update the tab's group color based on request status.
 * - idle (blue): AI not currently operating on this tab
 * - active (green): AI request in progress
 * - error (yellow): permission denied / error
 *
 * Silent no-op when tabGroups is unsupported, tab not in a group, or on error.
 */
export async function updateGroupColor(
  tabId: number,
  status: "idle" | "active" | "error",
): Promise<void> {
  if (!isTabGroupsSupported()) return;

  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.groupId === undefined || tab.groupId === -1) return;

    const color =
      status === "active" ? COLOR_ACTIVE :
      status === "error" ? COLOR_ERROR : COLOR_IDLE;
    // biome-ignore lint/suspicious/noExplicitAny: Firefox color enum not in @types
    await browser.tabGroups.update(tab.groupId, { color: color as any });
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
