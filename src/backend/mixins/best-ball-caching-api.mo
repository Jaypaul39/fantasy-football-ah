import Map "mo:core/Map";
import Types "../types/best-ball-caching";
import AuctionTypes "../types/auction-types";
import SyncStatusTypes "../types/sync-status";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import AdminAuthLib "../lib/admin-auth";

// Public API mixin for the best-ball-caching domain: the finalized-weekly-score
// cache and the automatic finalization lifecycle for Best Ball weekly stats.
//
// State is injected; delegates to lib/best-ball-caching. Normal operation is
// fully automatic — finalization is triggered by the synchronization flow and
// the daily timer, never by a human. The public methods here exist ONLY as
// host/admin recovery mechanisms, not for normal operation.
//
// CONTRACT (design-only; implemented by the develop task):
//   - finalizeWeek(season, week) — manual host-only recovery: force-finalizes a
//     #partial week and writes its cache. Refused for #finalized weeks.
//   - backfillFinalizedScores() — host-only recovery: populates the cache for
//     #finalized weeks lacking entries (post-migration population).
mixin (
  rooms : Map.Map<AuctionTypes.RoomId, AuctionTypes.Room>,
  participants : Map.Map<AuctionTypes.RoomId, Map.Map<AuctionTypes.UserId, AuctionTypes.Participant>>,
  bestBallConfigs : Map.Map<AuctionTypes.RoomId, AuctionTypes.BestBallConfig>,
  syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
  scores : Types.FinalizedWeeklyScores,
  calculateOptimalWeeklyLineup : (AuctionTypes.Room, AuctionTypes.Participant, Nat) -> LineupLib.LineupResult,
  adminPrincipalStore : Map.Map<Text, AuctionTypes.UserId>,
) {
  /// Host-only recovery: manually finalize a (season, week) and write its
  /// cache. Only a #partial week may be finalized; a #finalized week is refused
  /// (idempotent). This is a recovery mechanism only — normal operation never
  /// depends on it.
  public shared ({ caller }) func finalizeWeek(
    season : Nat,
    week : Nat,
  ) : async Types.FinalizeResult {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can finalize a week";
    };
    BestBallCachingLib.finalizeWeek(rooms, participants, bestBallConfigs, syncStatuses, scores, calculateOptimalWeeklyLineup, season, week);
  };

  /// Host-only recovery: populate the cache for every #finalized week lacking a
  /// cache entry (the post-migration population for pre-existing #synced→
  /// #finalized weeks). Idempotent — only fills missing entries, never
  /// overwrites. Returns the number of scores written.
  public shared ({ caller }) func backfillFinalizedScores() : async Nat {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return 0;
    };
    BestBallCachingLib.backfillFinalizedScores(rooms, participants, bestBallConfigs, syncStatuses, scores, calculateOptimalWeeklyLineup);
  };
};
