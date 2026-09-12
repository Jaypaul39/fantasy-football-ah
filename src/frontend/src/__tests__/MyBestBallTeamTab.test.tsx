import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports GameType) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import type { backendInterface } from "../backend.d.ts";
import { MyBestBallTeamTab } from "../components/MyBestBallTeamTab";
import { findCurrentWeek } from "../hooks/useGetWeeklyLineup";
import type { RosterSettings } from "../types";

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
const other3 = makePrincipal("ccccc-cc00-cccc-ccccc-ccc00-ccccc-ccc-cc");

// ── Actor mock ─────────────────────────────────────────────────────────────
const getBestBallConfigMock = vi.fn();
const getWeeklyLineupMock = vi.fn();
const getStandingsMock = vi.fn();
const getWeeklyStandingsMock = vi.fn();
const getRoomStateMock = vi.fn();
const getH2HStandingsMock = vi.fn();
const getFlaggedWeeksMock = vi.fn();
const syncWeeklyStatsMock = vi.fn();
const actorMock = {
  getBestBallConfig: getBestBallConfigMock,
  getWeeklyLineup: getWeeklyLineupMock,
  getStandings: getStandingsMock,
  getWeeklyStandings: getWeeklyStandingsMock,
  getRoomState: getRoomStateMock,
  getH2HStandings: getH2HStandingsMock,
  getFlaggedWeeks: getFlaggedWeeksMock,
  syncWeeklyStats: syncWeeklyStatsMock,
} as unknown as backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

const rosterSettings: RosterSettings = {
  qb: BigInt(1),
  rb: BigInt(2),
  wr: BigInt(2),
  te: BigInt(1),
  flex: BigInt(1),
  superflex: BigInt(1),
  bench: BigInt(6),
  flexPositions: ["RB", "WR", "TE"],
  superflexPositions: ["QB", "RB", "WR", "TE"],
};

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MyBestBallTeamTab
        roomId="room-001"
        participantId={me}
        playerNames={{ RB01: "Christian McCaffrey" }}
        rosterSettings={rosterSettings}
      />
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

// A lineup whose starters array has length > 0 but includes a null playerId
// slot — used to prove such a week is treated as synced.
function syncedLineup(week: bigint) {
  return {
    __kind__: "ok" as const,
    ok: {
      roomId: "room-001",
      participantId: me,
      week,
      displayName: "You",
      total: 98,
      starters: [
        { slot: "QB", position: "QB", playerId: undefined, points: 0 },
        { slot: "RB", position: "RB", playerId: "RB01", points: 22 },
      ],
      bench: [],
    },
  };
}

// An unsynced week: empty starters array (length === 0).
function unsyncedLineup(week: bigint) {
  return {
    __kind__: "ok" as const,
    ok: {
      roomId: "room-001",
      participantId: me,
      week,
      displayName: "You",
      total: 0,
      starters: [],
      bench: [],
    },
  };
}

// Weekly standings for the selected week, with the viewer in 2nd place.
function weeklyStandingsOk() {
  return {
    __kind__: "ok" as const,
    ok: [
      { participantId: other, displayName: "Alice", totalPoints: 120 },
      { participantId: me, displayName: "You", totalPoints: 98 },
      { participantId: other2, displayName: "Bob", totalPoints: 50 },
    ],
  };
}

describe("findCurrentWeek (pure current-week detection)", () => {
  it("selects the latest contiguous synced week scanning up from startWeek", async () => {
    const config = { startWeek: BigInt(1) };
    // Weeks 1-3 are synced; week 4 is not. The scan stops at 3.
    const synced = new Set([BigInt(1), BigInt(2), BigInt(3)]);
    const result = await findCurrentWeek(config, (w) => synced.has(w));
    expect(result).toBe(BigInt(3));
  });

  it("falls back to startWeek when no week has starters.length > 0", async () => {
    const config = { startWeek: BigInt(2) };
    const result = await findCurrentWeek(config, () => false);
    expect(result).toBe(BigInt(2));
  });

  it("treats a week as synced when starters.length > 0 even if some slots are null", async () => {
    const config = { startWeek: BigInt(1) };
    // Weeks 1-3 are synced (week 3 has a null playerId slot); week 4 is not.
    const isSynced = (w: bigint) => {
      if (w >= BigInt(4)) return false;
      const lineup = syncedLineup(w).ok;
      return lineup.starters.length > 0;
    };
    const result = await findCurrentWeek(config, isSynced);
    expect(result).toBe(BigInt(3));
  });
});

