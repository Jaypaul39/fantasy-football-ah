import Map "mo:core/Map";
import Runtime "mo:core/Runtime";
import Types "../types/best-ball-caching";
import AuctionTypes "../types/auction-types";
import SyncStatusTypes "../types/sync-status";
import SyncStatusLib "../lib/sync-status";
import LineupLib "../lib/lineup";

// Domain logic for the best-ball-caching domain: the finalized-weekly-score
// cache and the automatic finalization lifecycle for Best Ball weekly stats.
//
// Pure functions — state is injected via parameters. The cache is written
// exactly once at finalization and never recomputed or overwritten afterward.
// The single current non-finalized (live) week is never cached.
//
// The finalization trigger is the synchronization flow itself: when a new week
// is synced, finalizePriorPartialWeeks finalizes every earlier #partial week in
// the same season. This guarantees at most one non-finalized (live) week per
// season, so multiple completed-but-unfinalized weeks can never accumulate and
// push getStandings over the 5B query instruction ceiling. No new NFL
// schedule/game-status data source is needed — a week is provably complete the
// moment a subsequent week is synced (its games ended before the later week's
// games began).
module {
  /// Composite cache key for one participant's finalized weekly score.
  public func finalizedScoreKey(
    roomId : Types.RoomId,
    season : Nat,
    week : Nat,
    principal : Types.UserId,
  ) : Types.FinalizedScoreKey {
    roomId # "|" # season.toText() # "|" # week.toText() # "|" # principal.toText();
  };

  /// Read a participant's cached finalized score for a (season, week), if one
  /// exists. Returns null when the week is not finalized or no score was cached.
  public func getFinalizedScore(
    scores : Types.FinalizedWeeklyScores,
    roomId : Types.RoomId,
    season : Nat,
    week : Nat,
    principal : Types.UserId,
  ) : ?Float {
    scores.get(finalizedScoreKey(roomId, season, week, principal));
  };

  /// Derived helper: a (season, week) is finalized iff its SyncStatusRecord
  /// status == #finalized. #notYetAttempted and #partial are not finalized.
  public func isWeekFinalized(
    syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
    season : Nat,
    week : Nat,
  ) : Bool {
    switch (syncStatuses.get(SyncStatusLib.syncKey(season, week))) {
      case (?record) record.status == #finalized;
      case null false;
    };
  };

  /// Derived helper: a (season, week) is the single live (non-finalized) week
  /// iff its status == #partial. Per the lifecycle invariant, at most one week
  /// per season is #partial at any time.
  public func isLiveWeek(
    syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
    season : Nat,
    week : Nat,
  ) : Bool {
    switch (syncStatuses.get(SyncStatusLib.syncKey(season, week))) {
      case (?record) record.status == #partial;
      case null false;
    };
  };

  /// The internal finalization operation. Transitions the (season, week) to
  /// #finalized and, for every Best Ball room in that season, computes and
  /// writes each participant's optimal weekly-lineup total into the cache.
  ///
  /// Guarded: only a #partial week may be finalized; a #finalized week is
  /// refused (idempotent no-op), and a #notYetAttempted week is refused. The
  /// cache write is exactly-once — an existing cache entry is never overwritten.
  public func finalizeWeek(
    rooms : Map.Map<AuctionTypes.RoomId, AuctionTypes.Room>,
    participants : Map.Map<AuctionTypes.RoomId, Map.Map<AuctionTypes.UserId, AuctionTypes.Participant>>,
    bestBallConfigs : Map.Map<AuctionTypes.RoomId, AuctionTypes.BestBallConfig>,
    syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
    scores : Types.FinalizedWeeklyScores,
    calculateOptimalWeeklyLineup : (AuctionTypes.Room, AuctionTypes.Participant, Nat) -> LineupLib.LineupResult,
    season : Nat,
    week : Nat,
  ) : Types.FinalizeResult {
    // Guard: only a #partial week may be finalized.
    let key = SyncStatusLib.syncKey(season, week);
    switch (syncStatuses.get(key)) {
      case (?record) {
        switch (record.status) {
          case (#finalized) return #err "Week already finalized";
          case (#notYetAttempted) return #err "Week not in a partial state";
          case (#partial) {};
        };
      };
      case null return #err "Week not in a partial state";
    };
    // Compute and write each participant's score for every Best Ball room in
    // the season. Exactly-once: an existing cache entry is never overwritten.
    var written = 0;
    bestBallConfigs.forEach(func(roomId, _cfg) {
      switch (rooms.get(roomId)) {
        case (?room) {
          if (room.gameType == #BestBall and room.season == season) {
            switch (participants.get(roomId)) {
              case (?pm) {
                pm.forEach(func(userId, p) {
                  let scoreKey = finalizedScoreKey(roomId, season, week, userId);
                  if (scores.get(scoreKey) == null) {
                    let res = calculateOptimalWeeklyLineup(room, p, week);
                    scores.add(scoreKey, res.total);
                    written += 1;
                  };
                });
              };
              case null {};
            };
          };
        };
        case null {};
      };
    });
    // Transition the week to #finalized.
    let record = syncStatuses.get(key) ?? Runtime.trap("best-ball-caching: missing sync status during finalizeWeek");
    syncStatuses.add(key, { record with status = #finalized });
    #ok written;
  };

  /// The automatic finalization trigger. Called from the synchronization flow
  /// whenever a new week is synced: finalizes every earlier #partial week in the
  /// same season (weeks < justSyncedWeek). Returns the number of weeks finalized.
  ///
  /// This is what enforces the hard reliability invariant: the moment a
  /// subsequent week is synced, all prior partial weeks are finalized, so at
  /// most one non-finalized (live) week exists per season.
  public func finalizePriorPartialWeeks(
    rooms : Map.Map<AuctionTypes.RoomId, AuctionTypes.Room>,
    participants : Map.Map<AuctionTypes.RoomId, Map.Map<AuctionTypes.UserId, AuctionTypes.Participant>>,
    bestBallConfigs : Map.Map<AuctionTypes.RoomId, AuctionTypes.BestBallConfig>,
    syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
    scores : Types.FinalizedWeeklyScores,
    calculateOptimalWeeklyLineup : (AuctionTypes.Room, AuctionTypes.Participant, Nat) -> LineupLib.LineupResult,
    season : Nat,
    justSyncedWeek : Nat,
  ) : Nat {
    var weeksFinalized = 0;
    syncStatuses.forEach(func(_key, record) {
      if (record.season == season and record.week < justSyncedWeek and record.status == #partial) {
        switch (finalizeWeek(rooms, participants, bestBallConfigs, syncStatuses, scores, calculateOptimalWeeklyLineup, season, record.week)) {
          case (#ok _) weeksFinalized += 1;
          case (#err _) {};
        };
      };
    });
    weeksFinalized;
  };

  /// Post-migration backfill: for every #finalized week that lacks a cache
  /// entry, compute and write each participant's score. Idempotent — only fills
  /// missing entries, never overwrites. Returns the number of scores written.
  /// Runs in an update context (the daily timer) because it writes the cache.
  public func backfillFinalizedScores(
    rooms : Map.Map<AuctionTypes.RoomId, AuctionTypes.Room>,
    participants : Map.Map<AuctionTypes.RoomId, Map.Map<AuctionTypes.UserId, AuctionTypes.Participant>>,
    bestBallConfigs : Map.Map<AuctionTypes.RoomId, AuctionTypes.BestBallConfig>,
    syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
    scores : Types.FinalizedWeeklyScores,
    calculateOptimalWeeklyLineup : (AuctionTypes.Room, AuctionTypes.Participant, Nat) -> LineupLib.LineupResult,
  ) : Nat {
    var written = 0;
    syncStatuses.forEach(func(_key, record) {
      if (record.status == #finalized) {
        let season = record.season;
        let week = record.week;
        bestBallConfigs.forEach(func(roomId, _cfg) {
          switch (rooms.get(roomId)) {
            case (?room) {
              if (room.gameType == #BestBall and room.season == season) {
                switch (participants.get(roomId)) {
                  case (?pm) {
                    pm.forEach(func(userId, p) {
                      let scoreKey = finalizedScoreKey(roomId, season, week, userId);
                      if (scores.get(scoreKey) == null) {
                        let res = calculateOptimalWeeklyLineup(room, p, week);
                        scores.add(scoreKey, res.total);
                        written += 1;
                      };
                    });
                  };
                  case null {};
                };
              };
            };
            case null {};
          };
        });
      };
    });
    written;
  };
};
