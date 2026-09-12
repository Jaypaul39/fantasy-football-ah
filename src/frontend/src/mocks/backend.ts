import {
  AuctionState,
  BidHistoryEventType,
  CompetitionMode,
  GameType,
  NominationState,
  SyncStatus,
} from "../backend";
import type { backendInterface } from "../backend.d.ts";

// ── Mock principals ────────────────────────────────────────────────────────
// The anonymous principal ("2vxsx-fae") is used for the current user so that
// the app treats the user as a participant when II is unavailable in dev mode.
// Two additional principals represent other participants.
function makePrincipal(text: string) {
  return {
    toText: () => text,
    toUint8Array: () => new Uint8Array(29),
    compareTo: () => "eq" as const,
    isAnonymous: () => false,
    _isPrincipal: true,
  } as unknown as import("@icp-sdk/core/principal").Principal;
}

const mockPrincipal = makePrincipal("2vxsx-fae"); // current user (anonymous)
const otherPrincipal1 = makePrincipal(
  "aaaaa-aa00-aaaa-aaaaa-aaa00-aaaaa-aaa-aa",
);
const otherPrincipal2 = makePrincipal(
  "bbbbb-bb00-bbbb-bbbbb-bbb00-bbbbb-bbb-bb");
const otherPrincipal3 = makePrincipal(
  "ccccc-cc00-cccc-ccccc-ccc00-ccccc-ccc-cc");

// ── Roster settings (exercises slotted roster + reserve ceiling) ───────────
const mockRosterSettings = {
  qb: BigInt(1),
  rb: BigInt(2),
  wr: BigInt(2),
  te: BigInt(1),
  flex: BigInt(1),
  superflex: BigInt(0),
  bench: BigInt(3),
  flexPositions: ["RB", "WR", "TE"],
  superflexPositions: ["QB", "RB", "WR", "TE"],
};

// Total roster slots = 1+2+2+1+1+0+3 = 10
const mockMaxRosterSize = BigInt(10);

// ── Won players with byeWeek populated (exercises bye week display) ────────
function makeWonPlayer(
  playerId: string,
  playerName: string,
  team: string,
  position: string,
  winningBid: bigint,
  byeWeek: bigint,
  nominatedBy: import("@icp-sdk/core/principal").Principal = mockPrincipal,
) {
  return {
    playerId,
    playerName,
    team,
    position,
    winningBid,
    byeWeek,
    nominatedBy,
    closedAt: BigInt(Date.now() - 60000),
  };
}

// Current user's won players (8 won, cap=10 → 2 slots remain → reserve ceiling active)
const myWonPlayers = [
  makeWonPlayer("QB01", "Patrick Mahomes", "KC", "QB", BigInt(45), BigInt(6)),
  makeWonPlayer("RB01", "Christian McCaffrey", "SF", "RB", BigInt(42), BigInt(9)),
  makeWonPlayer("RB02", "Bijan Robinson", "ATL", "RB", BigInt(38), BigInt(5)),
  makeWonPlayer("WR01", "CeeDee Lamb", "DAL", "WR", BigInt(40), BigInt(7)),
  makeWonPlayer("WR02", "Justin Jefferson", "MIN", "WR", BigInt(36), BigInt(9)),
  makeWonPlayer("WR03", "Tyreek Hill", "MIA", "WR", BigInt(34), BigInt(10)),
  makeWonPlayer("TE01", "Travis Kelce", "KC", "TE", BigInt(28), BigInt(6)),
  makeWonPlayer("WR04", "Amon-Ra St. Brown", "DET", "WR", BigInt(22), BigInt(11)),
];

// Other participant 1's won players
const other1WonPlayers = [
  makeWonPlayer("QB02", "Josh Allen", "BUF", "QB", BigInt(44), BigInt(12), otherPrincipal1),
  makeWonPlayer("RB03", "Saquon Barkley", "NYG", "RB", BigInt(41), BigInt(7), otherPrincipal1),
  makeWonPlayer("WR05", "A.J. Brown", "PHI", "WR", BigInt(37), BigInt(8), otherPrincipal1),
];

