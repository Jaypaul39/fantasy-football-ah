import type { Principal } from "@icp-sdk/core/principal";
export interface Some<T> {
    __kind__: "Some";
    value: T;
}
export interface None {
    __kind__: "None";
}
export type Option<T> = Some<T> | None;
export interface Player {
    id: string;
    adp: number;
    yearsExp: bigint;
    name: string;
    team: string;
    byeWeek?: bigint;
    position: string;
    headshotUrl?: string;
}
export type Timestamp = bigint;
export interface TransformationOutput {
    status: bigint;
    body: Uint8Array;
    headers: Array<HttpHeader>;
}
export interface HttpRequestResult {
    status: bigint;
    body: Uint8Array;
    headers: Array<HttpHeader>;
}
export interface Result__1 {
    hasMore: boolean;
    rows: Array<Array<Cell>>;
}
export type RoomId = string;
export interface Room {
    id: RoomId;
    leagueFormat?: string;
    rosterSettings?: RosterSettings;
    participants: Array<UserId>;
    admin: UserId;
    nominatorIndex: bigint;
    readyParticipants: Array<UserId>;
    password?: string;
    name: string;
    createdAt: Timestamp;
    scoringFormat: ScoringFormat;
    startingBudget: bigint;
    teamCount?: bigint;
    season: bigint;
    nominationTurnPausedAt?: Timestamp;
    playerFilter: PlayerFilter;
    state: AuctionState;
    paidParticipants: Array<UserId>;
    settings: AuctionSettings;
    isPublic: boolean;
    nominationTurnStartedAt: Timestamp;
}
export type ScoringFormat = {
    __kind__: "ppr";
    ppr: null;
} | {
    __kind__: "std";
    std: null;
} | {
    __kind__: "halfPpr";
    halfPpr: null;
} | {
    __kind__: "custom";
    custom: CustomScoringSettings;
};
export interface PlayerFilter {
    filterType: string;
    positions: Array<string>;
}
export interface WeeklyPlayerStats {
    twoPtConversions: bigint;
    receptions: bigint;
    ints: bigint;
    fumblesLost: bigint;
    playerId: string;
    week: bigint;
    season: bigint;
    passTds: bigint;
    passYds: bigint;
    rushTds: bigint;
    rushYds: bigint;
    recTds: bigint;
    recYds: bigint;
}
export interface ParticipantView {
    displayName: string;
    userId: UserId;
    budgetView: ParticipantBudgetView;
    avatarUrl?: string;
    skipNominationTurn: boolean;
    wonPlayers: Array<WonPlayer>;
}
export interface NominationView {
    id: NominationId;
    bidLeader?: UserId;
    playerId: string;
    team: string;
    bidLeaderName?: string;
    timerSecsRemaining: bigint;
    state: NominationState;
    imageUrl?: string;
    playerName: string;
    nominatedBy: UserId;
    currentBid: bigint;
    roomId: RoomId;
    position: string;
}
export type NominationId = bigint;
export interface BidHistoryEvent {
    displayName: string;
    userId: UserId;
    isAutoBid?: boolean;
    timestamp: Timestamp;
    playerName: string;
    amount: bigint;
    eventType: BidHistoryEventType;
}
export interface TransformationInput {
    context: Uint8Array;
    response: HttpRequestResult;
}
export interface ProxyBid {
    userId: UserId;
    maxBid: bigint;
    nominationId: NominationId;
}
export interface CustomScoringSettings {
    recTdPoints: number;
    passYdPoints: number;
    intPoints: number;
    recYdPoints: number;
    twoPtPoints: number;
    rushTdPoints: number;
    rushYdPoints: number;
    fumbleLostPoints: number;
    passTdPoints: number;
    receptionPoints: number;
}
export interface PrivateParticipantBudget {
    availableBudget: bigint;
    committedBudget: bigint;
    totalBudget: bigint;
    spentBudget: bigint;
}
export interface ChatMessage {
    id: bigint;
    displayName: string;
    userId: UserId;
    message: string;
    timestamp: Timestamp;
    reactions: Array<[string, Array<UserId>]>;
}
export interface Cell {
    value: Value;
    name: string;
}
export type Value = {
    __kind__: "int";
    int: bigint;
} | {
    __kind__: "nat";
    nat: bigint;
} | {
    __kind__: "float";
    float: number;
} | {
    __kind__: "bool";
    bool: boolean;
} | {
    __kind__: "null";
    null: null;
} | {
    __kind__: "text";
    text: string;
};
export interface BestBallConfig {
    startWeek: bigint;
    endWeek: bigint;
}
export interface PublicParticipantBudget {
    publicAvailableBudget: bigint;
    totalBudget: bigint;
    spentBudget: bigint;
}
export interface ADPDataset {
    lastUpdated: bigint;
    importedAt: bigint;
    entries: Array<AdpEntry>;
}
export interface AuctionSettings {
    minBidIncrement: bigint;
    maxActivePicks: bigint;
    adpDataset: string;
    nomTimerSecs: bigint;
    maxParticipants: bigint;
    bidTimerSecs: bigint;
    maxRosterSize?: bigint;
}
export interface WonPlayer {
    playerId: string;
    team: string;
    closedAt: Timestamp;
    playerName: string;
    byeWeek?: bigint;
    nominatedBy: UserId;
    position: string;
    winningBid: bigint;
}
export interface HttpHeader {
    value: string;
    name: string;
}
export type UserId = Principal;
export type ParticipantBudgetView = {
    __kind__: "public";
    public: PublicParticipantBudget;
} | {
    __kind__: "private";
    private: PrivateParticipantBudget;
};
export type Result = {
    __kind__: "ok";
    ok: null;
} | {
    __kind__: "err";
    err: string;
};
export interface RoomSummary {
    id: RoomId;
    name: string;
    createdAt: Timestamp;
    state: AuctionState;
    participantCount: bigint;
    maxParticipants: bigint;
    isPublic: boolean;
    adminId: UserId;
}
export interface RoomView {
    queuedPlayerId?: string;
    participants: Array<ParticipantView>;
    draftedPlayerIds: Array<string>;
    currentNominatorName?: string;
    currentNominatorId?: UserId;
    room: Room;
    nominationTimerSecsRemaining: bigint;
    activeNominations: Array<NominationView>;
    completedNominations: Array<NominationView>;
    myProxyBids: Array<ProxyBid>;
}
export interface AdpEntry {
    adp: number;
    name: string;
    team?: string;
    position?: string;
}
export interface UserProfile {
    displayName: string;
    userId: UserId;
    avatarUrl?: string;
}
export interface RosterSettings {
    qb: bigint;
    rb: bigint;
    te: bigint;
    wr: bigint;
    flex: bigint;
    superflex: bigint;
    superflexPositions: Array<string>;
    bench: bigint;
    flexPositions: Array<string>;
}
export enum AuctionState {
    Paused = "Paused",
    Active = "Active",
    Waiting = "Waiting",
    Completed = "Completed"
}
export enum BidHistoryEventType {
    nominationEnded = "nominationEnded",
    leaderChanged = "leaderChanged",
    nominationCreated = "nominationCreated"
}
export enum NominationState {
    Closed = "Closed",
    Active = "Active",
    Expired = "Expired"
}
export interface backendInterface {
    adminDrainQueueNow(): Promise<{
        __kind__: "ok";
        ok: bigint;
    } | {
        __kind__: "err";
        err: string;
    }>;
    checkIsAdmin(): Promise<boolean>;
    clearNominationQueue(roomId: RoomId): Promise<void>;
    clearPlayers(): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    createRoom(name: string, startingBudget: bigint, settings: AuctionSettings, isPublic: boolean, password: string | null, playerFilter: PlayerFilter | null, maxRosterSize: bigint | null, rosterSettings: RosterSettings | null, teamCount: bigint | null, leagueFormat: string | null, season: bigint, scoringFormat: ScoringFormat): Promise<{
        __kind__: "ok";
        ok: RoomId;
    } | {
        __kind__: "err";
        err: string;
    }>;
    deleteRoom(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    editParticipantBudget(roomId: RoomId, targetUser: UserId, newBudget: bigint): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    endAuction(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    execute(qJson: string): Promise<Result__1>;
    fetchRssFeeds(): Promise<string>;
    getADPDataset(): Promise<ADPDataset | null>;
    getADPDatasetByType(datasetType: string): Promise<ADPDataset | null>;
    getActiveADPDataset(): Promise<ADPDataset | null>;
    getBestBallConfig(roomId: RoomId): Promise<BestBallConfig | null>;
    getByeWeeks(): Promise<Array<[string, bigint]>>;
    getCycleBalance(): Promise<bigint>;
    getDisplayName(userId: UserId): Promise<string | null>;
    getGiphyApiKey(): Promise<string | null>;
    getHeartbeatDiagnostics(): Promise<{
        lastNotificationWorkerError?: string;
        lastNotificationWorkerCompletedAt: bigint;
        lastNotificationWorkerStartedAt: bigint;
        notificationWorkerEntryCount: bigint;
    }>;
    getLastRssFetchStatus(): Promise<Array<[string, boolean]>>;
    getMessages(roomId: RoomId, limit: bigint): Promise<Array<ChatMessage>>;
    getNominationHistory(nominationId: NominationId): Promise<Array<BidHistoryEvent>>;
    getNominationQueue(roomId: RoomId): Promise<string | null>;
    getNominations(roomId: RoomId): Promise<Array<NominationView>>;
    getNotificationCounters(): Promise<{
        expired: bigint;
        sent: bigint;
        queued: bigint;
        processed: bigint;
        failed: bigint;
        retried: bigint;
    }>;
    getNotificationQueueSnapshot(): Promise<Array<{
        id: bigint;
        title: string;
        userId: string;
        attempts: bigint;
        ageSeconds: bigint;
    }>>;
    getOneSignalApiKey(): Promise<string | null>;
    getOneSignalPlayerIds(): Promise<Array<[string, string]>>;
    getPlayerWeeklyPoints(playerId: string, season: bigint, week: bigint, format: ScoringFormat): Promise<number | null>;
    getPlayers(queryText: string, position: string | null): Promise<Array<Player>>;
    getPlayersByRoom(roomId: RoomId, queryText: string, positionFilter: string): Promise<Array<Player>>;
    getPlayersWithADP(): Promise<Array<Player>>;
    getProfile(): Promise<UserProfile>;
    getRoomParticipantPrincipals(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: Array<{
            principal: string;
            displayName: string;
        }>;
    } | {
        __kind__: "err";
        err: string;
    }>;
    getRoomState(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: RoomView;
    } | {
        __kind__: "err";
        err: string;
    }>;
    getRooms(): Promise<Array<RoomSummary>>;
    getRssFeedUrls(): Promise<Array<string>>;
    getRssRefreshIntervalSecs(): Promise<bigint>;
    getUserRooms(): Promise<Array<RoomSummary>>;
    importADPDataset(entries: Array<AdpEntry>, datasetType: string | null): Promise<{
        __kind__: "ok";
        ok: string;
    } | {
        __kind__: "err";
        err: string;
    }>;
    importPlayers(batch: Array<Player>): Promise<{
        __kind__: "ok";
        ok: bigint;
    } | {
        __kind__: "err";
        err: string;
    }>;
    joinPrivateRoomByPassword(password: string): Promise<{
        __kind__: "ok";
        ok: RoomId;
    } | {
        __kind__: "err";
        err: string;
    }>;
    joinRoom(roomId: RoomId, password: string | null): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    leaveRoom(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    listPublicRooms(): Promise<Array<RoomSummary>>;
    nominatePlayer(roomId: RoomId, playerId: string): Promise<{
        __kind__: "ok";
        ok: NominationId;
    } | {
        __kind__: "err";
        err: string;
    }>;
    pauseAuction(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    placeProxyBid(nominationId: NominationId, roomId: RoomId, maxBid: bigint): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    randomizeNominationOrder(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: Array<UserId>;
    } | {
        __kind__: "err";
        err: string;
    }>;
    reconcileMembershipIndexes(): Promise<void>;
    recoverAdmin(providedSecret: string): Promise<Result>;
    removeADPDataset(datasetType: string): Promise<{
        __kind__: "ok";
        ok: string;
    } | {
        __kind__: "err";
        err: string;
    }>;
    removeParticipant(roomId: RoomId, targetUser: UserId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    removeUserFromRoom(roomId: RoomId, userId: UserId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    resumeAuction(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    schema(): Promise<string>;
    sendMessage(roomId: RoomId, message: string): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    sendTestPush(): Promise<{
        __kind__: "ok";
        ok: {
            body: string;
            playerId: string;
            looksSuccessful: boolean;
        };
    } | {
        __kind__: "err";
        err: string;
    }>;
    setActiveNominationCount(roomId: RoomId, count: bigint): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setAvatarUrl(url: string): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setBestBallConfig(roomId: RoomId, startWeek: bigint, endWeek: bigint): Promise<Result>;
    setByeWeeks(mapping: Array<[string, bigint]>): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setDisplayName(name: string): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setGiphyApiKey(key: string): Promise<{
        __kind__: "ok";
        ok: string;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setNominationOrder(roomId: RoomId, orderedUsers: Array<UserId>): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setNominationQueue(roomId: RoomId, playerId: string): Promise<{
        __kind__: "ok";
        ok: string;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setOneSignalApiKey(key: string): Promise<{
        __kind__: "ok";
        ok: string;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setOneSignalPlayerId(id: string): Promise<void>;
    setParticipantPaid(roomId: RoomId, targetUserId: UserId, paid: boolean): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setRecoveryPassword(newSecret: string): Promise<Result>;
    setRssFeedUrls(urls: Array<string>): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setRssRefreshIntervalSecs(seconds: bigint): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    setSkipNominationTurn(roomId: RoomId, skip: boolean): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    startAuction(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    sweepNominations(roomId: RoomId): Promise<void>;
    syncWeeklyStats(season: bigint, week: bigint, batch: Array<WeeklyPlayerStats>): Promise<{
        __kind__: "ok";
        ok: bigint;
    } | {
        __kind__: "err";
        err: string;
    }>;
    toggleMessageReaction(roomId: RoomId, messageId: bigint, emoji: string): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    toggleReady(roomId: RoomId): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
    transferParticipantIdentity(roomId: RoomId, oldPrincipal: UserId, newPrincipal: UserId): Promise<{
        __kind__: "ok";
        ok: string;
    } | {
        __kind__: "err";
        err: string;
    }>;
    transform(raw: TransformationInput): Promise<TransformationOutput>;
    updateRoomSettings(roomId: RoomId, nomTimerSecs: bigint, bidTimerSecs: bigint, maxRosterSize: bigint | null, adpDataset: string): Promise<{
        __kind__: "ok";
        ok: null;
    } | {
        __kind__: "err";
        err: string;
    }>;
}
