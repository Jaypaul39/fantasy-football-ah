import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import H2HLib "../lib/h2h";
import LineupLib "../lib/lineup";
import SyncStatusLib "../lib/sync-status";
import SyncStatusTypes "../types/sync-status";
import BestBallCachingLib "../lib/best-ball-caching";
import BestBallCachingTypes "../types/best-ball-caching";
import Map "mo:core/Map";
import List "mo:core/List";

// Phase 12b — Head-to-Head (H2H) playoff bracket resolution read API.
//
// getPlayoffBracket is a read-only method that derives the fixed-slot playoff
// bracket for a #HeadToHead room with playoffTeams > 0, resolving each game's
// slots recursively from the regular-season standings ordering (getH2HStandings)
// and the Phase 3 optimal-lineup calculator (calculateOptimalWeeklyLineup, wired
// in main.mo) as the single source of truth for weekly scores. No lineup
// optimization or scoring logic is duplicated here.
//
// The bracket, every game, and the champion are pure computations over
// already-persisted data — NO new stable storage. The champion is never stored;
// it is the recursively-resolved winner of the final game, computed on demand.
//
// Access follows the existing room-access/privacy model: a caller must be a
// participant of the room to read that room's bracket. Only #BestBall +
// #HeadToHead rooms with playoffTeams > 0 are accepted; #Cumulative rooms and
// H2H rooms with playoffTeams == 0 are rejected with distinct #err messages.
//
// This method never mutates stable state — it is a pure query.

