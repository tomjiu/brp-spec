/**
 * v0.8.0: tab-groups.ts tests — three fixed groups (idle/active/error)
 *
 * IMPORTANT: All tests import real code from ../src/tab-groups.
 * No reimplementation — mocking only stubs browser APIs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isTabGroupsSupported,
  addToGroup,
  updateGroupColor,
  removeFromGroup,
} from "../src/tab-groups";

// ── Mock browser globals ──
const mockedGroup = vi.fn().mockResolvedValue(42);
const mockedUngroup = vi.fn().mockResolvedValue(undefined);
const mockedTabGroupsUpdate = vi.fn().mockResolvedValue(undefined);

function resetMocks() {
  mockedGroup.mockReset().mockResolvedValue(42);
  mockedUngroup.mockReset().mockResolvedValue(undefined);
  mockedTabGroupsUpdate.mockReset().mockResolvedValue(undefined);
}

(globalThis as Record<string, unknown>).browser = {
  tabs: {
    group: mockedGroup,
    ungroup: mockedUngroup,
    get: vi.fn().mockResolvedValue({ id: 1, windowId: 1 }),
  },
  tabGroups: {
    update: mockedTabGroupsUpdate,
    // Return empty array → ensureGroup always creates new groups
    query: vi.fn().mockResolvedValue([]),
  },
};

// ── isTabGroupsSupported ──
describe("isTabGroupsSupported", () => {
  it("should return true when browser.tabGroups exists", () => {
    expect(isTabGroupsSupported()).toBe(true);
  });

  it("should return false when browser.tabGroups is missing", () => {
    const saved = (browser as Record<string, unknown>).tabGroups;
    delete (browser as Record<string, unknown>).tabGroups;
    expect(isTabGroupsSupported()).toBe(false);
    (browser as Record<string, unknown>).tabGroups = saved;
  });
});

// ── addToGroup ──
describe("addToGroup", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("should create idle (blue) group for single tab", async () => {
    await addToGroup(5);
    // first call: ungroup, then group to create the group
    expect(mockedGroup).toHaveBeenCalledWith({ tabIds: [5] });
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, {
      title: "BRP-idle",
      color: "blue",
    });
  });

  it("should handle array of tab ids", async () => {
    await addToGroup([1, 2, 3]);
    // ensureGroup creates the group with first tab, then addToGroup adds all
    expect(mockedGroup).toHaveBeenCalledWith({ tabIds: [1, 2, 3], groupId: 42 });
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, {
      title: "BRP-idle",
      color: "blue",
    });
  });

  it("should be no-op when tabGroups is unsupported", async () => {
    const saved = (browser as Record<string, unknown>).tabGroups;
    delete (browser as Record<string, unknown>).tabGroups;
    await expect(addToGroup(1)).resolves.toBeUndefined();
    (browser as Record<string, unknown>).tabGroups = saved;
  });

  it("should be no-op on empty array", async () => {
    await addToGroup([]);
    expect(mockedGroup).not.toHaveBeenCalled();
  });

  it("should catch and ignore errors silently", async () => {
    mockedGroup.mockRejectedValueOnce(new Error("fail"));
    await expect(addToGroup(1)).resolves.toBeUndefined();
  });
});

// ── updateGroupColor ──
describe("updateGroupColor", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("should move tab to active (green) group", async () => {
    await updateGroupColor(1, "active");
    // ensureGroup: ungroup + create group + set title/color
    // then: ungroup + move tab into group
    expect(mockedUngroup).toHaveBeenCalled();
    expect(mockedGroup).toHaveBeenCalled();
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, {
      title: "BRP-active",
      color: "green",
    });
  });

  it("should move tab to idle (blue) group", async () => {
    await updateGroupColor(1, "idle");
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, {
      title: "BRP-idle",
      color: "blue",
    });
  });

  it("should move tab to error (yellow) group", async () => {
    await updateGroupColor(1, "error");
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, {
      title: "BRP-error",
      color: "yellow",
    });
  });

  it("should be no-op when tabGroups is unsupported", async () => {
    const saved = (browser as Record<string, unknown>).tabGroups;
    delete (browser as Record<string, unknown>).tabGroups;
    await expect(updateGroupColor(1, "active")).resolves.toBeUndefined();
    (browser as Record<string, unknown>).tabGroups = saved;
  });

  it("should catch and ignore errors silently", async () => {
    mockedUngroup.mockRejectedValueOnce(new Error("fail"));
    await expect(updateGroupColor(1, "error")).resolves.toBeUndefined();
  });
});

// ── removeFromGroup ──
describe("removeFromGroup", () => {
  beforeEach(() => {
    resetMocks();
    mockedUngroup.mockClear();
  });

  it("should call browser.tabs.ungroup with tab id", async () => {
    await removeFromGroup(5);
    expect(mockedUngroup).toHaveBeenCalledWith(5);
  });

  it("should be no-op when tabGroups is unsupported", async () => {
    const saved = (browser as Record<string, unknown>).tabGroups;
    delete (browser as Record<string, unknown>).tabGroups;
    await expect(removeFromGroup(5)).resolves.toBeUndefined();
    (browser as Record<string, unknown>).tabGroups = saved;
  });
});
