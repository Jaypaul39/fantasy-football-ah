// Domain-specific types for the bye-weeks domain.
// Admin-importable NFL team → bye week mapping that replaces the
// previously hardcoded byeWeekForTeam lookup table in lib/auction-types.mo.
module {
  // A single (team abbreviation, bye week) pair.
  // team: NFL team abbreviation (e.g. "ARI", "ATL"). Non-empty.
  // byeWeek: NFL regular-season week number, 1–18 inclusive.
  public type ByeWeekEntry = (Text, Nat);

  // The full admin-configurable mapping as an array of (team, byeWeek) pairs.
  // Stored in main.mo as a single-entry Map keyed by a literal Text (same
  // pattern as rssFeedUrlsStore / giphyApiKeyStore) and injected into the mixin.
  public type ByeWeekMapping = [(Text, Nat)];
};
