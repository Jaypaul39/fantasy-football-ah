import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports GameType) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import { CompetitionMode, GameType } from "../backend";
import type { backendInterface } from "../backend.d.ts";
import {
  useMyRooms,
  useRoomPolling,
  useRoomsList,
} from "../hooks/useRoomPolling";
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

const me = makePrincipal("2vxsx-fae");

// ── Actor mock ─────────────────────────────────────────────────────────────
type GetRoomStateResult =
  | { __kind__: "ok"; ok: RoomView }
  | { __kind__: "err"; err: string };
const getRoomStateMock = vi.fn(
  async (): Promise<GetRoomStateResult> => ({ __kind__: "err", err: "unset" }),
);
const listPublicRoomsMock = vi.fn(async () => []);
const getUserRoomsMock = vi.fn(async () => []);
const actorMock = {
  getRoomState: getRoomStateMock,
  sweepNominations: vi.fn(async () => {}),
  listPublicRooms: listPublicRoomsMock,
  getUserRooms: getUserRoomsMock,
} as unknown as backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

vi.mock("@caffeineai/core-infrastructure", () => ({
  useInternetIdentity: () => ({
    identity: { getPrincipal: () => me },
  }),
}));

// ── RoomView fixture ───────────────────────────────────────────────────────
function buildRoomView(roomId: string): RoomView {
  return {
    queuedPlayerId: undefined,
    participants: [],
    draftedPlayerIds: [],
    currentNominatorName: undefined,
    currentNominatorId: undefined,
    room: {
      id: roomId,
      name: "Main Draft Room",
      createdAt: BigInt(Date.now()),
      scoringFormat: { __kind__: "halfPpr", halfPpr: null },
      season: BigInt(2026),
      startingBudget: BigInt(200),
      gameType: GameType.Auction,
      competitionMode: CompetitionMode.Cumulative,
      playoffTeams: BigInt(0),
      state: "Active" as AuctionState,
      participants: [me],
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

// A tiny harness that surfaces the hook's return value for assertions.
function RoomPollingHarness({ roomId }: { roomId: string }) {
  const { roomView, isLoading, error } = useRoomPolling(roomId);
  return (
    <div>
      <span data-testid="room-id">{roomView?.room?.id ?? "none"}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="error">{error ? "error" : "no-error"}</span>
    </div>
  );
}

function renderHarness(roomId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RoomPollingHarness roomId={roomId} />
    </QueryClientProvider>,
  );
}

describe("useRoomPolling room-state query contract", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches getRoomState for the given roomId and surfaces the room view", async () => {
    getRoomStateMock.mockResolvedValue({
      __kind__: "ok",
      ok: buildRoomView("room-001"),
    });
    renderHarness("room-001");

    await waitFor(() => {
      expect(actorMock.getRoomState).toHaveBeenCalledWith("room-001");
    });
    await waitFor(() => {
      expect(screen.getByTestId("room-id")).toHaveTextContent("room-001");
    });
  });

  it("does not fetch when getRoomState returns an error variant", async () => {
    getRoomStateMock.mockResolvedValue({
      __kind__: "err",
      err: "not found",
    });
    renderHarness("room-001");

    await waitFor(() => {
      expect(actorMock.getRoomState).toHaveBeenCalledWith("room-001");
    });
    await waitFor(() => {
      expect(screen.getByTestId("room-id")).toHaveTextContent("none");
    });
  });
});

// ── Lobby cadence ──────────────────────────────────────────────────────────
// The polling optimization requires lobby-level queries (public room list and
// the user's rooms) to poll at a clearly slower cadence than the active auction
// room, so the lobby does not hammer the backend at auction speed. These tests
// assert the configured refetchInterval for each query via the query cache.
function LobbyHarness() {
  useRoomsList();
  useMyRooms();
  return null;
}

function renderLobby() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LobbyHarness />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("useRoomPolling lobby cadence", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("polls the public room list and user's rooms at a slower cadence than the auction room", async () => {
    const queryClient = renderLobby();

    await waitFor(() => {
      expect(actorMock.listPublicRooms).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(actorMock.getUserRooms).toHaveBeenCalled();
    });

    const roomsQuery = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["rooms"] });
    const myRoomsQuery = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["myRooms"] });

    // The runtime query options carry the configured polling cadence. The
    // library's public QueryOptions type omits these fields, so read them via
    // a narrow structural cast.
    const roomsOptions = roomsQuery[0].options as {
      refetchInterval?: number;
      refetchIntervalInBackground?: boolean;
    };
    const myRoomsOptions = myRoomsQuery[0].options as {
      refetchInterval?: number;
      refetchIntervalInBackground?: boolean;
    };

    // The lobby queries must exist and be configured with a slower interval
    // than the active auction room's 500ms poll.
    expect(roomsQuery).toHaveLength(1);
    expect(myRoomsQuery).toHaveLength(1);
    expect(roomsOptions.refetchInterval).toBeGreaterThan(500);
    expect(myRoomsOptions.refetchInterval).toBeGreaterThan(500);
    expect(roomsOptions.refetchInterval).toBe(12000);
    expect(myRoomsOptions.refetchInterval).toBe(12000);
  });

  it("does not poll the lobby in the background while the tab is hidden", async () => {
    const queryClient = renderLobby();

    await waitFor(() => {
      expect(actorMock.listPublicRooms).toHaveBeenCalled();
    });

    const roomsQuery = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["rooms"] });
    const roomsOptions = roomsQuery[0].options as {
      refetchIntervalInBackground?: boolean;
    };
    expect(roomsOptions.refetchIntervalInBackground).toBe(false);
  });
});
