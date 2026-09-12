import Common "common";

// Types for the sync-status domain: per-(season, week) sync status tracking
// for Best Ball weekly stats.
//
// This is operational/diagnostic state — it records whether a (season, week)
// has been synced, is empty (no data available), failed, or not yet attempted.
// It is NOT wired into any existing UI's sync-detection logic and does NOT
// change the starters.length === 0 heuristic used by Phases 7-9. It is also
// NOT full autonomy: the backend never fetches from Sleeper and never makes an
// HTTPS outcall — the actual fetch+parse+submit happens in an authenticated
// admin's browser session. This record only makes what is missing visible.
module {
  public type Timestamp = Common.Timestamp;

  /// Lifecycle status of a (season, week) sync attempt.
  ///   #notYetAttempted — never attempted; the starting state
  ///   #partial         — mutable, non-terminal active/partial state; accepts
  ///                      repeated syncWeeklyStats calls without locking; the
  ///                      single live week
  ///   #finalized       — terminal; syncWeeklyStats rejects further writes for
  ///                      that (season, week)
  ///
  /// Critical correctness rule: a (season, week) is marked #partial whenever a
  /// sync attempt records any stats for it, regardless of how many owned
  /// players have actually played yet. `stored == 0` mid-progress must NOT
  /// imply "nothing happened" — a partial sync where most owned players
  /// legitimately haven't played yet stays #partial (retry-eligible,
  /// non-terminal), never locked or misrepresented. A week only becomes
  /// terminal via the finalization operation, never via a sync call.
  public type SyncStatus = {
    #notYetAttempted;
    #partial;
    #finalized;
  };

  /// One sync status record per (season, week).
  ///   lastAttemptedAt  — Time.now() (nanoseconds) of the most recent attempt
  ///   status           — current lifecycle status
  ///   lastError        — human-readable error message from the most recent failed attempt
  ///   lastSuccessfulAt — Time.now() (nanoseconds) when the week was last marked #partial
  public type SyncStatusRecord = {
    season : Nat;
    week : Nat;
    lastAttemptedAt : Int;
    status : SyncStatus;
    lastError : ?Text;
    lastSuccessfulAt : ?Int;
  };
};
