import Common "common";

// Domain-specific types for the Fantasy Football Auction platform
module {
  public type RoomId = Common.RoomId;
  public type UserId = Common.UserId;
  public type NominationId = Common.NominationId;
  public type Timestamp = Common.Timestamp;

  // ── Auction state ──────────────────────────────────────────────────────────

  public type AuctionState = {
    #Waiting;
    #Active;
    #Paused;
    #Completed;
  };

  // ── Settings ───────────────────────────────────────────────────────────────

  public type AuctionSettings = {
    nomTimerSecs : Nat;     // nomination timer duration (host-configurable)
    bidTimerSecs : Nat;     // bid timer duration reset on new leader (host-configurable)
    minBidIncrement : Nat;  // default 1
    maxActivePicks : Nat;   // default 3
    maxParticipants : Nat;  // valid range 8–16, default 8
    maxRosterSize : ?Nat;   // optional roster cap per participant; null = no cap
    adpDataset : Text;      // "all" | "rookies" — which ADP dataset to use for this room
  };

  // ── Player filter (room-level) ─────────────────────────────────────────────

  /// Controls which players are eligible for nomination in a room.
  /// positions: subset of ["QB","RB","WR","TE"] (empty = all positions allowed)
  /// filterType: "all" | "rookies" (yearsExp == 0) | "veterans" (yearsExp > 0)
  public type PlayerFilter = {
    positions  : [Text];   // empty means no position restriction
    filterType : Text;     // "all" | "rookies" | "veterans"
  };

  // ── Roster settings ────────────────────────────────────────────────────────

  /// Configurable lineup requirements for a room.
  /// flexPositions: positions eligible for FLEX slot (default ["RB","WR","TE"])
  /// superflexPositions: positions eligible for SUPERFLEX slot (default ["QB","RB","WR","TE"])
  public type RosterSettings = {
    qb         : Nat;
    rb         : Nat;
    wr         : Nat;
    te         : Nat;
    flex       : Nat;
    superflex  : Nat;
    bench      : Nat;
    flexPositions      : [Text];
    superflexPositions : [Text];
  };

  // ── Scoring format ─────────────────────────────────────────────────────────

  /// Custom scoring weights for the #custom ScoringFormat variant.
  public type CustomScoringSettings = {
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

  /// Typed scoring format for a room. Replaces the legacy free-text scoringType.
  public type ScoringFormat = {
    #std;
    #halfPpr;
    #ppr;
    #custom : CustomScoringSettings;
  };

  /// Best Ball tracking configuration for a room. Its presence marks that the
  /// room has Best Ball tracking enabled and records the week range. No stats
  /// storage or scoring calculation lives here — that is a later phase.
  public type BestBallConfig = {
    startWeek : Nat;
    endWeek : Nat;
  };

  /// Raw weekly player statistics for a single player in a single season/week.
  /// Raw stat categories only — NO precomputed points. ptsStd/ptsHalfPpr/ptsPpr
  /// are computed from these raw categories in a later phase, never stored
  /// redundantly. Keyed in stable storage by a composite Text key:
  ///   playerId # "|" # Nat.toText(season) # "|" # Nat.toText(week)
  public type WeeklyPlayerStats = {
    playerId : Text;
    season : Nat;
    week : Nat;
    // passYds/rushYds/recYds are Int, not Nat — negative yardage on a play
    // (e.g. a running back tackled behind the line of scrimmage) is valid game
    // data that Nat cannot represent. All other fields are counts that can
    // never be negative, so they stay Nat.
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

  // ── Room ──────────────────────────────────────────────────────────────────

  public type Room = {
    id : RoomId;
    name : Text;
    admin : UserId;
    participants : [UserId];
    state : AuctionState;
    startingBudget : Nat;
    createdAt : Timestamp;
    settings : AuctionSettings;
    /// Index into participants array for whose turn it is to nominate (round-robin)
    nominatorIndex : Nat;
    /// Timestamp when the current nomination turn started (for nomTimerSecs countdown)
    nominationTurnStartedAt : Timestamp;
    /// Whether this room is publicly listed in the lobby (true) or private/invite-only (false)
    isPublic : Bool;
    /// Password for private rooms; null for public rooms
    password : ?Text;
    /// Player pool filter applied at nomination time
    playerFilter : PlayerFilter;
    /// When the nomination turn timer is paused (max concurrent nominations reached),
    /// this stores the timestamp at which the pause began so the countdown freezes.
    /// Null means the timer is running normally. Do NOT confuse with timerPausedAt on Nomination.
    nominationTurnPausedAt : ?Timestamp;
    /// Principals of participants who have toggled ready in the Waiting Room.
    /// Cleaned up automatically when a participant leaves or is removed.
    readyParticipants : [UserId];
    /// Principals of participants the host has marked as paid. Informational
    /// only — does not affect starting the auction. Mirrors readyParticipants;
    /// kept in sync when a participant leaves the room. Added via additive
    /// migration pattern.
    paidParticipants : [UserId];
    /// Optional roster configuration — null for legacy rooms (use defaultRosterSettings)
    rosterSettings : ?RosterSettings;
    /// Optional team count for this room
    teamCount : ?Nat;
    /// League format: "redraft" | "dynasty" | "keeper" | "rookie" (default: "redraft")
    leagueFormat : ?Text;
    /// Canonical NFL season this room belongs to (e.g. 2026). Set at creation.
    season : Nat;
    /// Typed scoring format. Always has a value (defaults to #halfPpr).
    scoringFormat : ScoringFormat;
  };

  // ── User Profile ──────────────────────────────────────────────────────────

  /// Global user profile — persisted per principal across all rooms
  public type UserProfile = {
    userId : UserId;
    displayName : Text;
    avatarUrl : ?Text;
  };

  // ── Participant ────────────────────────────────────────────────────────────

  public type WonPlayer = {
    playerId : Text;
    playerName : Text;
    position : Text;
    team : Text;
    winningBid : Nat;
    nominatedBy : UserId;
    closedAt : Timestamp;
    /// Optional bye week derived from the player's team at win-settlement time.
    /// Populated in applyWin from the player's byeWeek. null when the player's
    /// team is not a valid NFL team. Added via additive migration pattern.
    byeWeek : ?Nat;
  };

  /// committed: list of (NominationId, locked amount) for each active nomination.
  /// available_budget = budget - spent - sum(committed amounts)
  public type Participant = {
    userId : UserId;
    displayName : Text;
    budget : Nat;           // total starting budget; decremented only on win settlement
    spent : Nat;            // total actually spent (deducted from budget on win)
    committed : [(NominationId, Nat)]; // locked per active nomination (returned if no win)
    wonPlayers : [WonPlayer];
    /// Standing toggle: when true, advanceNominatorIndex skips this participant's
    /// nomination turn. Persists until turned off again. Added via additive
    /// migration pattern.
    skipNominationTurn : Bool;
  };

  // ── Nomination ────────────────────────────────────────────────────────────

  public type NominationState = {
    #Active;
    #Closed;
    #Expired;
  };

  public type Nomination = {
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

  // ── Bid ───────────────────────────────────────────────────────────────────

  public type Bid = {
    nominationId : NominationId;
    userId : UserId;
    amount : Nat;
    isProxy : Bool;
    timestamp : Timestamp;
  };

  // ── Proxy bid (private — never exposed directly via API) ──────────────────

  public type ProxyBid = {
    nominationId : NominationId;
    userId : UserId;
    maxBid : Nat;
  };

  // ── Player (Sleeper structure) ─────────────────────────────────────────────

  public type Player = {
    id         : Text;
    name       : Text;
    position   : Text;
    team       : Text;
    /// Optional bye week derived from the backend NFL team → bye week lookup table.
    /// null when the player's team is not a valid NFL team (instead of 0).
    byeWeek    : ?Nat;
    adp        : Float;
    headshotUrl : ?Text;
    /// Years of NFL experience. 0 = rookie (null years_exp from Sleeper maps to 0).
    yearsExp   : Nat;
  };

  // ── Pending notification (queued for backend worker delivery) ──────────────

  /// A notification enqueued for delivery by the backend worker.
  /// The worker drains up to MAX_NOTIFICATIONS_PER_RUN entries per heartbeat tick,
  /// sending each via the OneSignal REST API through an IC management canister HTTP outcall.
  public type PendingNotification = {
    id        : Nat;       // monotonically increasing ID from nextNotificationId
    userId    : UserId;    // recipient principal
    title     : Text;      // notification title
    body      : Text;      // notification body (capped at MAX_NOTIFICATION_BODY_LENGTH)
    createdAt : Timestamp; // enqueue time (nanoseconds)
    attempts  : Nat;       // number of delivery attempts so far
  };

  // ── Budget view types (privacy-separated, API boundary) ──────────────────

  /// Full budget breakdown — returned only to the participant viewing their own data.
  public type PrivateParticipantBudget = {
    totalBudget     : Nat;   // starting budget
    spentBudget     : Nat;   // winning bids only
    committedBudget : Nat;   // sum of all active max bids
    availableBudget : Nat;   // totalBudget - committedBudget - spentBudget
  };

  /// Public budget — returned when any other user's budget is displayed.
  /// Never includes committedBudget so proxy/max bids cannot be reverse-engineered.
  public type PublicParticipantBudget = {
    totalBudget            : Nat;  // starting budget
    spentBudget            : Nat;  // winning bids only
    publicAvailableBudget  : Nat;  // totalBudget - spentBudget (no committed)
  };

  /// Discriminated union so the frontend always knows which shape it received.
  public type ParticipantBudgetView = {
    #private_ : PrivateParticipantBudget;
    #public_  : PublicParticipantBudget;
  };

  /// ParticipantView: safe view of a participant for the API boundary.
  /// The 'committed' array is NEVER included — budget info is in budgetView only.
  public type ParticipantView = {
    userId      : UserId;
    displayName : Text;
    wonPlayers  : [WonPlayer];
    budgetView  : ParticipantBudgetView;
    avatarUrl   : ?Text;
    /// Mirrors Participant.skipNominationTurn so the frontend can render the
    /// "Skip my nomination turns" badge without reading the internal type.
    skipNominationTurn : Bool;
  };

  // ── View types (API boundary, no mutable fields, no private data) ─────────

  /// NominationView: computed view with timerSecsRemaining, no private proxy data.
  /// bidLeaderName: display name of the bid leader (resolved from profiles).
  public type NominationView = {
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
    bidLeaderName : ?Text;
    timerSecsRemaining : Nat;
  };

  /// RoomSummary: lightweight list view
  public type RoomSummary = {
    id : RoomId;
    name : Text;
    state : AuctionState;
    participantCount : Nat;
    maxParticipants : Nat;
    adminId : UserId;
    createdAt : Timestamp;
    /// Whether this room is publicly listed in the lobby
    isPublic : Bool;
  };

  // ── Bid history event (event-based, per nomination) ──────────────────────

  public type BidHistoryEventType = {
    #nominationCreated;
    #leaderChanged;
    #nominationEnded;
  };

  public type BidHistoryEvent = {
    eventType   : BidHistoryEventType;
    userId      : UserId;
    displayName : Text;
    playerName  : Text;
    amount      : Nat;
    timestamp   : Timestamp;
    isAutoBid   : ?Bool;  // ?true when the auto/proxy-bid system placed this leaderChanged event on behalf of a user; null/false = manual bid
  };

  // ── ADP dataset types ─────────────────────────────────────────────────────

  /// A single entry in an ADP dataset.
  /// name: player name as it appears in the ADP source (will be normalized for matching)
  /// adp: average draft position (lower = higher draft value)
  /// position/team: optional disambiguators when multiple players share a name
  public type AdpEntry = {
    name     : Text;
    adp      : Float;
    position : ?Text;
    team     : ?Text;
  };

  /// An active ADP dataset — only one is kept at a time (new upload replaces old).
  public type ADPDataset = {
    entries     : [AdpEntry];
    importedAt  : Int;
    /// Alias for importedAt — set to the same value on each import.
    lastUpdated : Int;
  };

  // ── Chat message (per room) ────────────────────────────────────────────────

  public type ChatMessage = {
    id          : Nat;
    userId      : UserId;
    displayName : Text;
    message     : Text;
    timestamp   : Timestamp;
    reactions   : [(Text, [UserId])];
  };

  // ── Historical price record ───────────────────────────────────────────────

  public type PlayerPriceRecord = {
    playerId      : ?Text;
    playerName    : Text;
    position      : Text;
    winningBid    : Nat;
    budgetPct     : Float;
    totalBudget   : Nat;
    numTeams      : Nat;
    leagueType    : Text;
    winningUserId : UserId;
    roomId        : RoomId;
    closedAt      : Timestamp;
  };

  /// RoomView: full state for a room, includes caller's proxy bids and nomination timer info.
  public type RoomView = {
    room : Room;
    participants : [ParticipantView];
    activeNominations : [NominationView];
    completedNominations : [NominationView];
    myProxyBids : [ProxyBid];               // only the caller's own proxy bids
    nominationTimerSecsRemaining : Nat;      // backend-computed seconds until nomination turn expires
    currentNominatorId : ?UserId;           // principal of who must nominate next
    currentNominatorName : ?Text;           // display name of current nominator
    queuedPlayerId : ?Text;                 // server-side nomination queue entry for the caller
    /// Authoritative set of player IDs already drafted (won) in this room.
    /// Single source of truth for excluding drafted players from the nomination
    /// list. Populated in every nomination-close path with a winning bid and
    /// never removed when a participant leaves. Additive, backward compatible.
    draftedPlayerIds : [Text];
  };

  // ── HTTP outcall types ─────────────────────────────────────────────────────

  public type HttpRequest = {
    url : Text;
    method : Text;
    headers : [(Text, Text)];
    body : [Nat8];
  };

  public type HttpResponse = {
    status : Nat;
    headers : [(Text, Text)];
    body : [Nat8];
  };
};
