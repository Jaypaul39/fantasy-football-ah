import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";
import Int "mo:core/Int";

// Migration: widen WeeklyPlayerStats yardage fields from Nat to Int.
//
// Negative yardage on a play (e.g. a running back tackled behind the line of
// scrimmage, rushYds: -1) is valid game data that Nat cannot represent, so
// syncWeeklyStats failed candid encoding whenever a player had negative
// yardage. This migration widens passYds/rushYds/recYds from Nat to Int
// losslessly (a plain widening conversion — no data is lost or changed in
// value, only the type). All other fields stay Nat.
//
// OldActor matches the deployed .most signature exactly — which equals the
// NewActor of the frozen 20260822_weekly_stats.mo migration (the source of
// truth). That shape has weeklyPlayerStats : Map.Map<Text, WeeklyPlayerStats>
// where WeeklyPlayerStats has all-Nat fields.
//
// NewActor is identical except WeeklyPlayerStats.passYds/rushYds/recYds are
// Int. The migration body maps every existing weeklyPlayerStats entry through
// the widening conversion; if no entries exist yet, the map is simply empty
// (Map.map over an empty map yields an empty map).
//
// This file is self-contained: all type definitions referenced by OldActor and
// NewActor are inlined below (only `mo:core/` imports are used). The chain
// runner requires the exported function to be named `migration`.
module {
  // ── Inlined shared type aliases ───────────────────────────────────────────
  type RoomId = Text;
  type UserId = Principal;
  type NominationId = Nat;
  type Timestamp = Int;

  // ── Inlined domain types ─────────────────────────────────────────────────
  // Old types (deployed .most shape — the NewActor of 20260822_weekly_stats.mo).

  type AuctionState = {
    #Waiting;
    #Active;
    #Paused;
    #Completed;
  };

  type AuctionSettings = {
    nomTimerSecs : Nat;
    bidTimerSecs : Nat;
    minBidIncrement : Nat;
    maxActivePicks : Nat;
    maxParticipants : Nat;
    maxRosterSize : ?Nat;
    adpDataset : Text;
  };

  type PlayerFilter = {
    positions : [Text];
    filterType : Text;
  };

  type RosterSettings = {
    qb : Nat;
    rb : Nat;
    wr : Nat;
    te : Nat;
    flex : Nat;
    superflex : Nat;
    bench : Nat;
    flexPositions : [Text];
    superflexPositions : [Text];
  };

  type CustomScoringSettings = {
    receptionPoints : Float;
    passYdPoints : Float;
    passTdPoints : Float;
    intPoints : Float;
    rushYdPoints : Float;
    rushTdPoints : Float;
    recYdPoints : Float;
    recTdPoints : Float;
    fumbleLostPoints : Float;
    twoPtPoints : Float;
  };

  type ScoringFormat = {
    #std;
    #halfPpr;
    #ppr;
    #custom : CustomScoringSettings;
  };

  type BestBallConfig = {
    startWeek : Nat;
    endWeek : Nat;
  };

  type Room = {
    id : RoomId;
    name : Text;
    admin : UserId;
    participants : [UserId];
    state : AuctionState;
    startingBudget : Nat;
    createdAt : Timestamp;
    settings : AuctionSettings;
    nominatorIndex : Nat;
    nominationTurnStartedAt : Timestamp;
    isPublic : Bool;
    password : ?Text;
    playerFilter : PlayerFilter;
    nominationTurnPausedAt : ?Timestamp;
    readyParticipants : [UserId];
    rosterSettings : ?RosterSettings;
    teamCount : ?Nat;
    leagueFormat : ?Text;
    season : Nat;
    scoringFormat : ScoringFormat;
    paidParticipants : [UserId];
  };

  type UserProfile = {
    userId : UserId;
    displayName : Text;
    avatarUrl : ?Text;
  };

  type WonPlayer = {
    playerId : Text;
    playerName : Text;
    position : Text;
    team : Text;
    winningBid : Nat;
    nominatedBy : UserId;
    closedAt : Timestamp;
    byeWeek : ?Nat;
  };

  type Participant = {
    userId : UserId;
    displayName : Text;
    budget : Nat;
    spent : Nat;
    committed : [(NominationId, Nat)];
    wonPlayers : [WonPlayer];
    skipNominationTurn : Bool;
  };

  type NominationState = {
    #Active;
    #Closed;
    #Expired;
  };

  type Nomination = {
    id : NominationId;
    roomId : RoomId;
    playerId : Text;
    playerName : Text;
    position : Text;
    team : Text;
    imageUrl : ?Text;
    nominatedBy : UserId;
    state : NominationState;
    currentBid : Nat;
    bidLeader : ?UserId;
    timerStartedAt : Timestamp;
    timerDurationSecs : Nat;
    timerPausedAt : ?Timestamp;
    timerElapsedSecs : Nat;
  };

  type Bid = {
    nominationId : NominationId;
    userId : UserId;
    amount : Nat;
    isProxy : Bool;
    timestamp : Timestamp;
  };

  type ProxyBid = {
    nominationId : NominationId;
    userId : UserId;
    maxBid : Nat;
  };

  type Player = {
    id : Text;
    name : Text;
    position : Text;
    team : Text;
    byeWeek : ?Nat;
    adp : Float;
    headshotUrl : ?Text;
    yearsExp : Nat;
  };

  type PendingNotification = {
    id : Nat;
    userId : UserId;
    title : Text;
    body : Text;
    createdAt : Timestamp;
    attempts : Nat;
  };

  type BidHistoryEventType = {
    #nominationCreated;
    #leaderChanged;
    #nominationEnded;
  };

  type BidHistoryEvent = {
    eventType : BidHistoryEventType;
    userId : UserId;
    displayName : Text;
    playerName : Text;
    amount : Nat;
    timestamp : Timestamp;
    isAutoBid : ?Bool;
  };

  type AdpEntry = {
    name : Text;
    adp : Float;
    position : ?Text;
    team : ?Text;
  };

  type ADPDataset = {
    entries : [AdpEntry];
    importedAt : Int;
    lastUpdated : Int;
  };

  type ChatMessage = {
    id : Nat;
    userId : UserId;
    displayName : Text;
    message : Text;
    timestamp : Timestamp;
    reactions : [(Text, [UserId])];
  };

  type PlayerPriceRecord = {
    playerId : ?Text;
    playerName : Text;
    position : Text;
    winningBid : Nat;
    budgetPct : Float;
    totalBudget : Nat;
    numTeams : Nat;
    leagueType : Text;
    winningUserId : UserId;
    roomId : RoomId;
    closedAt : Timestamp;
  };

  type RecoveryAttempt = {
    count : Nat;
    lockedUntil : ?Timestamp;
  };

  // Old WeeklyPlayerStats — all-Nat fields (deployed .most shape).
  type OldWeeklyPlayerStats = {
    playerId : Text;
    season : Nat;
    week : Nat;
    passYds : Nat;
    passTds : Nat;
    ints : Nat;
    rushYds : Nat;
    rushTds : Nat;
    receptions : Nat;
    recYds : Nat;
    recTds : Nat;
    fumblesLost : Nat;
    twoPtConversions : Nat;
  };

  // New WeeklyPlayerStats — passYds/rushYds/recYds widened to Int.
  type NewWeeklyPlayerStats = {
    playerId : Text;
    season : Nat;
    week : Nat;
    passYds : Int;
    passTds : Nat;
    ints : Nat;
    rushYds : Int;
    rushTds : Nat;
    receptions : Nat;
    recYds : Int;
    recTds : Nat;
    fumblesLost : Nat;
    twoPtConversions : Nat;
  };

  // ── OldActor: matches the deployed .most stable signature exactly ────────
  // This is the NewActor of the frozen 20260822_weekly_stats.mo migration —
  // the source of truth for the deployed signature. It includes
  // weeklyPlayerStats with all-Nat WeeklyPlayerStats.
  type OldActor = {
    processingNotifications     : { var value : Bool };
    rooms                  : Map.Map<RoomId, Room>;
    roomIdState            : { var next : Nat };
    nextMsgIdState         : { var next : Nat };
    nextNominationIdState  : { var next : Nat };
    participants           : Map.Map<RoomId, Map.Map<UserId, Participant>>;
    nominations            : Map.Map<NominationId, Nomination>;
    nominationsByRoom      : Map.Map<RoomId, [NominationId]>;
    bids                   : Map.Map<RoomId, Map.Map<NominationId, List.List<Bid>>>;
    proxyBids              : Map.Map<RoomId, Map.Map<NominationId, Map.Map<UserId, ProxyBid>>>;
    nominatedByRoom        : Map.Map<RoomId, Set.Set<Text>>;
    profiles               : Map.Map<UserId, UserProfile>;
    userRooms              : Map.Map<UserId, List.List<RoomId>>;
    adminPrincipalStore    : Map.Map<Text, UserId>;
    players                : Map.Map<Text, Player>;
    nominationHistory      : Map.Map<RoomId, Map.Map<NominationId, List.List<BidHistoryEvent>>>;
    roomMessages           : Map.Map<RoomId, List.List<ChatMessage>>;
    activeAdpDataset       : Map.Map<Text, ADPDataset>;
    nominationQueue        : Map.Map<Text, Text>;
    giphyApiKeyStore       : Map.Map<Text, Text>;
    oneSignalApiKeyStore   : Map.Map<Text, Text>;
    oneSignalPlayerIds     : Map.Map<Text, Text>;
    playerPriceHistory     : Map.Map<Text, List.List<PlayerPriceRecord>>;
    rssCacheContent        : { var content : ?Text };
    rssCacheTimestamp      : { var timestamp : Nat };
    rssFeedUrlsStore       : Map.Map<Text, [Text]>;
    byeWeeksStore          : Map.Map<Text, [(Text, Nat)]>;
    rssRefreshIntervalSecs : { var seconds : Nat };
    lastRssFetchStatus     : { var status : [(Text, Bool)] };
    activeRoomIds          : Set.Set<RoomId>;
    notificationQueue      : List.List<PendingNotification>;
    nextNotificationId     : { var next : Nat };
    notificationsQueuedTotal    : { var count : Nat };
    notificationsProcessedTotal : { var count : Nat };
    notificationsSentTotal      : { var count : Nat };
    notificationsExpiredTotal   : { var count : Nat };
    notificationsRetriedTotal   : { var count : Nat };
    notificationsFailedTotal    : { var count : Nat };
    notificationWorkerEntryCount      : { var count : Nat };
    lastNotificationWorkerStartedAt   : { var value : Int };
    lastNotificationWorkerCompletedAt : { var value : Int };
    lastNotificationWorkerError        : { var error : ?Text };
    recoveryPasswordHash    : { var value : ?Text };
    recoveryAttempts        : Map.Map<Text, RecoveryAttempt>;
    draftedPlayerIds        : Map.Map<RoomId, Set.Set<Text>>;
    bestBallConfigs         : Map.Map<RoomId, BestBallConfig>;
    weeklyPlayerStats       : Map.Map<Text, OldWeeklyPlayerStats>;
  };

  // ── NewActor: widens weeklyPlayerStats yardage fields to Int ─────────────
  // Everything else is unchanged from OldActor.
  type NewActor = {
    processingNotifications     : { var value : Bool };
    rooms                  : Map.Map<RoomId, Room>;
    roomIdState            : { var next : Nat };
    nextMsgIdState         : { var next : Nat };
    nextNominationIdState  : { var next : Nat };
    participants           : Map.Map<RoomId, Map.Map<UserId, Participant>>;
    nominations            : Map.Map<NominationId, Nomination>;
    nominationsByRoom      : Map.Map<RoomId, [NominationId]>;
    bids                   : Map.Map<RoomId, Map.Map<NominationId, List.List<Bid>>>;
    proxyBids              : Map.Map<RoomId, Map.Map<NominationId, Map.Map<UserId, ProxyBid>>>;
    nominatedByRoom        : Map.Map<RoomId, Set.Set<Text>>;
    profiles               : Map.Map<UserId, UserProfile>;
    userRooms              : Map.Map<UserId, List.List<RoomId>>;
    adminPrincipalStore    : Map.Map<Text, UserId>;
    players                : Map.Map<Text, Player>;
    nominationHistory      : Map.Map<RoomId, Map.Map<NominationId, List.List<BidHistoryEvent>>>;
    roomMessages           : Map.Map<RoomId, List.List<ChatMessage>>;
    activeAdpDataset       : Map.Map<Text, ADPDataset>;
    nominationQueue        : Map.Map<Text, Text>;
    giphyApiKeyStore       : Map.Map<Text, Text>;
    oneSignalApiKeyStore   : Map.Map<Text, Text>;
    oneSignalPlayerIds     : Map.Map<Text, Text>;
    playerPriceHistory     : Map.Map<Text, List.List<PlayerPriceRecord>>;
    rssCacheContent        : { var content : ?Text };
    rssCacheTimestamp      : { var timestamp : Nat };
    rssFeedUrlsStore       : Map.Map<Text, [Text]>;
    byeWeeksStore          : Map.Map<Text, [(Text, Nat)]>;
    rssRefreshIntervalSecs : { var seconds : Nat };
    lastRssFetchStatus     : { var status : [(Text, Bool)] };
    activeRoomIds          : Set.Set<RoomId>;
    notificationQueue      : List.List<PendingNotification>;
    nextNotificationId     : { var next : Nat };
    notificationsQueuedTotal    : { var count : Nat };
    notificationsProcessedTotal : { var count : Nat };
    notificationsSentTotal      : { var count : Nat };
    notificationsExpiredTotal   : { var count : Nat };
    notificationsRetriedTotal   : { var count : Nat };
    notificationsFailedTotal    : { var count : Nat };
    notificationWorkerEntryCount      : { var count : Nat };
    lastNotificationWorkerStartedAt   : { var value : Int };
    lastNotificationWorkerCompletedAt : { var value : Int };
    lastNotificationWorkerError        : { var error : ?Text };
    recoveryPasswordHash    : { var value : ?Text };
    recoveryAttempts        : Map.Map<Text, RecoveryAttempt>;
    draftedPlayerIds        : Map.Map<RoomId, Set.Set<Text>>;
    bestBallConfigs         : Map.Map<RoomId, BestBallConfig>;
    weeklyPlayerStats       : Map.Map<Text, NewWeeklyPlayerStats>;
  };

  public func migration(old : OldActor) : NewActor {
    // Widen every existing weeklyPlayerStats entry's yardage fields from Nat
    // to Int losslessly (a plain widening conversion — no data is lost or
    // changed in value, only the type). If no entries exist, Map.map over the
    // empty map yields an empty map, seeding the migrated map empty as before.
    let weeklyPlayerStats = old.weeklyPlayerStats.map<Text, OldWeeklyPlayerStats, NewWeeklyPlayerStats>(
      func(_, s) {
        {
          playerId = s.playerId;
          season = s.season;
          week = s.week;
          passYds = Int.fromNat(s.passYds);
          passTds = s.passTds;
          ints = s.ints;
          rushYds = Int.fromNat(s.rushYds);
          rushTds = s.rushTds;
          receptions = s.receptions;
          recYds = Int.fromNat(s.recYds);
          recTds = s.recTds;
          fumblesLost = s.fumblesLost;
          twoPtConversions = s.twoPtConversions;
        };
      }
    );
    {
      processingNotifications = old.processingNotifications;
      rooms = old.rooms;
      roomIdState = old.roomIdState;
      nextMsgIdState = old.nextMsgIdState;
      nextNominationIdState = old.nextNominationIdState;
      participants = old.participants;
      nominations = old.nominations;
      nominationsByRoom = old.nominationsByRoom;
      bids = old.bids;
      proxyBids = old.proxyBids;
      nominatedByRoom = old.nominatedByRoom;
      profiles = old.profiles;
      userRooms = old.userRooms;
      adminPrincipalStore = old.adminPrincipalStore;
      players = old.players;
      nominationHistory = old.nominationHistory;
      roomMessages = old.roomMessages;
      activeAdpDataset = old.activeAdpDataset;
      nominationQueue = old.nominationQueue;
      giphyApiKeyStore = old.giphyApiKeyStore;
      oneSignalApiKeyStore = old.oneSignalApiKeyStore;
      oneSignalPlayerIds = old.oneSignalPlayerIds;
      playerPriceHistory = old.playerPriceHistory;
      rssCacheContent = old.rssCacheContent;
      rssCacheTimestamp = old.rssCacheTimestamp;
      rssFeedUrlsStore = old.rssFeedUrlsStore;
      byeWeeksStore = old.byeWeeksStore;
      rssRefreshIntervalSecs = old.rssRefreshIntervalSecs;
      lastRssFetchStatus = old.lastRssFetchStatus;
      activeRoomIds = old.activeRoomIds;
      notificationQueue = old.notificationQueue;
      nextNotificationId = old.nextNotificationId;
      notificationsQueuedTotal = old.notificationsQueuedTotal;
      notificationsProcessedTotal = old.notificationsProcessedTotal;
      notificationsSentTotal = old.notificationsSentTotal;
      notificationsExpiredTotal = old.notificationsExpiredTotal;
      notificationsRetriedTotal = old.notificationsRetriedTotal;
      notificationsFailedTotal = old.notificationsFailedTotal;
      notificationWorkerEntryCount = old.notificationWorkerEntryCount;
      lastNotificationWorkerStartedAt = old.lastNotificationWorkerStartedAt;
      lastNotificationWorkerCompletedAt = old.lastNotificationWorkerCompletedAt;
      lastNotificationWorkerError = old.lastNotificationWorkerError;
      recoveryPasswordHash = old.recoveryPasswordHash;
      recoveryAttempts = old.recoveryAttempts;
      draftedPlayerIds = old.draftedPlayerIds;
      bestBallConfigs = old.bestBallConfigs;
      weeklyPlayerStats;
    };
  };
};
