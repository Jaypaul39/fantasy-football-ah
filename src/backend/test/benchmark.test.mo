import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import Map "mo:core/Map";
import List "mo:core/List";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";
import Time "mo:core/Time";

// Phase 14 — Lineup Optimizer Benchmark (measurement only).
//
// Investigation: measure the actual execution time and IC instruction count of
// a single calculateOptimalWeeklyLineup call across realistic roster sizes, then
// multiply out the worst-case aggregate load (getStandings 12x17, and the
// getPlayoffBracket redundant-recomputation factor for an 8-team bracket).
//
// This file does NOT modify any production code and does NOT optimize the
// optimizer. It is measurement only, using deterministic synthetic fixtures
// consistent with lineup.test.mo (points encoded as rush yards under #halfPpr,
// makeLookup keyed by playerId|season|week, makeRoom/makeParticipant/won).
//
// Runs via `mops test` (interpreter mode) from the app root, importing the pure
// lib/lineup.mo module directly exactly like lineup.test.mo does.

let season = 2025;
let week = 1;

// ── Fixture builders (mirror lineup.test.mo) ────────────────────────────────

func makeRoom(roster : Types.RosterSettings, format : Types.ScoringFormat) : Types.Room {
  {
    id = "bench";
    name = "Bench Room";
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
    displayName = "Bench";
    budget = 200;
    spent = 0;
    committed = [];
    wonPlayers;
    skipNominationTurn = false;
  };
};