// ── Active nominations ─────────────────────────────────────────────────────
// Nom #1: current user is leading (so safeguard does NOT fire on this one)
// Nom #2: current user is NOT leading (safeguard CAN fire if user leads another + near cap)
const activeNominations = [
  {
    id: BigInt(1),
    playerId: "RB04",
    playerName: "Jahmyr Gibbs",
    team: "DET",
    position: "RB",
    currentBid: BigInt(15),
    bidLeader: mockPrincipal,
    bidLeaderName: "You",
    timerSecsRemaining: BigInt(20),
    state: NominationState.Active,
    nominatedBy: mockPrincipal,
    roomId: "room-001",
  },
  {
    id: BigInt(2),
    playerId: "WR06",
    playerName: "Garrett Wilson",
    team: "NYJ",
    position: "WR",
    currentBid: BigInt(12),
    bidLeader: otherPrincipal1,
    bidLeaderName: "Alice",
    timerSecsRemaining: BigInt(25),
    state: NominationState.Active,
    nominatedBy: otherPrincipal1,
    roomId: "room-001",
  },
];

// ── Room view builder ──────────────────────────────────────────────────────
function buildRoomView(roomId: string, state: AuctionState) {
  const isWaiting = state === AuctionState.Waiting;
  return {
    room: {
      id: roomId,
      name: isWaiting ? "Waiting Draft Room" : "Main Draft Room",
      createdAt: BigInt(Date.now()),
      scoringFormat: { __kind__: "halfPpr", halfPpr: null } as const,
      season: BigInt(2026),
      startingBudget: BigInt(200),
      gameType: GameType.BestBall,
      competitionMode: CompetitionMode.HeadToHead,
      playoffTeams: BigInt(0),
      state,
      participants: [mockPrincipal, otherPrincipal1, otherPrincipal2],
      admin: mockPrincipal,
      nominatorIndex: BigInt(0),
      nominationTurnStartedAt: BigInt(Date.now() - 10000),
      readyParticipants: isWaiting ? [otherPrincipal1] : [],
      paidParticipants: isWaiting ? [otherPrincipal1] : [],
      nominationTurnPausedAt: undefined,
      rosterSettings: mockRosterSettings,
      settings: {
        minBidIncrement: BigInt(1),
        maxActivePicks: BigInt(3),
        nomTimerSecs: BigInt(30),
        bidTimerSecs: BigInt(30),
        maxParticipants: BigInt(12),
        adpDataset: "all",
        maxRosterSize: mockMaxRosterSize,
      },
      isPublic: true,
      playerFilter: { positions: ["QB", "RB", "WR", "TE"], filterType: "all" },
    },
    participants: [
      {
        userId: mockPrincipal,
        displayName: "You",
        skipNominationTurn: false, // current user — toggle available
        budgetView: {
          __kind__: "private" as const,
          private: {
            // totalBudget=300, spent=285 (sum of 8 won players), committed=15 (leading nom #1)
            // availableBudget = 300 - 285 - 15 = 0 → exhausted, but reserve ceiling still computable
            // Use availableBudget=15 so reserve ceiling = 15 - (10-8-1) = 14 (exercises ceiling)
            totalBudget: BigInt(300),
            spentBudget: BigInt(285),
            committedBudget: BigInt(0),
            availableBudget: BigInt(15),
          },
        },
        wonPlayers: myWonPlayers,
      },
      {
        userId: otherPrincipal1,
        displayName: "Alice",
        skipNominationTurn: true, // exercises "Skipping" badge
        budgetView: {
          __kind__: "public" as const,
          public: {
            totalBudget: BigInt(200),
            spentBudget: BigInt(122),
            publicAvailableBudget: BigInt(78),
          },
        },
        wonPlayers: other1WonPlayers,
      },
      {
        userId: otherPrincipal2,
        displayName: "Bob",
        skipNominationTurn: false,
        budgetView: {
          __kind__: "public" as const,
          public: {
            totalBudget: BigInt(200),
            spentBudget: BigInt(0),
            publicAvailableBudget: BigInt(200),
          },
        },
        wonPlayers: [],
      },
    ],
    activeNominations: isWaiting ? [] : activeNominations,
    completedNominations: myWonPlayers.map((wp, i) => ({
      id: BigInt(i + 100),
      playerId: wp.playerId,
      playerName: wp.playerName,
      team: wp.team,
      position: wp.position,
      currentBid: wp.winningBid,
      bidLeader: mockPrincipal,
      bidLeaderName: "You",
      timerSecsRemaining: BigInt(0),
      state: NominationState.Closed,
      nominatedBy: mockPrincipal,
      roomId,
    })),
    myProxyBids: [],
    nominationTimerSecsRemaining: BigInt(20),
    currentNominatorId: mockPrincipal,
    currentNominatorName: "You",
    draftedPlayerIds: [],
  };
}

