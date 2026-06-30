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
const mockedGroup = vi.fn().mockResolvedValue(42);
const mockedUngroup = vi.fn().mockResolvedValue(undefined);
const mockedTabGroupsUpdate = vi.fn().mockResolvedValue(undefined);

(globalThis as Record<string, unknown>).browser = {
  tabs: {
    group: mockedGroup,
    ungroup: mockedUngroup,
    get: vi.fn().mockResolvedValue({ id: 1 }), // no longer checked for groupId
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

  it("should set group title to empty and color to green", async () => {
    await addToGroup(3);
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, {
      title: "",
      color: "green",
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
    mockedUngroup.mockClear();
    mockedGroup.mockClear();
  });

  it("should ungroup then re-group with green for active", async () => {
    await updateGroupColor(1, "active");
    expect(mockedUngroup).toHaveBeenCalledWith(1);
    expect(mockedGroup).toHaveBeenCalledWith({ tabIds: [1] });
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, { title: "", color: "green" });
  });

  it("should ungroup then re-group with green for idle", async () => {
    await updateGroupColor(1, "idle");
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, { title: "", color: "green" });
  });

  it("should ungroup then re-group with yellow for error", async () => {
    await updateGroupColor(1, "error");
    expect(mockedTabGroupsUpdate).toHaveBeenCalledWith(42, { title: "", color: "yellow" });
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
  beforeEach(() => mockedUngroup.mockClear());

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