mixin (
  rooms : Map.Map<Types.RoomId, Types.Room>,
  participants : Map.Map<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>,
  bestBallConfigs : Map.Map<Types.RoomId, Types.BestBallConfig>,
  syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
  scores : BestBallCachingTypes.FinalizedWeeklyScores,
  calculateOptimalWeeklyLineup : (Types.Room, Types.Participant, Nat) -> LineupLib.LineupResult,
  getH2HStandings : shared query (Types.RoomId) -> async {
    #ok : [{
      participant : Types.UserId;
      displayName : Text;
      wins : Nat;
      losses : Nat;
      ties : Nat;
      pointsFor : Float;
      gamesPlayed : Nat;
    }];
    #err : Text;
  },
) {

  /// A resolved contestant in a bracket slot. Carries the contestant's ORIGINAL
  /// seed (not just their current-slot identity) so tie-breaking at any slot an
  /// upset winner has advanced into can compare original seeds — required for
  /// correct resolution when a numerically higher/worse seed beats a favorite
  /// and then ties a later opponent. This is an internal computation detail of
  /// the recursive resolver, never persisted.
  public type ResolvedContestant = {
    participant : Types.UserId;
    seed : Nat;
    score : Float;
  };

  /// The state of a single bracket slot in the returned bracket.
  ///   - #resolved: the slot's contestant is known (a seed slot always resolves
  ///     immediately, independent of any week's sync status; a winner-of slot
  ///     resolves only when both its slots are resolved and its week is settled).
  ///   - #pendingOnSync: both of the slot's underlying slots are known but the
  ///     game's week is not yet settled — "not yet played", never a score of 0.
  ///   - #pendingOnDependency: at least one underlying slot is still an
  ///     unresolved #WinnerOf — distinct from pending-on-sync.
  public type BracketSlotState = {
    #resolved : ResolvedContestant;
    #pendingOnSync;
    #pendingOnDependency;
  };

  /// The status of a single playoff game, distinguishing the two pending states
  /// explicitly (Phase 9/10's "unsynced ≠ zero" discipline depends on this
  /// distinction being real, not cosmetic).
  ///   - #resolved: both slots known and the week settled — reports both actual
  ///     scores and the winner. Higher score wins; on an exact tie the
  ///     contestant with the numerically lower (better) original seed advances.
  ///   - #pendingOnSync: both slots known but the week not yet settled.
  ///   - #pendingOnDependency: at least one slot still an unresolved #WinnerOf.
  public type GameStatus = {
    #resolved : { homeScore : Float; awayScore : Float; winner : Types.UserId };
    #pendingOnSync;
    #pendingOnDependency;
  };

  /// One game of the resolved bracket: its fixed slots, its week, the state of
  /// each slot, and the game's overall status.
  public type PlayoffGameResult = {
    game : H2HLib.PlayoffGame;
    home : BracketSlotState;
    away : BracketSlotState;
    status : GameStatus;
  };

  /// The full resolved bracket for a room: every game (with slots and week) plus
  /// the champion once the final game resolves, or an explicit in-progress
  /// indicator otherwise. The champion is computed on demand, never stored.
  public type PlayoffBracketResult = {
    games : [PlayoffGameResult];
    champion : { #some : ResolvedContestant; #inProgress };
  };

  /// A standings row as returned by getH2HStandings (structural match). Only
  /// `participant` is needed for seeding; the rest is carried for clarity.
  /// Named distinctly from best-ball-api's StandingsEntry to avoid a duplicate
  /// type definition when both mixins are included in the same actor.
  type H2HStandingsEntry = {
    participant : Types.UserId;
    displayName : Text;
    wins : Nat;
    losses : Nat;
    ties : Nat;
    pointsFor : Float;
    gamesPlayed : Nat;
  };

  /// Resolve a single bracket slot to a BracketSlotState.
  ///
  ///   - `#Seed n` resolves immediately to the participant at standings index
  ///     `n - 1` (1-based seed → 0-based array index), carrying `seed = n` and
  ///     its optimal-lineup score for `gameWeek`. This is independent of any
  ///     week's sync status — a seed slot is always known.
  ///   - `#WinnerOf gameIdx` resolves only when both of that game's slots are
  ///     resolved AND that game's week is settled. Otherwise it is pending:
  ///     `#pendingOnSync` when both underlying slots are known but the week is
  ///     not yet settled, `#pendingOnDependency` when at least one underlying
  ///     slot is still an unresolved `#WinnerOf`.
  ///
  /// The winner of a resolved game carries forward its ORIGINAL seed (not just
  /// its current-slot identity) so an upset winner that ties a later opponent
  /// loses to the better-seeded opponent.
  func resolveSlot(
    slot : H2HLib.BracketSlot,
    gameWeek : Nat,
    standings : [H2HStandingsEntry],
    room : Types.Room,
    roomId : Types.RoomId,
    pm : Map.Map<Types.UserId, Types.Participant>,
    games : [H2HLib.PlayoffGame],
  ) : BracketSlotState {
    switch (slot) {
      case (#Seed n) {
        // 1-based seed n → standings array index n - 1.
        if (n >= 1 and n <= standings.size()) {
          let entry = standings[n - 1];
          switch (pm.get(entry.participant)) {
            case (?p) {
              // Finalized week → read the cached finalized score; live week →
              // compute dynamically (never cached). Matches h2h-api.mo's
              // `?? 0.0` fallback for a finalized week with no cache entry.
              let score = if (BestBallCachingLib.isWeekFinalized(syncStatuses, room.season, gameWeek)) {
                BestBallCachingLib.getFinalizedScore(scores, roomId, room.season, gameWeek, entry.participant) ?? 0.0;
              } else {
                calculateOptimalWeeklyLineup(room, p, gameWeek).total;
              };
              #resolved({ participant = entry.participant; seed = n; score });
            };
            case null #pendingOnDependency;
          };
        } else {
          #pendingOnDependency;
        };
      };
      case (#WinnerOf gameIdx) {
        if (gameIdx < games.size()) {
          let g = games[gameIdx];
          let homeState = resolveSlot(g.home, g.week, standings, room, roomId, pm, games);
          let awayState = resolveSlot(g.away, g.week, standings, room, roomId, pm, games);
          switch (homeState) {
            case (#resolved home) {
              switch (awayState) {
                case (#resolved away) {
                  if (SyncStatusLib.isWeekFinalized(syncStatuses, room.season, g.week)) {
                    // Both slots known and the week settled: read both cached
                    // finalized scores for this game's week; higher score wins,
                    // tie → lower seed. Matches h2h-api.mo's `?? 0.0` fallback.
                    switch (pm.get(home.participant)) { case (?_) {}; case null return #pendingOnDependency };
                    switch (pm.get(away.participant)) { case (?_) {}; case null return #pendingOnDependency };
                    let homeScore = BestBallCachingLib.getFinalizedScore(scores, roomId, room.season, g.week, home.participant) ?? 0.0;
                    let awayScore = BestBallCachingLib.getFinalizedScore(scores, roomId, room.season, g.week, away.participant) ?? 0.0;
                    let winner = if (homeScore > awayScore) { home }
                      else if (homeScore < awayScore) { away }
                      else if (home.seed < away.seed) { home }
                      else { away };
                    #resolved({
                      participant = winner.participant;
                      seed = winner.seed;
                      score = if (winner.participant == home.participant) { homeScore } else { awayScore };
                    });
                  } else {
                    #pendingOnSync;
                  };
                };
                case _ #pendingOnDependency;
              };
            };
            case _ #pendingOnDependency;
          };
        } else {
          #pendingOnDependency;
        };
      };
    };
  };

  /// Resolve a single playoff game into its PlayoffGameResult plus the winner's
  /// ResolvedContestant (null when the game is not yet resolved).
  ///
  /// A game is `#resolved` only when both slots are known and the week is
  /// settled — reporting both actual scores and the winner. It is
  /// `#pendingOnSync` when both slots are known but the week is not yet settled
  /// (never a score of 0), and `#pendingOnDependency` when at least one slot is
  /// still an unresolved `#WinnerOf`.
  func resolveGame(
    game : H2HLib.PlayoffGame,
    standings : [H2HStandingsEntry],
    room : Types.Room,
    roomId : Types.RoomId,
    pm : Map.Map<Types.UserId, Types.Participant>,
    games : [H2HLib.PlayoffGame],
  ) : (PlayoffGameResult, ?ResolvedContestant) {
    let homeState = resolveSlot(game.home, game.week, standings, room, roomId, pm, games);
    let awayState = resolveSlot(game.away, game.week, standings, room, roomId, pm, games);
    switch (homeState) {
      case (#resolved home) {
        switch (awayState) {
          case (#resolved away) {
            if (SyncStatusLib.isWeekFinalized(syncStatuses, room.season, game.week)) {
              switch (pm.get(home.participant)) { case (?_) {}; case null return ({ game; home = homeState; away = awayState; status = #pendingOnDependency }, null) };
              switch (pm.get(away.participant)) { case (?_) {}; case null return ({ game; home = homeState; away = awayState; status = #pendingOnDependency }, null) };
              // Finalized week → read both cached finalized scores; matches
              // h2h-api.mo's `?? 0.0` fallback for a missing cache entry.
              let homeScore = BestBallCachingLib.getFinalizedScore(scores, roomId, room.season, game.week, home.participant) ?? 0.0;
              let awayScore = BestBallCachingLib.getFinalizedScore(scores, roomId, room.season, game.week, away.participant) ?? 0.0;
              let (winner, winnerScore) = if (homeScore > awayScore) { (home, homeScore) }
                else if (homeScore < awayScore) { (away, awayScore) }
                else if (home.seed < away.seed) { (home, homeScore) }
                else { (away, awayScore) };
              let winnerContestant = { participant = winner.participant; seed = winner.seed; score = winnerScore };
              (
                { game; home = homeState; away = awayState; status = #resolved({ homeScore; awayScore; winner = winner.participant }) },
                ?winnerContestant,
              );
            } else {
              ({ game; home = homeState; away = awayState; status = #pendingOnSync }, null);
            };
          };
          case _ ({ game; home = homeState; away = awayState; status = #pendingOnDependency }, null);
        };
      };
      case _ ({ game; home = homeState; away = awayState; status = #pendingOnDependency }, null);
    };
  };

  /// Derive and resolve the playoff bracket for a #HeadToHead room with
  /// playoffTeams > 0.
  ///
  /// Rejects with #err if the room is not found, is not #BestBall + #HeadToHead,
  /// is a #Cumulative room, has playoffTeams == 0, or the caller is not a
  /// participant. #Cumulative rooms and H2H rooms with playoffTeams == 0 each
  /// get a clear, distinct error message.
  ///
  /// Seeding comes from getH2HStandings' existing deterministic ordering (wins →
  /// pointsFor → Principal.compare), restricted to the top playoffTeams entries.
  /// Bracket seed numbers are 1-based: `#Seed n` resolves to the participant
  /// occupying seed `n` in that ordering, i.e. standings array index `n - 1`.
  public shared ({ caller }) func getPlayoffBracket(
    roomId : Types.RoomId,
  ) : async { #ok : PlayoffBracketResult; #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        // Distinct rejection for #Cumulative rooms (checked before the generic
        // H2H check so a #Cumulative room always gets its own clear message).
        if (room.competitionMode == #Cumulative) {
          return #err "Room is a Cumulative room; playoffs require a Head-to-Head room";
        };
        // Best Ball + HeadToHead only — every other room is rejected.
        if (room.gameType != #BestBall or room.competitionMode != #HeadToHead) {
          return #err "Room is not a Head-to-Head Best Ball room";
        };
        // Distinct rejection for H2H rooms without playoffs.
        if (room.playoffTeams == 0) {
          return #err "Room has no playoffs (playoffTeams is 0)";
        };
        // Room access/privacy: caller must be a participant of the room.
        if (not AuctionLib.isParticipant(room, caller)) {
          return #err "Not a participant in this room";
        };
        // Best Ball config must exist (getH2HStandings also enforces this).
        switch (bestBallConfigs.get(roomId)) {
          case (?_) {};
          case null return #err "Room is not a Best Ball room";
        };
        let pm = switch (participants.get(roomId)) {
          case (?m) m;
          case null return #err "No participants";
        };
        // Seeding: getH2HStandings' deterministic ordering, top playoffTeams.
        let standings = switch (await getH2HStandings(roomId)) {
          case (#err e) return #err e;
          case (#ok entries) entries;
        };
        // The fixed-slot bracket; weeks fall out of playoffStartWeek/playoffRounds.
        let games = H2HLib.playoffBracket(room.playoffTeams, H2HLib.playoffStartWeek(room.playoffTeams));
        let results = List.empty<PlayoffGameResult>();
        var champion : { #some : ResolvedContestant; #inProgress } = #inProgress;
        var i = 0;
        while (i < games.size()) {
          let (result, winner) = resolveGame(games[i], standings, room, roomId, pm, games);
          results.add(result);
          // The champion is the winner of the final game, computed on demand.
          if (i == games.size() - 1) {
            switch (winner) {
              case (?w) champion := #some(w);
              case null {};
            };
          };
          i += 1;
        };
        #ok { games = results.toArray(); champion };
      };
    };
  };
};