// Fix the current user's budget to a realistic positive value
// availableBudget = totalBudget - spentBudget = 200 - 285 = -85 (overcommitted)
// That's unrealistic. Recompute: spentBudget should be sum of winning bids.
// myWonPlayers total = 45+42+38+40+36+34+28+22 = 285. That exceeds 200.
// Reduce won players to keep budget realistic. Remove 2 players.
// New total with 6 players: 45+42+40+36+28+22 = 213. Still > 200.
// Use 5 players: 45+42+40+36+28 = 191. availableBudget = 200-191 = 9.
// But we need 8 won for the safeguard (8 won + leading 1 + bidding 1 = 10 = cap).
// Let's increase totalBudget to 300 so 8 won @ 285 leaves availableBudget = 15.
// reserve ceiling = availableBudget - (cap - won - 1) = 15 - (10-8-1) = 15 - 1 = 14.
// That exercises the reserve ceiling path.

// ── Best Ball config (in-memory store keyed by roomId) ─────────────────────
const bestBallConfigs = new Map<string, { startWeek: bigint }>();
// Seed a config so the "My Team" week selector is bounded to startWeek
// and useCurrentWeek can resolve a current week. Weeks 1..4; week 4 is the
// current (synced) week, weeks 1-3 are unsynced for navigation testing.
bestBallConfigs.set("room-001", { startWeek: BigInt(1) });

