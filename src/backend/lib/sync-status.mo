import Map "mo:core/Map";
import List "mo:core/List";
import Time "mo:core/Time";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Types "../types/sync-status";
import AuctionTypes "../types/auction-types";
import AuctionLib "../lib/auction-types";

// Domain logic for the sync-status domain: per-(season, week) sync status
// tracking for Best Ball weekly stats.
//
// Pure functions — state is injected via parameters. The atomic duplicate-sync
// guard lives in recordSyncStatus: it is checked and set within the same call,
// so a (season, week) already marked #synced can never be reprocessed or
// replaced by a later submission.
//
// This is visibility, not full autonomy: the backend never fetches from Sleeper
// and never makes an HTTPS outcall. The actual fetch+parse+submit happens in an
// authenticated admin's browser session; these functions only record and expose
// what is missing.
module {
  /// Composite map key for a (season, week): "season|week".
  /// Consistent with the existing composite-key convention used by
  /// weeklyPlayerStats (playerId|season|week).
  public func syncKey(season : Nat, week : Nat) : Text {
    season.toText() # "|" # week.toText();
  };

  /// Compute the deduplicated set of (season, week) pairs across all #BestBall
  /// rooms' startWeek..FINAL_WEEK ranges. Unions overlapping ranges across
  /// different rooms on the same season so each (season, week) appears exactly
  /// once. Only rooms with a BestBallConfig entry (gameType #BestBall) are
  /// considered.
  public func computeDedupSeasonWeeks(
    rooms : Map.Map<AuctionTypes.RoomId, AuctionTypes.Room>,
    bestBallConfigs : Map.Map<AuctionTypes.RoomId, AuctionTypes.BestBallConfig>,
  ) : [(Nat, Nat)] {
    // Dedup by the composite "season|week" Text key so overlapping ranges across
    // rooms on the same season collapse to a single pair.
    let seen = Map.empty<Text, Bool>();
    let pairs = List.empty<(Nat, Nat)>();
    bestBallConfigs.forEach(func(roomId, cfg) {
      switch (rooms.get(roomId)) {
        case (?room) {
          if (room.gameType == #BestBall) {
            var week = cfg.startWeek;
            while (week <= AuctionLib.FINAL_WEEK) {
              let key = syncKey(room.season, week);
              if (seen.get(key) == null) {
                seen.add(key, true);
                pairs.add((room.season, week));
              };
              week += 1;
            };
          };
        };
        case null {};
      };
    });
    pairs.toArray();
  };

  /// Get the sync status record for a (season, week), if one exists.
  public func getSyncStatus(
    syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
    season : Nat,
    week : Nat,
  ) : ?Types.SyncStatusRecord {
    syncStatuses.get(syncKey(season, week));
  };

  /// Record/update the sync status for a (season, week).
  ///
  /// The atomic duplicate-sync guard lives here, checked and set within the
  /// same call: if the (season, week) is already #finalized, a new submission is
  /// rejected with #err and cannot reprocess or replace the terminal state.
  /// #partial and #notYetAttempted are retry-eligible and may be overwritten by
  /// a later attempt. #notYetAttempted may be promoted to any status.
  public func recordSyncStatus(
    syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
    season : Nat,
    week : Nat,
    status : Types.SyncStatus,
    lastError : ?Text,
    lastSuccessfulAt : ?Int,
  ) : { #ok : Types.SyncStatusRecord; #err : Text } {
    let key = syncKey(season, week);
    // Atomic guard: an already-#finalized week is terminal. Checked and set within
    // this same call, so no later submission can reprocess or replace it.
    switch (syncStatuses.get(key)) {
      case (?existing) {
        if (existing.status == #finalized) {
          return #err "Already finalized";
        };
      };
      case null {};
    };
    let record : Types.SyncStatusRecord = {
      season;
      week;
      lastAttemptedAt = Time.now();
      status;
      lastError;
      lastSuccessfulAt;
    };
    syncStatuses.add(key, record);
    #ok record;
  };

  /// Derived helper (Phase 11): a (season, week) is **finalized** iff its
  /// SyncStatusRecord.status == #finalized. #notYetAttempted and #partial are
  /// NOT finalized — #partial remains retry-eligible exactly as the lifecycle
  /// establishes. This is purely derived from the existing SyncStatusRecord;
  /// no new status value and no stored finalized/seasonComplete boolean.
  public func isWeekFinalized(
    syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
    season : Nat,
    week : Nat,
  ) : Bool {
    switch (syncStatuses.get(syncKey(season, week))) {
      case (?record) record.status == #finalized;
      case null false;
    };
  };

  /// Derived helper (Phase 11): a Best Ball season (a room) is **final** when it
  /// is #BestBall, has a BestBallConfig, and every week from startWeek to
  /// FINAL_WEEK is finalized per isWeekFinalized. Purely computed — never persisted.
  /// Rooms that are not #BestBall or have no BestBallConfig are never final.
  public func isSeasonFinal(
    rooms : Map.Map<AuctionTypes.RoomId, AuctionTypes.Room>,
    bestBallConfigs : Map.Map<AuctionTypes.RoomId, AuctionTypes.BestBallConfig>,
    syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
    roomId : AuctionTypes.RoomId,
  ) : Bool {
    switch (rooms.get(roomId)) {
      case null false;
      case (?room) {
        if (room.gameType != #BestBall) {
          false;
        } else {
          switch (bestBallConfigs.get(roomId)) {
            case null false;
            case (?cfg) {
              var week = cfg.startWeek;
              var allSettled = true;
              while (week <= AuctionLib.FINAL_WEEK and allSettled) {
                if (not isWeekFinalized(syncStatuses, room.season, week)) {
                  allSettled := false;
                };
                week += 1;
              };
              allSettled;
            };
          };
        };
      };
    };
  };

  /// List all sync status records (for the admin status view).
  public func listSyncStatuses(
    syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
  ) : [Types.SyncStatusRecord] {
    let records = List.empty<Types.SyncStatusRecord>();
    syncStatuses.forEach(func(_key, record) { records.add(record) });
    records.toArray();
  };

  /// Determine the single live (non-finalized) week for a season.
  ///
  /// The live week is the highest week in the season's range that is #partial;
  /// if no week is #partial, it is the first non-finalized week in the range
  /// (the earliest week that is not #finalized — #notYetAttempted or missing a
  /// record). This ensures the current live week is always identified even when
  /// the season's startWeek is already #finalized (e.g. post-migration where a
  /// #synced week became #finalized), so the next non-finalized week is still
  /// flagged for auto-sync. Per the lifecycle invariant, at most one week per
  /// season is #partial at any time, so this is well-defined.
  public func liveWeekForSeason(
    syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
    season : Nat,
    weeks : [Nat],
  ) : Nat {
    var live : ?Nat = null;
    var firstNonFinalized : ?Nat = null;
    var minWeek : ?Nat = null;
    for (w in weeks.values()) {
      switch (minWeek) {
        case null minWeek := ?w;
        case (?mw) if (w < mw) minWeek := ?w;
      };
      switch (syncStatuses.get(syncKey(season, w))) {
        case (?record) {
          if (record.status == #partial) {
            switch (live) {
              case null live := ?w;
              case (?lw) if (w > lw) live := ?w;
            };
          };
          if (record.status != #finalized) {
            switch (firstNonFinalized) {
              case null firstNonFinalized := ?w;
              case (?fnw) if (w < fnw) firstNonFinalized := ?w;
            };
          };
        };
        case null {
          // No record — not yet attempted, hence non-finalized.
          switch (firstNonFinalized) {
            case null firstNonFinalized := ?w;
            case (?fnw) if (w < fnw) firstNonFinalized := ?w;
          };
        };
      };
    };
    switch (live) {
      case (?lw) lw;
      case null firstNonFinalized ?? minWeek ?? 0;
    };
  };

  /// Daily timer job: flag only the weeks eligible for a partial sync — the
  /// current live week per season (the highest #partial week, or the first
  /// non-finalized week if none) when it is #partial or #notYetAttempted.
  /// Excludes #finalized weeks and #notYetAttempted future weeks (weeks after
  /// the live week that haven't started). Returns the flagged (needing-attention)
  /// records. Never fetches from Sleeper and never makes an outcall — this is
  /// visibility, not full autonomy.
  public func flagNeedingAttention(
    syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
    pairs : [(Nat, Nat)],
  ) : [Types.SyncStatusRecord] {
    let flagged = List.empty<Types.SyncStatusRecord>();
    // Group weeks by season so the live week is determined per season.
    let bySeason = Map.empty<Nat, List.List<Nat>>();
    for ((season, week) in pairs.values()) {
      switch (bySeason.get(season)) {
        case (?weeks) weeks.add(week);
        case null {
          let weeks = List.empty<Nat>();
          weeks.add(week);
          bySeason.add(season, weeks);
        };
      };
    };
    bySeason.forEach(func(season, weeks) {
      let weekArr = weeks.toArray();
      let live = liveWeekForSeason(syncStatuses, season, weekArr);
      let key = syncKey(season, live);
      switch (syncStatuses.get(key)) {
        case (?existing) {
          // Flag the live week only if it is #partial or #notYetAttempted.
          // #finalized weeks and #notYetAttempted future weeks are excluded.
          if (existing.status == #partial or existing.status == #notYetAttempted) {
            flagged.add(existing);
          };
        };
        case null {
          // No record yet — create a not-yet-attempted record for the live week
          // so it is visible as needing attention.
          let record : Types.SyncStatusRecord = {
            season;
            week = live;
            lastAttemptedAt = 0;
            status = #notYetAttempted;
            lastError = null;
            lastSuccessfulAt = null;
          };
          syncStatuses.add(key, record);
          flagged.add(record);
        };
      };
    });
    flagged.toArray();
  };
};