describe("MyBestBallTeamTab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getBestBallConfigMock.mockResolvedValue({
      startWeek: BigInt(1),
    });
    getFlaggedWeeksMock.mockResolvedValue([]);
    syncWeeklyStatsMock.mockResolvedValue({ __kind__: "ok", ok: BigInt(0) });
    getWeeklyLineupMock.mockImplementation(
      async (_roomId: string, _pid: unknown, week: bigint) =>
        week > BigInt(3) ? unsyncedLineup(week) : syncedLineup(week),
    );
    getStandingsMock.mockResolvedValue({
      __kind__: "ok",
      ok: [
        { participantId: other, displayName: "Alice", totalPoints: 400 },
        { participantId: me, displayName: "You", totalPoints: 349.28 },
        { participantId: other2, displayName: "Bob", totalPoints: 100 },
      ],
    });
    getWeeklyStandingsMock.mockResolvedValue(weeklyStandingsOk());
    // Default room is Cumulative so the cumulative branch is exercised unless a
    // test overrides it to Head-to-Head.
    getRoomStateMock.mockResolvedValue({
      __kind__: "ok",
      ok: {
        queuedPlayerId: undefined,
        participants: [],
        draftedPlayerIds: [],
        currentNominatorName: undefined,
        currentNominatorId: undefined,
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
        nominationTimerSecsRemaining: BigInt(20),
        activeNominations: [],
        completedNominations: [],
        myProxyBids: [],
      },
    });
    getH2HStandingsMock.mockResolvedValue({
      __kind__: "ok",
      ok: [],
    });
  });

  it("reads rank and total from getStandings, not recomputed client-side", async () => {
    renderTab();

    // Season total must equal the getStandings value (349.28), which differs
    // from the weekly lineup total (98) — proving it is not recomputed.
    await waitFor(() => {
      expect(byOcid("bestball-season-total")).toHaveTextContent("349.28");
    });
    // Rank is the participant's index in the ordered standings list (2nd).
    expect(byOcid("bestball-rank")).toHaveTextContent("2nd");
  });

  it("renders unfilled (null) starter slots visibly rather than omitting them", async () => {
    renderTab();

    expect(await screen.findByText("No player")).toBeInTheDocument();
    // The QB slot is unfilled but still labeled and present.
    expect(screen.getByText("QB")).toBeInTheDocument();
    // The filled RB slot shows its player name and points.
    expect(screen.getByText("Christian McCaffrey")).toBeInTheDocument();
    expect(screen.getByText("22.00")).toBeInTheDocument();
  });

  it("does not fetch or render any other participant's data", async () => {
    renderTab();

    // Wait for the weekly lineup fetch to happen.
    await waitFor(() => {
      expect(getWeeklyLineupMock).toHaveBeenCalled();
    });

    // Every getWeeklyLineup call must be for the authenticated participant only.
    for (const call of getWeeklyLineupMock.mock.calls) {
      expect((call[1] as { toText: () => string }).toText()).toBe(me.toText());
    }

    // Other participants' names never appear in the rendered view.
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  it("shows the weekly total from getWeeklyLineup", async () => {
    renderTab();

    await waitFor(() => {
      expect(byOcid("bestball-weekly-total")).toHaveTextContent("98.00");
    });
  });

  it("applies the top class to the rank badge when rank is 1", async () => {
    // Place the authenticated participant first so rank === 1.
    getStandingsMock.mockResolvedValue({
      __kind__: "ok",
      ok: [
        { participantId: me, displayName: "You", totalPoints: 400 },
        { participantId: other, displayName: "Alice", totalPoints: 349.28 },
        { participantId: other2, displayName: "Bob", totalPoints: 100 },
      ],
    });

    renderTab();

    await waitFor(() => {
      expect(byOcid("bestball-rank")).toHaveTextContent("1st");
    });
    expect(byOcid("bestball-rank")).toHaveClass("top");
  });

  it("defaults the week selector to the current week", async () => {
    renderTab();

    // All weeks are synced, so the current-week scan resolves to week 3.
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("3");
    });
    // The lineup shown is for the current week.
    await waitFor(() => {
      expect(byOcid("bestball-weekly-total")).toHaveTextContent("98.00");
    });
  });

  it("bounds week navigation to startWeek, disabling prev at the start boundary", async () => {
    renderTab();

    // Defaults to current week = 3.
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("3");
    });
    // Without an upper bound, the next button is never disabled.
    expect(byOcid("bestball-week-next")).not.toBeDisabled();

    // Navigate back to week 1 (startWeek). Prev must then be disabled.
    fireEvent.click(byOcid("bestball-week-prev"));
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("2");
    });
    fireEvent.click(byOcid("bestball-week-prev"));
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("1");
    });
    expect(byOcid("bestball-week-prev")).toBeDisabled();
    // At the start boundary, next is enabled again.
    expect(byOcid("bestball-week-next")).not.toBeDisabled();
  });

  it("shows the viewer's lineup and own weekly rank for the selected week", async () => {
    renderTab();

    // Navigate to week 2.
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("3");
    });
    fireEvent.click(byOcid("bestball-week-prev"));
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("2");
    });

    // The viewer's lineup for week 2 is shown.
    await waitFor(() => {
      expect(byOcid("bestball-weekly-total")).toHaveTextContent("98.00");
    });
    // The viewer's own weekly rank (2nd in the weekly standings) is shown.
    await waitFor(() => {
      expect(byOcid("bestball-weekly-rank")).toHaveTextContent("2nd");
    });
  });

  it("renders an unsynced week distinctly from a zero-point synced lineup", async () => {
    // Week 1 is unsynced (empty starters); weeks 2-3 are synced; later weeks
    // are unsynced so the current-week scan resolves to 3.
    getWeeklyLineupMock.mockImplementation(
      async (_roomId: string, _pid: unknown, week: bigint) =>
        week === BigInt(1) || week > BigInt(3)
          ? unsyncedLineup(week)
          : syncedLineup(week),
    );

    renderTab();

    // Defaults to current week 3 (synced) — shows a normal lineup, not unsynced.
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("3");
    });
    expect(
      document.querySelector('[data-ocid="bestball-unsynced"]'),
    ).toBeNull();

    // Navigate to week 1 (unsynced).
    fireEvent.click(byOcid("bestball-week-prev"));
    fireEvent.click(byOcid("bestball-week-prev"));
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("1");
    });

    // The distinct unsynced state is shown, not a zero-point lineup.
    await waitFor(() => {
      expect(byOcid("bestball-unsynced")).toBeInTheDocument();
    });
    expect(byOcid("bestball-unsynced")).toHaveTextContent(
      "Week 1 hasn't synced yet",
    );
    // No weekly total banner is rendered for an unsynced week.
    expect(
      document.querySelector('[data-ocid="bestball-weekly-total"]'),
    ).toBeNull();
  });

  it("determines the current week and navigates without re-fetching the selected week", async () => {
    renderTab();

    // The current-week scan resolves to week 3 (the latest synced week).
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("3");
    });

    // Navigate to week 2.
    fireEvent.click(byOcid("bestball-week-prev"));
    await waitFor(() => {
      expect(byOcid("bestball-week-label")).toHaveTextContent("2");
    });
    await waitFor(() => {
      expect(byOcid("bestball-weekly-total")).toHaveTextContent("98.00");
    });

    const fetchedWeeks = getWeeklyLineupMock.mock.calls.map(
      (call) => call[2] as bigint,
    );
    // Week 3 is the resolved current week; week 2 is the selected week.
    expect(fetchedWeeks).toContain(BigInt(3));
    expect(fetchedWeeks).toContain(BigInt(2));
  });

  // ── Head-to-Head branch ───────────────────────────────────────────────────

  function setH2HRoom() {
    getRoomStateMock.mockResolvedValue({
      __kind__: "ok",
      ok: {
        queuedPlayerId: undefined,
        participants: [],
        draftedPlayerIds: [],
        currentNominatorName: undefined,
        currentNominatorId: undefined,
        room: {
          id: "room-001",
          name: "Main Draft Room",
          createdAt: BigInt(Date.now()),
          scoringFormat: { __kind__: "halfPpr", halfPpr: null },
          season: BigInt(2026),
          startingBudget: BigInt(200),
          gameType: "BestBall",
          competitionMode: "HeadToHead",
          playoffTeams: BigInt(0),
          state: "Completed",
          participants: [me, other, other2, other3],
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
        nominationTimerSecsRemaining: BigInt(20),
        activeNominations: [],
        completedNominations: [],
        myProxyBids: [],
      },
    });
  }

  // A synced lineup for an arbitrary participant (used for the H2H opponent).
  function h2hLineup(week: bigint, total: number, displayName: string) {
    return {
      __kind__: "ok" as const,
      ok: {
        roomId: "room-001",
        participantId: me,
        week,
        displayName,
        total,
        starters: [
          { slot: "QB", position: "QB", playerId: "QB01", points: total },
        ],
        bench: [],
      },
    };
  }

  it("renders the H2H weekly matchup (opponent, scores, W/L/T) for a Head-to-Head room", async () => {
    setH2HRoom();
    getH2HStandingsMock.mockResolvedValue({
      __kind__: "ok",
      ok: [
        {
          participant: me,
          displayName: "You",
          wins: BigInt(5),
          losses: BigInt(1),
          ties: BigInt(0),
          pointsFor: 620.5,
          gamesPlayed: BigInt(6),
        },
        {
          participant: other,
          displayName: "Alice",
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
        {
          participant: other3,
          displayName: "Carol",
          wins: BigInt(1),
          losses: BigInt(5),
          ties: BigInt(0),
          pointsFor: 400,
          gamesPlayed: BigInt(6),
        },
      ],
    });
    // All weeks synced for the viewer (98 pts) and the week-1 opponent Carol
    // (80 pts), so the current-week scan resolves and the matchup renders.
    // The viewer's lineup is unsynced beyond week 1 so the current-week scan
    // resolves to week 1 (within the regular season, where the opponent is
    // derived from the round-robin pairing table).
    getWeeklyLineupMock.mockImplementation(
      async (_roomId: string, pid: unknown, week: bigint) => {
        const isMe = (pid as { toText: () => string }).toText() === me.toText();
        if (isMe) {
          return week > BigInt(1)
            ? unsyncedLineup(week)
            : h2hLineup(week, 98, "You");
        }
        return h2hLineup(week, 80, "Carol");
      },
    );

    renderTab();

    // The H2H matchup card renders with the viewer's score and the opponent.
    await waitFor(() => {
      expect(byOcid("h2h-matchup-team-score")).toBeInTheDocument();
    });
    expect(byOcid("h2h-matchup-team-score")).toHaveTextContent("98.00");
    expect(byOcid("h2h-matchup-opponent-score")).toHaveTextContent("80.00");
    // 98 > 80 → Win.
    expect(byOcid("h2h-matchup-result")).toHaveTextContent("Win");
    // The opponent's name appears in the matchup.
    expect(document.body.textContent).toContain("Carol");
  });

  it("renders the H2H season W-L-T record and pointsFor for a Head-to-Head room", async () => {
    setH2HRoom();
    getH2HStandingsMock.mockResolvedValue({
      __kind__: "ok",
      ok: [
        {
          participant: me,
          displayName: "You",
          wins: BigInt(5),
          losses: BigInt(1),
          ties: BigInt(0),
          pointsFor: 620.5,
          gamesPlayed: BigInt(6),
        },
        {
          participant: other,
          displayName: "Alice",
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
        {
          participant: other3,
          displayName: "Carol",
          wins: BigInt(1),
          losses: BigInt(5),
          ties: BigInt(0),
          pointsFor: 400,
          gamesPlayed: BigInt(6),
        },
      ],
    });
    getWeeklyLineupMock.mockImplementation(
      async (_roomId: string, pid: unknown, week: bigint) => {
        const isMe = (pid as { toText: () => string }).toText() === me.toText();
        if (isMe) return h2hLineup(week, 98, "You");
        return h2hLineup(week, 80, "Carol");
      },
    );

    renderTab();

    await waitFor(() => {
      expect(byOcid("h2h-record")).toBeInTheDocument();
    });
    // Season record 5 - 1 - 0.
    expect(byOcid("h2h-record")).toHaveTextContent("5");
    expect(byOcid("h2h-record")).toHaveTextContent("1");
    expect(byOcid("h2h-record")).toHaveTextContent("0");
    expect(byOcid("h2h-points-for")).toHaveTextContent("620.50");
  });

  it("still renders the cumulative best-ball view for a Cumulative room", async () => {
    // getRoomStateMock defaults to Cumulative in beforeEach.
    renderTab();

    await waitFor(() => {
      expect(byOcid("bestball-season-total")).toHaveTextContent("349.28");
    });
    expect(byOcid("bestball-rank")).toHaveTextContent("2nd");
    // The H2H matchup and snapshot are not rendered for the cumulative branch.
    expect(document.querySelector('[data-ocid="h2h-matchup"]')).toBeNull();
    expect(document.querySelector('[data-ocid="h2h-snapshot"]')).toBeNull();
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
      expect(byOcid("sync-status-updated")).toBeInTheDocument();
    });
    expect(byOcid("sync-status-updated")).toHaveTextContent("Stats updated");
    // The last-sync time is rendered as an HH:MM local time.
    expect(byOcid("sync-status-updated").textContent).toMatch(/\d{1,2}:\d{2}/);
    // No conflicting state is shown alongside it.
    expect(
      document.querySelector('[data-ocid="sync-status-up-to-date"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="sync-status-error"]'),
    ).toBeNull();

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
      expect(byOcid("sync-status-up-to-date")).toBeInTheDocument();
    });
    expect(byOcid("sync-status-up-to-date")).toHaveTextContent(
      "Stats up to date",
    );
    // The 'updated' copy must be absent — this distinction is asserted
    // explicitly, not just by the presence of the up-to-date copy.
    expect(
      document.querySelector('[data-ocid="sync-status-updated"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Stats updated");

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
      expect(byOcid("sync-status-error")).toBeInTheDocument();
    });
    expect(byOcid("sync-status-error")).toHaveTextContent("Stats unavailable");
    expect(
      document.querySelector('[data-ocid="sync-status-up-to-date"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="sync-status-updated"]'),
    ).toBeNull();

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
      expect(byOcid("sync-status-error")).toBeInTheDocument();
    });
    expect(byOcid("sync-status-error")).toHaveTextContent("Stats unavailable");

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
      expect(byOcid("sync-status-up-to-date")).toBeInTheDocument();

      // Advance past the 5-minute interval, then regain visibility. The
      // catch-up runs the overdue sync, which now stores data → 'updated'.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(byOcid("sync-status-updated")).toBeInTheDocument();
      expect(
        document.querySelector('[data-ocid="sync-status-up-to-date"]'),
      ).toBeNull();

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
      expect(byOcid("sync-status-updated")).toBeInTheDocument();
    });
    // Exactly one sync-status element is rendered for the single mounted tab.
    const indicators = document.querySelectorAll('[data-ocid^="sync-status-"]');
    expect(indicators.length).toBe(1);

    vi.unstubAllGlobals();
  });
});
