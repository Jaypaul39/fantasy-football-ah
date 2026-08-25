import Types "../types/admin-auth";
import AuctionTypes "../types/auction-types";
import AdminAuthLib "../lib/admin-auth";
import Map "mo:core/Map";
import Result "mo:core/Result";
import Text "mo:core/Text";
import Time "mo:core/Time";

// Public API mixin for the admin-auth domain: password-based admin recovery.
// State is injected; delegates to lib/admin-auth.
//
// recoveryPasswordHash is a record-wrapped ?Text so the mixin receives a
// mutable reference (setRecoveryPassword overwrites it, recoverAdmin reads it).
// recoveryAttempts is a Map keyed by caller principal text, mutable via methods.
mixin (
  adminPrincipalStore : Map.Map<Text, AuctionTypes.UserId>,
  recoveryPasswordHash : { var value : ?Text },
  recoveryAttempts : Map.Map<Text, Types.RecoveryAttempt>,
) {
  /// Admin-only: set (or overwrite) the recovery password.
  /// Rejects secrets shorter than 16 characters with #err. Non-admins get
  /// #err "Not authorized". On success hashes newSecret and stores it in
  /// recoveryPasswordHash, overwriting any previous value.
  public shared ({ caller }) func setRecoveryPassword(
    newSecret : Text,
  ) : async Result.Result<(), Text> {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err("Not authorized");
    };
    if (newSecret.size() < 16) {
      return #err("Recovery password must be at least 16 characters");
    };
    recoveryPasswordHash.value := ?AdminAuthLib.hashSecret(newSecret);
    #ok
  };

  /// Anyone: recover admin access by proving knowledge of the recovery password.
  /// On success, reassigns adminPrincipalStore to the caller (replacing whoever
  /// was previously stored) and clears the caller's recoveryAttempts entry.
  public shared ({ caller }) func recoverAdmin(
    providedSecret : Text,
  ) : async Result.Result<(), Text> {
    let callerKey = caller.toText();
    let now = Time.now();

    // 1. Recovery not configured — no default/bypass password.
    switch (recoveryPasswordHash.value) {
      case null { return #err("Recovery not configured") };
      case (?storedHash) {
        // 2. Lockout check — if locked out, do not check the password.
        switch (recoveryAttempts.get(callerKey)) {
          case (?attempt) {
            switch (attempt.lockedUntil) {
              case (?until) {
                if (until > now) {
                  let remainingSecs = (until - now) / 1_000_000_000;
                  return #err(
                    "Recovery locked out. Try again in " # remainingSecs.toText() # " seconds"
                  );
                };
              };
              case null {};
            };
          };
          case null {};
        };

        // 3. Hash and compare.
        let providedHash = AdminAuthLib.hashSecret(providedSecret);
        if (providedHash == storedHash) {
          // 4. On match: reassign admin, clear caller's attempts.
          adminPrincipalStore.add("admin", caller);
          recoveryAttempts.remove(callerKey);
          #ok
        } else {
          // 5. On mismatch: increment attempts, apply escalating lockout.
          let current = switch (recoveryAttempts.get(callerKey)) {
            case (?a) a;
            case null { { count = 0; lockedUntil = null } };
          };
          let newCount = current.count + 1;
          var lockedUntil : ?Types.Timestamp = null;
          let minutes = AdminAuthLib.lockoutMinutes(newCount);
          if (minutes > 0) {
            lockedUntil := ?(now + Int.fromNat(minutes * 60_000_000_000));
          };
          recoveryAttempts.add(callerKey, { count = newCount; lockedUntil });
          #err("Incorrect recovery code")
        };
      };
    };
  };
};
