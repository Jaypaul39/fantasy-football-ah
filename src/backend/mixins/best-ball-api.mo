import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import BestBallCachingTypes "../types/best-ball-caching";
import SyncStatusTypes "../types/sync-status";
import Map "mo:core/Map";
import List "mo:core/List";
import Principal "mo:core/Principal";
import Order "mo:core/Order";

// Phase 4 — Best Ball weekly lineup + cumulative standings read APIs.
//
// Both public methods are read-only queries that consume the Phase 3 optimal
// lineup calculator (calculateOptimalWeeklyLineup, wired in main.mo) as the
// single source of truth. No lineup optimization or scoring logic is duplicated
// here — every weekly score comes from that one authoritative calculator.
//
// Access follows the existing room-access/privacy model: a caller must be a
// participant of the room (AuctionLib.isParticipant) to read that room's Best
// Ball data. Non-participants cannot inspect private-room data, and the methods
// are not global-admin-only. Best Ball rooms are distinguished by the presence
// of a bestBallConfigs entry; non-Best-Ball rooms are rejected.
//
// These methods never mutate stable state — they are pure queries.

mixin (
  rooms : Map.Map<Types.RoomId, Types.Room>,
  participants : Map.Map<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>,
  bestBallConfigs : Map.Map<Types.RoomId, Types.BestBallConfig>,
  syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
  scores : BestBallCachingTypes.FinalizedWeeklyScores,
  calculateOptimalWeeklyLineup : (Types.Room, Types.Participant, Nat) -> LineupLib.LineupResult,
) {

  /// Public view of one participant's optimal Best Ball lineup for one week.
  /// Reuses the Phase 3 LineupResult shape (starters, bench, total) and adds the
  /// participant/team identity and week so the frontend can render it directly.
  public type WeeklyLineupView = {
    roomId : Types.RoomId;
    participantId : Types.UserId;
    displayName : Text;
    week : Nat;
    starters : [LineupLib.LineupSlot];
    bench : [LineupLib.LineupBenchEntry];
    total : Float;
  };

  /// One row of the cumulative Best Ball standings for a room.
  public type StandingsEntry = {
    participantId : Types.UserId;
    displayName : Text;
    totalPoints : Float;
  };

  /// Resolved context shared by getStandings and getWeeklyStandings after the
  /// room/gameType/config lookup and participant-access gating succeed.
  type StandingsContext = {
    room : Types.Room;
    cfg : Types.BestBallConfig;
    pm : Map.Map<Types.UserId, Types.Participant>;
  };

  /// Shared room/gameType/config lookup + participant-access gating used by
  /// both getStandings and getWeeklyStandings. Returns the resolved room,
  /// BestBallConfig, and participants map on success, or the same #err Text the
  /// two public methods surface: "Room not found", "Room is not a Best Ball
  /// room" (gameType != #BestBall, or no config), "Not a participant in this
  /// room", or "No participants".
  func resolveStandingsContext(
    roomId : Types.RoomId,
    caller : Principal,
  ) : { #ok : StandingsContext; #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        // Best Ball only — the room's gameType discriminator marks it.
        if (room.gameType != #BestBall) {
          return #err "Room is not a Best Ball room";
        };
        // Phase 12a — cumulative standings apply only to #Cumulative rooms.
        // A #HeadToHead room is rejected: its standings come from
        // getH2HStandings, not the cumulative sum.
        if (room.competitionMode == #HeadToHead) {
          return #err "Room is a Head-to-Head room; use getH2HStandings";
        };
        let cfg = switch (bestBallConfigs.get(roomId)) {
          case (?c) c;
          case null return #err "Room is not a Best Ball room";
        };
        // Room access/privacy: caller must be a participant of the room.
        if (not AuctionLib.isParticipant(room, caller)) {
          return #err "Not a participant in this room";
        };
        let pm = switch (participants.get(roomId)) {
          case (?m) m;
          case null return #err "No participants";
        };
        #ok { room; cfg; pm };
      };
    };
  };

  /// Shared deterministic sort comparator used by both getStandings and
  /// getWeeklyStandings: descending totalPoints, ties broken by ascending
  /// Principal.compare(participantId). Ordering never depends on map iteration
  /// order.
  func compareStandings(a : StandingsEntry, b : StandingsEntry) : Order.Order {
    if (a.totalPoints > b.totalPoints) { #less }
    else if (a.totalPoints < b.totalPoints) { #greater }
    else { Principal.compare(a.participantId, b.participantId) };
  };

  /// Retrieve one participant's optimal Best Ball lineup for one week.
  ///
  /// Identifies the room, participant, and week using the existing identifier
  /// types (RoomId = Text, UserId = Principal, week = Nat). Returns the Phase 3
  /// calculator result unchanged (starters, bench, total) plus participant/team
  /// identity and the week.
  ///
  /// An unsynced week returns an empty lineup with total 0 — not an error — per
  /// the Phase 3 semantics. Missing individual player stats contribute 0 points
  /// while the player remains owned (and may appear on the bench).
  ///
  /// Access: the caller must be a participant of the room. Non-Best-Ball rooms
  /// are rejected.
  public shared query ({ caller }) func getWeeklyLineup(
    roomId : Types.RoomId,
    participantId : Types.UserId,
    week : Nat,
  ) : async { #ok : WeeklyLineupView; #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        // Best Ball only — the room's gameType discriminator marks it.
        if (room.gameType != #BestBall) {
          return #err "Room is not a Best Ball room";
        };
        // Room access/privacy: caller must be a participant of the room.
        if (not AuctionLib.isParticipant(room, caller)) {
          return #err "Not a participant in this room";
        };
        let pm = switch (participants.get(roomId)) {
          case (?m) m;
          case null return #err "Participant not found";
        };
        switch (pm.get(participantId)) {
          case null return #err "Participant not found";
          case (?p) {
            let result = calculateOptimalWeeklyLineup(room, p, week);
            #ok {
              roomId;
              participantId;
              displayName = p.displayName;
              week;
              starters = result.starters;
              bench = result.bench;
              total = result.total;
            };
          };
        };
      };
    };
  };

  /// Compute Cumulative Best Ball standings for a room.
  ///
  /// Each participant's cumulative score is the sum of their optimal Best Ball
  /// weekly score across every applicable week from BestBallConfig.startWeek
  /// through FINAL_WEEK (17, inclusive), computed via the Phase 3
  /// calculator — no second scoring/lineup algorithm. Unsynced weeks contribute
  /// 0 points and do not fail the calculation; missing individual player stats
  /// contribute 0 while the player stays owned/benched.
  ///
  /// The result is deterministically ordered: descending by cumulative points,
  /// with equal scores broken by the stable participant identifier (ascending),
  /// so ordering never depends on map iteration order.
  ///
  /// Access: the caller must be a participant of the room. Non-Best-Ball rooms
  /// are rejected.
  public shared query ({ caller }) func getStandings(
    roomId : Types.RoomId,
  ) : async { #ok : [StandingsEntry]; #err : Text } {
    switch (resolveStandingsContext(roomId, caller)) {
      case (#err e) return #err e;
      case (#ok ctx) {
        // Compute each participant's cumulative score. For a #finalized week,
        // read the cached value from finalizedWeeklyScores (written exactly once
        // at finalization, never recomputed); only the single live (#partial)
        // week is computed dynamically via calculateOptimalWeeklyLineup;
        // #notYetAttempted weeks contribute 0. This enforces the invariant that
        // multiple completed-but-unfinalized weeks cannot accumulate and become
        // simultaneously expensive recomputation targets.
        let entries = List.empty<StandingsEntry>();
        ctx.pm.forEach(func(userId, p) {
          var total = 0.0;
          var w = ctx.cfg.startWeek;
          while (w <= AuctionLib.FINAL_WEEK) {
            if (BestBallCachingLib.isWeekFinalized(syncStatuses, ctx.room.season, w)) {
              total += BestBallCachingLib.getFinalizedScore(scores, roomId, ctx.room.season, w, userId) ?? 0.0;
            } else if (BestBallCachingLib.isLiveWeek(syncStatuses, ctx.room.season, w)) {
              let res = calculateOptimalWeeklyLineup(ctx.room, p, w);
              total += res.total;
            };
            // #notYetAttempted weeks contribute 0.
            w += 1;
          };
          entries.add({ participantId = userId; displayName = p.displayName; totalPoints = total });
        });
        // Deterministic ordering: descending points, ascending participantId on ties.
        let sorted = entries.toArray().sort(compareStandings);
        #ok sorted;
      };
    };
  };

  /// Compute single-week Best Ball standings for a room.
  ///
  /// Each participant's score for the requested `week` is their optimal Best
  /// Ball weekly score for that single week, computed via the Phase 3
  /// calculator — no second scoring/lineup algorithm. An unsynced week
  /// contributes 0 points for each participant and does not fail the
  /// calculation (consistent with how getStandings treats unsynced weeks within
  /// its sum); missing individual player stats contribute 0 while the player
  /// stays owned/benched.
  ///
  /// The result is deterministically ordered exactly like getStandings:
  /// descending by points, with equal scores broken by the stable participant
  /// identifier (ascending), so ordering never depends on map iteration order.
  ///
  /// Access: the caller must be a participant of the room. Non-Best-Ball rooms
  /// are rejected. The requested week must fall within the room's configured
  /// BestBallConfig range (startWeek..FINAL_WEEK inclusive); a week outside that
  /// range is rejected with #err.
  public shared query ({ caller }) func getWeeklyStandings(
    roomId : Types.RoomId,
    week : Nat,
  ) : async { #ok : [StandingsEntry]; #err : Text } {
    switch (resolveStandingsContext(roomId, caller)) {
      case (#err e) return #err e;
      case (#ok ctx) {
        // Backend enforcement of the week navigation boundary: the requested
        // week must fall within the room's configured BestBallConfig range
        // (startWeek..FINAL_WEEK).
        if (week < ctx.cfg.startWeek or week > AuctionLib.FINAL_WEEK) {
          return #err "Week out of range";
        };
        // Compute each participant's score for the single requested week. For a
        // #finalized week, read the cached value from finalizedWeeklyScores; for
        // the live (#partial) week, compute dynamically via
        // calculateOptimalWeeklyLineup; #notYetAttempted weeks contribute 0.
        let entries = List.empty<StandingsEntry>();
        ctx.pm.forEach(func(userId, p) {
          var score = 0.0;
          if (BestBallCachingLib.isWeekFinalized(syncStatuses, ctx.room.season, week)) {
            score := BestBallCachingLib.getFinalizedScore(scores, roomId, ctx.room.season, week, userId) ?? 0.0;
          } else if (BestBallCachingLib.isLiveWeek(syncStatuses, ctx.room.season, week)) {
            let res = calculateOptimalWeeklyLineup(ctx.room, p, week);
            score := res.total;
          };
          entries.add({ participantId = userId; displayName = p.displayName; totalPoints = score });
        });
        // Deterministic ordering: descending points, ascending participantId on ties.
        let sorted = entries.toArray().sort(compareStandings);
        #ok sorted;
      };
    };
  };
};
