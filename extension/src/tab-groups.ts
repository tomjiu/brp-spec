/**
 * v0.6.0 tabGroups Coloring (Experimental)
 *
 * Uses Firefox v139+ browser.tabGroups API to colorize browser tabs.
 * Falls back silently to page-indicator (v0.5.1) when API is unavailable.
 *
 * Design:
 * - All BRP-controlled tabs in a window share ONE group (avoids duplicates)
 * - addToGroup: finds existing BRP group first, creates only if none exists
 * - updateGroupColor: updates existing group color in-place (no ungroup needed)
 * - Group titles are empty (Firefox shows just the color dot)
 * - Firefox auto-deletes empty groups
 * - All operations are try-catch (never block main flow)
 */

// idle = same green as active (simplified: only 操控中(绿) and 故障(黄))
const COLOR_IDLE = "green";
const COLOR_ACTIVE = "green";
const COLOR_ERROR = "yellow";

const GROUP_TITLE = "";  // empty: Firefox shows just a compact color indicator

/** Check if the tabGroups API is available in this runtime. */
export function isTabGroupsSupported(): boolean {
  return typeof browser.tabGroups !== "undefined";
}

/**
 * Find an existing BRP group in the same window as the given tab.
 * Returns the group ID if found, otherwise null.
 */
async function findExistingGroup(tabId: number): Promise<number | null> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.windowId) return null;
    const groups = await browser.tabGroups.query({ windowId: tab.windowId });
    const brp = groups.find(g => g.title === GROUP_TITLE);
    return brp ? brp.id : null;
  } catch {
    return null;
  }
}

/**
 * Add tab(s) to the BRP group. Reuses existing group if one exists
 * in the same window; otherwise creates a new one.
 * Multiple tabs passed together share one group.
 * Silent no-op when tabGroups is unsupported or on error.
 */
export async function addToGroup(tabIds: number | number[]): Promise<void> {
  if (!isTabGroupsSupported()) return;
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  if (ids.length === 0) return;

  try {
    const existingId = await findExistingGroup(ids[0]);
    if (existingId !== null) {
      // Join existing BRP group — all tabs share one group
      await browser.tabs.group({ tabIds: ids, groupId: existingId });
    } else {
      const groupId = await browser.tabs.group({ tabIds: ids });
      await browser.tabGroups.update(groupId, {
        title: GROUP_TITLE,
        color: COLOR_IDLE as any,
      });
    }
  } catch {
    // silent fallback
  }
}

/**
 * Update the tab's group color to reflect request status.
 * Tries to update the existing BRP group color in-place first;
 * falls back to ungroup + re-group if the group can't be found.
 *
 * - idle (green): AI not currently operating on this tab
 * - active (green): AI request in progress
 * - error (yellow): permission denied / error
 *
 * Silent no-op when tabGroups is unsupported or on error.
 */
export async function updateGroupColor(
  tabId: number,
  status: "idle" | "active" | "error",
): Promise<void> {
  if (!isTabGroupsSupported()) return;

  try {
    const color =
      status === "active" ? COLOR_ACTIVE :
      status === "error" ? COLOR_ERROR : COLOR_IDLE;

    // Try updating the existing BRP group's color in-place
    const existingId = await findExistingGroup(tabId);
    if (existingId !== null) {
      await browser.tabGroups.update(existingId, {
        title: GROUP_TITLE,
        color: color as any,
      });
      return;
    }

    // Fallback: ungroup and re-group (tab not yet in a BRP group)
    await browser.tabs.ungroup(tabId);
    const groupId = await browser.tabs.group({ tabIds: [tabId] });
    await browser.tabGroups.update(groupId, {
      title: GROUP_TITLE,
      color: color as any,
    });
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
