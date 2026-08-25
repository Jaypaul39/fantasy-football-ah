import Common "common";

// Types for the admin-auth domain: centralized global-admin authorization and
// password-based admin recovery.
module {
  public type Timestamp = Common.Timestamp;
  public type UserId = Common.UserId;

  // Per-caller recovery attempt tracking for basic rate limiting.
  // count: number of consecutive failed recovery attempts by this caller.
  // lockedUntil: when non-null and in the future, the caller is locked out of
  // recoverAdmin until this timestamp (nanoseconds from Time.now()).
  public type RecoveryAttempt = {
    count : Nat;
    lockedUntil : ?Timestamp;
  };
};
