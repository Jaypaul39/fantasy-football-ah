import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import Map "mo:core/Map";
import List "mo:core/List";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Debug "mo:core/Debug";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Prim "mo:prim";

// Phase 14 — Lineup Optimizer Benchmark canister (measurement only).
//
// Standalone benchmark canister. Imports the pure lib/lineup.mo and
// lib/auction-types.mo modules directly (exactly like lineup.test.mo) and
// measures calculateOptimalWeeklyLineup on a REAL replica via PocketIC, where
// Prim.performanceCounter(0) returns real IC instruction counts (it traps in
// the mops interpreter). Deterministic synthetic fixtures only — no real data,
// no randomness, no modification of any production module, no optimizer change.
//
// runBenchmark() runs every measurement and stores a text report; getReport()
// returns it so the PocketIC test can surface the numbers.
//
// IC limits being compared against: 5,000,000,000 (5B) instructions for query
// calls, 20,000,000,000 (20B) for update calls, 5 second time limit.

actor {
  var report : Text = "";
  let scores = Map.empty<Text, Float>();

  let season = 2025;
  let week = 1;

  // ── Fixture builders (mirror lineup.test.mo) ──────────────────────────────

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

  // Deterministic synthetic pool: a participant owning a realistic position mix
  // (QB/RB/WR/TE) with deterministic, varied points so the exhaustive search has
  // real work to do. Stats are generated for every week in `weeks` so the week
  // is always "synced".
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

  // Deterministic position distribution for a controlled pool of exactly
  // `poolSize` owned players, always able to fill the fixed 9-starter roster
  // (QB1/RB2/WR2/TE1/FLEX2/SUPERFLEX1). QB stays at 1; all extras go to the
  // non-QB positions (RB/WR/TE), which each have the same 4 search branches
  // (own slot + FLEX + SUPERFLEX + bench), so the pool-size curve is not
  // confounded by a changing QB/non-QB split.
  func controlledDistribution(poolSize : Nat) : (Nat, Nat, Nat, Nat) {
    switch (poolSize) {
      case 9 (1, 3, 3, 2);
      case 10 (1, 3, 4, 2);
      case 11 (1, 4, 4, 2);
      case 12 (1, 4, 5, 2);
      case 13 (1, 4, 6, 2);
      case 14 (1, 5, 6, 2);
      case 15 (1, 5, 7, 2);
      case 16 (1, 6, 7, 2);
      case _ (1, 4, 5, 2);
    };
  };

  // ── Roster configurations ─────────────────────────────────────────────────

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

  // ── Measurement helpers ───────────────────────────────────────────────────

  // Measure a single optimizer call: returns (instruction count, wall-clock ms).
  // Prim.performanceCounter(0) is the current message instruction counter; it
  // resets on shared entry and every await, and runBenchmark has no awaits, so
  // sampling before/after the call yields that call's real instruction count.
  func measureOnce(
    room : Types.Room,
    p : Types.Participant,
    w : Nat,
    lookup : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats,
  ) : (Nat64, Float) {
    let c0 = Prim.performanceCounter(0);
    let t0 = Time.now();
    ignore LineupLib.calculateOptimalWeeklyLineup(room, p, w, lookup);
    let t1 = Time.now();
    let c1 = Prim.performanceCounter(0);
    (c1 - c0, (t1 - t0).toFloat() / 1_000_000.0);
  };

  // Run n iterations, return (minInstr, avgInstr, minMs, avgMs, exceeded).
  // If any single call exceeds the 12B guard, it returns immediately with
  // exceeded=true and that call's values, so an explosive config is recorded
  // as EXCEEDS instead of hanging the message.
  func runIterations(
    room : Types.Room,
    p : Types.Participant,
    w : Nat,
    lookup : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats,
    n : Nat,
  ) : (Nat64, Nat64, Float, Float, Bool) {
    var minInstr : ?Nat64 = null;
    var sumInstr : Nat64 = 0;
    var minMs = 999999.0;
    var sumMs = 0.0;
    var i = 0;
    while (i < n) {
      let (instr, ms) = measureOnce(room, p, w, lookup);
      if (instr > 12_000_000_000) {
        return (instr, instr, ms, ms, true);
      };
      switch (minInstr) {
        case null { minInstr := ?instr };
        case (?m) { if (instr < m) { minInstr := ?instr } };
      };
      sumInstr += instr;
      if (ms < minMs) { minMs := ms };
      sumMs += ms;
      i += 1;
    };
    (minInstr ?? 0, sumInstr / n.toNat64(), minMs, sumMs / n.toFloat(), false);
  };

  func fmtInstr(v : Nat64) : Text {
    let n = v.toNat();
    if (n >= 1_000_000_000) {
      (n / 1_000_000_000).toText() # "B"
    } else if (n >= 1_000_000) {
      (n / 1_000_000).toText() # "M"
    } else {
      n.toText();
    };
  };

  // ── Single-call benchmark for one roster config ───────────────────────────
  func benchSingle(
    lines : List.List<Text>,
    tag : Text,
    roster : Types.RosterSettings,
    qbCount : Nat, rbCount : Nat, wrCount : Nat, teCount : Nat,
  ) {
    let room = makeRoom(roster, #halfPpr);
    let (p, lookup) = makePool(tag, qbCount, rbCount, wrCount, teCount, [1]);
    let poolSize = qbCount + rbCount + wrCount + teCount;
    let (minInstr, avgInstr, minMs, avgMs, exceeded) = runIterations(room, p, week, lookup, 3);
    lines.add("SINGLE " # tag
      # " | roster qb" # roster.qb.toText()
      # " rb" # roster.rb.toText()
      # " wr" # roster.wr.toText()
      # " te" # roster.te.toText()
      # " flex" # roster.flex.toText()
      # " superflex" # roster.superflex.toText()
      # " bench" # roster.bench.toText()
      # " | pool " # poolSize.toText());
    if (exceeded) {
      lines.add("  EXCEEDS 12B instr guard (update limit 20B) — "
        # fmtInstr(minInstr) # " (" # minInstr.toText() # ") instr, "
        # debug_show(minMs) # " ms");
    } else {
      lines.add("  min instr: " # fmtInstr(minInstr) # " (" # minInstr.toText() # ")");
      lines.add("  avg instr: " # fmtInstr(avgInstr) # " (" # avgInstr.toText() # ")");
      lines.add("  min ms: " # debug_show(minMs));
      lines.add("  avg ms: " # debug_show(avgMs));
    };
  };

  // ── Scaling curve for default-13 across pool sizes ────────────────────────
  // Progressively larger pools (9..15). Guarded so a single call that would
  // blow the update budget is recorded as EXCEEDS and the curve stops instead
  // of hanging the message.
  func runScaling(lines : List.List<Text>) {
    lines.add("SCALING default-13 (qb1 rb2 wr2 te1 flex1 superflex0) across pool sizes:");
    let room = makeRoom(defaultRoster, #halfPpr);
    // pool size -> (qb, rb, wr, te) distribution; extras go to RB/WR (the
    // positions with the most eligible slots, which drive the branching).
    let sizes : [(Nat, Nat, Nat, Nat, Nat)] = [
      (9, 2, 3, 3, 1),
      (10, 2, 4, 3, 1),
      (11, 2, 4, 4, 1),
      (12, 2, 5, 4, 1),
      (13, 2, 5, 5, 1),
      (14, 2, 6, 5, 1),
      (15, 2, 6, 6, 1),
    ];
    for ((poolSize, qb, rb, wr, te) in sizes.values()) {
      // Total-message budget guard: Prim.performanceCounter(0) accumulates across
      // the whole runBenchmark message (no awaits), so stop before the message
      // approaches the 20B update limit / 5s time limit.
      if (Prim.performanceCounter(0) > 12_000_000_000) {
        lines.add("  pool " # poolSize.toText()
          # ": SKIPPED — message budget guard hit (cumulative > 12B instr)");
        return;
      };
      let (p, lookup) = makePool("S" # poolSize.toText(), qb, rb, wr, te, [1]);
      let (instr, ms) = measureOnce(room, p, week, lookup);
      if (instr > 12_000_000_000) {
        lines.add("  pool " # poolSize.toText()
          # ": EXCEEDS 12B instr guard (update limit 20B) — " # fmtInstr(instr)
          # " (" # instr.toText() # ") instr, " # debug_show(ms) # " ms — stopping curve");
        return;
      };
      lines.add("  pool " # poolSize.toText()
        # " (qb" # qb.toText() # " rb" # rb.toText()
        # " wr" # wr.toText() # " te" # te.toText() # "): "
        # fmtInstr(instr) # " (" # instr.toText() # ") instr, "
        # debug_show(ms) # " ms");
    };
  };

  // ── Aggregate: getStandings-equivalent (12 teams x 17 weeks) ──────────────
  func runAggregate(lines : List.List<Text>) {
    let room = makeRoom(defaultRoster, #halfPpr);
    // 12 teams, each with a 9-player pool (QB2 RB3 WR3 TE1), stats for all 17 weeks.
    let teams = List.empty<(Types.Participant, (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats)>();
    var t = 0;
    while (t < 12) {
      let (p, lookup) = makePool("T" # t.toText(), 2, 3, 3, 1, allWeeks);
      teams.add((p, lookup));
      t += 1;
    };
    let c0 = Prim.performanceCounter(0);
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
    let c1 = Prim.performanceCounter(0);
    let totalInstr = c1 - c0;
    let ms = (t1 - t0).toFloat() / 1_000_000.0;
    lines.add("AGGREGATE getStandings-equivalent (12 teams x 17 weeks, default 13-man, 9-player pool):");
    lines.add("  total calls: " # calls.toText());
    lines.add("  total instr: " # fmtInstr(totalInstr) # " (" # totalInstr.toText() # ")");
    lines.add("  total ms: " # debug_show(ms));
    lines.add("  avg instr/call: " # fmtInstr(totalInstr / calls.toNat64()));
    lines.add("  fits in query (5B)? " # (if (totalInstr <= 5_000_000_000) "YES" else "NO"));
    lines.add("  fits in update (20B)? " # (if (totalInstr <= 20_000_000_000) "YES" else "NO"));
  };

  // ── Playoff bracket redundant-recomputation model (8-team) ────────────────
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
  let gameResolveCount : [var Nat] = [var 0, 0, 0, 0, 0, 0, 0];

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

  func runBracket(lines : List.List<Text>) {
    bracketCalls := 0;
    for (i in gameResolveCount.keys()) { gameResolveCount[i] := 0 };
    // Seeding pass: getH2HStandings for an 8-team round-robin regular season.
    // matchups = numTeams * (numTeams - 1) / 2 = 8 * 7 / 2 = 28.
    let matchups = 28;
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
    lines.add("PLAYOFF BRACKET (8-team, 7 games):");
    lines.add("  seeding pass (getH2HStandings round-robin) calls: " # seedingCalls.toText());
    lines.add("  bracket resolution calls: " # bracketCalls.toText());
    lines.add("  total optimizer calls (seeding + bracket): " # (seedingCalls + bracketCalls).toText());
    lines.add("  per-game resolution counts: "
      # gameResolveCount[0].toText() # ","
      # gameResolveCount[1].toText() # ","
      # gameResolveCount[2].toText() # ","
      # gameResolveCount[3].toText() # ","
      # gameResolveCount[4].toText() # ","
      # gameResolveCount[5].toText() # ","
      # gameResolveCount[6].toText());
    lines.add("  total game resolutions: " # totalGameResolves.toText());
    lines.add("  ideal (non-redundant) game resolutions: 7");
    lines.add("  redundant factor (game resolutions): " # debug_show(totalGameResolves.toFloat() / 7.0));
    lines.add("  ideal (non-redundant) bracket calls: " # idealBracketCalls.toText());
    lines.add("  redundant factor (bracket calls): " # debug_show(bracketCalls.toFloat() / idealBracketCalls.toFloat()));
  };

  // ── Run all benchmarks ────────────────────────────────────────────────────

  // Total-message budget guard: Prim.performanceCounter(0) accumulates across
  // the whole runBenchmark message (no awaits). Stop before the message
  // approaches the 20B update limit / 5s time limit.
  func budgetOk(lines : List.List<Text>) : Bool {
    if (Prim.performanceCounter(0) > 12_000_000_000) {
      lines.add("MESSAGE BUDGET EXHAUSTED (cumulative > 12B instr) — stopping further benchmarks");
      false;
    } else {
      true;
    };
  };

  func finalize(lines : List.List<Text>) {
    report := lines.toArray().values().join("\n");
    Debug.print(report);
  };

  // ── Controlled benchmark (Phase 14 follow-up) ─────────────────────────────
  // Isolates pool-size scaling from roster complexity. The roster is FIXED at
  // QB1/RB2/WR2/TE1/FLEX2/SUPERFLEX1 (9 required starters) for every call; only
  // the owned-player pool size (curve a) or the bench size (curve b) changes.
  // Each call is a separate update message so an explosive config (e.g. pool 16)
  // is measured in isolation and never lost to a cumulative message-budget guard.
  public func runControlled(poolSize : Nat, benchSize : Nat) : async Text {
    let roster : Types.RosterSettings = {
      qb = 1; rb = 2; wr = 2; te = 1; flex = 2; superflex = 1; bench = benchSize;
      flexPositions = ["RB", "WR", "TE"];
      superflexPositions = ["QB", "RB", "WR", "TE"];
    };
    let room = makeRoom(roster, #halfPpr);
    let (qb, rb, wr, te) = controlledDistribution(poolSize);
    let (p, lookup) = makePool("C" # poolSize.toText() # "-b" # benchSize.toText(), qb, rb, wr, te, [1]);
    let (instr, ms) = measureOnce(room, p, week, lookup);
    "CONTROLLED pool " # poolSize.toText() # " bench " # benchSize.toText()
      # " (qb" # qb.toText() # " rb" # rb.toText() # " wr" # wr.toText() # " te" # te.toText() # "): "
      # fmtInstr(instr) # " (" # instr.toText() # ") instr, " # debug_show(ms) # " ms";
  };

  // ── Caching model: finalized weeks read from cache vs full recompute ──────
  // Demonstrates the optimizer-invocation-count reduction from the Best Ball
  // score cache. "Before" (old model): every finalized week is recomputed via
  // calculateOptimalWeeklyLineup. "After" (new model): finalized weeks are read
  // from the cache (zero optimizer calls) and only the single live week is
  // computed. Both models are instrumented with an exact optimizer-call counter.
  //
  // Runs as its own update message (like runControlled) so it is never dropped
  // by runBenchmark's cumulative message-budget guard.
  public func runCachingBenchmark() : async Text {
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
    let c0 = Prim.performanceCounter(0);
    let t0 = Time.now();
    var beforeCalls = 0;
    for ((p, lookup) in teamArr.values()) {
      for (w in finalizedWeeks.values()) {
        ignore LineupLib.calculateOptimalWeeklyLineup(room, p, w, lookup);
        beforeCalls += 1;
      };
      ignore LineupLib.calculateOptimalWeeklyLineup(room, p, liveWeek, lookup);
      beforeCalls += 1;
    };
    let t1 = Time.now();
    let c1 = Prim.performanceCounter(0);
    let beforeInstr = c1 - c0;
    let beforeMs = (t1 - t0).toFloat() / 1_000_000.0;

    // AFTER (new model): finalized weeks read from cache (0 optimizer calls),
    // only the live week computed.
    let c2 = Prim.performanceCounter(0);
    let t2 = Time.now();
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
    let t3 = Time.now();
    let c3 = Prim.performanceCounter(0);
    let afterInstr = c3 - c2;
    let afterMs = (t3 - t2).toFloat() / 1_000_000.0;

    "CACHING getStandings model (16 teams, 5 finalized weeks + 1 live week):\n"
    # "  BEFORE (full recompute): " # beforeCalls.toText()
    # " optimizer calls (" # teamArr.size().toText() # " teams x "
    # (finalizedWeeks.size() + 1).toText() # " weeks)\n"
    # "    total instr: " # fmtInstr(beforeInstr) # " (" # beforeInstr.toText() # "), "
    # debug_show(beforeMs) # " ms\n"
    # "  AFTER (cached finalized + 1 live): " # afterCalls.toText()
    # " optimizer calls (" # teamArr.size().toText() # " teams x 1 live week)\n"
    # "    total instr: " # fmtInstr(afterInstr) # " (" # afterInstr.toText() # "), "
    # debug_show(afterMs) # " ms\n"
    # "  optimizer-call reduction: " # beforeCalls.toText()
    # " -> " # afterCalls.toText()
    # " (" # (beforeCalls - afterCalls).toText() # " fewer)\n"
    # "  instruction reduction: " # fmtInstr(beforeInstr) # " -> " # fmtInstr(afterInstr);
  };

  public func runBenchmark() : async () {
    let lines = List.empty<Text>();
    lines.add("=== LINEUP OPTIMIZER BENCHMARK (Phase 14, real-replica instruction counts) ===");
    lines.add("IC limits: query 5B instr / update 20B instr / 5s time.");

    // (a) default 13-man: pool QB2 RB3 WR3 TE1 = 9
    benchSingle(lines, "default-13", defaultRoster, 2, 3, 3, 1);
    if (not budgetOk(lines)) { finalize(lines); return };
    // (b) 18-man deeper bench: pool QB2 RB4 WR4 TE2 = 12
    benchSingle(lines, "roster-18", roster18, 2, 4, 4, 2);
    if (not budgetOk(lines)) { finalize(lines); return };
    // (c) 20-man deeper bench: pool QB2 RB5 WR5 TE2 = 14
    benchSingle(lines, "roster-20", roster20, 2, 5, 5, 2);
    if (not budgetOk(lines)) { finalize(lines); return };
    // (d) SUPERFLEX enabled: pool QB3 RB3 WR3 TE1 = 10
    benchSingle(lines, "superflex", rosterSF, 3, 3, 3, 1);
    if (not budgetOk(lines)) { finalize(lines); return };

    runAggregate(lines);
    if (not budgetOk(lines)) { finalize(lines); return };
    runBracket(lines);
    runScaling(lines);

    finalize(lines);
  };

  public query func getReport() : async Text {
    report;
  };
};
