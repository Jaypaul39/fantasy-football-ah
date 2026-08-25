import Types "../types/bye-weeks";
import AuctionTypes "../types/auction-types";
import ByeWeeksLib "../lib/bye-weeks";
import Map "mo:core/Map";
import AdminAuthLib "../lib/admin-auth";

// Public API mixin for the bye-weeks domain.
// State is injected; admin guard follows the existing setRssFeedUrls pattern.
// The byeWeeksStore is a single-entry Map keyed by a literal Text ("mapping"),
// declared in main.mo and injected here as a constructor parameter — same pattern
// as rssFeedUrlsStore / giphyApiKeyStore. The stored value is the ByeWeekMapping
// array [(Text, Nat)] so it serializes cleanly across the API boundary.

mixin (
  byeWeeksStore : Map.Map<Text, [(Text, Nat)]>,
  players : Map.Map<Text, AuctionTypes.Player>,
  adminPrincipalStore : Map.Map<Text, AuctionTypes.UserId>,
) {
  /// Admin-only: replace the entire bye week mapping atomically.
  /// Validates that each team abbreviation is non-empty and each bye week is
  /// between 1 and 18 (NFL regular season weeks). Returns an error if any
  /// entry is invalid. On success, also re-applies bye weeks to already-imported
  /// players so the change takes effect immediately: each player's byeWeek is
  /// updated based on their team using the new mapping; players whose team is
  /// not in the mapping get byeWeek = null.
  public shared ({ caller }) func setByeWeeks(
    mapping : [(Text, Nat)],
  ) : async { #ok : (); #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can set the bye week mapping";
    };

    // Validate the candidate mapping before touching any state.
    if (not ByeWeeksLib.validateByeWeekMapping(mapping)) {
      return #err "Invalid bye week mapping: each team must be non-empty and each bye week must be between 1 and 18";
    };

    // Replace the stored mapping atomically.
    byeWeeksStore.add("mapping", mapping);

    // Build a team → byeWeek lookup Map for efficient per-player resolution,
    // then re-apply bye weeks to already-imported players in place.
    let lookup = Map.empty<Text, Nat>();
    for (entry in mapping.vals()) {
      let (team, byeWeek) = entry;
      lookup.add(team, byeWeek);
    };
    ByeWeeksLib.reapplyByeWeeksToPlayers(players, lookup);

    #ok ();
  };

  /// Public query: return the current bye week mapping as an array of
  /// (team, byeWeek) pairs. Not sensitive — bye weeks are public NFL schedule
  /// data. Returns the default 2025 mapping if no admin import has occurred.
  public shared query func getByeWeeks() : async [(Text, Nat)] {
    switch (byeWeeksStore.get("mapping")) {
      case (?mapping) mapping;
      case null ByeWeeksLib.defaultByeWeekMapping();
    };
  };
};
