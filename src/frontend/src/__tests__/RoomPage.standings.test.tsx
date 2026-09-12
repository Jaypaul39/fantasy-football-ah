import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports GameType) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import { CompetitionMode, GameType } from "../backend";
import type { backendInterface } from "../backend.d.ts";
import RoomPage from "../pages/RoomPage";
import type { AuctionState, RoomView } from "../types";

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
const other = makePrincipal("other-bbbb-bbbb-bbbb-bbbbb-bbb");

// ── Controllable room view + actor mock ────────────────────────────────────
let roomView: RoomView | null = null;

const actorMock = {
  getADPDatasetByType: vi.fn(async () => null),
  getActiveADPDataset: vi.fn(async () => null),
  getPlayersByRoom: vi.fn(async () => []),
} as unknown as backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ principal: me }),
}));

vi.mock("../hooks/useRoomPolling", () => ({
  useRoomPolling: () => ({ roomView, isLoading: false, error: null }),
  useMessages: () => ({ messages: [], isLoading: false }),
  useSendMessage: () => async () => {},
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "room-001" }),
}));

// Stub heavy child components so RoomPage renders in isolation.
vi.mock("../components/AuctionDashboard", () => ({
  AuctionDashboard: () => <div data-testid="auction-dashboard" />,
}));
vi.mock("../components/ChatPanel", () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}));
vi.mock("../components/DraftBoardTab", () => ({
  default: () => <div data-testid="draft-board" />,
}));
vi.mock("../components/HostControls", () => ({
  HostControls: () => <div data-testid="host-controls" />,
}));
vi.mock("../components/NewsTab", () => ({
  NewsTab: () => <div data-testid="news-tab" />,
}));
vi.mock("../components/NominateTab", () => ({
  default: () => <div data-testid="nominate-tab" />,
}));
vi.mock("../components/NominationTimerBanner", () => ({
  NominationTimerBanner: () => <div data-testid="nom-timer-banner" />,
}));
vi.mock("../components/WaitingRoom", () => ({
  default: () => <div data-testid="waiting-room" />,
}));
vi.mock("../components/ScoresTab", () => ({
  ScoresTab: () => <div data-testid="scores-tab" />,
}));

// ── RoomView fixture ───────────────────────────────────────────────────────
function buildRoomView(
  state: AuctionState,
  gameType: GameType,
  participants: (typeof me)[],
): RoomView {
  return {
    queuedPlayerId: undefined,
    participants: participants.map((p) => ({
      userId: p,
      displayName: p === me ? "You" : "Participant",
      skipNominationTurn: false,
      budgetView: {
        __kind__: "public",
        public: {
          totalBudget: BigInt(200),
          spentBudget: BigInt(0),
          publicAvailableBudget: BigInt(200),
        },
      },
      wonPlayers: [],
    })),
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
      gameType,
      competitionMode: CompetitionMode.Cumulative,
      playoffTeams: BigInt(0),
      state,
      participants,
      admin: me,
      nominatorIndex: BigInt(0),
      nominationTurnStartedAt: BigInt(Date.now() - 10000),
      readyParticipants: [],
      paidParticipants: [],
      nominationTurnPausedAt: undefined,
      playerFilter: { positions: ["QB", "RB", "WR", "TE"], filterType: "all" },
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
  };
}

function renderRoomPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RoomPage />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

describe("RoomPage Scores tab gating", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Scores tab for a Best Ball participant", async () => {
    roomView = buildRoomView("Completed" as AuctionState, GameType.BestBall, [
      me,
      other,
    ]);
    renderRoomPage();
    expect(screen.getByRole("tab", { name: "Scores" })).toBeInTheDocument();
  });

  it("does not show the Scores tab for a non-BestBall room", async () => {
    roomView = buildRoomView("Completed" as AuctionState, GameType.Auction, [
      me,
      other,
    ]);
    renderRoomPage();
    expect(
      screen.queryByRole("tab", { name: "Scores" }),
    ).not.toBeInTheDocument();
  });

  it("does not show the Scores tab for a non-participant", async () => {
    roomView = buildRoomView("Completed" as AuctionState, GameType.BestBall, [
      other,
    ]);
    renderRoomPage();
    expect(
      screen.queryByRole("tab", { name: "Scores" }),
    ).not.toBeInTheDocument();
  });

  it("renders the Scores panel when the tab is selected", async () => {
    const user = (await import("@testing-library/user-event")).default;
    roomView = buildRoomView("Completed" as AuctionState, GameType.BestBall, [
      me,
      other,
    ]);
    renderRoomPage();
    await user.click(screen.getByRole("tab", { name: "Scores" }));
    expect(screen.getByTestId("scores-tab")).toBeInTheDocument();
  });
});
