import Types "../types/admin-auth";
import AuctionTypes "../types/auction-types";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";

// Domain logic for the admin-auth domain: centralized global-admin
// authorization and password-based admin recovery.
// Stateless functions — state is injected via parameters.
module {
  /// The hardcoded global admin principal. Always has admin access regardless
  /// of the registered admin in adminPrincipalStore.
  public func isGlobalAdmin(
    adminPrincipalStore : Map.Map<Text, AuctionTypes.UserId>,
    caller : AuctionTypes.UserId,
  ) : Bool {
    if (caller.toText() == "25yx5-qybpd-5uj7t-3zzix-uktvl-yew4u-qv7k2-rtp55-4xttv-4bhws-vqe") {
      return true;
    };
    switch (adminPrincipalStore.get("admin")) {
      case (?admin) Principal.equal(admin, caller);
      case null false;
    };
  };

  /// SHA-256 hash of a secret, hex-encoded as Text for storage.
  /// Uses the verified `sha2` mops package (Sha256.fromBlob over
  /// Text.encodeUtf8(secret)). SHA-256 is cryptographic; Motoko's built-in
  /// Text.hash/Blob.hash return Word32 and are NOT adequate for password
  /// storage.
  public func hashSecret(secret : Text) : Text {
    let digest = Sha256.fromBlob(#sha256, secret.encodeUtf8());
    let bytes = digest.toArray();
    let hexChars = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
    // True hex encoding: each byte maps to two hex digits via nibble lookup.
    let hex = bytes.map(func b {
      let hi = Nat32.toNat(b.toNat32() >> 4);
      let lo = Nat32.toNat(b.toNat32() & 0x0F);
      hexChars[hi] # hexChars[lo]
    });
    hex.values().join("")
  };

  /// Escalating lockout duration in minutes after 5+ failed attempts:
  /// 2^(attempts-5) minutes, capped at 24 hours (1440 minutes).
  /// The 5th failed attempt (attempts = 5) yields 2^0 = 1 minute.
  public func lockoutMinutes(attempts : Nat) : Nat {
    if (attempts < 5) {
      return 0;
    };
    var minutes : Nat = 1;
    var exponent = attempts - 5;
    while (exponent > 0) {
      minutes *= 2;
      exponent -= 1;
    };
    if (minutes > 1440) { 1440 } else { minutes }
  };
};
