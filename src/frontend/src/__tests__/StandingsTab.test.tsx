import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports GameType) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import type { StandingsEntry } from "../backend.d.ts";
import { StandingsTab } from "../components/StandingsTab";

// ── Mock principals ────────────────────────────────────────────────────────
function makePrincipal(text: string) {
  return {
    toText: () => text,
    toUint8Array: () => new Uint8Array(29),
    compareTo: () => "eq" as const,
    isAnonymous: () => false,
    _isPrincipal: true,
  } as unknown as import("@icp-sdk/core/principal").Principal;
}

const me = makePrincipal("2vxsx-fae"); // current user
const other = makePrincipal("aaaaa-aa00-aaaa-aaaaa-aaa00-aaaaa-aaa-aa");
const other2 = makePrincipal("bbbbb-bb00-bbbb-bbbbb-bbb00-bbbbb-bbb-bb");

// ── Actor mock with a getWeeklyLineup spy ──────────────────────────────────
// The Standings view must never invoke getWeeklyLineup directly or indirectly.
const getWeeklyLineupMock = vi.fn();
const getRoomStateMock = vi.fn();
const getH2HStandingsMock = vi.fn();
const getFlaggedWeeksMock = vi.fn();
const syncWeeklyStatsMock = vi.fn();
const actorMock = {
  getBestBallConfig: vi.fn(async () => null),
  getWeeklyLineup: getWeeklyLineupMock,
  getRoomState: getRoomStateMock,
  getH2HStandings: getH2HStandingsMock,
  getFlaggedWeeks: getFlaggedWeeksMock,
  syncWeeklyStats: syncWeeklyStatsMock,
} as unknown as import("../backend.d.ts").backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

// ── Mock the shared hooks so the component consumes them without real calls ─
let standingsMock: StandingsEntry[] = [];
let currentWeekMock: bigint | null = null;
let h2hStandingsMock: import("../backend.d.ts").H2HStandingEntry[] = [];

