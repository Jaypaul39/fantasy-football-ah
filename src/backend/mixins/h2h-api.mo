import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import H2HLib "../lib/h2h";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import BestBallCachingTypes "../types/best-ball-caching";
import SyncStatusTypes "../types/sync-status";
import Map "mo:core/Map";
import List "mo:core/List";
import Principal "mo:core/Principal";
import Order "mo:core/Order";
import Runtime "mo:core/Runtime";

// Phase 12a — Head-to-Head (H2H) regular-season standings read API.
//
// getH2HStandings is a read-only query that resolves each team's weekly H2H
// result via the derived round-robin schedule (lib/h2h.mo) and the Phase 3
// optimal-lineup calculator (calculateOptimalWeeklyLineup, wired in main.mo) as
// the single source of truth for weekly scores. No lineup optimization or
// scoring logic is duplicated here.
//
// Access follows the existing room-access/privacy model: a caller must be a
// participant of the room to read that room's H2H data. Only #BestBall +
// #HeadToHead rooms are accepted; every other room is rejected with #err.
//
// This method never mutates stable state — it is a pure query. Playoff weeks
// (playoffStartWeek..FINAL_WEEK) are out of scope this phase; getH2HStandings
// reflects only regular-season results.

mixin (
  rooms : Map.Map<Types.RoomId, Types.Room>,
  participants : Map.Map<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>,
  bestBallConfigs : Map.Map<Types.RoomId, Types.BestBallConfig>,
  syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>,
  scores : BestBallCachingTypes.FinalizedWeeklyScores,
  calculateOptimalWeeklyLineup : (Types.Room, Types.Participant, Nat) -> LineupLib.LineupResult,
) {

  /// One row of the head-to-head regular-season standings for a room.
  /// `participant` is the team's owner principal; `displayName` is resolved for
  /// rendering. `pointsFor` is the team's cumulative optimal weekly score across
  /// its regular-season games. `gamesPlayed` counts resolved (synced) weeks.
  public type H2HStandingEntry = {
    participant : Types.UserId;
    displayName : Text;
    wins : Nat;
    losses : Nat;
    ties : Nat;
    pointsFor : Float;
    gamesPlayed : Nat;
  };

  /// Deterministic H2H standings comparator: wins descending, then pointsFor
  /// descending, then Principal.compare ascending. Never map iteration order.
  func compareH2H(a : H2HStandingEntry, b : H2HStandingEntry) : Order.Order {
    if (a.wins > b.wins) { #less }
    else if (a.wins < b.wins) { #greater }
    else if (a.pointsFor > b.pointsFor) { #less }
    else if (a.pointsFor < b.pointsFor) { #greater }
    else { Principal.compare(a.participant, b.participant) };
  };

  /// Compute Head-to-Head regular-season standings for a room.
  ///
  /// Rejects with #err if the room is not #BestBall + #HeadToHead, is not found,
  /// or the caller is not a participant. Each team's weekly result is resolved
  /// via the derived pairing table for weeks in startWeek..regularSeasonEnd;
  /// unsynced weeks produce no result (not counted in gamesPlayed), and genuine
  /// ties are allowed with no synthetic tiebreaker. Playoff weeks are out of
  /// scope this phase.
  ///
  /// The result is deterministically ordered: wins descending, pointsFor
  /// descending, then Principal.compare ascending — never map iteration order.
  public shared query ({ caller }) func getH2HStandings(
    roomId : Types.RoomId,
  ) : async { #ok : [H2HStandingEntry]; #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        // Best Ball + HeadToHead only — every other room is rejected.
        if (room.gameType != #BestBall or room.competitionMode != #HeadToHead) {
          return #err "Room is not a Head-to-Head Best Ball room";
        };
        // Room access/privacy: caller must be a participant of the room.
        if (not AuctionLib.isParticipant(room, caller)) {
          return #err "Not a participant in this room";
        };
        let cfg = switch (bestBallConfigs.get(roomId)) {
          case (?c) c;
          case null return #err "Room is not a Best Ball room";
        };
        let pm = switch (participants.get(roomId)) {
          case (?m) m;
          case null return #err "No participants";
        };
        // Initialize a standings row for every participant.
        let standings = Map.empty<Types.UserId, H2HStandingEntry>();
        pm.forEach(func(userId, p) {
          standings.add(userId, {
            participant = userId;
            displayName = p.displayName;
            wins = 0;
            losses = 0;
            ties = 0;
            pointsFor = 0.0;
            gamesPlayed = 0;
          });
        });
        // Resolve each regular-season week via the derived pairing table.
        // Iteration is per-matchup (Matchup { week; home; away }), NOT
        // per-participant-per-week like getStandings. For each matchup, branch
        // on the week's status:
        //   #finalized       → read cached totals for both home and away (both
        //                      always exist for a finalized week) and resolve
        //                      the matchup (no empty-starters skip).
        //   live (#partial)  → compute both dynamically and keep the existing
        //                      empty-starters skip check.
        //   #notYetAttempted → skip (no result).
        let schedule = H2HLib.regularSeasonSchedule(room, cfg);
        for (m in schedule.values()) {
          let homeP = switch (pm.get(m.home)) { case (?p) p; case null continue };
          let awayP = switch (pm.get(m.away)) { case (?p) p; case null continue };
          var homeTotal : ?Float = null;
          var awayTotal : ?Float = null;
          if (BestBallCachingLib.isWeekFinalized(syncStatuses, room.season, m.week)) {
            // Finalized week: read cached totals for both teams.
            homeTotal := ?(BestBallCachingLib.getFinalizedScore(scores, roomId, room.season, m.week, m.home) ?? 0.0);
            awayTotal := ?(BestBallCachingLib.getFinalizedScore(scores, roomId, room.season, m.week, m.away) ?? 0.0);
          } else if (BestBallCachingLib.isLiveWeek(syncStatuses, room.season, m.week)) {
            // Live week: compute both dynamically, keep the empty-starters skip.
            let homeRes = calculateOptimalWeeklyLineup(room, homeP, m.week);
            let awayRes = calculateOptimalWeeklyLineup(room, awayP, m.week);
            // Unsynced live week: neither team has a synced lineup (empty
            // starters) → no result for this week. Not counted in gamesPlayed.
            if (homeRes.starters.size() == 0 and awayRes.starters.size() == 0) {
              continue;
            };
            homeTotal := ?homeRes.total;
            awayTotal := ?awayRes.total;
          } else {
            // #notYetAttempted: skip (no result).
            continue;
          };
          let hTotal = homeTotal ?? 0.0;
          let aTotal = awayTotal ?? 0.0;
          let homeEntry = standings.get(m.home) ?? Runtime.trap("h2h: missing home standings entry");
          let awayEntry = standings.get(m.away) ?? Runtime.trap("h2h: missing away standings entry");
          // Genuine ties are allowed — no synthetic tiebreaker.
          let (homeW, homeL, homeT, awayW, awayL, awayT) =
            if (hTotal > aTotal) { (1, 0, 0, 0, 1, 0) }
            else if (hTotal < aTotal) { (0, 1, 0, 1, 0, 0) }
            else { (0, 0, 1, 0, 0, 1) };
          standings.add(m.home, {
            homeEntry with
            wins = homeEntry.wins + homeW;
            losses = homeEntry.losses + homeL;
            ties = homeEntry.ties + homeT;
            pointsFor = homeEntry.pointsFor + hTotal;
            gamesPlayed = homeEntry.gamesPlayed + 1;
          });
          standings.add(m.away, {
            awayEntry with
            wins = awayEntry.wins + awayW;
            losses = awayEntry.losses + awayL;
            ties = awayEntry.ties + awayT;
            pointsFor = awayEntry.pointsFor + aTotal;
            gamesPlayed = awayEntry.gamesPlayed + 1;
          });
        };
        // Deterministic ordering: wins desc, pointsFor desc, Principal asc.
        let entries = List.empty<H2HStandingEntry>();
        standings.forEach(func(_uid, e) { entries.add(e) });
        let sorted = entries.toArray().sort(compareH2H);
        #ok sorted;
      };
    };
  };
};
