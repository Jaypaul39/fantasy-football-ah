import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import Map "mo:core/Map";
import List "mo:core/List";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";

// Authoritative optimal weekly Best Ball lineup calculator (Phase 3).
//
// Pure module — no state, no side effects. The weeklyPlayerStats map lives in
// main.mo; this module receives a stats-lookup closure so it never touches
// persistent auction data. It is the single source of truth for weekly lineup
// selection and is reused unchanged by Phase 4's getWeeklyLineup/getStandings.
//
// The algorithm performs an exhaustive (backtracking) search over the small
// candidate set of owned players, finding the globally highest-scoring valid
// combination of starters across all required, FLEX, and SUPERFLEX slots
// simultaneously — not a fixed greedy slot-by-slot fill. A player eligible for
// multiple slot categories is considered against all valid placements and may
// occupy exactly one starting slot (never double-counted).
module {
  // ── Result types ──────────────────────────────────────────────────────────
  // Module-internal (not Candid/API types). Exposed from the module only so
  // main.mo can wire the closure and return the result to Phase 4.

  /// One starter slot in the returned lineup. playerId is null when the slot
  /// could not be filled (the participant owns fewer eligible players than the
  /// roster requires) — such a slot contributes 0 points.
  public type LineupSlot = {
    playerId : ?Text;
    position : Text; // the player's position; "" for an unfilled slot
    points : Float;
    slot : Text; // "QB" | "RB" | "WR" | "TE" | "FLEX" | "SUPERFLEX"
  };

  /// One bench entry — an owned non-starter, including players with no weekly
  /// stats record (0 points).
  public type LineupBenchEntry = {
    playerId : Text;
    points : Float;
  };

  /// The complete weekly lineup result.
  public type LineupResult = {
    starters : [LineupSlot];
    bench : [LineupBenchEntry];
    total : Float; // total fantasy points of the selected starters
  };

  // ── Internal working types ────────────────────────────────────────────────

  type OwnedPlayer = {
    playerId : Text;
    position : Text;
    points : Float;
  };

  type SlotAssign = {
    category : Text;
    playerId : Text;
  };

  func isIn(pos : Text, list : [Text]) : Bool {
    list.find(func x = x == pos) != null;
  };

  /// Lexicographic comparison of two sorted Text arrays.
  func compareTextArrays(a : [Text], b : [Text]) : { #less; #equal; #greater } {
    var i = 0;
    while (i < a.size() and i < b.size()) {
      let c = Text.compare(a[i], b[i]);
      if (c != #equal) return c;
      i += 1;
    };
    if (a.size() < b.size()) #less
    else if (a.size() > b.size()) #greater
    else #equal;
  };

  /// Canonical tie-break key for a category: the sorted playerIds assigned to it.
  func categoryIds(cat : Text, assign : [SlotAssign]) : [Text] {
    let ids = assign.filter(func s = s.category == cat)
      .map(func s = s.playerId);
    ids.sort();
  };

  /// Deterministic tie-break: true when assignment `a` is strictly preferred
  /// over `b` for equal totals. First prefers the assignment that fills more
  /// slots (fewer empty required slots) — a 0-point player may occupy a required
  /// slot rather than leaving it empty. Then compares canonical per-category
  /// sorted playerId lists in a fixed category order — independent of
  /// map/iteration order.
  func better(a : [SlotAssign], b : [SlotAssign]) : Bool {
    if (a.size() != b.size()) return a.size() > b.size();
    let cats = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX"];
    for (cat in cats.values()) {
      let c = compareTextArrays(categoryIds(cat, a), categoryIds(cat, b));
      if (c == #less) return true;
      if (c == #greater) return false;
    };
    false; // identical canonical keys — either assignment is equivalent
  };

  /// Compute the authoritative optimal weekly Best Ball lineup for one
  /// participant in one week.
  ///
  /// Pure: reads only the supplied Room, Participant, and stats-lookup closure.
  /// Never mutates wonPlayers, rosterSettings, WeeklyPlayerStats, or any
  /// persistent auction data.
  ///
  /// getStats(playerId, season, week) -> ?WeeklyPlayerStats supplies the raw
  /// weekly stats for the requested season+week. Points are computed via the
  /// Phase 2 calculatePlayerPoints with the room's ScoringFormat.
  public func calculateOptimalWeeklyLineupExhaustive(
    room : Types.Room,
    participant : Types.Participant,
    week : Nat,
    getStats : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats,
  ) : LineupResult {
    let roster = switch (room.rosterSettings) {
      case (?r) r;
      case null AuctionLib.defaultRosterSettings();
    };
    let format = room.scoringFormat;
    let season = room.season;

    // ── Synced-week check ────────────────────────────────────────────────────
    // A week is "synced" when at least one WeeklyPlayerStats record exists for
    // this season+week across all owned players. If none exist at all, the week
    // has not been synced: return an empty lineup rather than treating every
    // player as zero-scoring.
    var synced = false;
    for (wp in participant.wonPlayers.values()) {
      if (getStats(wp.playerId, season, week) != null) { synced := true };
    };
    if (not synced) {
      return { starters = []; bench = []; total = 0.0 };
    };

    // ── Owned players with computed points ───────────────────────────────────
    // Every wonPlayer counts for every week equally — no filtering by closedAt
    // or any acquisition timestamp. Players with no stats record during an
    // otherwise synced week are treated as 0 points (valid candidates).
    let owned = List.empty<OwnedPlayer>();
    for (wp in participant.wonPlayers.values()) {
      let points = switch (getStats(wp.playerId, season, week)) {
        case (?s) AuctionLib.calculatePlayerPoints(s, format);
        case null 0.0;
      };
      owned.add({ playerId = wp.playerId; position = wp.position; points });
    };
    let ownedArr = owned.toArray();
    // Deterministic processing order for the search.
    let sorted = ownedArr.sort(func(a, b) = Text.compare(a.playerId, b.playerId));

    // ── Exhaustive search over the small candidate set ───────────────────────
    // Backtracking over players: each player is either benched or assigned to
    // exactly one eligible slot category with remaining capacity. This finds the
    // globally highest-scoring valid combination across all required, FLEX, and
    // SUPERFLEX slots simultaneously (not a fixed greedy fill), and never
    // double-counts a player. Required slots may be left empty (0 points).
    var bestTotal : ?Float = null;
    var bestAssign : [SlotAssign] = [];

    func recordLeaf(total : Float, assign : List.List<SlotAssign>) {
      let cand = { total; assign = assign.toArray() };
      switch (bestTotal) {
        case null {
          bestTotal := ?total;
          bestAssign := cand.assign;
        };
        case (?bt) {
          if (total > bt or (total == bt and better(cand.assign, bestAssign))) {
            bestTotal := ?total;
            bestAssign := cand.assign;
          };
        };
      };
    };

    func search(
      i : Nat,
      qbR : Nat, rbR : Nat, wrR : Nat, teR : Nat, flexR : Nat, sfR : Nat,
      total : Float,
      assign : List.List<SlotAssign>,
    ) {
      if (qbR == 0 and rbR == 0 and wrR == 0 and teR == 0 and flexR == 0 and sfR == 0) {
        // All slots filled — remaining players are all benched. Record the leaf.
        recordLeaf(total, assign);
      } else if (i == sorted.size()) {
        // No more players but slots remain — record the leaf (empty slots).
        recordLeaf(total, assign);
      } else {
        let p = sorted[i];
        // Option 1: bench this player.
        search(i + 1, qbR, rbR, wrR, teR, flexR, sfR, total, assign);
        // Option 2: assign to an eligible category with remaining capacity.
        // Each branch gets its own cloned list so backtracking is safe.
        if (p.position == "QB" and qbR > 0) {
          let next = assign.clone();
          next.add({ category = "QB"; playerId = p.playerId });
          search(i + 1, qbR - 1, rbR, wrR, teR, flexR, sfR, total + p.points, next);
        };
        if (p.position == "RB" and rbR > 0) {
          let next = assign.clone();
          next.add({ category = "RB"; playerId = p.playerId });
          search(i + 1, qbR, rbR - 1, wrR, teR, flexR, sfR, total + p.points, next);
        };
        if (p.position == "WR" and wrR > 0) {
          let next = assign.clone();
          next.add({ category = "WR"; playerId = p.playerId });
          search(i + 1, qbR, rbR, wrR - 1, teR, flexR, sfR, total + p.points, next);
        };
        if (p.position == "TE" and teR > 0) {
          let next = assign.clone();
          next.add({ category = "TE"; playerId = p.playerId });
          search(i + 1, qbR, rbR, wrR, teR - 1, flexR, sfR, total + p.points, next);
        };
        if (isIn(p.position, roster.flexPositions) and flexR > 0) {
          let next = assign.clone();
          next.add({ category = "FLEX"; playerId = p.playerId });
          search(i + 1, qbR, rbR, wrR, teR, flexR - 1, sfR, total + p.points, next);
        };
        if (isIn(p.position, roster.superflexPositions) and sfR > 0) {
          let next = assign.clone();
          next.add({ category = "SUPERFLEX"; playerId = p.playerId });
          search(i + 1, qbR, rbR, wrR, teR, flexR, sfR - 1, total + p.points, next);
        };
      };
    };

    search(0, roster.qb, roster.rb, roster.wr, roster.te, roster.flex, roster.superflex, 0.0, List.empty());

    let total = bestTotal ?? 0.0;
    let assign = bestAssign;

    // ── Build starters in fixed slot order ───────────────────────────────────
    let byId = Map.empty<Text, OwnedPlayer>();
    for (p in ownedArr.values()) { byId.add(p.playerId, p); };

    let starters = List.empty<LineupSlot>();
    func addSlots(cat : Text, count : Nat, ids : [Text]) {
      var i = 0;
      while (i < count) {
        if (i < ids.size()) {
          let id = ids[i];
          let p = byId.get(id) ?? Runtime.trap("lineup: missing owned player " # id);
          starters.add({ playerId = ?id; position = p.position; points = p.points; slot = cat });
        } else {
          starters.add({ playerId = null; position = ""; points = 0.0; slot = cat });
        };
        i += 1;
      };
    };
    addSlots("QB", roster.qb, categoryIds("QB", assign));
    addSlots("RB", roster.rb, categoryIds("RB", assign));
    addSlots("WR", roster.wr, categoryIds("WR", assign));
    addSlots("TE", roster.te, categoryIds("TE", assign));
    addSlots("FLEX", roster.flex, categoryIds("FLEX", assign));
    addSlots("SUPERFLEX", roster.superflex, categoryIds("SUPERFLEX", assign));

    // ── Build bench: all owned non-starters ──────────────────────────────────
    let starterSet = Map.empty<Text, ()>();
    for (s in assign.values()) { starterSet.add(s.playerId, ()); };
    let bench = List.empty<LineupBenchEntry>();
    for (p in ownedArr.values()) {
      if (starterSet.get(p.playerId) == null) {
        bench.add({ playerId = p.playerId; points = p.points });
      };
    };

    {
      starters = starters.toArray();
      bench = bench.toArray();
      total;
    };
  };

  /// Public entry point. Currently delegates to the exhaustive optimizer; the
  /// DP variant is not yet wired into any production call site.
  public func calculateOptimalWeeklyLineup(
    room : Types.Room,
    participant : Types.Participant,
    week : Nat,
    getStats : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats,
  ) : LineupResult {
    calculateOptimalWeeklyLineupExhaustive(room, participant, week, getStats);
  };

  /// Memoized top-down DP variant of the weekly lineup optimizer.
  ///
  /// Same inputs and LineupResult-shaped output as
  /// calculateOptimalWeeklyLineupExhaustive, but replaces the brute-force
  /// backtracking with a memoized top-down DP over the state
  /// (i, qbR, rbR, wrR, teR, flexR, sfR) = current player index and remaining
  /// slot capacities. The cache stores the best achievable suffix total plus
  /// the suffix's own per-category assignment. Because players are processed in
  /// ascending playerId order, every prefix-assigned id is <= every
  /// suffix-assigned id within a category, so two full assignments sharing the
  /// same prefix compare (via better()) by their suffix contributions alone —
  /// memoizing the best suffix per state is provably equivalent to the full
  /// exhaustive search.
  ///
  /// This is a NEW function, reachable only for testing in this phase; it is
  /// not wired into any production call site.
  public func calculateOptimalWeeklyLineupDP(
    room : Types.Room,
    participant : Types.Participant,
    week : Nat,
    getStats : (Text, Nat, Nat) -> ?Types.WeeklyPlayerStats,
  ) : LineupResult {
    let roster = switch (room.rosterSettings) {
      case (?r) r;
      case null AuctionLib.defaultRosterSettings();
    };
    let format = room.scoringFormat;
    let season = room.season;

    // ── Synced-week check ────────────────────────────────────────────────────
    // Identical to the exhaustive version: a week is "synced" when at least one
    // WeeklyPlayerStats record exists for this season+week across all owned
    // players. If none exist at all, return an empty lineup.
    var synced = false;
    for (wp in participant.wonPlayers.values()) {
      if (getStats(wp.playerId, season, week) != null) { synced := true };
    };
    if (not synced) {
      return { starters = []; bench = []; total = 0.0 };
    };

    // ── Owned players with computed points ───────────────────────────────────
    // Identical to the exhaustive version: every wonPlayer counts for every
    // week equally; players with no stats record during an otherwise synced
    // week are treated as 0 points (valid candidates).
    let owned = List.empty<OwnedPlayer>();
    for (wp in participant.wonPlayers.values()) {
      let points = switch (getStats(wp.playerId, season, week)) {
        case (?s) AuctionLib.calculatePlayerPoints(s, format);
        case null 0.0;
      };
      owned.add({ playerId = wp.playerId; position = wp.position; points });
    };
    let ownedArr = owned.toArray();
    // Deterministic processing order for the search (ascending playerId).
    let sorted = ownedArr.sort(func(a, b) = Text.compare(a.playerId, b.playerId));

    // ── Memoized top-down DP ─────────────────────────────────────────────────
    type DpResult = { total : Float; assign : [SlotAssign] };
    let memo = Map.empty<Text, DpResult>();

    func dpKey(i : Nat, qbR : Nat, rbR : Nat, wrR : Nat, teR : Nat, flexR : Nat, sfR : Nat) : Text {
      i.toText() # "|" # qbR.toText() # "|" # rbR.toText() # "|" # wrR.toText() # "|" # teR.toText() # "|" # flexR.toText() # "|" # sfR.toText();
    };

    func dp(i : Nat, qbR : Nat, rbR : Nat, wrR : Nat, teR : Nat, flexR : Nat, sfR : Nat) : DpResult {
      let k = dpKey(i, qbR, rbR, wrR, teR, flexR, sfR);
      switch (memo.get(k)) {
        case (?r) r;
        case null {
          let result = if (qbR == 0 and rbR == 0 and wrR == 0 and teR == 0 and flexR == 0 and sfR == 0) {
            // All slots filled — remaining players are all benched.
            { total = 0.0; assign = [] };
          } else if (i == sorted.size()) {
            // No more players but slots remain — empty slots.
            { total = 0.0; assign = [] };
          } else {
            let p = sorted[i];
            // Option 1: bench this player.
            var best = dp(i + 1, qbR, rbR, wrR, teR, flexR, sfR);
            // Option 2: assign to an eligible category with remaining capacity.
            // Each candidate is the current player plus the best suffix; the
            // suffix-scoped better() tie-break is equivalent to the exhaustive
            // full-assignment comparison because the prefix is shared.
            if (p.position == "QB" and qbR > 0) {
              let sub = dp(i + 1, qbR - 1, rbR, wrR, teR, flexR, sfR);
              let cand = { total = p.points + sub.total; assign = [{ category = "QB"; playerId = p.playerId }].concat(sub.assign) };
              if (cand.total > best.total or (cand.total == best.total and better(cand.assign, best.assign))) {
                best := cand;
              };
            };
            if (p.position == "RB" and rbR > 0) {
              let sub = dp(i + 1, qbR, rbR - 1, wrR, teR, flexR, sfR);
              let cand = { total = p.points + sub.total; assign = [{ category = "RB"; playerId = p.playerId }].concat(sub.assign) };
              if (cand.total > best.total or (cand.total == best.total and better(cand.assign, best.assign))) {
                best := cand;
              };
            };
            if (p.position == "WR" and wrR > 0) {
              let sub = dp(i + 1, qbR, rbR, wrR - 1, teR, flexR, sfR);
              let cand = { total = p.points + sub.total; assign = [{ category = "WR"; playerId = p.playerId }].concat(sub.assign) };
              if (cand.total > best.total or (cand.total == best.total and better(cand.assign, best.assign))) {
                best := cand;
              };
            };
            if (p.position == "TE" and teR > 0) {
              let sub = dp(i + 1, qbR, rbR, wrR, teR - 1, flexR, sfR);
              let cand = { total = p.points + sub.total; assign = [{ category = "TE"; playerId = p.playerId }].concat(sub.assign) };
              if (cand.total > best.total or (cand.total == best.total and better(cand.assign, best.assign))) {
                best := cand;
              };
            };
            if (isIn(p.position, roster.flexPositions) and flexR > 0) {
              let sub = dp(i + 1, qbR, rbR, wrR, teR, flexR - 1, sfR);
              let cand = { total = p.points + sub.total; assign = [{ category = "FLEX"; playerId = p.playerId }].concat(sub.assign) };
              if (cand.total > best.total or (cand.total == best.total and better(cand.assign, best.assign))) {
                best := cand;
              };
            };
            if (isIn(p.position, roster.superflexPositions) and sfR > 0) {
              let sub = dp(i + 1, qbR, rbR, wrR, teR, flexR, sfR - 1);
              let cand = { total = p.points + sub.total; assign = [{ category = "SUPERFLEX"; playerId = p.playerId }].concat(sub.assign) };
              if (cand.total > best.total or (cand.total == best.total and better(cand.assign, best.assign))) {
                best := cand;
              };
            };
            best;
          };
          memo.add(k, result);
          result;
        };
      };
    };

    let best = dp(0, roster.qb, roster.rb, roster.wr, roster.te, roster.flex, roster.superflex);
    let total = best.total;
    let assign = best.assign;

    // ── Build starters in fixed slot order ───────────────────────────────────
    let byId = Map.empty<Text, OwnedPlayer>();
    for (p in ownedArr.values()) { byId.add(p.playerId, p); };

    let starters = List.empty<LineupSlot>();
    func addSlots(cat : Text, count : Nat, ids : [Text]) {
      var i = 0;
      while (i < count) {
        if (i < ids.size()) {
          let id = ids[i];
          let p = byId.get(id) ?? Runtime.trap("lineup: missing owned player " # id);
          starters.add({ playerId = ?id; position = p.position; points = p.points; slot = cat });
        } else {
          starters.add({ playerId = null; position = ""; points = 0.0; slot = cat });
        };
        i += 1;
      };
    };
    addSlots("QB", roster.qb, categoryIds("QB", assign));
    addSlots("RB", roster.rb, categoryIds("RB", assign));
    addSlots("WR", roster.wr, categoryIds("WR", assign));
    addSlots("TE", roster.te, categoryIds("TE", assign));
    addSlots("FLEX", roster.flex, categoryIds("FLEX", assign));
    addSlots("SUPERFLEX", roster.superflex, categoryIds("SUPERFLEX", assign));

    // ── Build bench: all owned non-starters ──────────────────────────────────
    let starterSet = Map.empty<Text, ()>();
    for (s in assign.values()) { starterSet.add(s.playerId, ()); };
    let bench = List.empty<LineupBenchEntry>();
    for (p in ownedArr.values()) {
      if (starterSet.get(p.playerId) == null) {
        bench.add({ playerId = p.playerId; points = p.points });
      };
    };

    {
      starters = starters.toArray();
      bench = bench.toArray();
      total;
    };
  };
};