vi.mock("../hooks/useGetStandings", () => ({
  useGetStandings: () => ({
    standings: standingsMock,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../hooks/useGetWeeklyLineup", () => ({
  useCurrentWeek: () => ({
    currentWeek: currentWeekMock,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../hooks/useGetH2HStandings", () => ({
  useGetH2HStandings: () => ({
    standings: h2hStandingsMock,
    isLoading: false,
    error: null,
  }),
}));

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <StandingsTab roomId="room-001" participantId={me} />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

/** Queries an element by its data-ocid deterministic marker. */
function byOcid(ocid: string): HTMLElement {
  const el = document.querySelector(`[data-ocid="${ocid}"]`);
  if (!el) throw new Error(`No element with data-ocid="${ocid}"`);
  return el as HTMLElement;
}

describe("StandingsTab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    standingsMock = [];
    currentWeekMock = BigInt(5);
    h2hStandingsMock = [];
    getFlaggedWeeksMock.mockResolvedValue([]);
    syncWeeklyStatsMock.mockResolvedValue({ __kind__: "ok", ok: BigInt(0) });
    // Default room is Cumulative so the cumulative branch is exercised unless a
    // test overrides it to Head-to-Head.
    getRoomStateMock.mockResolvedValue({
      __kind__: "ok",
      ok: {
        room: {
          id: "room-001",
          name: "Main Draft Room",
          createdAt: BigInt(Date.now()),
          scoringFormat: { __kind__: "halfPpr", halfPpr: null },
          season: BigInt(2026),
          startingBudget: BigInt(200),
          gameType: "BestBall",
          competitionMode: "Cumulative",
          playoffTeams: BigInt(0),
          state: "Completed",
          participants: [],
          admin: me,
          nominatorIndex: BigInt(0),
          nominationTurnStartedAt: BigInt(Date.now()),
          readyParticipants: [],
          paidParticipants: [],
          playerFilter: {
            positions: ["QB", "RB", "WR", "TE"],
            filterType: "all",
          },
          settings: {
            minBidIncrement: BigInt(1),
            maxActivePicks: BigInt(3),
            nomTimerSecs: BigInt(30),
            bidTimerSecs: BigInt(30),
            maxParticipants: BigInt(12),
            adpDataset: "all",
            maxRosterSize: BigInt(10),
          },
          isPublic: true,
        },
      },
    });
    getH2HStandingsMock.mockResolvedValue({
      __kind__: "ok",
      ok: [],
    });
  });

  it("renders standings in the order getStandings returns them with rank = index + 1", async () => {
    standingsMock = [
      { participantId: other, displayName: "Alice", totalPoints: 400 },
      { participantId: me, displayName: "You", totalPoints: 349.28 },
      { participantId: other2, displayName: "Bob", totalPoints: 100 },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-team-1")).toHaveTextContent("Alice");
    });
    expect(byOcid("standings-rank-1")).toHaveTextContent("1");
    expect(byOcid("standings-total-1")).toHaveTextContent("400.00");
    expect(byOcid("standings-team-2")).toHaveTextContent("You");
    expect(byOcid("standings-rank-2")).toHaveTextContent("2");
    expect(byOcid("standings-total-2")).toHaveTextContent("349.28");
    expect(byOcid("standings-team-3")).toHaveTextContent("Bob");
    expect(byOcid("standings-rank-3")).toHaveTextContent("3");
    expect(byOcid("standings-total-3")).toHaveTextContent("100.00");
  });

  it("gives tied participants adjacent rows with different index-based ranks", async () => {
    standingsMock = [
      { participantId: other, displayName: "Alice", totalPoints: 400 },
      { participantId: me, displayName: "You", totalPoints: 400 },
      { participantId: other2, displayName: "Bob", totalPoints: 100 },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-team-1")).toHaveTextContent("Alice");
    });
    // Tied on totalPoints but ranks are index-based (1 and 2), never shared.
    expect(byOcid("standings-rank-1")).toHaveTextContent("1");
    expect(byOcid("standings-rank-2")).toHaveTextContent("2");
  });

  it("renders all-zero rows without error when no weeks are synced", async () => {
    standingsMock = [
      { participantId: other, displayName: "Alice", totalPoints: 0 },
      { participantId: me, displayName: "You", totalPoints: 0 },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-total-1")).toHaveTextContent("0.00");
    });
    expect(byOcid("standings-total-2")).toHaveTextContent("0.00");
  });

  it("renders a valid one-row table for a single participant", async () => {
    standingsMock = [
      { participantId: me, displayName: "You", totalPoints: 123.45 },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-team-1")).toHaveTextContent("You");
    });
    expect(byOcid("standings-rank-1")).toHaveTextContent("1");
    expect(byOcid("standings-total-1")).toHaveTextContent("123.45");
    expect(document.querySelector('[data-ocid="standings-row-2"]')).toBeNull();
  });

  it("shows the 'Standings through Week X' label from useCurrentWeek with no extra completeness text", async () => {
    currentWeekMock = BigInt(7);
    standingsMock = [
      { participantId: me, displayName: "You", totalPoints: 10 },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-through-week")).toHaveTextContent(
        "Standings through Week 7",
      );
    });
    // No additional text asserting completeness of the range.
    expect(document.body.textContent).not.toMatch(/synced/i);
    expect(document.body.textContent).not.toMatch(/scored/i);
    expect(document.body.textContent).not.toMatch(/complete/i);
  });

  it("never invokes getWeeklyLineup directly or indirectly", async () => {
    standingsMock = [
      { participantId: me, displayName: "You", totalPoints: 10 },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-row-1")).toBeInTheDocument();
    });
    expect(getWeeklyLineupMock).not.toHaveBeenCalled();
  });

  // ── Head-to-Head branch ───────────────────────────────────────────────────

  function setH2HRoom() {
    getRoomStateMock.mockResolvedValue({
      __kind__: "ok",
      ok: {
        room: {
          id: "room-001",
          name: "Main Draft Room",
          createdAt: BigInt(Date.now()),
          scoringFormat: { __kind__: "halfPpr", halfPpr: null },
          season: BigInt(2026),
          startingBudget: BigInt(200),
          gameType: "BestBall",
          competitionMode: "HeadToHead",
          playoffTeams: BigInt(4),
          state: "Completed",
          participants: [me, other, other2],
          admin: me,
          nominatorIndex: BigInt(0),
          nominationTurnStartedAt: BigInt(Date.now()),
          readyParticipants: [],
          paidParticipants: [],
          playerFilter: {
            positions: ["QB", "RB", "WR", "TE"],
            filterType: "all",
          },
          settings: {
            minBidIncrement: BigInt(1),
            maxActivePicks: BigInt(3),
            nomTimerSecs: BigInt(30),
            bidTimerSecs: BigInt(30),
            maxParticipants: BigInt(12),
            adpDataset: "all",
            maxRosterSize: BigInt(10),
          },
          isPublic: true,
        },
      },
    });
  }

  it("renders the H2H standings table (Rank/Team/W/L/T/PF) for a Head-to-Head room", async () => {
    setH2HRoom();
    h2hStandingsMock = [
      {
        participant: other,
        displayName: "Alice",
        wins: BigInt(5),
        losses: BigInt(1),
        ties: BigInt(0),
        pointsFor: 620.5,
        gamesPlayed: BigInt(6),
      },
      {
        participant: me,
        displayName: "You",
        wins: BigInt(4),
        losses: BigInt(2),
        ties: BigInt(0),
        pointsFor: 590.25,
        gamesPlayed: BigInt(6),
      },
      {
        participant: other2,
        displayName: "Bob",
        wins: BigInt(2),
        losses: BigInt(4),
        ties: BigInt(0),
        pointsFor: 480,
        gamesPlayed: BigInt(6),
      },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("h2h-standings-row-1")).toBeInTheDocument();
    });
    // The backend already orders by wins desc then pointsFor desc; the table
    // renders rows in that order with rank = index + 1.
    expect(byOcid("h2h-standings-rank-1")).toHaveTextContent("1");
    expect(byOcid("h2h-standings-team-1")).toHaveTextContent("Alice");
    expect(byOcid("h2h-standings-wins-1")).toHaveTextContent("5");
    expect(byOcid("h2h-standings-losses-1")).toHaveTextContent("1");
    expect(byOcid("h2h-standings-ties-1")).toHaveTextContent("0");
    expect(byOcid("h2h-standings-pf-1")).toHaveTextContent("620.50");

    expect(byOcid("h2h-standings-rank-2")).toHaveTextContent("2");
    expect(byOcid("h2h-standings-team-2")).toHaveTextContent("You");
    expect(byOcid("h2h-standings-wins-2")).toHaveTextContent("4");
    expect(byOcid("h2h-standings-pf-2")).toHaveTextContent("590.25");

    expect(byOcid("h2h-standings-rank-3")).toHaveTextContent("3");
    expect(byOcid("h2h-standings-team-3")).toHaveTextContent("Bob");
    expect(byOcid("h2h-standings-wins-3")).toHaveTextContent("2");
    expect(byOcid("h2h-standings-pf-3")).toHaveTextContent("480.00");

    // The cumulative table is not rendered for the H2H branch.
    expect(document.querySelector('[data-ocid="standings-table"]')).toBeNull();
  });

  it("renders the H2H standings label for a Head-to-Head room", async () => {
    setH2HRoom();
    h2hStandingsMock = [
      {
        participant: me,
        displayName: "You",
        wins: BigInt(1),
        losses: BigInt(0),
        ties: BigInt(0),
        pointsFor: 100,
        gamesPlayed: BigInt(1),
      },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("h2h-standings-label")).toHaveTextContent("Head-to-Head");
    });
  });

  it("still renders the cumulative table for a Cumulative room", async () => {
    // getRoomStateMock defaults to Cumulative in beforeEach.
    standingsMock = [
      { participantId: other, displayName: "Alice", totalPoints: 400 },
      { participantId: me, displayName: "You", totalPoints: 349.28 },
    ];
    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-team-1")).toHaveTextContent("Alice");
    });
    expect(byOcid("standings-total-1")).toHaveTextContent("400.00");
    expect(byOcid("standings-total-2")).toHaveTextContent("349.28");
    // The H2H table is not rendered for the cumulative branch.
    expect(
      document.querySelector('[data-ocid="h2h-standings-table"]'),
    ).toBeNull();
  });

  // ── Automatic sync trigger (ported from AdminPanel's Phase 4 pattern) ─────

  // A Sleeper fetch mock that returns a stats map and a player list, mirroring
  // the AdminPanel auto-sync tests.
  function stubSleeperFetch() {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/stats/nfl/regular/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            "1001": { pass_yd: 250, pass_td: 2 },
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
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fires the auto-sync on load, calling syncWeeklyStats for the room's flagged season", async () => {
    // The room's season is 2026 (from the room fixture). Flag a week for that
    // season so the trigger syncs it.
    getFlaggedWeeksMock.mockResolvedValue([
      {
        season: BigInt(2026),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
      {
        // A different season must be ignored — the trigger only syncs the
        // current room's season.
        season: BigInt(2024),
        week: BigInt(4),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    stubSleeperFetch();

    renderTab();

    // The trigger fires on load and syncs only the room's season (2026 week 3).
    await waitFor(() => {
      expect(syncWeeklyStatsMock).toHaveBeenCalledTimes(1);
    });
    expect(syncWeeklyStatsMock).toHaveBeenCalledWith(
      "room-001",
      BigInt(2026),
      BigInt(3),
      expect.any(Array),
    );

    vi.unstubAllGlobals();
  });

  it("re-runs the auto-sync after the ~5 minute interval elapses", async () => {
    vi.useFakeTimers();
    try {
      getFlaggedWeeksMock.mockResolvedValue([
        {
          season: BigInt(2026),
          week: BigInt(9),
          lastAttemptedAt: BigInt(0),
          status: "notYetAttempted",
        },
      ]);
      stubSleeperFetch();

      renderTab();

      // The first auto-sync runs on load.
      await vi.advanceTimersByTimeAsync(0);
      expect(syncWeeklyStatsMock).toHaveBeenCalledTimes(1);

      // Before the ~5 minute interval elapses, the sync must NOT re-run.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(syncWeeklyStatsMock).toHaveBeenCalledTimes(1);

      // Once the interval elapses, the sync re-runs.
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
      expect(syncWeeklyStatsMock).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the auto-sync catch-up when the tab regains visibility after the interval elapses", async () => {
    vi.useFakeTimers();
    try {
      getFlaggedWeeksMock.mockResolvedValue([
        {
          season: BigInt(2026),
          week: BigInt(10),
          lastAttemptedAt: BigInt(0),
          status: "notYetAttempted",
        },
      ]);
      stubSleeperFetch();

      renderTab();

      // The first auto-sync runs on load.
      await vi.advanceTimersByTimeAsync(0);
      expect(syncWeeklyStatsMock).toHaveBeenCalledTimes(1);

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
      expect(syncWeeklyStatsMock).toHaveBeenCalledTimes(1);

      // Advance past the 5-minute interval, then regain visibility. The
      // catch-up must run the overdue sync immediately.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(syncWeeklyStatsMock).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Sync-status indicator behavior ────────────────────────────────────────

  it("shows the 'Updated' state with a last-sync time after a successful sync (#ok n > 0)", async () => {
    getFlaggedWeeksMock.mockResolvedValue([
      {
        season: BigInt(2026),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    syncWeeklyStatsMock.mockResolvedValue({ __kind__: "ok", ok: BigInt(2) });
    stubSleeperFetch();

    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-sync-status")).toHaveTextContent(
        "Stats updated",
      );
    });
    // The last-sync time is rendered as an HH:MM local time.
    expect(byOcid("standings-sync-status").textContent).toMatch(
      /\d{1,2}:\d{2}/,
    );
    // The neutral up-to-date copy is not shown alongside it.
    expect(byOcid("standings-sync-status").textContent).not.toContain(
      "Stats up to date",
    );

    vi.unstubAllGlobals();
  });

  it("shows 'up to date' (not 'updated') for a cooldown no-op (#ok 0)", async () => {
    getFlaggedWeeksMock.mockResolvedValue([
      {
        season: BigInt(2026),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    syncWeeklyStatsMock.mockResolvedValue({ __kind__: "ok", ok: BigInt(0) });
    stubSleeperFetch();

    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-sync-status")).toHaveTextContent(
        "Stats up to date",
      );
    });
    // The 'updated' copy must be absent — this distinction is asserted
    // explicitly, not just by the presence of the up-to-date copy.
    expect(byOcid("standings-sync-status").textContent).not.toContain(
      "Stats updated",
    );

    vi.unstubAllGlobals();
  });

  it("shows a distinguishable error state when the sync returns #err", async () => {
    getFlaggedWeeksMock.mockResolvedValue([
      {
        season: BigInt(2026),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    syncWeeklyStatsMock.mockResolvedValue({ __kind__: "err", err: "cooldown" });
    stubSleeperFetch();

    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-sync-status")).toHaveTextContent(
        "Stats sync unavailable",
      );
    });
    expect(byOcid("standings-sync-status").textContent).not.toContain(
      "Stats up to date",
    );
    expect(byOcid("standings-sync-status").textContent).not.toContain(
      "Stats updated",
    );

    vi.unstubAllGlobals();
  });

  it("shows a distinguishable error state when the Sleeper fetch fails", async () => {
    getFlaggedWeeksMock.mockResolvedValue([
      {
        season: BigInt(2026),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-sync-status")).toHaveTextContent(
        "Stats sync unavailable",
      );
    });

    vi.unstubAllGlobals();
  });

  it("updates the displayed status when the visibility catch-up runs an overdue sync", async () => {
    vi.useFakeTimers();
    try {
      getFlaggedWeeksMock.mockResolvedValue([
        {
          season: BigInt(2026),
          week: BigInt(10),
          lastAttemptedAt: BigInt(0),
          status: "notYetAttempted",
        },
      ]);
      // First sync on load is a cooldown no-op (#ok 0 → up-to-date); the
      // visibility catch-up after the interval stores data (#ok 2 → updated).
      syncWeeklyStatsMock
        .mockResolvedValueOnce({ __kind__: "ok", ok: BigInt(0) })
        .mockResolvedValueOnce({ __kind__: "ok", ok: BigInt(2) });
      stubSleeperFetch();

      renderTab();

      // On load the sync runs and reports up-to-date (cooldown no-op).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(byOcid("standings-sync-status")).toHaveTextContent(
        "Stats up to date",
      );

      // Advance past the 5-minute interval, then regain visibility. The
      // catch-up runs the overdue sync, which now stores data → 'updated'.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(byOcid("standings-sync-status")).toHaveTextContent(
        "Stats updated",
      );
      expect(byOcid("standings-sync-status").textContent).not.toContain(
        "Stats up to date",
      );

      vi.unstubAllGlobals();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders exactly one sync-status indicator for the mounted tab (no duplicate or conflicting states)", async () => {
    getFlaggedWeeksMock.mockResolvedValue([
      {
        season: BigInt(2026),
        week: BigInt(3),
        lastAttemptedAt: BigInt(0),
        status: "notYetAttempted",
      },
    ]);
    syncWeeklyStatsMock.mockResolvedValue({ __kind__: "ok", ok: BigInt(2) });
    stubSleeperFetch();

    renderTab();

    await waitFor(() => {
      expect(byOcid("standings-sync-status")).toHaveTextContent(
        "Stats updated",
      );
    });
    // Exactly one sync-status element is rendered for the single mounted tab.
    const indicators = document.querySelectorAll(
      '[data-ocid="standings-sync-status"]',
    );
    expect(indicators.length).toBe(1);

    vi.unstubAllGlobals();
  });
});