export const mockBackend: backendInterface = {
  getApiDoc: async () => "",
  fetchRssFeeds: async () => "",
  createRoom: async () => ({ __kind__: "ok", ok: "room-001" }),

  endAuction: async () => ({ __kind__: "ok", ok: null }),

  execute: async () => ({ hasMore: false, rows: [] }),

  getNominations: async () => activeNominations,

  getPlayers: async () => [
    {
      id: "RB01",
      name: "Christian McCaffrey",
      position: "RB",
      team: "SF",
      byeWeek: BigInt(9),
      adp: 1.0,
      yearsExp: BigInt(7),
      headshotUrl: "https://sleeper.app/avatars/thumbs/RB01",
    },
    {
      id: "WR02",
      name: "CeeDee Lamb",
      position: "WR",
      team: "DAL",
      byeWeek: BigInt(7),
      adp: 2.0,
      yearsExp: BigInt(4),
      headshotUrl: "https://sleeper.app/avatars/thumbs/WR02",
    },
  ],

  getRoomState: async (roomId: string) => ({
    __kind__: "ok",
    ok: buildRoomView(roomId || "room-001", AuctionState.Active),
  }),

  getBestBallConfig: async (roomId: string) =>
    bestBallConfigs.get(roomId) ?? null,

  getWeeklyLineup: async (
    roomId: string,
    participantId: import("@icp-sdk/core/principal").Principal,
    week: bigint,
  ) => {
    // Weeks 1-3 are unsynced (empty starters); week 4 (the current week) is
    // synced with a full lineup. This lets the visual QA verify both the
    // synced lineup and the distinct "hasn't synced yet" state.
    if (week < BigInt(4)) {
      return {
        __kind__: "ok" as const,
        ok: {
          roomId,
          participantId,
          week,
          displayName: "You",
          total: 0,
          starters: [],
          bench: [],
        },
      };
    }
    // The opponent (any participant other than the current user) gets a
    // distinct name and score so the H2H matchup renders a genuine win/loss
    // rather than a self-tie. The current user's lineup stays "You" @ 98.
    const isOpponent =
      participantId.toText() !== "2vxsx-fae";
    return {
      __kind__: "ok" as const,
      ok: {
        roomId,
        participantId,
        week,
        displayName: isOpponent ? "Alice" : "You",
        total: isOpponent ? 84 : 98,
        starters: [
          { slot: "QB", position: "QB", playerId: "QB01", points: 28 },
          { slot: "RB", position: "RB", playerId: "RB01", points: 22 },
          { slot: "RB", position: "RB", playerId: "RB02", points: 18 },
          { slot: "WR", position: "WR", playerId: "WR01", points: 15 },
          { slot: "WR", position: "WR", playerId: "WR02", points: 10 },
          { slot: "TE", position: "TE", playerId: "TE01", points: 5 },
          { slot: "FLEX", position: "WR", playerId: "WR03", points: 0 },
        ],
        bench: [
          { playerId: "WR04", points: 0 },
        ],
      },
    };
  },

  getStandings: async (roomId: string) => ({
    __kind__: "ok" as const,
    ok: [
      {
        participantId: mockPrincipal,
        displayName: "You",
        totalPoints: 98,
      },
      {
        participantId: otherPrincipal1,
        displayName: "Alice",
        totalPoints: 77,
      },
      {
        participantId: otherPrincipal2,
        displayName: "Bob",
        totalPoints: 0,
      },
    ],
  }),

  getH2HStandings: async (roomId: string) => ({
    __kind__: "ok" as const,
    ok: [
      {
        participant: mockPrincipal,
        displayName: "You",
        wins: BigInt(3),
        losses: BigInt(1),
        ties: BigInt(0),
        pointsFor: 320.5,
        gamesPlayed: BigInt(4),
      },
      {
        participant: otherPrincipal1,
        displayName: "Alice",
        wins: BigInt(2),
        losses: BigInt(2),
        ties: BigInt(0),
        pointsFor: 305.0,
        gamesPlayed: BigInt(4),
      },
      {
        participant: otherPrincipal2,
        displayName: "Bob",
        wins: BigInt(1),
        losses: BigInt(3),
        ties: BigInt(0),
        pointsFor: 280.25,
        gamesPlayed: BigInt(4),
      },
    ],
  }),

  // 4-team playoff bracket fixture. Week 15 = Semifinals (Seed1 v Seed4
  // resolved; Seed2 v Seed3 pending-on-sync), Week 16 = Finals
  // (pending-on-dependency on the two semifinal winners). Champion in progress.
  getPlayoffBracket: async (roomId: string) => ({
    __kind__: "ok" as const,
    ok: {
      games: [
        {
          game: {
            week: BigInt(15),
            home: { __kind__: "Seed", Seed: BigInt(1) },
            away: { __kind__: "Seed", Seed: BigInt(4) },
          },
          home: {
            __kind__: "resolved",
            resolved: {
              participant: mockPrincipal,
              seed: BigInt(1),
              score: 120.5,
            },
          },
          away: {
            __kind__: "resolved",
            resolved: {
              participant: otherPrincipal3,
              seed: BigInt(4),
              score: 88.0,
            },
          },
          status: {
            __kind__: "resolved",
            resolved: {
              winner: mockPrincipal,
              homeScore: 120.5,
              awayScore: 88.0,
            },
          },
        },
        {
          game: {
            week: BigInt(15),
            home: { __kind__: "Seed", Seed: BigInt(2) },
            away: { __kind__: "Seed", Seed: BigInt(3) },
          },
          home: { __kind__: "pendingOnSync", pendingOnSync: null },
          away: { __kind__: "pendingOnSync", pendingOnSync: null },
          status: { __kind__: "pendingOnSync", pendingOnSync: null },
        },
        {
          game: {
            week: BigInt(16),
            home: { __kind__: "WinnerOf", WinnerOf: BigInt(0) },
            away: { __kind__: "WinnerOf", WinnerOf: BigInt(1) },
          },
          home: {
            __kind__: "pendingOnDependency",
            pendingOnDependency: null,
          },
          away: {
            __kind__: "pendingOnDependency",
            pendingOnDependency: null,
          },
          status: { __kind__: "pendingOnDependency", pendingOnDependency: null },
        },
      ],
      champion: { __kind__: "inProgress", inProgress: null },
    },
  }),

  getWeeklyStandings: async (roomId: string, week: bigint) => ({
    __kind__: "ok" as const,
    ok: [
      {
        participantId: otherPrincipal1,
        displayName: "Alice",
        totalPoints: 120,
      },
      {
        participantId: mockPrincipal,
        displayName: "You",
        totalPoints: 98,
      },
      {
        participantId: otherPrincipal2,
        displayName: "Bob",
        totalPoints: 50,
      },
    ],
  }),

  getRooms: async () => [
    {
      id: "room-001",
      name: "Main Draft Room",
      createdAt: BigInt(Date.now() - 3600000),
      state: AuctionState.Active,
      participantCount: BigInt(3),
      maxParticipants: BigInt(12),
      adminId: mockPrincipal,
      isPublic: true,
    },
    {
      id: "room-waiting",
      name: "Waiting Draft Room",
      createdAt: BigInt(Date.now() - 1800000),
      state: AuctionState.Waiting,
      participantCount: BigInt(3),
      maxParticipants: BigInt(12),
      adminId: mockPrincipal,
      isPublic: true,
    },
  ],

  joinRoom: async () => ({ __kind__: "ok", ok: null }),

  joinPrivateRoomByPassword: async () => ({
    __kind__: "ok",
    ok: "room-001",
  }),

  listPublicRooms: async () => [
    {
      id: "room-001",
      name: "Main Draft Room",
      createdAt: BigInt(Date.now() - 3600000),
      state: AuctionState.Active,
      participantCount: BigInt(3),
      maxParticipants: BigInt(12),
      adminId: mockPrincipal,
      isPublic: true,
    },
    {
      id: "room-waiting",
      name: "Waiting Draft Room",
      createdAt: BigInt(Date.now() - 1800000),
      state: AuctionState.Waiting,
      participantCount: BigInt(3),
      maxParticipants: BigInt(12),
      adminId: mockPrincipal,
      isPublic: true,
    },
  ],

  getUserRooms: async () => [
    {
      id: "room-001",
      name: "Main Draft Room",
      createdAt: BigInt(Date.now() - 3600000),
      state: AuctionState.Active,
      participantCount: BigInt(3),
      maxParticipants: BigInt(12),
      adminId: mockPrincipal,
      isPublic: true,
    },
    {
      id: "room-waiting",
      name: "Waiting Draft Room",
      createdAt: BigInt(Date.now() - 1800000),
      state: AuctionState.Waiting,
      participantCount: BigInt(3),
      maxParticipants: BigInt(12),
      adminId: mockPrincipal,
      isPublic: true,
    },
  ],

  leaveRoom: async () => ({ __kind__: "ok", ok: null }),

  nominatePlayer: async () => ({ __kind__: "ok", ok: BigInt(3) }),

  pauseAuction: async () => ({ __kind__: "ok", ok: null }),

  reconcileMembershipIndexes: async () => {
    return;
  },

  placeProxyBid: async () => ({ __kind__: "ok", ok: null }),

  removeUserFromRoom: async () => ({ __kind__: "ok", ok: null }),

  resumeAuction: async () => ({ __kind__: "ok", ok: null }),

  schema: async () => "",

  startAuction: async () => ({ __kind__: "ok", ok: null }),

  getDisplayName: async () => "Demo User",

  getProfile: async () => ({
    userId: mockPrincipal,
    displayName: "Demo User",
    avatarUrl: undefined,
  }),

  setDisplayName: async () => ({ __kind__: "ok", ok: null }),

  setAvatarUrl: async () => ({ __kind__: "ok", ok: null }),

  sweepNominations: async () => {},

  updateRoomSettings: async () => ({ __kind__: "ok", ok: null }),

  editParticipantBudget: async () => ({ __kind__: "ok", ok: null }),

  removeParticipant: async () => ({ __kind__: "ok", ok: null }),

  setActiveNominationCount: async () => ({ __kind__: "ok", ok: null }),

  setNominationOrder: async () => ({ __kind__: "ok", ok: null }),

  getNominationHistory: async () => [
    {
      eventType: BidHistoryEventType.nominationCreated,
      userId: mockPrincipal,
      displayName: "You",
      playerName: "Jahmyr Gibbs",
      amount: BigInt(1),
      timestamp: BigInt(Date.now() - 30000),
    },
    {
      eventType: BidHistoryEventType.leaderChanged,
      userId: mockPrincipal,
      displayName: "You",
      playerName: "Jahmyr Gibbs",
      amount: BigInt(15),
      timestamp: BigInt(Date.now() - 20000),
    },
  ],

  sendMessage: async () => ({ __kind__: "ok", ok: null }),

  getMessages: async () => [
    {
      id: BigInt(1),
      userId: mockPrincipal,
      displayName: "You",
      message: "Good luck everyone!",
      timestamp: BigInt(Date.now() - 5000),
      reactions: [],
    },
  ],

  randomizeNominationOrder: async () => ({ __kind__: "ok", ok: [] }),

  checkIsAdmin: async () => false,

  getPlayersByRoom: async () => [
    {
      id: "RB01",
      name: "Christian McCaffrey",
      position: "RB",
      team: "SF",
      byeWeek: BigInt(9),
      adp: 1.0,
      yearsExp: BigInt(7),
      headshotUrl: "https://sleeper.app/avatars/thumbs/RB01",
    },
    {
      id: "WR02",
      name: "CeeDee Lamb",
      position: "WR",
      team: "DAL",
      byeWeek: BigInt(7),
      adp: 2.0,
      yearsExp: BigInt(4),
      headshotUrl: "https://sleeper.app/avatars/thumbs/WR02",
    },
    {
      id: "QB01",
      name: "Patrick Mahomes",
      position: "QB",
      team: "KC",
      byeWeek: BigInt(6),
      adp: 12.0,
      yearsExp: BigInt(8),
      headshotUrl: "https://sleeper.app/avatars/thumbs/QB01",
    },
    {
      id: "TE01",
      name: "Travis Kelce",
      position: "TE",
      team: "KC",
      byeWeek: BigInt(6),
      adp: 6.0,
      yearsExp: BigInt(11),
      headshotUrl: "https://sleeper.app/avatars/thumbs/TE01",
    },
    {
      id: "RB04",
      name: "Jahmyr Gibbs",
      position: "RB",
      team: "DET",
      byeWeek: BigInt(11),
      adp: 18.0,
      yearsExp: BigInt(2),
      headshotUrl: "https://sleeper.app/avatars/thumbs/RB04",
    },
    {
      id: "WR06",
      name: "Garrett Wilson",
      position: "WR",
      team: "NYJ",
      byeWeek: BigInt(12),
      adp: 24.0,
      yearsExp: BigInt(3),
      headshotUrl: "https://sleeper.app/avatars/thumbs/WR06",
    },
  ],

  importPlayers: async () => ({ __kind__: "ok", ok: BigInt(0) }),

  syncWeeklyStats: async () => ({ __kind__: "ok", ok: BigInt(0) }),

  computeDedupSeasonWeeks: async () => [],

  getSyncStatusRecords: async () => [
    {
      season: BigInt(2026),
      week: BigInt(1),
      lastAttemptedAt: BigInt(Date.now() - 5 * 86400_000) * 1_000_000n,
      status: SyncStatus.finalized,
      lastError: undefined,
      lastSuccessfulAt: BigInt(Date.now() - 5 * 86400_000) * 1_000_000n,
    },
    {
      season: BigInt(2026),
      week: BigInt(2),
      lastAttemptedAt: BigInt(Date.now() - 2 * 86400_000) * 1_000_000n,
      status: SyncStatus.partial,
      lastError: undefined,
      lastSuccessfulAt: BigInt(Date.now() - 2 * 86400_000) * 1_000_000n,
    },
    {
      season: BigInt(2026),
      week: BigInt(3),
      lastAttemptedAt: BigInt(Date.now() - 1 * 86400_000) * 1_000_000n,
      status: SyncStatus.partial,
      lastError: undefined,
      lastSuccessfulAt: undefined,
    },
    {
      season: BigInt(2026),
      week: BigInt(4),
      lastAttemptedAt: BigInt(0),
      status: SyncStatus.notYetAttempted,
      lastError: undefined,
      lastSuccessfulAt: undefined,
    },
  ],

  getFlaggedWeeks: async () => [],

  recordSyncStatus: async () => ({
    __kind__: "ok" as const,
    ok: {
      season: BigInt(0),
      week: BigInt(0),
      lastAttemptedAt: BigInt(0),
      status: SyncStatus.notYetAttempted,
      lastError: undefined,
      lastSuccessfulAt: undefined,
    },
  }),

  backfillFinalizedScores: async () => BigInt(0),

  finalizeWeek: async () => ({ __kind__: "ok" as const, ok: BigInt(0) }),

  importADPDataset: async () => ({ __kind__: "ok", ok: "imported" }),

  getADPDataset: async () => null,

  getActiveADPDataset: async () => null,

  getADPDatasetByType: async () => null,

  getPlayersWithADP: async () => [],

  clearPlayers: async () => ({ __kind__: "ok" as const, ok: null }),

  deleteRoom: async () => ({ __kind__: "ok" as const, ok: null }),

  toggleReady: async () => ({ __kind__: "ok" as const, ok: null }),

  setSkipNominationTurn: async () => ({ __kind__: "ok" as const, ok: null }),

  setParticipantPaid: async () => ({ __kind__: "ok" as const, ok: null }),

  setNominationQueue: async () => ({ __kind__: "ok" as const, ok: "Queued" }),

  clearNominationQueue: async () => {},

  getNominationQueue: async () => null,

  removeADPDataset: async () => ({ __kind__: "ok" as const, ok: "Removed" }),

  getGiphyApiKey: async () => null,

  setGiphyApiKey: async () => ({ __kind__: "ok" as const, ok: "Saved" }),

  getOneSignalApiKey: async () => null,

  setOneSignalApiKey: async () => ({ __kind__: "ok" as const, ok: "Saved" }),

  setOneSignalPlayerId: async () => {},

  sendTestPush: async () => ({
    __kind__: "err" as const,
    err: "Mock: sendTestPush not implemented",
  }),

  toggleMessageReaction: async () => ({ __kind__: "ok", ok: null }),

  transform: async () => ({
    status: BigInt(200),
    body: new Uint8Array(0),
    headers: [],
  }),

  getOneSignalPlayerIds: async () => [],

  getCycleBalance: async () => BigInt(1_500_000_000_000),

  getPlayerWeeklyPoints: async () => null,

  getLastRssFetchStatus: async () => [["https://www.espn.com/espn/rss/nfl/news", true]],

  getRssFeedUrls: async () => ["https://www.espn.com/espn/rss/nfl/news"],

  getRssRefreshIntervalSecs: async () => BigInt(900),

  setRssFeedUrls: async () => ({ __kind__: "ok" as const, ok: null }),

  setRssRefreshIntervalSecs: async () => ({ __kind__: "ok" as const, ok: null }),

  getByeWeeks: async () => [
    ["ARI", BigInt(8)],
    ["ATL", BigInt(5)],
    ["BAL", BigInt(14)],
    ["SF", BigInt(9)],
    ["DAL", BigInt(7)],
    ["KC", BigInt(6)],
    ["DET", BigInt(11)],
    ["NYJ", BigInt(12)],
    ["MIA", BigInt(10)],
    ["MIN", BigInt(9)],
    ["NYG", BigInt(7)],
    ["BUF", BigInt(12)],
    ["PHI", BigInt(8)],
  ],

  setByeWeeks: async () => ({ __kind__: "ok" as const, ok: null }),

  adminDrainQueueNow: async () => ({ __kind__: "ok" as const, ok: BigInt(0) }),

  getNotificationCounters: async () => ({
    queued: BigInt(0),
    processed: BigInt(0),
    sent: BigInt(0),
    expired: BigInt(0),
    retried: BigInt(0),
    failed: BigInt(0),
  }),

  getNotificationQueueSnapshot: async () => [],

  getHeartbeatDiagnostics: async () => ({
    lastNotificationWorkerStartedAt: BigInt(0),
    lastNotificationWorkerCompletedAt: BigInt(0),
    notificationWorkerEntryCount: BigInt(0),
  }),

  getRoomParticipantPrincipals: async () => ({
    __kind__: "ok" as const,
    ok: [
      { principal: "2vxsx-fae", displayName: "You" },
      { principal: "aaaaa-aa00-aaaa-aaaaa-aaa00-aaaaa-aaa-aa", displayName: "Alice" },
      { principal: "bbbbb-bb00-bbbb-bbbbb-bbb00-bbbbb-bbb-bb", displayName: "Bob" },
    ],
  }),

  transferParticipantIdentity: async () => ({
    __kind__: "ok" as const,
    ok: "Identity transferred.",
  }),

  setRecoveryPassword: async () => ({ __kind__: "ok" as const, ok: null }),

  recoverAdmin: async () => ({ __kind__: "ok" as const, ok: null }),
};
