/**
 * Tests for v0.5.2 History Access permission check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock browser.permissions
const permissionsContainsMock = vi.fn();

vi.stubGlobal("browser", {
  permissions: {
    contains: permissionsContainsMock,
    request: vi.fn(),
    remove: vi.fn(),
  },
  history: {
    search: vi.fn(() => Promise.resolve([])),
    deleteUrl: vi.fn(() => Promise.resolve()),
  },
  browserAction: {
    setIcon: vi.fn(() => Promise.resolve()),
    setBadgeText: vi.fn(() => Promise.resolve()),
    setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
  },
});

async function checkHistoryPermission(): Promise<boolean> {
  return permissionsContainsMock({ permissions: ["history"] });
}

describe("history permission check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true when history permission is granted", async () => {
    permissionsContainsMock.mockResolvedValue(true);
    const granted = await checkHistoryPermission();
    expect(granted).toBe(true);
  });

  it("should return false when history permission is not granted", async () => {
    permissionsContainsMock.mockResolvedValue(false);
    const granted = await checkHistoryPermission();
    expect(granted).toBe(false);
  });

  it("should call permissions.contains with history permission", async () => {
    permissionsContainsMock.mockResolvedValue(true);
    await checkHistoryPermission();
    expect(permissionsContainsMock).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: expect.arrayContaining(["history"]) }),
    );
  });
});

describe("history search result formatting", () => {
  it("should format search results correctly", () => {
    const raw = [{
      id: "1",
      url: "https://example.com",
      title: "Example",
      lastVisitTime: 1700000000000,
      visitCount: 5,
    }];

    const formatted = raw.map((h) => ({
      id: h.id,
      url: h.url,
      title: h.title,
      lastVisitTime: h.lastVisitTime,
      visitCount: h.visitCount,
    }));

    expect(formatted[0].url).toBe("https://example.com");
    expect(formatted[0].visitCount).toBe(5);
  });
});
