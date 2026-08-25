import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { backendInterface } from "../backend.d.ts";
import NominateTab from "../components/NominateTab";
import type { AuctionState, RoomView, UserId } from "../types";

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
const alice = makePrincipal("aaaaa-aa00-aaaa-aaaaa-aaa00-aaaaa-aaa-aa");
const bob = makePrincipal("bbbbb-bb00-bbbb-bbbbb-bbb00-bbbbb-bbb-bb");

// ── Actor mock ─────────────────────────────────────────────────────────────
// NominateTab (and the PlayerSearch it renders) call a handful of read methods
// on mount. All are stubbed to empty/neutral values so the component renders
// without a live canister.
const actorMock = {
  getActiveADPDataset: vi.fn(async () => null),
  getADPDatasetByType: vi.fn(async () => null),
  getPlayers: vi.fn(async () => []),
  getPlayersByRoom: vi.fn(async () => []),
  setNominationQueue: vi.fn(async () => ({ __kind__: "ok", ok: "Queued" })),
  clearNominationQueue: vi.fn(async () => {}),
} as unknown as backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

// ── RoomView fixture ───────────────────────────────────────────────────────
function buildRoomView(overrides: {
  currentNominatorId?: UserId;
  currentNominatorName?: string;
  queuedPlayerId?: string;
}): RoomView {
  return {
    queuedPlayerId: overrides.queuedPlayerId,
    participants: [
      {
        userId: me,
        displayName: "You",
        skipNominationTurn: false,
        budgetView: {
          __kind__: "private",
          private: {
            totalBudget: BigInt(200),
            spentBudget: BigInt(0),
            committedBudget: BigInt(0),
            availableBudget: BigInt(200),
          },
        },
        wonPlayers: [],
      },
      {
        userId: alice,
        displayName: "Alice",
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
      },
      {
        userId: bob,
        displayName: "Bob",
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
      },
    ],
    draftedPlayerIds: [],
    currentNominatorName: overrides.currentNominatorName,
    currentNominatorId: overrides.currentNominatorId,
    room: {
      id: "room-001",
      name: "Main Draft Room",
      createdAt: BigInt(Date.now()),
      scoringFormat: { __kind__: "halfPpr", halfPpr: null },
      season: BigInt(2026),
      startingBudget: BigInt(200),
      state: "Active" as AuctionState,
      participants: [me, alice, bob],
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

function renderNominateTab(roomView: RoomView) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NominateTab
        roomView={roomView}
        roomId="room-001"
        myPrincipal={me}
        nominatedPlayerIds={new Set()}
        playerFilter={{
          positions: ["QB", "RB", "WR", "TE"],
          filterType: "all",
        }}
      />
    </QueryClientProvider>,
  );
}

describe("NominateTab nomination-queue consumer behavior", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the 'You are up to nominate!' banner when it is my turn", () => {
    renderNominateTab(
      buildRoomView({ currentNominatorId: me, currentNominatorName: "You" }),
    );
    expect(screen.getByText("You are up to nominate!")).toBeInTheDocument();
  });

  it("shows the waiting banner when it is not my turn", () => {
    renderNominateTab(
      buildRoomView({
        currentNominatorId: alice,
        currentNominatorName: "Alice",
      }),
    );
    expect(screen.getByText(/Waiting for/)).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("shows the auto-nomination banner with the queued player when queued and not my turn", () => {
    renderNominateTab(
      buildRoomView({
        currentNominatorId: alice,
        currentNominatorName: "Alice",
        queuedPlayerId: "RB01",
      }),
    );
    expect(screen.getByText(/Auto-nominating:/)).toBeInTheDocument();
  });

  it("does not show the auto-nomination banner when it is my turn", () => {
    renderNominateTab(
      buildRoomView({
        currentNominatorId: me,
        currentNominatorName: "You",
        queuedPlayerId: "RB01",
      }),
    );
    expect(screen.queryByText(/Auto-nominating:/)).not.toBeInTheDocument();
  });

  it("calls setNominationQueue when queueing a watchlist player for auto-nomination", async () => {
    const user = userEvent.setup();
    // Seed a watchlist entry so the WatchlistCard with the queue action renders.
    localStorage.setItem("ffah_watchlist_room-001", JSON.stringify(["RB01"]));
    renderNominateTab(
      buildRoomView({
        currentNominatorId: alice,
        currentNominatorName: "Alice",
      }),
    );

    const queueButton = await screen.findByRole("button", {
      name: "Queue for auto-nominate",
    });
    await user.click(queueButton);

    expect(actorMock.setNominationQueue).toHaveBeenCalledWith(
      "room-001",
      "RB01",
    );
  });

  it("calls clearNominationQueue when clearing the auto-nomination queue", async () => {
    const user = userEvent.setup();
    renderNominateTab(
      buildRoomView({
        currentNominatorId: alice,
        currentNominatorName: "Alice",
        queuedPlayerId: "RB01",
      }),
    );

    const clearButton = screen.getByRole("button", {
      name: "Clear auto-nominate queue",
    });
    await user.click(clearButton);

    expect(actorMock.clearNominationQueue).toHaveBeenCalledWith("room-001");
  });

  it("renders the player search with a loading state while players are fetched", async () => {
    renderNominateTab(
      buildRoomView({ currentNominatorId: me, currentNominatorName: "You" }),
    );
    // PlayerSearch shows skeletons while the ADP/player queries are pending.
    await waitFor(() => {
      expect(actorMock.getActiveADPDataset).toHaveBeenCalled();
    });
    expect(screen.getByPlaceholderText("Search players…")).toBeInTheDocument();
  });
});