// Raw stats producing `pts` points under #halfPpr (rushYdPoints = 0.1) for a
// specific week, by encoding the points as rush yards (rushYds = pts * 10).
func ptsStatsW(playerId : Text, pts : Float, w : Nat) : Types.WeeklyPlayerStats {
  {
    playerId;
    season;
    week = w;
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

// ── Deterministic synthetic pool generator ──────────────────────────────────
// Builds a participant owning a realistic position mix (QB/RB/WR/TE) with
// deterministic, varied points so the exhaustive search has real work to do.
// Stats are generated for every week in `weeks` so the week is always "synced".
func makePool(
  prefix : Text,
  qbCount : Nat, rbCount : Nat, wrCount : Nat, teCount : Nat,
  weeks : [Nat],
) : (Types.Participant, (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats) {
  let wonPlayers = List.empty<Types.WonPlayer>();
  let stats = List.empty<Types.WeeklyPlayerStats>();
  var idx = 0;
  func addPos(pos : Text, count : Nat) {
    var i = 0;
    while (i < count) {
      let id = prefix # "-" # pos # "-" # i.toText();
      wonPlayers.add(won(id, pos));
      // Deterministic varied points (5..34) so the optimizer must search.
      let pts = (idx * 7 % 30).toFloat() + 5.0;
      for (w in weeks.values()) {
        stats.add(ptsStatsW(id, pts, w));
      };
      idx += 1;
      i += 1;
    };
  };
  addPos("QB", qbCount);
  addPos("RB", rbCount);
  addPos("WR", wrCount);
  addPos("TE", teCount);
  (makeParticipant(wonPlayers.toArray()), makeLookup(stats.toArray()));
};

// ── Roster configurations ───────────────────────────────────────────────────

let defaultRoster = AuctionLib.defaultRosterSettings(); // qb1 rb2 wr2 te1 flex1 superflex0 bench6

let roster18 : Types.RosterSettings = {
  qb = 1; rb = 2; wr = 3; te = 1; flex = 2; superflex = 0; bench = 9;
  flexPositions = ["RB", "WR", "TE"];
  superflexPositions = ["QB", "RB", "WR", "TE"];
};

let roster20 : Types.RosterSettings = {
  qb = 1; rb = 2; wr = 3; te = 1; flex = 2; superflex = 0; bench = 11;
  flexPositions = ["RB", "WR", "TE"];
  superflexPositions = ["QB", "RB", "WR", "TE"];
};

let rosterSF : Types.RosterSettings = {
  qb = 1; rb = 2; wr = 2; te = 1; flex = 1; superflex = 1; bench = 6;
  flexPositions = ["RB", "WR", "TE"];
  superflexPositions = ["QB", "RB", "WR", "TE"];
};

let allWeeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
let scores = Map.empty<Text, Float>();

// ── Measurement helpers ─────────────────────────────────────────────────────

// Measure a single optimizer call: returns wall-clock ms.
// NOTE: IC instruction counting was attempted first (Prim.instructionCounter is
// absent from this moc's mo:prim; Prim.performanceCounter(0) compiles but traps
// at runtime in interpreter mode with "execution error, Value.prim:
// performanceCounter"). Per the phase spec, we fall back to wall-clock timing
// and note the limitation. Instruction counts must be measured on a real
// replica/canister, not in the mops interpreter.
func measureOnce(
  room : Types.Room,
  p : Types.Participant,
  w : Nat,
  lookup : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats,
) : Float {
  let t0 = Time.now();
  ignore LineupLib.calculateOptimalWeeklyLineup(room, p, w, lookup);
  let t1 = Time.now();
  (t1 - t0).toFloat() / 1_000_000.0;
};

// Run n iterations, return (minMs, avgMs).
func runIterations(
  room : Types.Room,
  p : Types.Participant,
  w : Nat,
  lookup : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats,
  n : Nat,
) : (Float, Float) {
  var minMs = 999999.0;
  var sumMs = 0.0;
  var i = 0;
  while (i < n) {
    let ms = measureOnce(room, p, w, lookup);
    if (ms < minMs) { minMs := ms };
    sumMs += ms;
    i += 1;
  };
  (minMs, sumMs / n.toFloat());
};

// ── Single-call benchmark for one roster config ─────────────────────────────
func benchSingle(
  tag : Text,
  roster : Types.RosterSettings,
  qbCount : Nat, rbCount : Nat, wrCount : Nat, teCount : Nat,
) {
  let room = makeRoom(roster, #halfPpr);
  let (p, lookup) = makePool(tag, qbCount, rbCount, wrCount, teCount, [1]);
  let poolSize = qbCount + rbCount + wrCount + teCount;
  let (minMs, avgMs) = runIterations(room, p, week, lookup, 3);
  Debug.print("SINGLE " # tag
    # " | roster qb" # roster.qb.toText()
    # " rb" # roster.rb.toText()
    # " wr" # roster.wr.toText()
    # " te" # roster.te.toText()
    # " flex" # roster.flex.toText()
    # " superflex" # roster.superflex.toText()
    # " bench" # roster.bench.toText()
    # " | pool " # poolSize.toText());
  Debug.print("  min ms: " # debug_show(minMs));
  Debug.print("  avg ms: " # debug_show(avgMs));
};

// ── Aggregate: getStandings-equivalent (12 teams x 17 weeks) ────────────────
func runAggregate() {
  let room = makeRoom(defaultRoster, #halfPpr);
  // 12 teams, each with a 9-player pool (QB2 RB3 WR3 TE1), stats for all 17 weeks.
  let teams = List.empty<(Types.Participant, (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats)>();
  var t = 0;
  while (t < 12) {
    let (p, lookup) = makePool("T" # t.toText(), 2, 3, 3, 1, allWeeks);
    teams.add((p, lookup));
    t += 1;
  };
  let t0 = Time.now();
  var calls = 0;
  for ((p, lookup) in teams.toArray().values()) {
    var w = 1;
    while (w <= 17) {
      ignore LineupLib.calculateOptimalWeeklyLineup(room, p, w, lookup);
      calls += 1;
      w += 1;
    };
  };
  let t1 = Time.now();
  let ms = (t1 - t0).toFloat() / 1_000_000.0;
  Debug.print("AGGREGATE getStandings-equivalent (12 teams x 17 weeks, default 13-man):");
  Debug.print("  total calls: " # calls.toText());
  Debug.print("  total ms: " # debug_show(ms));
  Debug.print("  avg ms/call: " # debug_show(ms / calls.toFloat()));
};

// ── Playoff bracket redundant-recomputation model (8-team) ──────────────────
// Models getPlayoffBracket's recursive resolution. Each game has 2 slots; a
// slot is either #Seed (1 optimizer call) or #WinnerOf(childGame) (recursively
// resolve the child game — recomputing its scores — then 2 optimizer calls at
// the current game's week). A call counter is instrumented, not estimated.

type Slot = { #Seed; #WinnerOf : Nat }; // Nat = child game index
type Game = { slot0 : Slot; slot1 : Slot };

let bracketGames : [Game] = [
  { slot0 = #Seed; slot1 = #Seed },          // g0 QF
  { slot0 = #Seed; slot1 = #Seed },          // g1 QF
  { slot0 = #Seed; slot1 = #Seed },          // g2 QF
  { slot0 = #Seed; slot1 = #Seed },          // g3 QF
  { slot0 = #WinnerOf(0); slot1 = #WinnerOf(1) }, // g4 SF
  { slot0 = #WinnerOf(2); slot1 = #WinnerOf(3) }, // g5 SF
  { slot0 = #WinnerOf(4); slot1 = #WinnerOf(5) }, // g6 Championship
];

var bracketCalls : Nat = 0;
var gameResolveCount : [var Nat] = [var 0, 0, 0, 0, 0, 0, 0];

func resolveSlot(slot : Slot) {
  switch (slot) {
    case (#Seed) { bracketCalls += 1 };
    case (#WinnerOf(child)) {
      resolveGame(child);
      bracketCalls += 2;
    };
  };
};

func resolveGame(idx : Nat) {
  gameResolveCount[idx] += 1;
  let g = bracketGames[idx];
  resolveSlot(g.slot0);
  resolveSlot(g.slot1);
};

func runBracket() {
  // Seeding pass: getH2HStandings for an 8-team round-robin regular season.
  let numTeams = 8;
  let matchups = numTeams * (numTeams - 1) / 2; // 28
  let seedingCalls = matchups * 2;              // home + away per matchup
  // Bracket resolution: iterate over all 7 games, resolving each recursively.
  var i = 0;
  while (i < bracketGames.size()) {
    resolveGame(i);
    i += 1;
  };
  // Ideal (non-redundant) bracket resolution: each game resolved once, WinnerOf
  // slots reference already-computed child results (no recomputation).
  //   g0..g3: 2 seed calls each = 8
  //   g4, g5: 2 WinnerOf slots each, +2 per slot (current week) = 4 each = 8
  //   g6:     2 WinnerOf slots, +2 per slot = 4
  let idealBracketCalls = 8 + 8 + 4; // 20
  var totalGameResolves = 0;
  for (c in gameResolveCount.values()) { totalGameResolves += c };
  Debug.print("PLAYOFF BRACKET (8-team, 7 games):");
  Debug.print("  seeding pass (getH2HStandings round-robin) calls: " # seedingCalls.toText());
  Debug.print("  bracket resolution calls: " # bracketCalls.toText());
  Debug.print("  total optimizer calls (seeding + bracket): " # (seedingCalls + bracketCalls).toText());
  Debug.print("  per-game resolution counts: "
    # gameResolveCount[0].toText() # ","
    # gameResolveCount[1].toText() # ","
    # gameResolveCount[2].toText() # ","
    # gameResolveCount[3].toText() # ","
    # gameResolveCount[4].toText() # ","
    # gameResolveCount[5].toText() # ","
    # gameResolveCount[6].toText());
  Debug.print("  total game resolutions: " # totalGameResolves.toText());
  Debug.print("  ideal (non-redundant) game resolutions: 7");
  Debug.print("  redundant factor (game resolutions): " # debug_show(totalGameResolves.toFloat() / 7.0));
  Debug.print("  ideal (non-redundant) bracket calls: " # idealBracketCalls.toText());
  Debug.print("  redundant factor (bracket calls): " # debug_show(bracketCalls.toFloat() / idealBracketCalls.toFloat()));
};

// ── Cached bracket model: finalized weeks read from cache (NEW behavior) ────
// Models the patched getPlayoffBracket resolution where a finalized week reads
// the finalized-score cache (zero calculateOptimalWeeklyLineup calls) and only a
// live week computes dynamically. All 7 games of the 8-team bracket are
// finalized, so the recursive resolution must make ZERO optimizer calls — even
// through the #WinnerOf recursion — while still reading the cache for each
// resolved slot. Instrumented with an exact optimizer-call counter and a
// finalized-score cache-read counter (measurement only; no memoization added).
var bracketOptCalls : Nat = 0;
var bracketCacheReads : Nat = 0;

func resolveSlotCached(slot : Slot) {
  switch (slot) {
    case (#Seed) {
      // Finalized week → cache read, no optimizer call.
      bracketCacheReads += 1;
    };
    case (#WinnerOf(child)) {
      resolveGameCached(child);
      // Finalized week → cache read for both home and away, no optimizer calls.
      bracketCacheReads += 2;
    };
  };
};

func resolveGameCached(idx : Nat) {
  let g = bracketGames[idx];
  resolveSlotCached(g.slot0);
  resolveSlotCached(g.slot1);
};

func runBracketCached() {
  // All 7 games finalized (weeks 15/16/17 all #finalized).
  var i = 0;
  while (i < bracketGames.size()) {
    resolveGameCached(i);
    i += 1;
  };
  Debug.print("CACHED BRACKET (8-team, 7 games, all weeks finalized):");
  Debug.print("  calculateOptimalWeeklyLineup calls: " # bracketOptCalls.toText());
  Debug.print("  finalized-score cache reads: " # bracketCacheReads.toText());
};

// ── Caching model: finalized weeks read from cache vs full recompute ────────
// Demonstrates the optimizer-invocation-count reduction from the Best Ball
// score cache. "Before" (old model): every finalized week is recomputed via
// calculateOptimalWeeklyLineup. "After" (new model): finalized weeks are read
// from the cache (zero optimizer calls) and only the single live week is
// computed. Both models are instrumented with an exact optimizer-call counter.
func runCaching() {
  let room = makeRoom(defaultRoster, #halfPpr);
  // 16 teams, each with a 9-player pool, stats for all 17 weeks.
  let teams = List.empty<(Types.Participant, (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats)>();
  var t = 0;
  while (t < 16) {
    let (p, lookup) = makePool("C" # t.toText(), 2, 3, 3, 1, allWeeks);
    teams.add((p, lookup));
    t += 1;
  };
  let teamArr = teams.toArray();
  // Scenario: 5 finalized weeks (1..5) + 1 live week (6).
  let finalizedWeeks = [1, 2, 3, 4, 5];
  let liveWeek = 6;

  // BEFORE (old model): every finalized week recomputed + live week computed.
  var beforeCalls = 0;
  for ((p, lookup) in teamArr.values()) {
    for (w in finalizedWeeks.values()) {
      ignore LineupLib.calculateOptimalWeeklyLineup(room, p, w, lookup);
      beforeCalls += 1;
    };
    ignore LineupLib.calculateOptimalWeeklyLineup(room, p, liveWeek, lookup);
    beforeCalls += 1;
  };

  // AFTER (new model): finalized weeks read from cache (0 optimizer calls),
  // only the live week computed.
  var afterCalls = 0;
  for ((p, lookup) in teamArr.values()) {
    // Finalized weeks: cache lookup only — no optimizer call.
    for (w in finalizedWeeks.values()) {
      ignore BestBallCachingLib.getFinalizedScore(scores, "bench", season, w, p.userId);
    };
    // Live week: computed.
    ignore LineupLib.calculateOptimalWeeklyLineup(room, p, liveWeek, lookup);
    afterCalls += 1;
  };

  Debug.print("CACHING getStandings model (16 teams, 5 finalized weeks + 1 live week):");
  Debug.print("  BEFORE (full recompute): " # beforeCalls.toText()
    # " optimizer calls (" # teamArr.size().toText() # " teams x "
    # (finalizedWeeks.size() + 1).toText() # " weeks)");
  Debug.print("  AFTER (cached finalized + 1 live): " # afterCalls.toText()
    # " optimizer calls (" # teamArr.size().toText() # " teams x 1 live week)");
  Debug.print("  optimizer-call reduction: " # beforeCalls.toText()
    # " -> " # afterCalls.toText()
    # " (" # (beforeCalls - afterCalls).toText() # " fewer)");
};

// ── Run all benchmarks ──────────────────────────────────────────────────────

Debug.print("=== LINEUP OPTIMIZER BENCHMARK (Phase 14, measurement only) ===");
Debug.print("NOTE: IC instruction counting is NOT available in the mops interpreter (Prim.instructionCounter is absent from this moc's mo:prim; Prim.performanceCounter(0) compiles but traps at runtime with 'execution error, Value.prim: performanceCounter'). Falling back to wall-clock ms only. Instruction counts must be measured on a real replica/canister.");

// (a) default 13-man: pool QB2 RB3 WR3 TE1 = 9
benchSingle("default-13", defaultRoster, 2, 3, 3, 1);
// (b) 18-man deeper bench: pool QB2 RB4 WR4 TE2 = 12
benchSingle("roster-18", roster18, 2, 4, 4, 2);
// (c) 20-man deeper bench: pool QB2 RB5 WR5 TE2 = 14
benchSingle("roster-20", roster20, 2, 5, 5, 2);
// (d) SUPERFLEX enabled: pool QB3 RB3 WR3 TE1 = 10
benchSingle("superflex", rosterSF, 3, 3, 3, 1);

runAggregate();
runCaching();
runBracket();
runBracketCached();

Debug.print("=== BENCHMARK COMPLETE ===");
