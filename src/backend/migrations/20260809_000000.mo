import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";
import Array "mo:core/Array";

// Migration: add four additive stable fields to the actor surface.
//
//   (1) WonPlayer.byeWeek : ?Nat        — populated from the player's byeWeek
//        in applyWin at runtime; existing wonPlayers don't have it, so the
//        migration sets byeWeek = null for every existing WonPlayer.
//   (2) Room.paidParticipants : [UserId] — host-toggled "paid" status, mirroring
//        the existing readyParticipants pattern. Existing rooms start with an
//        empty list.
//   (3) Participant.skipNominationTurn : Bool — standing toggle for a
//        participant to sit out nomination turns. Existing participants default
//        to false.
//   (4) nominationsByRoom : Map.Map<RoomId, [NominationId]> — per-room index of
//        nomination IDs, appended to at creation time. The backfill scan of the
//        existing flat `nominations` map happens in postupgrade, NOT in this
//        migration; the migration just initializes the map to empty for both
//        the upgrade and fresh-install paths.
//
// OldActor matches the deployed .most signature exactly — which equals the
// NewActor of the frozen 20260808_142843.mo migration (the source of truth).
// None of the four new fields exist in the deployed .most, so OldActor's
// inlined WonPlayer, Room, and Participant types omit them, and OldActor has no
// nominationsByRoom field.
//
// Fresh-install / empty-actor replay: when the chain replays from an empty
// actor, the old fields are empty/default. The new fields are seeded with
// their defaults regardless (paidParticipants = [], skipNominationTurn = false,
// byeWeek = null, nominationsByRoom = Map.empty()), so the empty-actor case
// needs no special sentinel detection for these four fields — the same
// transformations that run on a real upgrade produce correct defaults on a
// fresh install too. The existing fresh-install seeds from the prior migration
// (byeWeeksStore, nextNominationIdState, rssRefreshIntervalSecs) are NOT
// re-seeded here — they were already seeded by 20260808_142843.mo when it
// replayed on the fresh install, and this migration just passes them through.
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
  // Old types (deployed .most shape — no byeWeek on WonPlayer, no
  // paidParticipants on Room, no skipNominationTurn on Participant).

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

  type OldRoom = {
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

  type NewRoom = {
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
    paidParticipants : [UserId];
  };

  type UserProfile = {
    userId : UserId;
    displayName : Text;
    avatarUrl : ?Text;
  };

  type OldWonPlayer = {
    playerId : Text;
    playerName : Text;
    position : Text;
    team : Text;
    winningBid : Nat;
    nominatedBy : UserId;
    closedAt : Timestamp;
  };

  type NewWonPlayer = {
    playerId : Text;
    playerName : Text;
    position : Text;
    team : Text;
    winningBid : Nat;
    nominatedBy : UserId;
    closedAt : Timestamp;
    byeWeek : ?Nat;
  };

  type OldParticipant = {
    userId : UserId;
    displayName : Text;
    budget : Nat;
    spent : Nat;
    committed : [(NominationId, Nat)];
    wonPlayers : [OldWonPlayer];
  };

  type NewParticipant = {
    userId : UserId;
    displayName : Text;
    budget : Nat;
    spent : Nat;
    committed : [(NominationId, Nat)];
    wonPlayers : [NewWonPlayer];
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

  // ── OldActor: matches the deployed .most stable signature exactly ────────
  // This is the NewActor of the frozen 20260808_142843.mo migration — the
  // source of truth for the deployed signature. None of the four new fields
  // (WonPlayer.byeWeek, Room.paidParticipants, Participant.skipNominationTurn,
  // nominationsByRoom) exist here.
  type OldActor = {
    processingNotifications     : { var value : Bool };
    rooms                  : Map.Map<RoomId, OldRoom>;
    roomIdState            : { var next : Nat };
    nextMsgIdState         : { var next : Nat };
    nextNominationIdState  : { var next : Nat };
    participants           : Map.Map<RoomId, Map.Map<UserId, OldParticipant>>;
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

  // ── NewActor: adds the four new fields ───────────────────────────────────
  //   - rooms typed with NewRoom (adds paidParticipants)
  //   - participants typed with NewParticipant (adds skipNominationTurn, and
  //     wonPlayers typed with NewWonPlayer which adds byeWeek)
  //   - new top-level nominationsByRoom : Map.Map<RoomId, [NominationId]>
  // Everything else is unchanged from OldActor.
  type NewActor = {
    processingNotifications     : { var value : Bool };
    rooms                  : Map.Map<RoomId, NewRoom>;
    roomIdState            : { var next : Nat };
    nextMsgIdState         : { var next : Nat };
    nextNominationIdState  : { var next : Nat };
    participants           : Map.Map<RoomId, Map.Map<UserId, NewParticipant>>;
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
  };

  // Transform each OldRoom into a NewRoom by appending paidParticipants = [].
  // Record spread is safe here — Room has no var fields.
  func upgradeRoom(old : OldRoom) : NewRoom {
    { old with paidParticipants = [] : [UserId] };
  };

  // Transform each OldWonPlayer into a NewWonPlayer by appending byeWeek = null.
  // Record spread is safe here — WonPlayer has no var fields.
  func upgradeWonPlayer(old : OldWonPlayer) : NewWonPlayer {
    { old with byeWeek = null : ?Nat };
  };

  // Transform each OldParticipant into a NewParticipant: append
  // skipNominationTurn = false and upgrade the wonPlayers array element-by-
  // element to add byeWeek = null. Record spread is safe here — Participant has
  // no var fields; the wonPlayers array is rebuilt via .map with explicit type
  // arguments since the element type changes.
  func upgradeParticipant(old : OldParticipant) : NewParticipant {
    let newWonPlayers : [NewWonPlayer] = old.wonPlayers.map(
      upgradeWonPlayer,
    );
    {
      old with
      wonPlayers = newWonPlayers;
      skipNominationTurn = false;
    };
  };

  // Build the new rooms map by mapping each OldRoom value to a NewRoom.
  func upgradeRooms(old : Map.Map<RoomId, OldRoom>) : Map.Map<RoomId, NewRoom> {
    old.map(
      func(_key : RoomId, oldRoom : OldRoom) : NewRoom { upgradeRoom(oldRoom) },
    );
  };

  // Build the new participants map: outer map keyed by RoomId, inner map keyed
  // by UserId. Map over the outer map, and for each inner map map over its
  // values to upgrade each Participant.
  func upgradeParticipants(
    old : Map.Map<RoomId, Map.Map<UserId, OldParticipant>>,
  ) : Map.Map<RoomId, Map.Map<UserId, NewParticipant>> {
    old.map(
      func(_roomId : RoomId, inner : Map.Map<UserId, OldParticipant>) : Map.Map<UserId, NewParticipant> {
        inner.map(
          func(_userId : UserId, p : OldParticipant) : NewParticipant { upgradeParticipant(p) },
        );
      },
    );
  };

  // nominationsByRoom is initialized to an empty map for both the upgrade and
  // fresh-install paths. The backfill scan of the existing flat `nominations`
  // map (grouping NominationIds by roomId) happens in postupgrade, not here —
  // the migration must stay pure and trap-free, and a full scan belongs in the
  // postupgrade one-time repair pass.
  public func migration(old : OldActor) : NewActor {
    let rooms : Map.Map<RoomId, NewRoom> = upgradeRooms(old.rooms);
    let participants : Map.Map<RoomId, Map.Map<UserId, NewParticipant>> = upgradeParticipants(old.participants);
    let nominationsByRoom : Map.Map<RoomId, [NominationId]> = Map.empty();

    {
      processingNotifications = old.processingNotifications;
      rooms = rooms;
      roomIdState = old.roomIdState;
      nextMsgIdState = old.nextMsgIdState;
      nextNominationIdState = old.nextNominationIdState;
      participants = participants;
      nominations = old.nominations;
      nominationsByRoom = nominationsByRoom;
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
    };
  };
};
