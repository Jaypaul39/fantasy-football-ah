import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports GameType) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import type {
  BestBallConfig,
  H2HStandingEntry,
  PlayoffBracketResult,
  RosterSettings,
  StandingsEntry,
  WeeklyLineupView,
} from "../backend.d.ts";
import { ScoresTab } from "../components/ScoresTab";

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

// ── Actor mock ─────────────────────────────────────────────────────────────
// The child tabs also run direct useQuery calls for bestBallConfig and the
// room state; these resolve through the actor mock so those queries settle.
const getBestBallConfigMock = vi.fn();
const getRoomStateMock = vi.fn();
const actorMock = {
  getBestBallConfig: getBestBallConfigMock,
  getRoomState: getRoomStateMock,
} as unknown as import("../backend.d.ts").backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

// ── Mock the shared data hooks the child tabs consume ──────────────────────
// Each returns a controllable module-level var so tests can drive the mounted
// tab without real backend calls.
let standingsMock: StandingsEntry[] = [];
let currentWeekMock: bigint | null = null;
let lineupMock: WeeklyLineupView | null = null;
let weeklyStandingsMock: StandingsEntry[] = [];
let h2hStandingsMock: H2HStandingEntry[] = [];
let bracketMock: PlayoffBracketResult | null = null;
let syncStatusMock: "syncing" | "updated" | "up-to-date" | "error" =
  "up-to-date";

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
  useGetWeeklyLineup: () => ({
    lineup: lineupMock,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../hooks/useGetWeeklyStandings", () => ({
  useGetWeeklyStandings: () => ({
    standings: weeklyStandingsMock,
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

vi.mock("../hooks/useGetPlayoffBracket", () => ({
  useGetPlayoffBracket: () => ({
    bracket: bracketMock,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../hooks/useBestBallAutoSync", () => ({
  useBestBallAutoSync: () => ({
    status: syncStatusMock,
    lastSuccessfulSync: null,
  }),
}));

const rosterSettings: RosterSettings = {
  qb: BigInt(1),
  rb: BigInt(2),
  te: BigInt(1),
  wr: BigInt(3),
  flex: BigInt(1),
  superflex: BigInt(0),
  superflexPositions: [],
  bench: BigInt(6),
  flexPositions: ["RB", "WR", "TE"],
};

function renderScoresTab(flags: {
  showTeam: boolean;
  showStandings: boolean;
  showBracket: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ScoresTab
        roomId="room-001"
        participantId={me}
        playerNames={{}}
        rosterSettings={rosterSettings}
        season={BigInt(2026)}
        playoffTeams={4}
        participantNames={{}}
        showTeam={flags.showTeam}
        showStandings={flags.showStandings}
        showBracket={flags.showBracket}
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

/** Returns the set of sub-tab button ocids currently rendered. */
function renderedTabOcids(): string[] {
  return Array.from(
    document.querySelectorAll(
      '[data-ocid="scores-view-team-tab"], [data-ocid="scores-view-standings-tab"], [data-ocid="scores-view-bracket-tab"]',
    ),
  ).map((el) => el.getAttribute("data-ocid") as string);
}

describe("ScoresTab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    standingsMock = [];
    currentWeekMock = BigInt(5);
    lineupMock = null;
    weeklyStandingsMock = [];
    h2hStandingsMock = [];
    bracketMock = null;
    syncStatusMock = "up-to-date";
    getBestBallConfigMock.mockResolvedValue({
      startWeek: BigInt(1),
    } as BestBallConfig);
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
  });

  it("renders only the 'My Team' tab and selects it by default when only showTeam is true", () => {
    renderScoresTab({
      showTeam: true,
      showStandings: false,
      showBracket: false,
    });

    expect(renderedTabOcids()).toEqual(["scores-view-team-tab"]);
    expect(byOcid("scores-view-team-tab")).toHaveTextContent("My Team");
    // 'My Team' is the default active sub-tab → its panel is mounted.
    expect(byOcid("best-ball-tab-panel")).toBeInTheDocument();
    expect(
      document.querySelector('[data-ocid="standings-tab-panel"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="bracket-tab-panel"]'),
    ).toBeNull();
  });

  it("renders only the 'Standings' tab and selects it by default when only showStandings is true", () => {
    renderScoresTab({
      showTeam: false,
      showStandings: true,
      showBracket: false,
    });

    expect(renderedTabOcids()).toEqual(["scores-view-standings-tab"]);
    expect(byOcid("scores-view-standings-tab")).toHaveTextContent("Standings");
    // 'Standings' is the default active sub-tab → its panel is mounted.
    expect(byOcid("standings-tab-panel")).toBeInTheDocument();
    expect(
      document.querySelector('[data-ocid="best-ball-tab-panel"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="bracket-tab-panel"]'),
    ).toBeNull();
  });

  it("renders only the 'Bracket' tab and selects it by default when only showBracket is true", () => {
    renderScoresTab({
      showTeam: false,
      showStandings: false,
      showBracket: true,
    });

    expect(renderedTabOcids()).toEqual(["scores-view-bracket-tab"]);
    expect(byOcid("scores-view-bracket-tab")).toHaveTextContent("Bracket");
    // 'Bracket' is the default active sub-tab → its panel is mounted.
    expect(byOcid("bracket-tab-panel")).toBeInTheDocument();
    expect(
      document.querySelector('[data-ocid="best-ball-tab-panel"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="standings-tab-panel"]'),
    ).toBeNull();
  });

  it("renders all three tabs in order and selects 'My Team' by default when all are shown", () => {
    renderScoresTab({ showTeam: true, showStandings: true, showBracket: true });

    expect(renderedTabOcids()).toEqual([
      "scores-view-team-tab",
      "scores-view-standings-tab",
      "scores-view-bracket-tab",
    ]);
    expect(byOcid("scores-view-team-tab")).toHaveTextContent("My Team");
    expect(byOcid("scores-view-standings-tab")).toHaveTextContent("Standings");
    expect(byOcid("scores-view-bracket-tab")).toHaveTextContent("Bracket");
    // 'My Team' is the first available sub-tab → selected by default.
    expect(byOcid("best-ball-tab-panel")).toBeInTheDocument();
    expect(
      document.querySelector('[data-ocid="standings-tab-panel"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="bracket-tab-panel"]'),
    ).toBeNull();
  });

  it("switches from 'My Team' to 'Standings' when the Standings tab is clicked", () => {
    renderScoresTab({ showTeam: true, showStandings: true, showBracket: true });

    // 'My Team' is selected by default.
    expect(byOcid("best-ball-tab-panel")).toBeInTheDocument();
    expect(
      document.querySelector('[data-ocid="standings-tab-panel"]'),
    ).toBeNull();

    fireEvent.click(byOcid("scores-view-standings-tab"));

    // 'Standings' panel mounts and the previous 'My Team' panel unmounts.
    expect(byOcid("standings-tab-panel")).toBeInTheDocument();
    expect(
      document.querySelector('[data-ocid="best-ball-tab-panel"]'),
    ).toBeNull();
  });

  it("switches from 'Standings' to 'Bracket' when the Bracket tab is clicked", () => {
    renderScoresTab({ showTeam: true, showStandings: true, showBracket: true });

    // Move to 'Standings' first.
    fireEvent.click(byOcid("scores-view-standings-tab"));
    expect(byOcid("standings-tab-panel")).toBeInTheDocument();

    fireEvent.click(byOcid("scores-view-bracket-tab"));

    // 'Bracket' panel mounts and the previous 'Standings' panel unmounts.
    expect(byOcid("bracket-tab-panel")).toBeInTheDocument();
    expect(
      document.querySelector('[data-ocid="standings-tab-panel"]'),
    ).toBeNull();
  });
});
