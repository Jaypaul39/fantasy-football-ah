import Map "mo:core/Map";
import Common "common";
import AuctionTypes "auction-types";
import SyncStatus "sync-status";

// Types for the best-ball-caching domain: the finalized-weekly-score cache and
// the automatic finalization lifecycle for Best Ball weekly stats.
//
// This domain owns the permanent cache of each participant's final optimal
// weekly-lineup total for weeks that have transitioned to #finalized. The cache
// is written exactly once, at the moment a week finalizes, and is never
// recomputed or overwritten afterward. The single current non-finalized (live)
// week is never cached — it is always recomputed dynamically on each query.
module {
  public type RoomId = Common.RoomId;
  public type UserId = Common.UserId;
  public type Timestamp = Common.Timestamp;
  public type Room = AuctionTypes.Room;
  public type Participant = AuctionTypes.Participant;
  public type BestBallConfig = AuctionTypes.BestBallConfig;
  public type SyncStatusRecord = SyncStatus.SyncStatusRecord;
  public type SyncStatus = SyncStatus.SyncStatus;

  /// Composite cache key for one participant's finalized weekly score:
  ///   roomId # "|" # season.toText() # "|" # week.toText() # "|" # principal.toText()
  /// Follows the existing composite-key convention (playerId|season|week,
  /// season|week). The principal is the participant's UserId (Principal).
  public type FinalizedScoreKey = Text;

  /// The permanent cache: composite key → final optimal weekly-lineup total
  /// (Float) for a #finalized week. Written exactly once at finalization.
  public type FinalizedWeeklyScores = Map.Map<FinalizedScoreKey, Float>;

  /// Outcome of a finalizeWeek operation.
  ///   #ok : Nat — the number of participant scores written to the cache
  ///   #err : Text — why finalization was refused (e.g. week already finalized,
  ///                 week not in a #partial state, no Best Ball rooms in season)
  public type FinalizeResult = { #ok : Nat; #err : Text };
};
