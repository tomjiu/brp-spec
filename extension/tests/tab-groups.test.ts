/**
 * v0.6.0: tab-groups.ts tests
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
// tab-groups.ts imports from the firefox-webext-browser types.
// Tests stub browser.tabs / browser.tabGroups via the globalThis.browser object.

const mockedGroup = vi.fn().mockResolvedValue(42);
const mockedUngroup = vi.fn().mockResolvedValue(undefined);
const mockedTabGet = vi.fn().mockResolvedValue({ id: 1, groupId: 42 });
const mockedTabGroupsUpdate = vi.fn().mockResolvedValue(undefined);

(globalThis as Record<string, unknown>).browser = {
  tabs: {
    group: mockedGroup,
    ungroup: mockedUngroup,
    get: mockedTabGet,
  },
  tabGroups: {
    update: mockedTabGroupsUpdate,
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
    mockedGroup.mockClear();
    mockedTabGroupsUpdate.mockClear();
  });

  it("should call browser.tabs.group with single tab id", async () => {
    await addToGroup(5);
    expect(mockedGroup).toHaveBeenCalledWith({ tabIds: [5] });
  });

  it("should call browser.tabGroups.update with BRP title and blue color", async () => {
    await addToGroup(3);
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, {
      title: "BRP",
      color: "blue",
    });
  });

  it("should handle array of tab ids", async () => {
    await addToGroup([1, 2, 3]);
    expect(mockedGroup).toHaveBeenCalledWith({ tabIds: [1, 2, 3] });
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
    mockedTabGroupsUpdate.mockClear();
    mockedTabGet.mockClear();
  });

  it("should set green for active status", async () => {
    await updateGroupColor(1, "active");
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, { color: "green" });
  });

  it("should set blue for idle status", async () => {
    await updateGroupColor(1, "idle");
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, { color: "blue" });
  });

  it("should set yellow for error status", async () => {
    await updateGroupColor(1, "error");
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, { color: "yellow" });
  });

  it("should be no-op when tab has no groupId", async () => {
    mockedTabGet.mockResolvedValue({ id: 1, groupId: -1 });
    await updateGroupColor(1, "active");
    expect(mockedTabGroupsUpdate).not.toHaveBeenCalled();
  });

  it("should be no-op when tabGroups is unsupported", async () => {
    const saved = (browser as Record<string, unknown>).tabGroups;
    delete (browser as Record<string, unknown>).tabGroups;
    await expect(updateGroupColor(1, "active")).resolves.toBeUndefined();
    (browser as Record<string, unknown>).tabGroups = saved;
  });
});

// ── removeFromGroup ──

describe("removeFromGroup", () => {
  beforeEach(() => {
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
