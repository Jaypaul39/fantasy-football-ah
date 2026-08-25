import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";

// Migration: drop the `_heartbeatTimer`, `heartbeatRunning`,
// `cycleBalanceHistory`, `lastCycleSnapshotNs`, `heartbeatTickCount`,
// `lastHeartbeatTickAt`, and the six notification-worker tuning constants
// (`MAX_QUEUE_SIZE`, `MAX_NOTIFICATIONS_PER_RUN`, `MAX_NOTIFICATION_PROCESSING_NANOS`,
// `NOTIFICATION_EXPIRY_NANOS`, `MAX_SEND_ATTEMPTS`, `MAX_NOTIFICATION_BODY_LENGTH`)
// stable fields.
//
// The previous actor version registered a single recurring heartbeat timer:
//   - `_heartbeatTimer` (10s) — swept expired nominations, captured hourly
//     cycle-balance snapshots, and drained the notification queue (under its
//     own `processingNotifications` reentrancy guard).
//
// The recurring heartbeat timer has been removed entirely. The nomination
// sweep has run entirely on frontend polling for a long time and was redundant;
// cycle-balance history is no longer needed going forward; and notification
// draining is now triggered directly at enqueue time (fire-and-forget, under the
// existing `processingNotifications` guard) rather than by a periodic timer.
// Accordingly `_heartbeatTimer`, `heartbeatRunning`, `cycleBalanceHistory`,
// `lastCycleSnapshotNs`, `heartbeatTickCount`, and `lastHeartbeatTickAt` are
// consumed in the input and omitted from the output. The
// `processingNotifications` guard is kept (still used by the event-triggered
// drain) but promoted from a bare `var Bool` to a record-wrapped
// `{ var value : Bool }` so it can be injected into the AuctionMixin as a
// mutable reference — bare vars declared after the include are not visible to
// the mixin.
//
// The six notification-worker tuning constants were previously declared as bare
// `let` fields inside the AuctionMixin, which made them implicitly stable under
// enhanced orthogonal persistence. They are now declared `transient let` in the
// mixin body (per M0228) so they are re-initialized from literals on every
// (re)start and NOT persisted as stable state. This migration consumes the old
// stable `Nat` values and omits them from the output — they are now transient.
//
// Fresh-install seeding: on a fresh install the chain replays from an empty
// actor (`OldActor = {}` for the first migration), so several fields that need
// non-trivial initialization are seeded here:
//   - `byeWeeksStore`: if the old store has no "mapping" key, seed with the
//     inlined default 2025 NFL bye-week mapping (32 team entries) so the app
//     works out of the box before any admin import.
//   - `nextNominationIdState`: if `old.nextNominationIdState.next == 0`
//     (fresh-install default), seed to `{ var next = 1 }` so the first
//     nomination gets ID 1 (not 0).
//   - `rssRefreshIntervalSecs`: if `old.rssRefreshIntervalSecs.seconds == 0`
//     (fresh-install default), seed to `{ var seconds = 900 }` (15 minutes).
// All other fields pass through old.X unchanged (upgrade path).
//
// Every other stable field is unchanged between the previous and new versions
// (the prior episodes already migrated Player.byeWeek to ?Nat, added the
// reactions field to ChatMessage, and added the notification queue/counters and
// byeWeeksStore). They are passed through verbatim.
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

  // ── OldActor: matches the deployed .most stable signature exactly ────────
  // Verified against .old/src/backend/dist/backend.most. Includes the seven
  // heartbeat/cycle/timer fields and the six notification-worker tuning
  // constants that are dropped this migration, plus processingNotifications as
  // a bare `var Bool`.
  type OldActor = {
    // Timer ID — dropped this migration.
    _heartbeatTimer                 : Nat;
    // Heartbeat instrumentation/cycle history — all dropped this migration.
    var heartbeatRunning           : Bool;
    cycleBalanceHistory            : { var samples : [(Nat, Nat)] };
    lastCycleSnapshotNs             : { var timestamp : Nat };
    heartbeatTickCount              : { var count : Nat };
    lastHeartbeatTickAt             : { var value : Int };
    // Notification-worker tuning constants — previously bare `let` in the
    // AuctionMixin (implicitly stable), now `transient let` so they are no
    // longer persisted. Consumed here, omitted from NewActor.
    MAX_QUEUE_SIZE                       : Nat;
    MAX_NOTIFICATIONS_PER_RUN            : Nat;
    MAX_NOTIFICATION_PROCESSING_NANOS    : Nat;
    NOTIFICATION_EXPIRY_NANOS            : Nat;
    MAX_SEND_ATTEMPTS                    : Nat;
    MAX_NOTIFICATION_BODY_LENGTH         : Nat;
    // Reentrancy guard (var) — kept but promoted to { var value : Bool }.
    var processingNotifications     : Bool;
    // Core state
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
    // Notification-worker instrumentation — kept verbatim.
    notificationWorkerEntryCount      : { var count : Nat };
    lastNotificationWorkerStartedAt   : { var value : Int };
    lastNotificationWorkerCompletedAt : { var value : Int };
    lastNotificationWorkerError        : { var error : ?Text };
  };

  // ── NewActor: matches the current main.mo stable surface ─────────────────
  // The seven heartbeat/cycle/timer fields and the six notification-worker
  // tuning constants are omitted; processingNotifications is promoted to
  // { var value : Bool } so it can be shared with the AuctionMixin as a
  // mutable reference. Everything else is unchanged.
  type NewActor = {
    processingNotifications     : { var value : Bool };
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

  // Pass every kept field through unchanged. `_heartbeatTimer`,
  // `heartbeatRunning`, `cycleBalanceHistory`, `lastCycleSnapshotNs`,
  // `heartbeatTickCount`, `lastHeartbeatTickAt`, and the six `MAX_*` /
  // `NOTIFICATION_*` tuning constants are consumed in the input but
  // intentionally omitted from the output — these are the explicit drops.
  // The compiler emits M0207 warnings confirming each discard, which is
  // expected and correct. `processingNotifications` is promoted from a bare
  // `var Bool` to `{ var value = old.processingNotifications }`.
  //
  // Fresh-install seeding: on a fresh install the chain replays from an empty
  // actor, so `old.byeWeeksStore`, `old.nextNominationIdState`, and
  // `old.rssRefreshIntervalSecs` would be empty/zero. We detect that and seed
  // non-trivial defaults so the app works out of the box. On a real upgrade
  // from a deployed canister these fields already hold real values and pass
  // through unchanged.
  public func migration(old : OldActor) : NewActor {
    // Fresh-install seed for byeWeeksStore: if the old store has no "mapping"
    // key, seed with the inlined default 2025 NFL bye-week mapping (mirrors
    // lib/bye-weeks.mo defaultByeWeekMapping()). If the old store already has
    // data, pass it through unchanged.
    let byeWeeksStore : Map.Map<Text, [(Text, Nat)]> = switch (old.byeWeeksStore.get("mapping")) {
      case null {
        let store = Map.empty<Text, [(Text, Nat)]>();
        store.add(
          "mapping",
          [
            ("ARI", 8),
            ("ATL", 5),
            ("BAL", 7),
            ("BUF", 7),
            ("CAR", 14),
            ("CHI", 5),
            ("CIN", 10),
            ("CLE", 9),
            ("DAL", 10),
            ("DEN", 12),
            ("DET", 8),
            ("GB", 5),
            ("HOU", 6),
            ("IND", 11),
            ("JAX", 8),
            ("KC", 10),
            ("LV", 8),
            ("LAC", 12),
            ("LAR", 8),
            ("MIA", 12),
            ("MIN", 6),
            ("NE", 14),
            ("NO", 11),
            ("NYG", 14),
            ("NYJ", 9),
            ("PHI", 9),
            ("PIT", 5),
            ("SF", 14),
            ("SEA", 8),
            ("TB", 9),
            ("TEN", 10),
            ("WAS", 12),
          ],
        );
        store;
      };
      case (?_) old.byeWeeksStore;
    };

    // Fresh-install seed for nextNominationIdState: if old.next == 0
    // (fresh-install default), seed to 1 so the first nomination gets ID 1.
    let nextNominationIdState : { var next : Nat } = if (old.nextNominationIdState.next == 0) {
      { var next = 1 };
    } else {
      old.nextNominationIdState;
    };

    // Fresh-install seed for rssRefreshIntervalSecs: if old.seconds == 0
    // (fresh-install default), seed to 900 (15 minutes).
    let rssRefreshIntervalSecs : { var seconds : Nat } = if (old.rssRefreshIntervalSecs.seconds == 0) {
      { var seconds = 900 };
    } else {
      old.rssRefreshIntervalSecs;
    };

    {
      processingNotifications = { var value = old.processingNotifications };
      rooms = old.rooms;
      roomIdState = old.roomIdState;
      nextMsgIdState = old.nextMsgIdState;
      nextNominationIdState = nextNominationIdState;
      participants = old.participants;
      nominations = old.nominations;
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
      byeWeeksStore = byeWeeksStore;
      rssRefreshIntervalSecs = rssRefreshIntervalSecs;
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
    };
  };
};
