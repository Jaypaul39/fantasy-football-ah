import Types "../types/bye-weeks";
import AuctionTypes "../types/auction-types";
import Map "mo:core/Map";

// Domain logic for the bye-weeks domain.
// Stateless functions — state is injected via parameters.
module {
  /// The default 2025 NFL season bye week mapping, used to initialize the
  /// stable store in main.mo so the app works out of the box before any admin
  /// import. Mirrors the previously hardcoded byeWeekForTeam switch table.
  public func defaultByeWeekMapping() : Types.ByeWeekMapping {
    [
      ("ARI", 8),
      ("ATL", 5),
      ("BAL", 7),
      ("BUF", 7),
      ("CAR", 14),
      ("CHI", 5),
      ("CIN", 10),
      ("CLE", 9),
      ("DAL", 10),
      ("DEN", 12),
      ("DET", 8),
      ("GB", 5),
      ("HOU", 6),
      ("IND", 11),
      ("JAX", 8),
      ("KC", 10),
      ("LV", 8),
      ("LAC", 12),
      ("LAR", 8),
      ("MIA", 12),
      ("MIN", 6),
      ("NE", 14),
      ("NO", 11),
      ("NYG", 14),
      ("NYJ", 9),
      ("PHI", 9),
      ("PIT", 5),
      ("SF", 14),
      ("SEA", 8),
      ("TB", 9),
      ("TEN", 10),
      ("WAS", 12),
    ];
  };

  /// Validate a candidate bye week mapping.
  /// Each team abbreviation must be non-empty and each bye week must be
  /// between 1 and 18 (NFL regular season weeks). Returns true if every entry
  /// is valid, false otherwise.
  public func validateByeWeekMapping(mapping : Types.ByeWeekMapping) : Bool {
    for (entry in mapping.vals()) {
      let (team, byeWeek) = entry;
      if (team.size() == 0) return false;
      if (byeWeek < 1 or byeWeek > 18) return false;
    };
    true;
  };

  /// Look up a team's bye week in the given mapping.
  /// Returns null when the team is not present in the mapping (NOT 0).
  public func byeWeekForTeam(
    mapping : Map.Map<Text, Nat>,
    team : Text,
  ) : ?Nat {
    mapping.get(team);
  };

  /// Re-apply bye weeks to already-imported players using the new mapping.
  /// Updates each player's byeWeek based on their team; players whose team is
  /// not in the mapping get byeWeek = null. Mutates the players map in place.
  public func reapplyByeWeeksToPlayers(
    players : Map.Map<Text, AuctionTypes.Player>,
    mapping : Map.Map<Text, Nat>,
  ) {
    players.forEach(func(id : Text, player : AuctionTypes.Player) {
      let byeWeek = mapping.get(player.team);
      players.add(id, { player with byeWeek = byeWeek });
    });
  };
};
