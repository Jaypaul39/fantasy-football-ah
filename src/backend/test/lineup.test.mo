import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import LineupLib "../lib/lineup";
import Map "mo:core/Map";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";

// Phase 3 — authoritative optimal weekly Best Ball lineup calculator tests.
//
// Runs via `mops test` (interpreter mode) from the app root. Imports the pure
// lib/lineup.mo module directly (the calculator is internal and not exposed as
// a public method in this phase) and exercises it against controlled,
// deterministic fixtures covering scenarios A–J from the phase spec. Prints
// PASS/FAIL per scenario and traps if any assertion fails, so QA can verify the
// optimization and no-double-counting behavior explicitly.

let season = 2025;
let week = 1;

var failures = 0;

func check(name : Text, cond : Bool) {
  if (cond) {
    Debug.print("PASS: " # name);
  } else {
    Debug.print("FAIL: " # name);
    failures += 1;
  };
};

func approxEq(a : Float, b : Float) : Bool {
  let diff = a - b;
  diff < 0.0001 and diff > -0.0001;
};

func makeRoom(roster : Types.RosterSettings, format : Types.ScoringFormat) : Types.Room {
  {
    id = "room1";
    name = "Test Room";
    admin = Principal.fromText("aaaaa-aa");
    gameType = #Auction;
    competitionMode = #Cumulative;
    playoffTeams = 0;
    participants = [];
    state = #Completed;
    startingBudget = 200;
    createdAt = 0;
    settings = AuctionLib.defaultSettings();
    nominatorIndex = 0;
    nominationTurnStartedAt = 0;
    isPublic = true;
    password = null;
    playerFilter = AuctionLib.defaultPlayerFilter();
    nominationTurnPausedAt = null;
    readyParticipants = [];
    paidParticipants = [];
    rosterSettings = ?roster;
    teamCount = null;
    leagueFormat = null;
    season;
    scoringFormat = format;
  };
};

func won(id : Text, position : Text) : Types.WonPlayer {
  {
    playerId = id;
    playerName = id;
    position;
    team = "TST";
    winningBid = 1;
    nominatedBy = Principal.fromText("aaaaa-aa");
    closedAt = 0;
    byeWeek = null;
  };
};

func makeParticipant(wonPlayers : [Types.WonPlayer]) : Types.Participant {
  {
    userId = Principal.fromText("aaaaa-aa");
    displayName = "Test";
    budget = 200;
    spent = 0;
    committed = [];
    wonPlayers;
    skipNominationTurn = false;
  };
};

// Build raw stats that produce `pts` points under #halfPpr (rushYdPoints = 0.1),
// by encoding the points as rush yards (rushYds = pts * 10).
func ptsStats(playerId : Text, pts : Float) : Types.WeeklyPlayerStats {
  {
    playerId;
    season;
    week;
    passYds = 0;
    passTds = 0;
    ints = 0;
    rushYds = (pts * 10.0).toInt();
    rushTds = 0;
    receptions = 0;
    recYds = 0;
    recTds = 0;
    fumblesLost = 0;
    twoPtConversions = 0;
  };
};

// Build a stats-lookup closure over a Map keyed by playerId|season|week.
func makeLookup(entries : [Types.WeeklyPlayerStats]) : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats {
  let m = Map.empty<Text, Types.WeeklyPlayerStats>();
  for (e in entries.values()) {
    m.add(e.playerId # "|" # e.season.toText() # "|" # e.week.toText(), e);
  };
  func lookup(playerId : Text, s : Nat, w : Nat) : ?Types.WeeklyPlayerStats {
    m.get(playerId # "|" # s.toText() # "|" # w.toText());
  };
  lookup;
};

func sameLineup(a : LineupLib.LineupResult, b : LineupLib.LineupResult) : Bool {
  if (a.starters.size() != b.starters.size()) return false;
  if (a.bench.size() != b.bench.size()) return false;
  if (not approxEq(a.total, b.total)) return false;
  var i = 0;
  while (i < a.starters.size()) {
    if (a.starters[i].playerId != b.starters[i].playerId) return false;
    if (a.starters[i].slot != b.starters[i].slot) return false;
    i += 1;
  };
  var j = 0;
  while (j < a.bench.size()) {
    if (a.bench[j].playerId != b.bench[j].playerId) return false;
    j += 1;
  };
  true;
};

let defaultRoster = AuctionLib.defaultRosterSettings();

// A. Basic roster — enough QB/RB/WR/TE; highest-scoring eligible fills each slot.
func scenarioA() {
  let room = makeRoom(defaultRoster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("RB2", "RB"),
    won("WR1", "WR"), won("WR2", "WR"), won("TE1", "TE"), won("WR3", "WR"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 10.0), ptsStats("RB1", 15.0), ptsStats("RB2", 12.0),
    ptsStats("WR1", 18.0), ptsStats("WR2", 14.0), ptsStats("TE1", 9.0),
    ptsStats("WR3", 20.0),
  ]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  // Starters order: QB, RB, RB, WR, WR, TE, FLEX.
  check("A: 7 starters", res.starters.size() == 7);
  check("A: QB1 in QB", res.starters[0].playerId == ?"QB1");
  check("A: RB1 in RB", res.starters[1].playerId == ?"RB1");
  check("A: RB2 in RB", res.starters[2].playerId == ?"RB2");
  check("A: WR1 in WR", res.starters[3].playerId == ?"WR1");
  check("A: WR2 in WR", res.starters[4].playerId == ?"WR2");
  check("A: TE1 in TE", res.starters[5].playerId == ?"TE1");
  check("A: WR3 in FLEX", res.starters[6].playerId == ?"WR3");
  check("A: total 98", approxEq(res.total, 98.0));
  check("A: bench empty", res.bench.size() == 0);
};

// B. Missing position — no TE; TE slot is a null entry contributing 0; no error.
func scenarioB() {
  let room = makeRoom(defaultRoster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("RB2", "RB"),
    won("WR1", "WR"), won("WR2", "WR"), won("RB3", "RB"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 10.0), ptsStats("RB1", 15.0), ptsStats("RB2", 12.0),
    ptsStats("WR1", 18.0), ptsStats("WR2", 14.0), ptsStats("RB3", 8.0),
  ]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  // Starters order: QB, RB, RB, WR, WR, TE, FLEX.
  check("B: 7 starters", res.starters.size() == 7);
  check("B: TE slot null", res.starters[5].playerId == null);
  check("B: TE slot 0 points", approxEq(res.starters[5].points, 0.0));
  check("B: FLEX = RB3", res.starters[6].playerId == ?"RB3");
  check("B: total 77", approxEq(res.total, 77.0));
};

// C. FLEX optimization — multiple WR/RB compete between required slots and FLEX;
//    the globally highest-scoring valid combination is selected.
func scenarioC() {
  let roster = { defaultRoster with qb = 1; rb = 1; wr = 2; te = 1; flex = 1; superflex = 0 };
  let room = makeRoom(roster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("RB2", "RB"),
    won("WR1", "WR"), won("WR2", "WR"), won("TE1", "TE"), won("WR3", "WR"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 10.0), ptsStats("RB1", 20.0), ptsStats("RB2", 19.0),
    ptsStats("WR1", 18.0), ptsStats("WR2", 17.0), ptsStats("TE1", 3.0),
    ptsStats("WR3", 16.0),
  ]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  // Required: QB(1), RB(1), WR(2), TE(1), FLEX(1). FLEX competes between
  // RB2(19) and WR3(16); the global optimum puts RB2 in FLEX.
  check("C: 6 starters", res.starters.size() == 6);
  check("C: FLEX = RB2", res.starters[5].playerId == ?"RB2");
  check("C: total 87", approxEq(res.total, 87.0));
  check("C: WR3 benched", res.bench.find(func b = b.playerId == "WR3") != null);
};

// D. SUPERFLEX optimization — a QB and another eligible player compete for
//    SUPERFLEX; the highest-total combination respecting superflexPositions wins.
func scenarioD() {
  let roster = { defaultRoster with qb = 1; rb = 1; wr = 1; te = 1; flex = 1; superflex = 1 };
  let room = makeRoom(roster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("QB2", "QB"), won("RB1", "RB"), won("RB2", "RB"),
    won("WR1", "WR"), won("TE1", "TE"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 30.0), ptsStats("QB2", 29.0), ptsStats("RB1", 28.0),
    ptsStats("RB2", 27.0), ptsStats("WR1", 5.0), ptsStats("TE1", 3.0),
  ]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  // Starters order: QB, RB, WR, TE, FLEX, SUPERFLEX. SUPERFLEX competes between
  // QB2(29) and RB2(27); the global optimum puts QB2 in SUPERFLEX.
  check("D: 6 starters", res.starters.size() == 6);
  check("D: SUPERFLEX = QB2", res.starters[5].playerId == ?"QB2");
  check("D: total 122", approxEq(res.total, 122.0));
};

// E. No double counting — a player eligible for multiple slots appears exactly once.
func scenarioE() {
  let roster = { defaultRoster with qb = 1; rb = 1; wr = 1; te = 1; flex = 1; superflex = 1 };
  let room = makeRoom(roster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("QB2", "QB"), won("RB1", "RB"), won("RB2", "RB"),
    won("WR1", "WR"), won("TE1", "TE"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 30.0), ptsStats("QB2", 29.0), ptsStats("RB1", 28.0),
    ptsStats("RB2", 27.0), ptsStats("WR1", 5.0), ptsStats("TE1", 3.0),
  ]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  let seen = Map.empty<Text, ()>();
  var dup = false;
  for (s in res.starters.values()) {
    switch (s.playerId) {
      case null {};
      case (?id) {
        if (seen.get(id) != null) { dup := true };
        seen.add(id, ());
      };
    };
  };
  check("E: no duplicate starter", not dup);
  var qb1Count = 0;
  for (s in res.starters.values()) {
    if (s.playerId == ?"QB1") { qb1Count += 1 };
  };
  check("E: QB1 appears once", qb1Count == 1);
  check("E: 6 filled starters", seen.size() == 6);
};

// F. Zero scoring — a player with synced 0-point stats can occupy a required slot.
func scenarioF() {
  let roster = { defaultRoster with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
  let room = makeRoom(roster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 10.0), ptsStats("RB1", 0.0), ptsStats("WR1", 5.0), ptsStats("TE1", 3.0),
  ]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  // Starters order: QB, RB, WR, TE. RB1 has 0 points but is the only RB.
  check("F: 4 starters", res.starters.size() == 4);
  check("F: RB1 in RB slot", res.starters[1].playerId == ?"RB1");
  check("F: RB1 0 points", approxEq(res.starters[1].points, 0.0));
  check("F: total 18", approxEq(res.total, 18.0));
};

// G. Unsynced week — no WeeklyPlayerStats for the week returns empty lineup, total 0.
func scenarioG() {
  let room = makeRoom(defaultRoster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE"),
  ]);
  let lookup = makeLookup([]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  check("G: empty starters", res.starters.size() == 0);
  check("G: empty bench", res.bench.size() == 0);
  check("G: total 0", approxEq(res.total, 0.0));
};

// H. Custom scoring — lineup points match the Phase 2 custom scoring result.
func scenarioH() {
  let custom : Types.CustomScoringSettings = {
    receptionPoints = 1.0;
    passYdPoints = 0.04;
    passTdPoints = 4.0;
    intPoints = -2.0;
    rushYdPoints = 0.2;
    rushTdPoints = 5.0;
    recYdPoints = 0.1;
    recTdPoints = 6.0;
    fumbleLostPoints = -2.0;
    twoPtPoints = 2.0;
  };
  let roster = { defaultRoster with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
  let room = makeRoom(roster, #custom(custom));
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE"),
  ]);
  let rbStats : Types.WeeklyPlayerStats = {
    playerId = "RB1"; season; week;
    passYds = 0; passTds = 0; ints = 0;
    rushYds = 100; rushTds = 1;
    receptions = 0; recYds = 0; recTds = 0;
    fumblesLost = 0; twoPtConversions = 0;
  };
  let qbStats = ptsStats("QB1", 10.0);
  let wrStats = ptsStats("WR1", 5.0);
  let teStats = ptsStats("TE1", 3.0);
  let lookup = makeLookup([qbStats, rbStats, wrStats, teStats]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  // RB1 expected via Phase 2 custom scoring: 100*0.2 + 1*5 = 25.
  let expectedRb = AuctionLib.calculatePlayerPoints(rbStats, #custom(custom));
  check("H: custom RB points match Phase 2", approxEq(res.starters[1].points, expectedRb));
  check("H: custom RB = 25", approxEq(res.starters[1].points, 25.0));
  // Total must equal the sum of the Phase 2 custom results for all four players.
  let expectedTotal = AuctionLib.calculatePlayerPoints(qbStats, #custom(custom))
    + AuctionLib.calculatePlayerPoints(rbStats, #custom(custom))
    + AuctionLib.calculatePlayerPoints(wrStats, #custom(custom))
    + AuctionLib.calculatePlayerPoints(teStats, #custom(custom));
  check("H: total matches Phase 2 custom", approxEq(res.total, expectedTotal));
};

// I. Determinism — identical starters/bench across repeated runs (with ties).
func scenarioI() {
  let roster = { defaultRoster with qb = 1; rb = 1; wr = 1; te = 1; flex = 1; superflex = 0 };
  let room = makeRoom(roster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("RB2", "RB"),
    won("WR1", "WR"), won("WR2", "WR"), won("TE1", "TE"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 10.0), ptsStats("RB1", 15.0), ptsStats("RB2", 15.0),
    ptsStats("WR1", 12.0), ptsStats("WR2", 12.0), ptsStats("TE1", 9.0),
  ]);
  let first = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  var same = true;
  var i = 0;
  while (i < 5) {
    let r = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
    if (not sameLineup(first, r)) { same := false };
    i += 1;
  };
  check("I: deterministic across runs", same);
};

// J. Real historical data — none found in fixtures; deterministic realistic fixture.
func scenarioJ() {
  Debug.print("NOTE: no suitable real-data participant (wonPlayers + synced stats) exists in the codebase fixtures; using a deterministic realistic fixture for J.");
  let roster = { defaultRoster with qb = 1; rb = 2; wr = 2; te = 1; flex = 1; superflex = 0 };
  let room = makeRoom(roster, #halfPpr);
  let p = makeParticipant([
    won("QB1", "QB"), won("RB1", "RB"), won("RB2", "RB"), won("RB3", "RB"),
    won("WR1", "WR"), won("WR2", "WR"), won("WR3", "WR"), won("TE1", "TE"),
  ]);
  let lookup = makeLookup([
    ptsStats("QB1", 22.0), ptsStats("RB1", 18.0), ptsStats("RB2", 14.0), ptsStats("RB3", 9.0),
    ptsStats("WR1", 21.0), ptsStats("WR2", 16.0), ptsStats("WR3", 11.0), ptsStats("TE1", 13.0),
  ]);
  let res = LineupLib.calculateOptimalWeeklyLineup(room, p, week, lookup);
  // Required: QB(1), RB(2), WR(2), TE(1), FLEX(1). FLEX competes between
  // WR3(11) and RB3(9); the global optimum puts WR3 in FLEX.
  check("J: 7 starters", res.starters.size() == 7);
  check("J: FLEX = WR3", res.starters[6].playerId == ?"WR3");
  check("J: total 115", approxEq(res.total, 115.0));
  check("J: RB3 benched", res.bench.find(func b = b.playerId == "RB3") != null);
};

scenarioA();
scenarioB();
scenarioC();
scenarioD();
scenarioE();
scenarioF();
scenarioG();
scenarioH();
scenarioI();
scenarioJ();

if (failures > 0) {
  Debug.print("LINEUP TESTS: " # failures.toText() # " FAILURE(S)");
  Runtime.trap("lineup tests failed");
} else {
  Debug.print("ALL LINEUP TESTS PASSED");
};
