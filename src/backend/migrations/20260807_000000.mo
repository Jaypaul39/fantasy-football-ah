import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";

// Migration: bootstrap the actor from an empty fresh-install seed.
//
// This is the NEW FIRST migration in the chain (its timestamp sorts before the
// historical 20260808_142843.mo). On a fresh install the chain replays from an
// EMPTY actor, so OldActor = {} (the empty record) is required for the empty
// seed to deserialize without trapping — declaring any field here would trap
// with "field expected but not found in state" (the MOPS-CHECK-DEPLOY-SKIPPED
// failure).
//
// NewActor EXACTLY matches the OldActor of the historical 20260808_142843.mo
// migration — the ~40-field record including the heartbeat fields
// (_heartbeatTimer, heartbeatRunning, cycleBalanceHistory, lastCycleSnapshotNs,
// heartbeatTickCount, lastHeartbeatTickAt), the six notification-worker tuning
// constants (MAX_QUEUE_SIZE, MAX_NOTIFICATIONS_PER_RUN,
// MAX_NOTIFICATION_PROCESSING_NANOS, NOTIFICATION_EXPIRY_NANOS, MAX_SEND_ATTEMPTS,
// MAX_NOTIFICATION_BODY_LENGTH), and bare `var processingNotifications : Bool`.
// This makes 20260808_142843.mo the second migration, whose OldActor now matches
// this migration's NewActor, so its existing fresh-install seeding logic
// (byeWeeksStore / nextNominationIdState / rssRefreshIntervalSecs) runs
// correctly on a fresh install.
//
// The body constructs every NewActor field from fresh-install defaults: empty
// maps/lists/sets, counters at 0, heartbeat fields at their default/empty
// values, processingNotifications = false, byeWeeksStore = empty map,
// nextNominationIdState = { var next = 0 }, rssRefreshIntervalSecs = { var
// seconds = 0 }. The non-trivial seeds (bye-week mapping, next nomination ID =
// 1, RSS refresh = 900s) are intentionally NOT applied here — they are applied
// by the second migration (20260808_142843.mo), which detects the empty/default
// values and seeds them.
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

  // ── Inlined domain types (copied from types/auction-types.mo) ─────────────

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
    scoringType : ?Text;
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
  };

  type Participant = {
    userId : UserId;
    displayName : Text;
    budget : Nat;
    spent : Nat;
    committed : [(NominationId, Nat)];
    wonPlayers : [WonPlayer];
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

  // ── OldActor: the bootstrap migration starts from an EMPTY actor ─────────
  // This is the FIRST migration in the chain, so on a fresh install the chain
  // replays from an empty actor whose state carries NO fields. OldActor must
  // therefore be the empty record `{}` — declaring any field here would make
  // deserialization trap with "field expected but not found in state" against
  // the empty fresh-install seed (the MOPS-CHECK-DEPLOY-SKIPPED failure).
  type OldActor = {};

  // ── NewActor: EXACTLY matches the OldActor of 20260808_142843.mo ─────────
  // This is the ~40-field record including the heartbeat fields, the six
  // notification-worker tuning constants, and bare `var processingNotifications
  // : Bool`. It is the shape the historical 20260808_142843.mo migration
  // expects as its input (its OldActor), so the chain stays consistent.
  type NewActor = {
    _heartbeatTimer                 : Nat;
    var heartbeatRunning           : Bool;
    cycleBalanceHistory            : { var samples : [(Nat, Nat)] };
    lastCycleSnapshotNs             : { var timestamp : Nat };
    heartbeatTickCount              : { var count : Nat };
    lastHeartbeatTickAt             : { var value : Int };
    MAX_QUEUE_SIZE                       : Nat;
    MAX_NOTIFICATIONS_PER_RUN            : Nat;
    MAX_NOTIFICATION_PROCESSING_NANOS    : Nat;
    NOTIFICATION_EXPIRY_NANOS            : Nat;
    MAX_SEND_ATTEMPTS                    : Nat;
    MAX_NOTIFICATION_BODY_LENGTH         : Nat;
    var processingNotifications     : Bool;
    rooms                  : Map.Map<RoomId, Room>;
    roomIdState            : { var next : Nat };
    nextMsgIdState         : { var next : Nat };
    nextNominationIdState  : { var next : Nat };
    participants           : Map.Map<RoomId, Map.Map<UserId, Participant>>;
    nominations            : Map.Map<NominationId, Nomination>;
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
  };

  // Because OldActor is the empty record `{}`, `old` carries no fields. The
  // migration body therefore constructs EVERY NewActor field from fresh-install
  // defaults. The non-trivial seeds (bye-week mapping, next nomination ID = 1,
  // RSS refresh = 900s) are intentionally left at their empty/default values
  // here — the second migration (20260808_142843.mo) detects them and seeds
  // them, so its existing fresh-install seeding logic runs correctly.
  public func migration(old : OldActor) : NewActor {
    {
      _heartbeatTimer = 0;
      var heartbeatRunning = false;
      cycleBalanceHistory = { var samples = [] : [(Nat, Nat)] };
      lastCycleSnapshotNs = { var timestamp = 0 };
      heartbeatTickCount = { var count = 0 };
      lastHeartbeatTickAt = { var value = 0 };
      MAX_QUEUE_SIZE = 0;
      MAX_NOTIFICATIONS_PER_RUN = 0;
      MAX_NOTIFICATION_PROCESSING_NANOS = 0;
      NOTIFICATION_EXPIRY_NANOS = 0;
      MAX_SEND_ATTEMPTS = 0;
      MAX_NOTIFICATION_BODY_LENGTH = 0;
      var processingNotifications = false;
      rooms = Map.empty<RoomId, Room>();
      roomIdState = { var next = 0 };
      nextMsgIdState = { var next = 0 };
      nextNominationIdState = { var next = 0 };
      participants = Map.empty<RoomId, Map.Map<UserId, Participant>>();
      nominations = Map.empty<NominationId, Nomination>();
      bids = Map.empty<RoomId, Map.Map<NominationId, List.List<Bid>>>();
      proxyBids = Map.empty<RoomId, Map.Map<NominationId, Map.Map<UserId, ProxyBid>>>();
      nominatedByRoom = Map.empty<RoomId, Set.Set<Text>>();
      profiles = Map.empty<UserId, UserProfile>();
      userRooms = Map.empty<UserId, List.List<RoomId>>();
      adminPrincipalStore = Map.empty<Text, UserId>();
      players = Map.empty<Text, Player>();
      nominationHistory = Map.empty<RoomId, Map.Map<NominationId, List.List<BidHistoryEvent>>>();
      roomMessages = Map.empty<RoomId, List.List<ChatMessage>>();
      activeAdpDataset = Map.empty<Text, ADPDataset>();
      nominationQueue = Map.empty<Text, Text>();
      giphyApiKeyStore = Map.empty<Text, Text>();
      oneSignalApiKeyStore = Map.empty<Text, Text>();
      oneSignalPlayerIds = Map.empty<Text, Text>();
      playerPriceHistory = Map.empty<Text, List.List<PlayerPriceRecord>>();
      rssCacheContent = { var content = null : ?Text };
      rssCacheTimestamp = { var timestamp = 0 };
      rssFeedUrlsStore = Map.empty<Text, [Text]>();
      byeWeeksStore = Map.empty<Text, [(Text, Nat)]>();
      rssRefreshIntervalSecs = { var seconds = 0 };
      lastRssFetchStatus = { var status = [] : [(Text, Bool)] };
      activeRoomIds = Set.empty<RoomId>();
      notificationQueue = List.empty<PendingNotification>();
      nextNotificationId = { var next = 0 };
      notificationsQueuedTotal = { var count = 0 };
      notificationsProcessedTotal = { var count = 0 };
      notificationsSentTotal = { var count = 0 };
      notificationsExpiredTotal = { var count = 0 };
      notificationsRetriedTotal = { var count = 0 };
      notificationsFailedTotal = { var count = 0 };
      notificationWorkerEntryCount = { var count = 0 };
      lastNotificationWorkerStartedAt = { var value = 0 };
      lastNotificationWorkerCompletedAt = { var value = 0 };
      lastNotificationWorkerError = { var error = null : ?Text };
    };
  };
};
