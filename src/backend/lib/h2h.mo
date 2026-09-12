import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import Principal "mo:core/Principal";
import List "mo:core/List";
import Array "mo:core/Array";

// Head-to-Head (H2H) regular-season domain logic.
//
// ARCHITECTURAL INVARIANT — the reason nothing here is stored:
// After `endAuction` successfully completes, the H2H regular-season schedule is
// completely determined by the immutable inputs — `room.participants` (frozen at
// #Completed), the immutable `BestBallConfig.startWeek`, the immutable
// `competitionMode`/`playoffTeams` chosen at room creation, and the `FINAL_WEEK`
// constant. No subsequent operation may alter it, and there is no second source
// of truth for it anywhere. Every function in this module is a pure derivation
// over those authoritative inputs; callers invoke them on demand and never
// persist the derived schedule.
//
// This module deliberately introduces NO new stable storage, schedule type, or
// bracket type. Playoff bracket resolution is out of scope for this phase.
module {
  /// One deterministic weekly head-to-head matchup between two participants.
  /// `home`/`away` are the two teams paired for `week` by the round-robin
  /// circle method over the room's ordered participants.
  public type Matchup = {
    week : Nat;
    home : Types.UserId;
    away : Types.UserId;
  };

  /// The room's participants sorted by Principal.compare. Safe because
  /// `room.participants` is frozen at #Completed (Phase 5).
  public func orderedParticipants(room : Types.Room) : [Types.UserId] {
    room.participants.sort();
  };

  /// Number of regular-season rounds for a participant count: 0 for 0 or 1
  /// participants; otherwise count-1 if even, count if odd.
  ///
  /// NOTE (floor guard): `startAuction` does NOT reject rooms with fewer than 2
  /// participants, so this 0-for-0/1 behavior is load-bearing — a room with 0 or
  /// 1 participants must yield an empty schedule (no matchups), never a trap or
  /// garbage. The H2H schedule derivation relies on this floor.
  public func numberOfRounds(participantCount : Nat) : Nat {
    if (participantCount <= 1) { 0 }
    else if (participantCount % 2 == 0) { participantCount - 1 }
    else { participantCount };
  };

  /// Number of playoff rounds for a playoff-team count: 0 for 0, 2 for 4,
  /// 3 for 6 or 8.
  public func playoffRounds(playoffTeams : Nat) : Nat {
    if (playoffTeams == 0) { 0 }
    else if (playoffTeams == 4) { 2 }
    else { 3 }; // 6 or 8
  };

  /// The last regular-season week: FINAL_WEEK - playoffRounds(playoffTeams).
  public func regularSeasonEnd(playoffTeams : Nat) : Nat {
    AuctionLib.FINAL_WEEK - playoffRounds(playoffTeams);
  };

  /// The first playoff week: regularSeasonEnd(playoffTeams) + 1. Calendar math
  /// only — not used for resolution in this phase (Phase 12b consumes it).
  public func playoffStartWeek(playoffTeams : Nat) : Nat {
    regularSeasonEnd(playoffTeams) + 1;
  };

  /// Build the base round-robin cycle for `ordered` participants using the
  /// standard circle method. Returns one array of (home, away) pairings per
  /// round, for exactly `rounds` rounds. When the participant count is odd, a
  /// bye sentinel (the anonymous principal) is appended so the circle is even;
  /// pairings involving the sentinel are dropped, giving each real team a bye
  /// in one round.
  ///
  /// The circle method fixes the first participant and rotates the rest by one
  /// position each round, pairing position i with position (m-1-i). This yields
  /// every unordered pair exactly once across the cycle — a complete round-robin.
  func buildCycle(ordered : [Types.UserId], rounds : Nat) : [[(Types.UserId, Types.UserId)]] {
    let n = ordered.size();
    let m = if (n % 2 == 0) { n } else { n + 1 };
    // Mutable circle: the real participants followed by a bye sentinel when odd.
    // The sentinel is the anonymous principal — no real participant is anonymous
    // in this app (all callers are signed-in), so it can never collide.
    let bye : Types.UserId = Principal.anonymous();
    let arr : [var Types.UserId] = Array.tabulate(
      m,
      func i = if (i < n) ordered[i] else bye,
    ).toVarArray();
    let cycle = List.empty<[(Types.UserId, Types.UserId)]>();
    var r = 0;
    while (r < rounds) {
      let roundPairs = List.empty<(Types.UserId, Types.UserId)>();
      var i = 0;
      while (i < m / 2) {
        let a = arr[i];
        let b = arr[m - 1 - i];
        if (a != bye and b != bye) {
          roundPairs.add((a, b));
        };
        i += 1;
      };
      cycle.add(roundPairs.toArray());
      // Rotate positions 1..m-1 by one: move the last element to position 1,
      // shifting the intervening elements right. Position 0 stays fixed.
      let last = arr[m - 1];
      var j = m - 1;
      while (j > 1) {
        arr[j] := arr[j - 1];
        j -= 1;
      };
      arr[1] := last;
      r += 1;
    };
    cycle.toArray();
  };

  /// The deterministic regular-season pairing table for a room: the standard
  /// round-robin circle method over orderedParticipants(room), covering
  /// startWeek..regularSeasonEnd(playoffTeams). When the range spans more than
  /// one full cycle (numberOfRounds weeks), the additional weeks repeat the
  /// exact same deterministic pairings in the same round order — no variation,
  /// reshuffling, or new randomization on repeat.
  ///
  /// `cfg` supplies the immutable BestBallConfig.startWeek (the room itself does
  /// not carry it). Returns an empty array for rooms with 0 or 1 participants.
  public func regularSeasonSchedule(room : Types.Room, cfg : Types.BestBallConfig) : [Matchup] {
    let ordered = orderedParticipants(room);
    let rounds = numberOfRounds(ordered.size());
    let end = regularSeasonEnd(room.playoffTeams);
    let start = cfg.startWeek;
    let matchups = List.empty<Matchup>();
    if (rounds > 0 and end >= start) {
      let cycle = buildCycle(ordered, rounds);
      var week = start;
      var idx = 0;
      while (week <= end) {
        // Repeat the identical cycle when the season is longer than one full
        // cycle: week maps to round (idx % rounds), so weeks beyond the first
        // cycle replay the same pairings in the same order.
        let roundMatchups = cycle[idx % rounds];
        for (pair in roundMatchups.values()) {
          matchups.add({ week; home = pair.0; away = pair.1 });
        };
        idx += 1;
        week += 1;
      };
    };
    matchups.toArray();
  };

  /// Look up the deterministic matchup for a single week, if that week falls in
  /// the room's regular season (startWeek..regularSeasonEnd). Returns null for
  /// weeks outside the regular season (including playoff weeks, which are out of
  /// scope this phase).
  ///
  /// A single-matchup lookup is only well-defined when the week's round has
  /// exactly one pairing — i.e. a 2-team league (one game per week). For leagues
  /// with more than two teams each week has multiple simultaneous games, so this
  /// helper returns null and callers that need every team's result use
  /// `regularSeasonSchedule` instead.
  public func weeklyMatchup(room : Types.Room, cfg : Types.BestBallConfig, week : Nat) : ?Matchup {
    let end = regularSeasonEnd(room.playoffTeams);
    if (week < cfg.startWeek or week > end) {
      null;
    } else {
      let ordered = orderedParticipants(room);
      let rounds = numberOfRounds(ordered.size());
      if (rounds == 0) {
        null;
      } else {
        let cycle = buildCycle(ordered, rounds);
        let roundIdx = (week - cfg.startWeek) % rounds;
        let roundMatchups = cycle[roundIdx];
        if (roundMatchups.size() == 1) {
          ?{ week; home = roundMatchups[0].0; away = roundMatchups[0].1 };
        } else {
          null;
        };
      };
    };
  };

  // ── Playoff bracket derivation (Phase 12b) ────────────────────────────────
  //
  // Fixed-slot playoff bracket for #HeadToHead rooms with playoffTeams > 0.
  // Pure derivation over playoffTeams alone — no stable storage, no reseeding.
  // Bracket seed numbers are 1-based: `#Seed n` resolves to the participant
  // occupying seed `n` in the regular-season getH2HStandings ordering, which
  // internally corresponds to standings array index `n - 1`. The caller must
  // keep this 1-based ↔ 0-based mapping explicit.

  /// A slot in a playoff game: either a fixed seed (1-based) or the winner of
  /// another game (by its index into the bracket's games array).
  public type BracketSlot = {
    #Seed : Nat;
    #WinnerOf : Nat;
  };

  /// One fixed-slot playoff game: the two slots that meet and the week it is
  /// played. `week` falls out of the existing playoffStartWeek/playoffRounds
  /// derivation — never a separately computed value.
  public type PlayoffGame = {
    home : BracketSlot;
    away : BracketSlot;
    week : Nat;
  };

  /// The fixed-slot playoff bracket for a playoff-team count. Pure function of
  /// `playoffTeams` alone (plus the derived `playoffStartWk` for week math):
  ///   - 4-team (2 rounds): Game 0 = Seed1 v Seed4, Game 1 = Seed2 v Seed3
  ///     (week playoffStartWk); Game 2 = winner(0) v winner(1)
  ///     (week playoffStartWk + 1, championship).
  ///   - 6-team (3 rounds, byes for Seeds 1-2): Game 0 = Seed3 v Seed6,
  ///     Game 1 = Seed4 v Seed5 (week playoffStartWk); Game 2 = Seed1 v
  ///     winner(1), Game 3 = Seed2 v winner(0) (week playoffStartWk + 1,
  ///     semifinal — Seeds 1/2 occupy the slot directly, no game);
  ///     Game 4 = winner(2) v winner(3) (week playoffStartWk + 2, championship).
  ///   - 8-team (3 rounds): Games 0-3 = Seed1v8, Seed4v5, Seed3v6, Seed2v7
  ///     (week playoffStartWk); Games 4-5 = winner(0)vwinner(1),
  ///     winner(2)vwinner(3) (week playoffStartWk + 1); Game 6 =
  ///     winner(4)vwinner(5) (week playoffStartWk + 2, championship).
  public func playoffBracket(playoffTeams : Nat, playoffStartWk : Nat) : [PlayoffGame] {
    let wk = playoffStartWk;
    if (playoffTeams == 4) {
      [
        { home = #Seed 1; away = #Seed 4; week = wk },
        { home = #Seed 2; away = #Seed 3; week = wk },
        { home = #WinnerOf 0; away = #WinnerOf 1; week = wk + 1 },
      ];
    } else if (playoffTeams == 6) {
      [
        { home = #Seed 3; away = #Seed 6; week = wk },
        { home = #Seed 4; away = #Seed 5; week = wk },
        { home = #Seed 1; away = #WinnerOf 1; week = wk + 1 },
        { home = #Seed 2; away = #WinnerOf 0; week = wk + 1 },
        { home = #WinnerOf 2; away = #WinnerOf 3; week = wk + 2 },
      ];
    } else {
      // 8-team (the only remaining supported playoff count).
      [
        { home = #Seed 1; away = #Seed 8; week = wk },
        { home = #Seed 4; away = #Seed 5; week = wk },
        { home = #Seed 3; away = #Seed 6; week = wk },
        { home = #Seed 2; away = #Seed 7; week = wk },
        { home = #WinnerOf 0; away = #WinnerOf 1; week = wk + 1 },
        { home = #WinnerOf 2; away = #WinnerOf 3; week = wk + 1 },
        { home = #WinnerOf 4; away = #WinnerOf 5; week = wk + 2 },
      ];
    };
  };
};
