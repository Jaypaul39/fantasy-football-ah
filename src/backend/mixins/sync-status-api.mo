import Map "mo:core/Map";
import Types "../types/sync-status";
import AuctionTypes "../types/auction-types";
import SyncStatusLib "../lib/sync-status";
import BestBallCachingLib "../lib/best-ball-caching";
import BestBallCachingTypes "../types/best-ball-caching";
import LineupLib "../lib/lineup";
import AdminAuthLib "../lib/admin-auth";

// Public API mixin for the sync-status domain: per-(season, week) sync status
// tracking for Best Ball weekly stats.
//
// State is injected; delegates to lib/sync-status. All public methods are
// admin-gated (AdminAuthLib.isGlobalAdmin) — the status record is operational
// diagnostic data for the admin panel, not general-user data.
//
// This is visibility, not full autonomy: the backend never fetches from Sleeper
// and never makes an HTTPS outcall. The actual fetch+parse+submit happens in an
// authenticated admin's browser session; these methods only record and expose
// what is missing.
mixin (
  syncStatuses : Map.Map<Text, Types.SyncStatusRecord>,
  rooms : Map.Map<AuctionTypes.RoomId, AuctionTypes.Room>,
  bestBallConfigs : Map.Map<AuctionTypes.RoomId, AuctionTypes.BestBallConfig>,
  participants : Map.Map<AuctionTypes.RoomId, Map.Map<AuctionTypes.UserId, AuctionTypes.Participant>>,
  finalizedWeeklyScores : BestBallCachingTypes.FinalizedWeeklyScores,
  calculateOptimalWeeklyLineup : (AuctionTypes.Room, AuctionTypes.Participant, Nat) -> LineupLib.LineupResult,
  adminPrincipalStore : Map.Map<Text, AuctionTypes.UserId>,
) {
  /// Admin-only: compute the deduplicated set of (season, week) pairs across
  /// all #BestBall rooms' startWeek..FINAL_WEEK ranges. Unions overlapping ranges
  /// across different rooms on the same season. Used by the frontend to know
  /// which weeks exist to sync, and by the daily timer.
  public shared ({ caller }) func computeDedupSeasonWeeks() : async [(Nat, Nat)] {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return [];
    };
    SyncStatusLib.computeDedupSeasonWeeks(rooms, bestBallConfigs);
  };

  /// Admin-only: get all sync status records (for the admin status view).
  /// Each record carries its status and relevant timestamp (lastSuccessfulAt
  /// if synced, lastAttemptedAt + lastError if failed, lastAttemptedAt if
  /// empty/pending).
  public shared query ({ caller }) func getSyncStatusRecords() : async [Types.SyncStatusRecord] {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return [];
    };
    SyncStatusLib.listSyncStatuses(syncStatuses);
  };

  /// Admin-only: get the flagged (needing-attention) weeks — only the weeks
  /// eligible for a partial sync: the current live week per season (the highest
  /// #partial week, or the first non-finalized week if none) when it is #partial
  /// or #notYetAttempted. Excludes #finalized weeks and #notYetAttempted future
  /// weeks. The frontend runs its existing fetch+parse+submit flow for each
  /// flagged week on admin session load.
  ///
  /// This is an update (not a query) because it also ensures a status record
  /// exists for the live week (creating a #notYetAttempted record when none
  /// exists yet), so newly-created Best Ball rooms are flagged even before the
  /// once-per-day timer runs.
  ///
  /// It also triggers the post-migration cache backfill for pre-existing
  /// #finalized weeks, so those weeks show their correct cached score in
  /// getStandings promptly (on admin session load) rather than waiting up to
  /// 24h for the daily timer. The backfill is idempotent — it only fills missing
  /// entries and never overwrites existing ones.
  public shared ({ caller }) func getFlaggedWeeks() : async [Types.SyncStatusRecord] {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return [];
    };
    // Post-migration backfill: populate the cache for pre-existing #finalized
    // weeks promptly. Idempotent — only fills missing entries, never overwrites.
    ignore BestBallCachingLib.backfillFinalizedScores(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup);
    SyncStatusLib.flagNeedingAttention(
      syncStatuses,
      SyncStatusLib.computeDedupSeasonWeeks(rooms, bestBallConfigs),
    );
  };

  /// Admin-only: record/update the sync status for a (season, week).
  ///
  /// The atomic duplicate-sync guard lives here, checked and set within the
  /// same call: if the (season, week) is already #finalized, the submission is
  /// rejected with #err and cannot reprocess or replace the terminal state.
  /// #partial and #notYetAttempted are retry-eligible and may be overwritten.
  ///
  /// This is the new adjacent method for status recording — it does NOT change
  /// syncWeeklyStats's public signature or manual-flow behavior.
  public shared ({ caller }) func recordSyncStatus(
    season : Nat,
    week : Nat,
    status : Types.SyncStatus,
    lastError : ?Text,
    lastSuccessfulAt : ?Int,
  ) : async { #ok : Types.SyncStatusRecord; #err : Text } {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can record sync status";
    };
    SyncStatusLib.recordSyncStatus(syncStatuses, season, week, status, lastError, lastSuccessfulAt);
  };
};
