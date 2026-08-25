import Types "../types/auction-types";
import Map "mo:core/Map";
import List "mo:core/List";
import Text "mo:core/Text";

// Domain logic for the Fantasy Football Auction platform.
// Stateless functions — state is injected via parameters.
module {
  // ── Room helpers ──────────────────────────────────────────────────────────

  /// Default player filter — all positions, all player types
  public func defaultPlayerFilter() : Types.PlayerFilter {
    { positions = []; filterType = "all" };
  };

  /// Check whether a player matches the given PlayerFilter.
  /// Empty positions list means all positions are allowed.
  public func playerMatchesFilter(player : Types.Player, filter : Types.PlayerFilter) : Bool {
    // Position check — skip if positions list is empty
    let posOk = if (filter.positions.size() == 0) {
      true;
    } else {
      filter.positions.find(func(pos : Text) : Bool { pos == player.position }) != null;
    };
    // Rookie/veteran check
    let typeOk = switch (filter.filterType) {
      case "rookies"  { player.yearsExp == 0 };
      case "veterans" { player.yearsExp > 0 };
      case _          { true }; // "all" or any unknown value
    };
    posOk and typeOk;
  };

  /// Returns the default roster settings for a new room.
  public func defaultRosterSettings() : Types.RosterSettings {
    {
      qb        = 1;
      rb        = 2;
      wr        = 2;
      te        = 1;
      flex      = 1;
      superflex = 0;
      bench     = 6;
      flexPositions      = ["RB", "WR", "TE"];
      superflexPositions = ["QB", "RB", "WR", "TE"];
    };
  };

  /// Create a new Room record
  public func newRoom(
    id : Types.RoomId,
    name : Text,
    admin : Types.UserId,
    startingBudget : Nat,
    settings : Types.AuctionSettings,
    createdAt : Types.Timestamp,
    isPublic : Bool,
    password : ?Text,
    playerFilter : Types.PlayerFilter,
    rosterSettings : ?Types.RosterSettings,
    teamCount : ?Nat,
    leagueFormat : ?Text,
    season : Nat,
    scoringFormat : Types.ScoringFormat,
  ) : Types.Room {
    {
      id;
      name;
      admin;
      participants = [admin];
      state = #Waiting;
      startingBudget;
      createdAt;
      settings;
      nominatorIndex = 0;
      nominationTurnStartedAt = createdAt;
      isPublic;
      password;
      playerFilter;
      nominationTurnPausedAt = null;
      readyParticipants = [];
      paidParticipants = [];
      rosterSettings;
      teamCount;
      leagueFormat;
      season;
      scoringFormat;
    };
  };

  /// Return default AuctionSettings
  public func defaultSettings() : Types.AuctionSettings {
    {
      nomTimerSecs = 60;
      bidTimerSecs = 30;
      minBidIncrement = 1;
      maxActivePicks = 3;
      maxParticipants = 8;
      maxRosterSize = null;
      adpDataset = "all";
    };
  };

  /// Find a room by id
  public func getRoom(
    rooms : Map.Map<Types.RoomId, Types.Room>,
    roomId : Types.RoomId,
  ) : ?Types.Room {
    rooms.get(roomId);
  };

  /// Update a room in the map
  public func putRoom(
    rooms : Map.Map<Types.RoomId, Types.Room>,
    room : Types.Room,
  ) {
    rooms.add(room.id, room);
  };

  /// Build a RoomSummary from a Room + participant count
  public func toRoomSummary(room : Types.Room, participantCount : Nat) : Types.RoomSummary {
    {
      id = room.id;
      name = room.name;
      state = room.state;
      participantCount;
      maxParticipants = room.settings.maxParticipants;
      adminId = room.admin;
      createdAt = room.createdAt;
      isPublic = room.isPublic;
    };
  };

  // ── Participant helpers ───────────────────────────────────────────────────

  /// Create a new Participant
  public func newParticipant(userId : Types.UserId, displayName : Text, startingBudget : Nat) : Types.Participant {
    {
      userId;
      displayName;
      budget = startingBudget;
      spent = 0;
      committed = [];
      wonPlayers = [];
      skipNominationTurn = false;
    };
  };

  /// Check if a user is already in the room's participant list
  public func isParticipant(room : Types.Room, userId : Types.UserId) : Bool {
    room.participants.find(func(p) { p == userId }) != null;
  };

  /// Compute available budget: budget - spent - sum(committed amounts)
  public func availableBudget(p : Types.Participant) : Nat {
    let sumCommitted = p.committed.foldLeft(0 : Nat, func(acc : Nat, entry : (Types.NominationId, Nat)) : Nat {
      acc + entry.1;
    });
    let total : Int = p.budget;
    let used : Int = p.spent + sumCommitted;
    let avail = total - used;
    if (avail <= 0) 0 else avail.toNat();
  };

  /// Update committed amount for a nomination in a participant record.
  /// Replaces existing entry for the nomination or adds a new one.
  public func updateCommitted(
    p : Types.Participant,
    nomId : Types.NominationId,
    amount : Nat,
  ) : Types.Participant {
    // Remove existing entry for nomId, then add the new one
    let filtered = p.committed.filter(func(entry : (Types.NominationId, Nat)) : Bool {
      entry.0 != nomId;
    });
    let newCommitted = if (amount == 0) {
      filtered;
    } else {
      filtered.concat([(nomId, amount)]);
    };
    { p with committed = newCommitted };
  };

  /// Remove committed entry for a nomination (e.g. on expiry or win settlement)
  public func clearCommitted(
    p : Types.Participant,
    nomId : Types.NominationId,
  ) : Types.Participant {
    { p with committed = p.committed.filter(func(entry : (Types.NominationId, Nat)) : Bool {
        entry.0 != nomId;
      });
    };
  };

  // ── Nomination helpers ───────────────────────────────────────────────────

  /// Create a new active Nomination
  public func newNomination(
    id : Types.NominationId,
    roomId : Types.RoomId,
    player : Types.Player,
    nominatedBy : Types.UserId,
    timerDurationSecs : Nat,
    startedAt : Types.Timestamp,
  ) : Types.Nomination {
    {
      id;
      roomId;
      playerId = player.id;
      playerName = player.name;
      position = player.position;
      team = player.team;
      imageUrl = player.headshotUrl;
      nominatedBy;
      state = #Active;
      currentBid = 1; // opening bid starts at $1 — no bids yet, no leader
      bidLeader = null;
      timerStartedAt = startedAt;
      timerDurationSecs;
      timerPausedAt = null;
      timerElapsedSecs = 0;
    };
  };

  /// Compute seconds remaining on a nomination timer.
  /// Accounts for elapsed time and paused state.
  public func timerSecsRemaining(nom : Types.Nomination, now : Types.Timestamp) : Nat {
    let nanosPerSec : Int = 1_000_000_000;
    // If paused, elapsed is frozen at pause point
    let elapsedSecs : Int = switch (nom.timerPausedAt) {
      case (?pausedAt) {
        // elapsed = (pausedAt - timerStartedAt) / 1e9 + timerElapsedSecs
        (pausedAt - nom.timerStartedAt) / nanosPerSec + nom.timerElapsedSecs;
      };
      case null {
        // elapsed = (now - timerStartedAt) / 1e9 + timerElapsedSecs
        (now - nom.timerStartedAt) / nanosPerSec + nom.timerElapsedSecs;
      };
    };
    let total : Int = nom.timerDurationSecs;
    let remaining : Int = total - elapsedSecs;
    if (remaining <= 0) 0 else remaining.toNat();
  };

  /// Compute seconds remaining on the nomination turn timer.
  /// Returns 0 if the room is not Active or the turn has expired.
  /// When activeNominationCount >= maxActivePicks the timer is paused:
  ///   - if nominationTurnPausedAt is set, use that as the frozen reference time
  ///   - if nominationTurnPausedAt is null (safety fallback), do not advance the timer
  public func nominationTurnSecsRemaining(
    room : Types.Room,
    now : Types.Timestamp,
    activeNominationCount : Nat,
    maxActivePicks : Nat,
  ) : Nat {
    switch (room.state) {
      case (#Active) {
        let nanosPerSec : Int = 1_000_000_000;
        // Use frozen reference time when paused (slots full), otherwise use now
        let referenceTime : Types.Timestamp = if (activeNominationCount >= maxActivePicks) {
          switch (room.nominationTurnPausedAt) {
            case (?pausedAt) pausedAt;
            case null room.nominationTurnStartedAt; // safety fallback: freeze at start (no elapsed)
          };
        } else {
          now;
        };
        let elapsed : Int = (referenceTime - room.nominationTurnStartedAt) / nanosPerSec;
        let total : Int = room.settings.nomTimerSecs;
        let remaining = total - elapsed;
        if (remaining <= 0) 0 else remaining.toNat();
      };
      case _ 0;
    };
  };

  /// Convert a Nomination to a NominationView (no private data).
  /// bidLeaderName is resolved by the caller from the profiles map.
  public func toNominationView(
    nom : Types.Nomination,
    now : Types.Timestamp,
    bidLeaderName : ?Text,
  ) : Types.NominationView {
    {
      id = nom.id;
      roomId = nom.roomId;
      playerId = nom.playerId;
      playerName = nom.playerName;
      position = nom.position;
      team = nom.team;
      imageUrl = nom.imageUrl;
      nominatedBy = nom.nominatedBy;
      state = nom.state;
      currentBid = nom.currentBid;
      bidLeader = nom.bidLeader;
      bidLeaderName;
      timerSecsRemaining = timerSecsRemaining(nom, now);
    };
  };

  /// Check whether a nomination's timer has expired given current time
  public func isTimerExpired(nom : Types.Nomination, now : Types.Timestamp) : Bool {
    timerSecsRemaining(nom, now) == 0;
  };

  // ── Proxy bid helpers ─────────────────────────────────────────────────────

  /// Resolve the next visible bid given existing currentBid and a new proxy max.
  /// Returns the new visible bid amount:
  ///   - No bids yet (incumbentMax == 0): visible bid = 1 (opening bid)
  ///   - If challengerMax > incumbentMax:
  ///       newBid = min(incumbentMax + minIncrement, challengerMax)
  ///       challenger becomes leader
  ///   - If challengerMax <= incumbentMax:
  ///       newBid = challengerMax  (no auto-increment — incumbent holds, show the competing bid as-is)
  ///       incumbent stays leader
  public func resolveProxyBid(
    _currentBid : Nat,
    challengerMax : Nat,
    incumbentMax : Nat,
    minIncrement : Nat,
  ) : Nat {
    if (incumbentMax == 0) {
      // First bid ever — visible bid starts at 1 (opening price)
      1;
    } else if (challengerMax > incumbentMax) {
      // Challenger wins — visible bid is incumbentMax + increment (capped at challengerMax)
      let proposed = incumbentMax + minIncrement;
      if (proposed > challengerMax) challengerMax else proposed;
    } else {
      // Incumbent wins — visible bid equals the challenger's bid exactly.
      // Do NOT auto-increment: the current bid simply becomes what the challenger offered.
      // Auto-increment only applies when both sides are competing via max bids.
      challengerMax;
    };
  };

  // ── Player helpers ────────────────────────────────────────────────────────

  /// Verified 2025 NFL team abbreviation → bye week lookup table.
  /// Single source of truth for bye week assignment during player import.
  /// Players whose team is not in this table get byeWeek = null (not 0).
  public func byeWeekForTeam(team : Text) : ?Nat {
    switch (team) {
      case ("ARI") ?8;
      case ("ATL") ?5;
      case ("BAL") ?7;
      case ("BUF") ?7;
      case ("CAR") ?14;
      case ("CHI") ?5;
      case ("CIN") ?10;
      case ("CLE") ?9;
      case ("DAL") ?10;
      case ("DEN") ?12;
      case ("DET") ?8;
      case ("GB") ?5;
      case ("HOU") ?6;
      case ("IND") ?11;
      case ("JAX") ?8;
      case ("KC") ?10;
      case ("LV") ?8;
      case ("LAC") ?12;
      case ("LAR") ?8;
      case ("MIA") ?12;
      case ("MIN") ?6;
      case ("NE") ?14;
      case ("NO") ?11;
      case ("NYG") ?14;
      case ("NYJ") ?9;
      case ("PHI") ?9;
      case ("PIT") ?5;
      case ("SF") ?14;
      case ("SEA") ?8;
      case ("TB") ?9;
      case ("TEN") ?10;
      case ("WAS") ?12;
      case _ null;
    };
  };

  /// Resolve a player's bye week from their team using the verified 2025 lookup table.
  /// Returns null when the team is not a valid NFL team.
  public func resolveByeWeek(player : Types.Player) : ?Nat {
    byeWeekForTeam(player.team);
  };

  /// Filter players from the player map by name query and optional position.
  /// Kept for backward compatibility with getPlayers() API.
  public func filterPlayers(
    playerMap : Map.Map<Text, Types.Player>,
    queryText : Text,
    position  : ?Text,
  ) : [Types.Player] {
    let lowerQuery = queryText.toLower();
    let result = List.empty<Types.Player>();
    playerMap.forEach(func(_id, p) {
      let nameMatch = lowerQuery == "" or p.name.toLower().contains(#text (lowerQuery));
      let posMatch = switch (position) {
        case null true;
        case (?pos) p.position == pos;
      };
      if (nameMatch and posMatch) result.add(p);
    });
    result.toArray();
  };

  /// Filter players from the player map by name query and a full PlayerFilter
  /// (respects position list and rookie/veteran distinction).
  public func filterPlayersByRoom(
    playerMap  : Map.Map<Text, Types.Player>,
    queryText  : Text,
    filter     : Types.PlayerFilter,
  ) : [Types.Player] {
    let lowerQuery = queryText.toLower();
    let result = List.empty<Types.Player>();
    playerMap.forEach(func(_id, p) {
      let nameMatch = lowerQuery == "" or p.name.toLower().contains(#text (lowerQuery));
      if (nameMatch and playerMatchesFilter(p, filter)) result.add(p);
    });
    result.toArray();
  };

  // ── Budget helpers ────────────────────────────────────────────────────────

  /// Record win for participant: spent += winningBid (once, exactly),
  /// clear committed for this nomination, add to wonPlayers.
  /// NOTE: budget (total) is NOT decremented — availableBudget = budget - spent - committed,
  /// so incrementing spent once is the only deduction needed. Decrementing budget would
  /// cause a double-deduction in the available budget calculation.
  public func applyWin(
    participant : Types.Participant,
    player : Types.Player,
    winningBid : Nat,
    nomId : Types.NominationId,
    nominatedBy : Types.UserId,
    closedAt : Types.Timestamp,
  ) : Types.Participant {
    let won : Types.WonPlayer = {
      playerId = player.id;
      playerName = player.name;
      position = player.position;
      team = player.team;
      winningBid;
      nominatedBy;
      closedAt;
      byeWeek = player.byeWeek;
    };
    // Remove committed for this nomination (clears it exactly once)
    let withoutCommit = clearCommitted(participant, nomId);
    // Increment spent only — do NOT touch budget (total).
    // available = budget - spent - committed; incrementing spent once is sufficient.
    {
      withoutCommit with
      spent = withoutCommit.spent + winningBid;
      wonPlayers = withoutCommit.wonPlayers.concat([won]);
    };
  };

  // ── ADP helpers ───────────────────────────────────────────────────────────

  /// Normalize a player name for ADP matching.
  /// Rules: lowercase, remove punctuation (periods, apostrophes, commas, hyphens), trim, collapse spaces.
  public func normalizeName(name : Text) : Text {
    // Step 1: lowercase
    let lower = name.toLower();
    // Step 2: remove punctuation characters — periods, apostrophes, commas, hyphens, dots
    let stripped = lower.flatMap(func(c : Char) : Text {
      switch (c) {
        case '.' "";
        case '\'' "";
        case ',' "";
        case '-' "";
        case '`' "";
        case _ Text.fromChar(c);
      };
    });
    // Step 3: collapse multiple spaces and trim — split on spaces then re-join non-empty tokens
    let tokens = stripped.split(#char ' ');
    let parts = List.empty<Text>();
    tokens.forEach(func(t) {
      if (t.size() > 0) parts.add(t);
    });
    // Text.join takes an Iter<Text> and a separator
    parts.values().join(" ");
  };

  /// Build a normalized-name lookup map from the players map.
  /// key: normalizeName(player.name), value: player
  /// When two players normalize to the same key, both are stored — callers must disambiguate.
  public func buildNormalizedLookup(
    playerMap : Map.Map<Text, Types.Player>,
  ) : Map.Map<Text, List.List<Types.Player>> {
    let lookup = Map.empty<Text, List.List<Types.Player>>();
    playerMap.forEach(func(_id, p) {
      let key = normalizeName(p.name);
      switch (lookup.get(key)) {
        case (?list) list.add(p);
        case null {
          let list = List.empty<Types.Player>();
          list.add(p);
          lookup.add(key, list);
        };
      };
    });
    lookup;
  };

  /// Enrich a player map with ADP data from a dataset.
  /// Returns a new immutable array of Player records with adp populated.
  /// Matching: normalize names; if multiple players share a normalized name,
  /// disambiguate by position then team; skip still-ambiguous entries.
  public func enrichPlayersWithADP(
    playerMap : Map.Map<Text, Types.Player>,
    dataset   : Types.ADPDataset,
  ) : [Types.Player] {
    // Build normalized lookup: normName → List<Player>
    let lookup = buildNormalizedLookup(playerMap);

    // Build adpOverride map: playerId → Float
    let overrides = Map.empty<Text, Float>();
    dataset.entries.forEach(func(entry : Types.AdpEntry) {
      let key = normalizeName(entry.name);
      switch (lookup.get(key)) {
        case null {}; // no matching Sleeper player — skip
        case (?matches) {
          let count = matches.size();
          if (count == 1) {
            // Unique match
            switch (matches.first()) {
              case (?p) overrides.add(p.id, entry.adp);
              case null {};
            };
          } else {
            // Ambiguous — try to disambiguate by position then team
            let posFiltered : List.List<Types.Player> = switch (entry.position) {
              case null matches;
              case (?pos) {
                let upperPos = pos.toUpper();
                let f = matches.filter(func(p : Types.Player) : Bool { p.position == upperPos });
                if (f.size() > 0) f else matches;
              };
            };
            let finalMatch : ?Types.Player = if (posFiltered.size() == 1) {
              posFiltered.first();
            } else {
              // Try team disambiguation
              switch (entry.team) {
                case null null; // still ambiguous — skip
                case (?tm) {
                  let upperTm = tm.toUpper();
                  let tf = posFiltered.filter(func(p : Types.Player) : Bool { p.team == upperTm });
                  if (tf.size() == 1) tf.first() else null;
                };
              };
            };
            switch (finalMatch) {
              case null {}; // skip ambiguous
              case (?p) overrides.add(p.id, entry.adp);
            };
          };
        };
      };
    });

    // Build result array with overrides applied
    let result = List.empty<Types.Player>();
    playerMap.forEach(func(_id, p) {
      switch (overrides.get(p.id)) {
        case (?adpVal) result.add({ p with adp = adpVal });
        case null result.add(p);
      };
    });
    result.toArray();
  };

  // ── Profile helpers ────────────────────────────────────────────────────────

  /// Look up display name for a user from the profiles map, falling back to truncated principal
  public func resolveDisplayName(
    profiles : Map.Map<Types.UserId, Types.UserProfile>,
    userId : Types.UserId,
  ) : Text {
    switch (profiles.get(userId)) {
      case (?profile) profile.displayName;
      case null {
        let txt = userId.toText();
        // Take the first 8 characters of the principal text as a short identifier
        Text.fromIter(txt.toIter().take(8));
      };
    };
  };

  // ── Scoring ────────────────────────────────────────────────────────────────

  /// Fixed standard scoring constants for the #std, #halfPpr, and #ppr formats.
  /// These are the exact league-standard values — do not change them.
  module ScoringConstants {
    public let PASS_YD_POINTS : Float = 0.04;
    public let PASS_TD_POINTS : Float = 4.0;
    public let INT_POINTS : Float = -2.0;
    public let RUSH_YD_POINTS : Float = 0.1;
    public let RUSH_TD_POINTS : Float = 6.0;
    public let REC_YD_POINTS : Float = 0.1;
    public let REC_TD_POINTS : Float = 6.0;
    public let FUMBLE_LOST_POINTS : Float = -2.0;
    public let TWO_PT_POINTS : Float = 2.0;
    // Reception points vary by format: 0 (#std), 0.5 (#halfPpr), 1.0 (#ppr).
    public let RECEPTION_STD : Float = 0.0;
    public let RECEPTION_HALF_PPR : Float = 0.5;
    public let RECEPTION_PPR : Float = 1.0;
  };

  /// Compute fantasy points from a raw WeeklyPlayerStats record for any
  /// ScoringFormat. Pure function — no state, no side effects.
  ///
  /// For #std, #halfPpr, and #ppr the fixed standard constants are applied
  /// (see ScoringConstants); only the reception weight differs per format.
  /// For #custom(settings) the exact CustomScoringSettings weights are applied
  /// to the same raw categories with identical formula structure.
  ///
  /// passYds/rushYds/recYds are Int and converted to Float before multiplying.
  /// Negative yardage is NEVER clamped to zero — a bad rushing performance
  /// yields negative points from that category.
  public func calculatePlayerPoints(
    stats : Types.WeeklyPlayerStats,
    format : Types.ScoringFormat,
  ) : Float {
    // Convert the Int yardage fields to Float. Negative yardage is preserved
    // (never clamped to zero) so a bad performance subtracts points.
    let passYds = stats.passYds.toFloat();
    let rushYds = stats.rushYds.toFloat();
    let recYds = stats.recYds.toFloat();

    // Resolve the per-category weights from the format.
    let (receptionPoints, passYdPoints, passTdPoints, intPoints, rushYdPoints, rushTdPoints, recYdPoints, recTdPoints, fumbleLostPoints, twoPtPoints) =
      switch (format) {
        case (#std) {
          (
            ScoringConstants.RECEPTION_STD,
            ScoringConstants.PASS_YD_POINTS,
            ScoringConstants.PASS_TD_POINTS,
            ScoringConstants.INT_POINTS,
            ScoringConstants.RUSH_YD_POINTS,
            ScoringConstants.RUSH_TD_POINTS,
            ScoringConstants.REC_YD_POINTS,
            ScoringConstants.REC_TD_POINTS,
            ScoringConstants.FUMBLE_LOST_POINTS,
            ScoringConstants.TWO_PT_POINTS,
          );
        };
        case (#halfPpr) {
          (
            ScoringConstants.RECEPTION_HALF_PPR,
            ScoringConstants.PASS_YD_POINTS,
            ScoringConstants.PASS_TD_POINTS,
            ScoringConstants.INT_POINTS,
            ScoringConstants.RUSH_YD_POINTS,
            ScoringConstants.RUSH_TD_POINTS,
            ScoringConstants.REC_YD_POINTS,
            ScoringConstants.REC_TD_POINTS,
            ScoringConstants.FUMBLE_LOST_POINTS,
            ScoringConstants.TWO_PT_POINTS,
          );
        };
        case (#ppr) {
          (
            ScoringConstants.RECEPTION_PPR,
            ScoringConstants.PASS_YD_POINTS,
            ScoringConstants.PASS_TD_POINTS,
            ScoringConstants.INT_POINTS,
            ScoringConstants.RUSH_YD_POINTS,
            ScoringConstants.RUSH_TD_POINTS,
            ScoringConstants.REC_YD_POINTS,
            ScoringConstants.REC_TD_POINTS,
            ScoringConstants.FUMBLE_LOST_POINTS,
            ScoringConstants.TWO_PT_POINTS,
          );
        };
        case (#custom(settings)) {
          (
            settings.receptionPoints,
            settings.passYdPoints,
            settings.passTdPoints,
            settings.intPoints,
            settings.rushYdPoints,
            settings.rushTdPoints,
            settings.recYdPoints,
            settings.recTdPoints,
            settings.fumbleLostPoints,
            settings.twoPtPoints,
          );
        };
      };

    // Identical formula structure for every format — only the weights differ.
    // Count fields are Nat; .toFloat() is the current Nat→Float conversion.
    let passPoints = passYds * passYdPoints
      + stats.passTds.toFloat() * passTdPoints
      + stats.ints.toFloat() * intPoints;
    let rushPoints = rushYds * rushYdPoints
      + stats.rushTds.toFloat() * rushTdPoints;
    let recPoints = stats.receptions.toFloat() * receptionPoints
      + recYds * recYdPoints
      + stats.recTds.toFloat() * recTdPoints;
    let miscPoints = stats.fumblesLost.toFloat() * fumbleLostPoints
      + stats.twoPtConversions.toFloat() * twoPtPoints;

    passPoints + rushPoints + recPoints + miscPoints;
  };
};
