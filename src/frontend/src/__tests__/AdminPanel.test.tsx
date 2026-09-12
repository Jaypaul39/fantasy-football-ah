import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports SyncStatus) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import { SyncStatus } from "../backend";
import type { backendInterface } from "../backend.d.ts";
import AdminPanel from "../components/AdminPanel";

// Mirrors the component's formatSyncTimestamp so the test can assert on the
// exact rendered timestamp string for a given nanosecond bigint.
function formatForTest(ts: bigint): string {
  const date = new Date(Number(ts / 1_000_000n));
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Mock the useBackend hook ────────────────────────────────────────────────
// AdminPanel consumes the actor through useBackend(). We stub the hook with a
// typed actor mock so the component can be rendered in isolation without a
// live canister or the @caffeineai/core-infrastructure actor provider.
const actorMock = {
  getCycleBalance: vi.fn(async () => BigInt(1_500_000_000_000)),
  getRooms: vi.fn(async () => []),
  getGiphyApiKey: vi.fn(async () => null),
  getOneSignalApiKey: vi.fn(async () => null),
  getOneSignalPlayerIds: vi.fn(async () => []),
  getRssFeedUrls: vi.fn(async () => []),
  getLastRssFetchStatus: vi.fn(async () => []),
  getRssRefreshIntervalSecs: vi.fn(async () => BigInt(900)),
  getByeWeeks: vi.fn(async () => []),
  getADPDatasetByType: vi.fn(async () => null),
  getNotificationCounters: vi.fn(async () => ({
    queued: BigInt(0),
    processed: BigInt(0),
    sent: BigInt(0),
    expired: BigInt(0),
    retried: BigInt(0),
    failed: BigInt(0),
  })),
  getNotificationQueueSnapshot: vi.fn(async () => []),
  getHeartbeatDiagnostics: vi.fn(async () => ({
    lastNotificationWorkerStartedAt: BigInt(0),
    lastNotificationWorkerCompletedAt: BigInt(0),
    notificationWorkerEntryCount: BigInt(0),
  })),
  setRecoveryPassword: vi.fn(async () => ({ __kind__: "ok", ok: null })),
  syncWeeklyStats: vi.fn(async () => ({ __kind__: "ok", ok: BigInt(0) })),
  computeDedupSeasonWeeks: vi.fn(async () => []),
  getSyncStatusRecords: vi.fn(async () => []),
  getFlaggedWeeks: vi.fn(async () => []),
  recordSyncStatus: vi.fn(async () => ({
    __kind__: "ok",
    ok: {
      season: BigInt(0),
      week: BigInt(0),
      lastAttemptedAt: BigInt(0),
      status: "notYetAttempted",
      lastError: undefined,
      lastSuccessfulAt: undefined,
    },
  })),
} as unknown as backendInterface & {
  getFlaggedWeeks: ReturnType<typeof vi.fn>;
  getSyncStatusRecords: ReturnType<typeof vi.fn>;
  syncWeeklyStats: ReturnType<typeof vi.fn>;
  recordSyncStatus: ReturnType<typeof vi.fn>;
};
vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

describe("AdminPanel", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // vi.clearAllMocks() clears call history but NOT mockResolvedValue
    // implementations, so implementations leak across tests. Reset the shared
    // sync mocks (mockReset clears both calls and implementations) and restore
    // safe defaults so no test inherits another test's flagged weeks or sync
    // results.
    vi.clearAllMocks();
    actorMock.getFlaggedWeeks.mockReset();
    actorMock.getSyncStatusRecords.mockReset();
    actorMock.syncWeeklyStats.mockReset();
    actorMock.recordSyncStatus.mockReset();
    actorMock.getFlaggedWeeks.mockResolvedValue([]);
    actorMock.getSyncStatusRecords.mockResolvedValue([]);
    actorMock.syncWeeklyStats.mockResolvedValue({
      __kind__: "ok",
      ok: BigInt(0),
    });
    actorMock.recordSyncStatus.mockResolvedValue({
      __kind__: "ok",
      ok: {
        season: BigInt(0),
        week: BigInt(0),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
        lastError: undefined,
        lastSuccessfulAt: undefined,
      },
    });
  });

  it("renders the admin panel header", () => {
    render(<AdminPanel />);
    expect(
      screen.getByRole("heading", { name: "Admin Panel" }),
    ).toBeInTheDocument();
  });

  it("renders the existing administration cards", () => {
    render(<AdminPanel />);
    expect(
      screen.getByRole("heading", { name: "Canister Health" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Import Players from Sleeper API",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Clear All Players" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Delete Room" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Giphy API Key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "OneSignal REST API Key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "News Feed Sources" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "ADP Datasets" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Bye Weeks" }),
    ).toBeInTheDocument();
  });

  it("fetches and displays the canister cycle balance on mount", async () => {
    render(<AdminPanel />);
    expect(actorMock.getCycleBalance).toHaveBeenCalled();
    expect(await screen.findByText("1.50 TC")).toBeInTheDocument();
  });

  it("renders the clear-players confirmation flow", async () => {
    const user = (await import("@testing-library/user-event")).default;
    render(<AdminPanel />);
    await user.click(screen.getByRole("button", { name: "Clear Players" }));
    expect(
      screen.getByText(
        "Are you sure? This will delete all players permanently.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the recovery password set/update controls", () => {
    render(<AdminPanel />);
    expect(
      screen.getByRole("heading", { name: "Recovery Password" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("New Recovery Password")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Confirm Recovery Password"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save Recovery Password" }),
    ).toBeInTheDocument();
  });

  it("disables saving until both recovery password fields are filled", () => {
    render(<AdminPanel />);
    const saveButton = screen.getByRole("button", {
      name: "Save Recovery Password",
    });
    expect(saveButton).toBeDisabled();
    expect(actorMock.setRecoveryPassword).not.toHaveBeenCalled();
  });

  it("shows an error when the recovery password and confirmation do not match", async () => {
    const user = (await import("@testing-library/user-event")).default;
    render(<AdminPanel />);
    await user.type(
      screen.getByLabelText("New Recovery Password"),
      "secret-pass",
    );
    await user.type(
      screen.getByLabelText("Confirm Recovery Password"),
      "different-pass",
    );
    await user.click(
      screen.getByRole("button", { name: "Save Recovery Password" }),
    );
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(actorMock.setRecoveryPassword).not.toHaveBeenCalled();
  });

  it("saves a matching recovery password via setRecoveryPassword", async () => {
    const user = (await import("@testing-library/user-event")).default;
    render(<AdminPanel />);
    await user.type(
      screen.getByLabelText("New Recovery Password"),
      "secret-pass",
    );
    await user.type(
      screen.getByLabelText("Confirm Recovery Password"),
      "secret-pass",
    );
    await user.click(
      screen.getByRole("button", { name: "Save Recovery Password" }),
    );
    expect(actorMock.setRecoveryPassword).toHaveBeenCalledWith("secret-pass");
    expect(
      await screen.findByText("Recovery password saved successfully."),
    ).toBeInTheDocument();
  });

  it("automatically fetches+parses+submits flagged weeks on admin session load", async () => {
    // Flagged weeks returned by the backend on load.
    actorMock.getFlaggedWeeks.mockResolvedValue([
      {
        season: BigInt(2024),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
      {
        season: BigInt(2024),
        week: BigInt(4),
        lastAttemptedAt: BigInt(0),
        status: "partial",
        lastError: "previous error",
      },
    ]);
    // Mock the Sleeper stats fetch + the player-list fetch used by the shared
    // fetch+parse+submit flow.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/stats/nfl/regular/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { pass_yd: 250, pass_td: 2 },
            "1002": { rush_yd: 80, rush_td: 1 },
            TEAM_BUF: { points: 5 },
          }),
        };
      }
      // players/nfl
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          "1001": { player_id: "1001", position: "QB" },
          "1002": { player_id: "1002", position: "RB" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPanel />);

    // Both flagged weeks should be synced automatically (no manual click).
    // The fetch+parse+submit flow is async, so wait for it to settle.
    await waitFor(() => {
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(2);
    });
    expect(actorMock.syncWeeklyStats).toHaveBeenCalledWith(
      "",
      BigInt(2024),
      BigInt(3),
      expect.any(Array),
    );
    expect(actorMock.syncWeeklyStats).toHaveBeenCalledWith(
      "",
      BigInt(2024),
      BigInt(4),
      expect.any(Array),
    );

    // The status view is refreshed after the sync settles.
    await waitFor(() => {
      expect(actorMock.getSyncStatusRecords).toHaveBeenCalled();
    });

    vi.unstubAllGlobals();
  });

  it("in-flight guard prevents duplicate concurrent fetches for the same (season, week)", async () => {
    // One flagged week.
    actorMock.getFlaggedWeeks.mockResolvedValue([
      {
        season: BigInt(2024),
        week: BigInt(5),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    // A controllable fetch that we can hold open to simulate an in-progress
    // sync, then a re-render/remount while it is still in flight.
    const resolverHolder: { fn: (() => void) | null } = { fn: null };
    const statsPromise = new Promise<void>((resolve) => {
      resolverHolder.fn = resolve;
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/stats/nfl/regular/")) {
        await statsPromise; // hold the sync in-flight
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { pass_yd: 250, pass_td: 2 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          "1001": { player_id: "1001", position: "QB" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<AdminPanel />);

    // The first auto-sync starts and is held open by the unresolved fetch.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // Simulate a re-render/remount while the sync is still in-flight. The
    // in-flight guard must prevent a second fetch for the same (season, week).
    unmount();
    render(<AdminPanel />);

    // Release the held fetch so the first sync can complete.
    resolverHolder.fn?.();

    await waitFor(() => {
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(1);
    });
    // Only one stats fetch fired for the flagged week despite the remount.
    const statsFetches = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/stats/nfl/regular/"),
    );
    expect(statsFetches.length).toBe(1);

    vi.unstubAllGlobals();
  });

  it("re-runs the auto-sync after the ~5 minute interval elapses", async () => {
    vi.useFakeTimers();
    try {
      // One flagged week that stays flagged so each interval tick re-syncs it.
      actorMock.getFlaggedWeeks.mockResolvedValue([
        {
          season: BigInt(2024),
          week: BigInt(9),
          lastAttemptedAt: BigInt(0),
          status: "notYetAttempted",
        },
      ]);
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/stats/nfl/regular/")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              "1001": { pass_yd: 250, pass_td: 2 },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { player_id: "1001", position: "QB" },
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<AdminPanel />);

      // The first auto-sync runs on load.
      await vi.advanceTimersByTimeAsync(0);
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(1);

      // Before the ~5 minute interval elapses, the sync must NOT re-run.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(1);

      // Once the interval elapses, the sync re-runs.
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the auto-sync catch-up when the tab regains visibility after the interval elapses", async () => {
    vi.useFakeTimers();
    try {
      // One flagged week that stays flagged so each catch-up re-syncs it.
      actorMock.getFlaggedWeeks.mockResolvedValue([
        {
          season: BigInt(2024),
          week: BigInt(10),
          lastAttemptedAt: BigInt(0),
          status: "notYetAttempted",
        },
      ]);
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/stats/nfl/regular/")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              "1001": { pass_yd: 250, pass_td: 2 },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { player_id: "1001", position: "QB" },
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<AdminPanel />);

      // The first auto-sync runs on load.
      await vi.advanceTimersByTimeAsync(0);
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(1);

      // Simulate the tab being hidden, then becoming visible again before the
      // 5-minute interval has elapsed. The rate-limit guard must prevent a
      // duplicate sync.
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(1);

      // Advance past the 5-minute interval, then regain visibility. The
      // catch-up must run the overdue sync immediately.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(actorMock.syncWeeklyStats).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records sync status after a successful non-empty sync", async () => {
    // One flagged week that syncs to a non-empty stored count.
    actorMock.getFlaggedWeeks.mockResolvedValue([
      {
        season: BigInt(2024),
        week: BigInt(6),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    actorMock.syncWeeklyStats.mockResolvedValue({
      __kind__: "ok",
      ok: BigInt(5),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/stats/nfl/regular/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { pass_yd: 250, pass_td: 2 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          "1001": { player_id: "1001", position: "QB" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(actorMock.recordSyncStatus).toHaveBeenCalled();
    });
    expect(actorMock.recordSyncStatus).toHaveBeenCalledWith(
      BigInt(2024),
      BigInt(6),
      SyncStatus.partial,
      null,
      expect.any(BigInt),
    );

    vi.unstubAllGlobals();
  });

  it("records an empty status when the sync stores zero records", async () => {
    actorMock.getFlaggedWeeks.mockResolvedValue([
      {
        season: BigInt(2024),
        week: BigInt(7),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    // Backend stores zero records → status must be #notYetAttempted with no success time.
    actorMock.syncWeeklyStats.mockResolvedValue({
      __kind__: "ok",
      ok: BigInt(0),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/stats/nfl/regular/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { pass_yd: 250, pass_td: 2 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          "1001": { player_id: "1001", position: "QB" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(actorMock.recordSyncStatus).toHaveBeenCalled();
    });
    expect(actorMock.recordSyncStatus).toHaveBeenCalledWith(
      BigInt(2024),
      BigInt(7),
      SyncStatus.notYetAttempted,
      null,
      null,
    );

    vi.unstubAllGlobals();
  });

  it("records a failed status when the sync throws", async () => {
    actorMock.getFlaggedWeeks.mockResolvedValue([
      {
        season: BigInt(2024),
        week: BigInt(8),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    // syncWeeklyStats returns #err → the shared flow throws and must record
    // #notYetAttempted with the error message.
    actorMock.syncWeeklyStats.mockResolvedValue({
      __kind__: "err",
      err: "Sleeper API error: 500",
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/stats/nfl/regular/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { pass_yd: 250, pass_td: 2 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          "1001": { player_id: "1001", position: "QB" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(actorMock.recordSyncStatus).toHaveBeenCalled();
    });
    expect(actorMock.recordSyncStatus).toHaveBeenCalledWith(
      BigInt(2024),
      BigInt(8),
      SyncStatus.notYetAttempted,
      "Sleeper API error: 500",
      null,
    );

    vi.unstubAllGlobals();
  });

  it("displays the specific finalized-week message when syncWeeklyStats rejects a settled week", async () => {
    // A flagged week that the backend rejects because it is finalized.
    actorMock.getFlaggedWeeks.mockResolvedValue([
      {
        season: BigInt(2024),
        week: BigInt(5),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    // The backend rejects the resync with the finalized-week message.
    actorMock.syncWeeklyStats.mockResolvedValue({
      __kind__: "err",
      err: "Week 5 of 2024 is finalized and cannot be resynced",
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/stats/nfl/regular/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { pass_yd: 250, pass_td: 2 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          "1001": { player_id: "1001", position: "QB" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPanel />);

    // The specific finalized-week message must be shown, not a generic error.
    expect(
      await screen.findByText(
        "Week 5 of 2024 is finalized and cannot be resynced",
      ),
    ).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("displays each of the three sync states with correct timestamps", async () => {
    actorMock.getSyncStatusRecords.mockResolvedValue([
      {
        season: BigInt(2024),
        week: BigInt(1),
        lastAttemptedAt: BigInt(1_700_000_000_000_000_000n),
        status: "finalized",
        lastSuccessfulAt: BigInt(1_700_000_000_000_000_000n),
      },
      {
        season: BigInt(2024),
        week: BigInt(2),
        lastAttemptedAt: BigInt(1_700_000_000_000_000_000n),
        status: "partial",
      },
      {
        season: BigInt(2024),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);

    render(<AdminPanel />);

    // Each state renders its label. Some labels ("Finalized", "Pending") also
    // appear elsewhere on the admin panel (e.g. the notification counters
    // card), so match all occurrences and assert at least one is present.
    expect((await screen.findAllByText("Finalized")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Partial").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);

    // The finalized state shows the lastSuccessfulAt timestamp. The same
    // timestamp is also shown for the partial record's lastAttemptedAt, so
    // match all occurrences.
    const finalizedTimestamp = formatForTest(
      BigInt(1_700_000_000_000_000_000n),
    );
    expect(screen.getAllByText(finalizedTimestamp).length).toBeGreaterThan(0);
  });
});
