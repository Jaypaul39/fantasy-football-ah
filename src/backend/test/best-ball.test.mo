import Types "../types/auction-types";
import SyncStatusTypes "../types/sync-status";
import SyncStatusLib "../lib/sync-status";
import AuctionLib "../lib/auction-types";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import BestBallCachingTypes "../types/best-ball-caching";
import BestBallApi "../mixins/best-ball-api";
import AuctionMixin "../mixins/auction-types-api";
import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";

// Phase 4 — Best Ball weekly lineup + cumulative standings read API tests.
//
// Runs via `mops test` (replica mode) from the app root. This file is an
// unnamed `actor { ... }` with a `public func runTests() : async ()`, which is
// the mops replica-test convention: mops deploys the actor and calls runTests.
//
// It instantiates the Phase 4 mixin (mixins/best-ball-api.mo) with the same
// state shape main.mo wires (rooms, participants, bestBallConfigs, and a
// calculateOptimalWeeklyLineup closure that delegates to the Phase 3
// lib/lineup.mo calculator). Every public method under test is a `shared query`
// whose `caller` is the actor's own principal for a self-call, so the access
// guard (AuctionLib.isParticipant) is exercised by controlling whether that
// principal is a participant of each room.
//
// The lineup/standings computation is verified against the Phase 3 calculator
// directly, proving the APIs reuse it as the single source of truth rather than
// duplicating scoring/lineup logic.

actor {
  // ── State (mirrors main.mo's wiring for the Best Ball mixin) ─────────────
  let season = 2025;
  let rooms = Map.empty<Types.RoomId, Types.Room>();
  let participants = Map.empty<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>();
  let bestBallConfigs = Map.empty<Types.RoomId, Types.BestBallConfig>();
  let stats = Map.empty<Text, Types.WeeklyPlayerStats>();
  let syncStatuses = Map.empty<Text, SyncStatusTypes.SyncStatusRecord>();
  let scores = Map.empty<Text, Float>();

  // The caller for every mixin call made from within this actor. Computed once
  // at the start of runTests via a self-call; the same principal is what the
  // mixin's shared query methods observe as `caller`.
  var me : Types.UserId = Principal.anonymous();
  // Distinct, valid principals for the other participants. fromBlob always
  // yields a valid principal (no text-checksum pitfalls).
  let otherP = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\01");
  let thirdP = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\02");

  // The Phase 3 calculator closure, wired exactly as main.mo wires it.
  func calculateOptimalWeeklyLineup(
    room : Types.Room,
    participant : Types.Participant,
    week : Nat,
  ) : LineupLib.LineupResult {
    LineupLib.calculateOptimalWeeklyLineup(
      room,
      participant,
      week,
      func(playerId : Text, s : Nat, w : Nat) : ?Types.WeeklyPlayerStats {
        stats.get(playerId # "|" # s.toText() # "|" # w.toText());
      },
    );
  };

  include BestBallApi(rooms, participants, bestBallConfigs, syncStatuses, scores, calculateOptimalWeeklyLineup);

  // ── AuctionMixin state (for Best Ball lifecycle guardrail tests) ──────────
  // The lifecycle methods under test (endAuction with its gameType-aware
  // startWeek validation, and the roster-lock invariant via finalizeNomination)
  // live in mixins/auction-types-api.mo. Instantiating that mixin requires the
  // full state shape main.mo wires. The rooms/participants/bestBallConfigs
  // bindings are SHARED with BestBallApi above (same bindings), so both mixins
  // observe the same state. `stats` is passed as the weeklyPlayerStats map.
  let nominations = Map.empty<Types.NominationId, Types.Nomination>();
  let nominationsByRoom = Map.empty<Types.RoomId, [Types.NominationId]>();
  let bids = Map.empty<Types.RoomId, Map.Map<Types.NominationId, List.List<Types.Bid>>>();
  let proxyBids = Map.empty<Types.RoomId, Map.Map<Types.NominationId, Map.Map<Types.UserId, Types.ProxyBid>>>();
  let nominatedByRoom = Map.empty<Types.RoomId, Set.Set<Text>>();
  let draftedPlayerIds = Map.empty<Types.RoomId, Set.Set<Text>>();
  let players = Map.empty<Text, Types.Player>();
  let profiles = Map.empty<Types.UserId, Types.UserProfile>();
  let userRooms = Map.empty<Types.UserId, List.List<Types.RoomId>>();
  let nominationHistory = Map.empty<Types.RoomId, Map.Map<Types.NominationId, List.List<Types.BidHistoryEvent>>>();
  let roomMessages = Map.empty<Types.RoomId, List.List<Types.ChatMessage>>();
  let adminPrincipalStore = Map.empty<Text, Types.UserId>();
  let activeAdpDataset = Map.empty<Text, Types.ADPDataset>();
  let nominationQueue = Map.empty<Text, Text>();
  let giphyApiKeyStore = Map.empty<Text, Text>();
  let oneSignalApiKeyStore = Map.empty<Text, Text>();
  let oneSignalPlayerIds = Map.empty<Text, Text>();
  let roomIdState = { var next = 1 };
  let nextMsgIdState = { var next = 1 };
  let nextNominationIdState = { var next = 1 };
  func getOrCreateBids(roomId : Types.RoomId) : Map.Map<Types.NominationId, List.List<Types.Bid>> {
    switch (bids.get(roomId)) {
      case (?m) m;
      case null {
        let m = Map.empty<Types.NominationId, List.List<Types.Bid>>();
        bids.add(roomId, m);
        m;
      };
    };
  };
  func getOrCreateProxyBids(roomId : Types.RoomId) : Map.Map<Types.NominationId, Map.Map<Types.UserId, Types.ProxyBid>> {
    switch (proxyBids.get(roomId)) {
      case (?m) m;
      case null {
        let m = Map.empty<Types.NominationId, Map.Map<Types.UserId, Types.ProxyBid>>();
        proxyBids.add(roomId, m);
        m;
      };
    };
  };
  func getOrCreateNominationHistory(roomId : Types.RoomId) : Map.Map<Types.NominationId, List.List<Types.BidHistoryEvent>> {
    switch (nominationHistory.get(roomId)) {
      case (?m) m;
      case null {
        let m = Map.empty<Types.NominationId, List.List<Types.BidHistoryEvent>>();
        nominationHistory.add(roomId, m);
        m;
      };
    };
  };
  let rssCacheContent = { var content = null : ?Text };
  let rssCacheTimestamp = { var timestamp = 0 };
  let rssFeedUrlsStore = Map.empty<Text, [Text]>();
  let rssRefreshIntervalSecs = { var seconds = 900 };
  let lastRssFetchStatus = { var status = [] : [(Text, Bool)] };
  let activeRoomIds = Set.empty<Types.RoomId>();
  let playerPriceHistory = Map.empty<Text, List.List<Types.PlayerPriceRecord>>();
  let notificationQueue = List.empty<Types.PendingNotification>();
  let nextNotificationId = { var next = 1 };
  let byeWeeksStore = Map.empty<Text, [(Text, Nat)]>();
  let notificationsQueuedTotal = { var count = 0 };
  let notificationsProcessedTotal = { var count = 0 };
  let notificationsSentTotal = { var count = 0 };
  let notificationsExpiredTotal = { var count = 0 };
  let notificationsRetriedTotal = { var count = 0 };
  let notificationsFailedTotal = { var count = 0 };
  let notificationWorkerEntryCount = { var count = 0 };
  let lastNotificationWorkerStartedAt = { var value = 0 : Int };
  let lastNotificationWorkerCompletedAt = { var value = 0 : Int };
  let lastNotificationWorkerError = { var error = null : ?Text };
  let processingNotifications = { var value = false };

  // The automatic finalization trigger closure, wired exactly as main.mo wires
  // it: finalizes every earlier #partial week in the season when a new week is
  // synced.
  func finalizePriorPartialWeeks(season : Nat, week : Nat) : Nat {
    BestBallCachingLib.finalizePriorPartialWeeks(
      rooms, participants, bestBallConfigs, syncStatuses, scores,
      calculateOptimalWeeklyLineup, season, week,
    );
  };

  include AuctionMixin(
    rooms, participants, nominations, nominationsByRoom, bids, proxyBids,
    nominatedByRoom, draftedPlayerIds, players, profiles, userRooms,
    nominationHistory, roomMessages, adminPrincipalStore, activeAdpDataset,
    nominationQueue, giphyApiKeyStore, oneSignalApiKeyStore, oneSignalPlayerIds,
    roomIdState, nextMsgIdState, nextNominationIdState, getOrCreateBids,
    getOrCreateProxyBids, getOrCreateNominationHistory, rssCacheContent,
    rssCacheTimestamp, rssFeedUrlsStore, rssRefreshIntervalSecs,
    lastRssFetchStatus, activeRoomIds, playerPriceHistory, notificationQueue,
    nextNotificationId, byeWeeksStore, notificationsQueuedTotal,
    notificationsProcessedTotal, notificationsSentTotal,
    notificationsExpiredTotal, notificationsRetriedTotal,
    notificationsFailedTotal, notificationWorkerEntryCount,
    lastNotificationWorkerStartedAt, lastNotificationWorkerCompletedAt,
    lastNotificationWorkerError, processingNotifications, bestBallConfigs, stats,
    syncStatuses, finalizePriorPartialWeeks,
  );

  // The mixin's public types (WeeklyLineupView, StandingsEntry) are brought
  // into scope by the include above; the helpers below reference them directly.

  // ── Test harness ──────────────────────────────────────────────────────────
  var failures = 0;
  var firstFailure : ?Text = null;

  func check(name : Text, cond : Bool) {
    if (cond) {
      Debug.print("PASS: " # name);
    } else {
      Debug.print("FAIL: " # name);
      failures += 1;
      if (firstFailure == null) { firstFailure := ?name };
    };
  };

  func approxEq(a : Float, b : Float) : Bool {
    let diff = a - b;
    diff < 0.0001 and diff > -0.0001;
  };

  // ── Fixture builders ──────────────────────────────────────────────────────
  func makeRoom(id : Text, roster : Types.RosterSettings, format : Types.ScoringFormat, participants : [Types.UserId]) : Types.Room {
    {
      id;
      name = "Test Room";
      admin = me;
      participants;
      state = #Completed;
      gameType = #BestBall;
      competitionMode = #Cumulative;
      playoffTeams = 0;
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
      nominatedBy = me;
      closedAt = 0;
      byeWeek = null;
    };
  };

  func makeParticipant(userId : Types.UserId, displayName : Text, wonPlayers : [Types.WonPlayer]) : Types.Participant {
    {
      userId;
      displayName;
      budget = 200;
      spent = 0;
      committed = [];
      wonPlayers;
      skipNominationTurn = false;
    };
  };

  // Build raw stats that produce `pts` points under #halfPpr (rushYdPoints = 0.1),
  // by encoding the points as rush yards (rushYds = pts * 10).
  func ptsStats(playerId : Text, w : Nat, pts : Float) : Types.WeeklyPlayerStats {
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

  func addStats(s : Types.WeeklyPlayerStats) {
    stats.add(s.playerId # "|" # s.season.toText() # "|" # s.week.toText(), s);
  };

  // The stats map is shared across tests; player IDs repeat between scenarios,
  // so each test clears it first to avoid cross-test contamination.
  func clearStats() {
    stats.clear();
  };

  // Under the caching model, getStandings/getWeeklyStandings only score a week
  // that is #finalized (read from the cache) or #partial (live, computed
  // dynamically). Mark the given weeks as #partial so they are computed
  // dynamically from the injected stats, preserving each test's original
  // assertions about final values. Clears any prior sync status first to avoid
  // cross-test contamination.
  func markLive(weeks : [Nat]) {
    syncStatuses.clear();
    for (w in weeks.values()) {
      ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, w, #partial, null, ?0);
    };
  };

  func registerRoom(room : Types.Room, pm : [(Types.UserId, Types.Participant)], cfg : ?Types.BestBallConfig) {
    rooms.add(room.id, room);
    let inner = Map.empty<Types.UserId, Types.Participant>();
    for ((uid, p) in pm.values()) { inner.add(uid, p); };
    participants.add(room.id, inner);
    switch (cfg) {
      case (?c) bestBallConfigs.add(room.id, c);
      case null {};
    };
  };

  func viewMatchesLineup(v : WeeklyLineupView, res : LineupLib.LineupResult) : Bool {
    if (not approxEq(v.total, res.total)) return false;
    if (v.starters.size() != res.starters.size()) return false;
    if (v.bench.size() != res.bench.size()) return false;
    var i = 0;
    while (i < v.starters.size()) {
      if (v.starters[i].playerId != res.starters[i].playerId) return false;
      if (v.starters[i].slot != res.starters[i].slot) return false;
      i += 1;
    };
    var j = 0;
    while (j < v.bench.size()) {
      if (v.bench[j].playerId != res.bench[j].playerId) return false;
      j += 1;
    };
    true;
  };

  func flexStarter(v : WeeklyLineupView) : ?Text {
    switch (v.starters.find(func s = s.slot == "FLEX")) {
      case (?s) s.playerId;
      case null null;
    };
  };

  func findStanding(entries : [StandingsEntry], uid : Types.UserId) : ?StandingsEntry {
    entries.find(func e = e.participantId == uid);
  };

  // ── getWeeklyLineup tests ─────────────────────────────────────────────────

  // 1. Valid Best Ball room/participant/week returns the correct Phase 3 lineup.
  func testWeeklyLineupValid() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("r1", roster, #halfPpr, [me, otherP]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9006", "RB"),
      won("9003", "WR"), won("9007", "WR"), won("9004", "TE"), won("9011", "WR"),
    ]);
    let pOther = makeParticipant(otherP, "Other", []);
    registerRoom(room, [(me, pMe), (otherP, pOther)], ?{ startWeek = 1 });

    addStats(ptsStats("9001", 1, 10.0));
    addStats(ptsStats("9002", 1, 15.0));
    addStats(ptsStats("9006", 1, 12.0));
    addStats(ptsStats("9003", 1, 18.0));
    addStats(ptsStats("9007", 1, 14.0));
    addStats(ptsStats("9004", 1, 9.0));
    addStats(ptsStats("9011", 1, 20.0));

    let res = await getWeeklyLineup("r1", me, 1);
    switch (res) {
      case (#err e) check("WL1: valid returns ok (got err " # e # ")", false);
      case (#ok v) {
        check("WL1: roomId", v.roomId == "r1");
        check("WL1: participantId", v.participantId == me);
        check("WL1: displayName", v.displayName == "Me");
        check("WL1: week", v.week == 1);
        check("WL1: total 98", approxEq(v.total, 98.0));
        check("WL1: QB1 in QB", v.starters[0].playerId == ?"9001");
        check("WL1: WR3 in FLEX", v.starters[6].playerId == ?"9011");
        // The returned lineup must equal the Phase 3 calculator's result.
        let expected = LineupLib.calculateOptimalWeeklyLineup(room, pMe, 1, func(playerId : Text, s : Nat, w : Nat) : ?Types.WeeklyPlayerStats {
          stats.get(playerId # "|" # s.toText() # "|" # w.toText());
        });
        check("WL1: matches Phase 3 result", viewMatchesLineup(v, expected));
      };
    };
  };

  // 2. Unsynced week returns an empty lineup with total 0 (not an error).
  func testWeeklyLineupUnsynced() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("r2", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });

    // Week 1 synced; week 5 has no stats at all.
    addStats(ptsStats("9001", 1, 10.0));
    addStats(ptsStats("9002", 1, 5.0));
    addStats(ptsStats("9003", 1, 5.0));
    addStats(ptsStats("9004", 1, 3.0));

    let res = await getWeeklyLineup("r2", me, 5);
    switch (res) {
      case (#err e) check("WL2: unsynced returns ok (got err " # e # ")", false);
      case (#ok v) {
        check("WL2: empty starters", v.starters.size() == 0);
        check("WL2: empty bench", v.bench.size() == 0);
        check("WL2: total 0", approxEq(v.total, 0.0));
      };
    };
  };

  // 3. Missing player stats follow Phase 3 zero-point behavior: the player
  //    stays owned and appears on the bench contributing 0.
  func testWeeklyLineupMissingStats() : async () {
    clearStats();
    // Small roster (4 slots) with one extra owned player, so the missing-stats
    // player has a bench spot to land on rather than being forced into FLEX.
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("r3", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE"), won("9007", "WR"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });

    // WR2 has NO stats record this week (week is still synced via QB1).
    addStats(ptsStats("9001", 1, 10.0));
    addStats(ptsStats("9002", 1, 15.0));
    addStats(ptsStats("9003", 1, 18.0));
    addStats(ptsStats("9004", 1, 9.0));

    let res = await getWeeklyLineup("r3", me, 1);
    switch (res) {
      case (#err e) check("WL3: missing stats returns ok (got err " # e # ")", false);
      case (#ok v) {
        // WR2 (0 points) is benched; the 4 required slots are filled by the
        // players with stats (QB1+RB1+WR1+TE1 = 52).
        check("WL3: total 52", approxEq(v.total, 52.0));
        let benchWr2 = v.bench.find(func b = b.playerId == "9007");
        check("WL3: WR2 stays owned on bench", benchWr2 != null);
        switch (benchWr2) {
          case (?b) check("WL3: WR2 contributes 0", approxEq(b.points, 0.0));
          case null {};
        };
      };
    };
  };

  // 4. Room access/privacy is enforced: a caller who is not a participant of
  //    the room cannot retrieve its lineup data.
  func testWeeklyLineupAccessDenied() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    // Room participants do NOT include the caller (me).
    let room = makeRoom("r4", roster, #halfPpr, [otherP]);
    let pOther = makeParticipant(otherP, "Other", [
      won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE"),
    ]);
    registerRoom(room, [(otherP, pOther)], ?{ startWeek = 1 });
    addStats(ptsStats("9001", 1, 10.0));

    let res = await getWeeklyLineup("r4", otherP, 1);
    switch (res) {
      case (#ok _) check("WL4: non-participant denied", false);
      case (#err e) check("WL4: non-participant denied", e == "Not a participant in this room");
    };
  };

  // 5. Non-Best-Ball room is rejected.
  func testWeeklyLineupNonBestBall() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    // A non-Best-Ball room: gameType == #Auction (never converted), no config.
    let room = makeLifecycleRoom("r5", #Completed, #Auction, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoom(room, [(me, pMe)], null);

    let res = await getWeeklyLineup("r5", me, 1);
    switch (res) {
      case (#ok _) check("WL5: non-Best-Ball rejected", false);
      case (#err e) check("WL5: non-Best-Ball rejected", e == "Room is not a Best Ball room");
    };
  };

  // ── getStandings tests ────────────────────────────────────────────────────

  // 6. Multiple participants, multiple weeks, correct cumulative totals.
  func testStandingsMultiple() : async () {
    clearStats();
    markLive([1, 2]);
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("s1", roster, #halfPpr, [me, otherP]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9006", "RB"),
      won("9003", "WR"), won("9007", "WR"), won("9004", "TE"),
    ]);
    let pOther = makeParticipant(otherP, "Other", [
      won("9005", "QB"), won("9010", "RB"), won("9013", "RB"),
      won("9011", "WR"), won("9014", "WR"), won("9008", "TE"),
    ]);
    registerRoom(room, [(me, pMe), (otherP, pOther)], ?{ startWeek = 1 });

    // Me: 78 per week → 156 cumulative.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9001", 2, 10.0));
    addStats(ptsStats("9002", 1, 15.0)); addStats(ptsStats("9002", 2, 15.0));
    addStats(ptsStats("9006", 1, 12.0)); addStats(ptsStats("9006", 2, 12.0));
    addStats(ptsStats("9003", 1, 18.0)); addStats(ptsStats("9003", 2, 18.0));
    addStats(ptsStats("9007", 1, 14.0)); addStats(ptsStats("9007", 2, 14.0));
    addStats(ptsStats("9004", 1, 9.0));  addStats(ptsStats("9004", 2, 9.0));
    // Other: 59 per week → 118 cumulative.
    addStats(ptsStats("9005", 1, 8.0));  addStats(ptsStats("9005", 2, 8.0));
    addStats(ptsStats("9010", 1, 10.0)); addStats(ptsStats("9010", 2, 10.0));
    addStats(ptsStats("9013", 1, 10.0)); addStats(ptsStats("9013", 2, 10.0));
    addStats(ptsStats("9011", 1, 12.0)); addStats(ptsStats("9011", 2, 12.0));
    addStats(ptsStats("9014", 1, 12.0)); addStats(ptsStats("9014", 2, 12.0));
    addStats(ptsStats("9008", 1, 7.0));  addStats(ptsStats("9008", 2, 7.0));

    let res = await getStandings("s1");
    switch (res) {
      case (#err e) check("S1: standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        check("S1: two entries", entries.size() == 2);
        // Deterministic order: descending points → Me(156) first, Other(118) second.
        check("S1: rank 1 is Me", entries[0].participantId == me);
        check("S1: rank 2 is Other", entries[1].participantId == otherP);
        switch (findStanding(entries, me)) {
          case (?e) check("S1: Me cumulative 156", approxEq(e.totalPoints, 156.0));
          case null check("S1: Me present", false);
        };
        switch (findStanding(entries, otherP)) {
          case (?e) check("S1: Other cumulative 118", approxEq(e.totalPoints, 118.0));
          case null check("S1: Other present", false);
        };
        // Standings reuse the Phase 3 calculator: cumulative equals the sum of
        // direct calculateOptimalWeeklyLineup calls across the applicable weeks.
        let expectedMe = LineupLib.calculateOptimalWeeklyLineup(room, pMe, 1, func(playerId : Text, s : Nat, w : Nat) : ?Types.WeeklyPlayerStats {
          stats.get(playerId # "|" # s.toText() # "|" # w.toText());
        }).total
          + LineupLib.calculateOptimalWeeklyLineup(room, pMe, 2, func(playerId : Text, s : Nat, w : Nat) : ?Types.WeeklyPlayerStats {
            stats.get(playerId # "|" # s.toText() # "|" # w.toText());
          }).total;
        switch (findStanding(entries, me)) {
          case (?e) check("S1: Me matches Phase 3 sum", approxEq(e.totalPoints, expectedMe));
          case null {};
        };
      };
    };
  };

  // 7. Unsynced weeks contribute 0 without failing the calculation.
  func testStandingsUnsyncedWeek() : async () {
    clearStats();
    markLive([1, 2]);
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("s2", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });

    // Weeks 1 and 2 synced (23 each); week 3 has no stats → contributes 0.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9001", 2, 10.0));
    addStats(ptsStats("9002", 1, 5.0));  addStats(ptsStats("9002", 2, 5.0));
    addStats(ptsStats("9003", 1, 5.0));  addStats(ptsStats("9003", 2, 5.0));
    addStats(ptsStats("9004", 1, 3.0));  addStats(ptsStats("9004", 2, 3.0));

    let res = await getStandings("s2");
    switch (res) {
      case (#err e) check("S2: standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        check("S2: one entry", entries.size() == 1);
        switch (findStanding(entries, me)) {
          case (?e) check("S2: cumulative 46 (unsynced week 3 = 0)", approxEq(e.totalPoints, 46.0));
          case null check("S2: Me present", false);
        };
      };
    };
  };

  // 8. Missing individual player stats contribute 0.
  func testStandingsMissingPlayerStats() : async () {
    clearStats();
    markLive([1]);
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("s3", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9006", "RB"),
      won("9003", "WR"), won("9007", "WR"), won("9004", "TE"), won("9011", "WR"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });

    // WR3 has no stats → 0 points, benched. Total = 78.
    addStats(ptsStats("9001", 1, 10.0));
    addStats(ptsStats("9002", 1, 15.0));
    addStats(ptsStats("9006", 1, 12.0));
    addStats(ptsStats("9003", 1, 18.0));
    addStats(ptsStats("9007", 1, 14.0));
    addStats(ptsStats("9004", 1, 9.0));

    let res = await getStandings("s3");
    switch (res) {
      case (#err e) check("S3: standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        switch (findStanding(entries, me)) {
          case (?e) check("S3: cumulative 78 (WR3 missing = 0)", approxEq(e.totalPoints, 78.0));
          case null check("S3: Me present", false);
        };
      };
    };
  };

  // 9. startWeek is respected (weeks before it are excluded).
  func testStandingsStartWeek() : async () {
    clearStats();
    markLive([2, 3]);
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("s4", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 2 });

    // Week 1 (23) must be EXCLUDED; weeks 2 and 3 (23 each) count → 46.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9001", 2, 10.0)); addStats(ptsStats("9001", 3, 10.0));
    addStats(ptsStats("9002", 1, 5.0));  addStats(ptsStats("9002", 2, 5.0));  addStats(ptsStats("9002", 3, 5.0));
    addStats(ptsStats("9003", 1, 5.0));  addStats(ptsStats("9003", 2, 5.0));  addStats(ptsStats("9003", 3, 5.0));
    addStats(ptsStats("9004", 1, 3.0));  addStats(ptsStats("9004", 2, 3.0));  addStats(ptsStats("9004", 3, 3.0));

    let res = await getStandings("s4");
    switch (res) {
      case (#err e) check("S4: standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        switch (findStanding(entries, me)) {
          case (?e) check("S4: cumulative 46 (week 1 excluded)", approxEq(e.totalPoints, 46.0));
          case null check("S4: Me present", false);
        };
      };
    };
  };

  // 10. The season runs from startWeek through FINAL_WEEK (17) — there is no
  //     stored end week. A week that would have been excluded by an old
  //     endWeek=2 (week 3) is now included because the season extends to
  //     FINAL_WEEK. Weeks 1, 2, and 3 (23 each) all count → 69.
  func testStandingsEndWeek() : async () {
    clearStats();
    markLive([1, 2, 3]);
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("s5", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });

    // Weeks 1, 2, and 3 (23 each) all count → 69. Weeks 4-17 have no stats → 0.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9001", 2, 10.0)); addStats(ptsStats("9001", 3, 10.0));
    addStats(ptsStats("9002", 1, 5.0));  addStats(ptsStats("9002", 2, 5.0));  addStats(ptsStats("9002", 3, 5.0));
    addStats(ptsStats("9003", 1, 5.0));  addStats(ptsStats("9003", 2, 5.0));  addStats(ptsStats("9003", 3, 5.0));
    addStats(ptsStats("9004", 1, 3.0));  addStats(ptsStats("9004", 2, 3.0));  addStats(ptsStats("9004", 3, 3.0));

    let res = await getStandings("s5");
    switch (res) {
      case (#err e) check("S5: standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        switch (findStanding(entries, me)) {
          case (?e) check("S5: cumulative 69 (weeks 1-3 counted, season runs to FINAL_WEEK)", approxEq(e.totalPoints, 69.0));
          case null check("S5: Me present", false);
        };
      };
    };
  };

  // 11. Deterministic tie-breaking: equal cumulative scores are ordered by the
  //     stable participant identifier (ascending), never by map iteration order.
  func testStandingsTieBreak() : async () {
    clearStats();
    markLive([1]);
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("s6", roster, #halfPpr, [me, otherP, thirdP]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    let pOther = makeParticipant(otherP, "Other", [won("9005", "QB"), won("9006", "RB"), won("9007", "WR"), won("9008", "TE")]);
    let pThird = makeParticipant(thirdP, "Third", [won("9009", "QB"), won("9010", "RB"), won("9011", "WR"), won("9012", "TE")]);
    registerRoom(room, [(me, pMe), (otherP, pOther), (thirdP, pThird)], ?{ startWeek = 1 });

    // All three participants score exactly 23 → all tie.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9002", 1, 5.0)); addStats(ptsStats("9003", 1, 5.0)); addStats(ptsStats("9004", 1, 3.0));
    addStats(ptsStats("9005", 1, 10.0)); addStats(ptsStats("9006", 1, 5.0)); addStats(ptsStats("9007", 1, 5.0)); addStats(ptsStats("9008", 1, 3.0));
    addStats(ptsStats("9009", 1, 10.0)); addStats(ptsStats("9010", 1, 5.0)); addStats(ptsStats("9011", 1, 5.0)); addStats(ptsStats("9012", 1, 3.0));

    let res = await getStandings("s6");
    switch (res) {
      case (#err e) check("S6: standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        check("S6: three entries", entries.size() == 3);
        // Every entry must have the same total (all tied).
        var allTied = true;
        for (e in entries.values()) {
          if (not approxEq(e.totalPoints, 23.0)) { allTied := false };
        };
        check("S6: all tied at 23", allTied);
        // Ordering must be ascending by participantId (Principal.compare).
        var sorted = true;
        var i = 0;
        while (i + 1 < entries.size()) {
          if (Principal.compare(entries[i].participantId, entries[i + 1].participantId) != #less) {
            sorted := false;
          };
          i += 1;
        };
        check("S6: deterministic ascending participantId order", sorted);
      };
    };
  };

  // 12. Non-Best-Ball room is rejected by getStandings.
  func testStandingsNonBestBall() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    // A non-Best-Ball room: gameType == #Auction (never converted), no config.
    let room = makeLifecycleRoom("s7", #Completed, #Auction, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoom(room, [(me, pMe)], null);

    let res = await getStandings("s7");
    switch (res) {
      case (#ok _) check("S7: non-Best-Ball rejected", false);
      case (#err e) check("S7: non-Best-Ball rejected", e == "Room is not a Best Ball room");
    };
  };

  // ── getWeeklyStandings tests (Phase 9) ────────────────────────────────────

  // 22. Correct single-week totals for a straightforward roster/week.
  func testWeeklyStandingsSingleWeek() : async () {
    clearStats();
    markLive([1]);
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("w1", roster, #halfPpr, [me, otherP]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9006", "RB"),
      won("9003", "WR"), won("9007", "WR"), won("9004", "TE"),
    ]);
    let pOther = makeParticipant(otherP, "Other", [
      won("9005", "QB"), won("9010", "RB"), won("9013", "RB"),
      won("9011", "WR"), won("9014", "WR"), won("9008", "TE"),
    ]);
    registerRoom(room, [(me, pMe), (otherP, pOther)], ?{ startWeek = 1 });

    // Week 1: Me = 78, Other = 59. Week 2: Me = 78, Other = 59.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9001", 2, 10.0));
    addStats(ptsStats("9002", 1, 15.0)); addStats(ptsStats("9002", 2, 15.0));
    addStats(ptsStats("9006", 1, 12.0)); addStats(ptsStats("9006", 2, 12.0));
    addStats(ptsStats("9003", 1, 18.0)); addStats(ptsStats("9003", 2, 18.0));
    addStats(ptsStats("9007", 1, 14.0)); addStats(ptsStats("9007", 2, 14.0));
    addStats(ptsStats("9004", 1, 9.0));  addStats(ptsStats("9004", 2, 9.0));
    addStats(ptsStats("9005", 1, 8.0));  addStats(ptsStats("9005", 2, 8.0));
    addStats(ptsStats("9010", 1, 10.0)); addStats(ptsStats("9010", 2, 10.0));
    addStats(ptsStats("9013", 1, 10.0)); addStats(ptsStats("9013", 2, 10.0));
    addStats(ptsStats("9011", 1, 12.0)); addStats(ptsStats("9011", 2, 12.0));
    addStats(ptsStats("9014", 1, 12.0)); addStats(ptsStats("9014", 2, 12.0));
    addStats(ptsStats("9008", 1, 7.0));  addStats(ptsStats("9008", 2, 7.0));

    // Week 1 standings: Me(78) first, Other(59) second.
    let res = await getWeeklyStandings("w1", 1);
    switch (res) {
      case (#err e) check("W1: weekly standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        check("W1: two entries", entries.size() == 2);
        check("W1: rank 1 is Me", entries[0].participantId == me);
        check("W1: rank 2 is Other", entries[1].participantId == otherP);
        switch (findStanding(entries, me)) {
          case (?e) check("W1: Me week1 78", approxEq(e.totalPoints, 78.0));
          case null check("W1: Me present", false);
        };
        switch (findStanding(entries, otherP)) {
          case (?e) check("W1: Other week1 59", approxEq(e.totalPoints, 59.0));
          case null check("W1: Other present", false);
        };
        // Single-week standings reuse the Phase 3 calculator: the entry equals
        // one direct calculateOptimalWeeklyLineup call for the requested week.
        let expectedMe = LineupLib.calculateOptimalWeeklyLineup(room, pMe, 1, func(playerId : Text, s : Nat, w : Nat) : ?Types.WeeklyPlayerStats {
          stats.get(playerId # "|" # s.toText() # "|" # w.toText());
        }).total;
        switch (findStanding(entries, me)) {
          case (?e) check("W1: Me matches Phase 3 single-week", approxEq(e.totalPoints, expectedMe));
          case null {};
        };
      };
    };
  };

  // 23. Deterministic ordering matches getStandings's comparator exactly:
  //     descending total, ascending participantId tie-break.
  func testWeeklyStandingsOrdering() : async () {
    clearStats();
    markLive([1]);
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("w2", roster, #halfPpr, [me, otherP, thirdP]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    let pOther = makeParticipant(otherP, "Other", [won("9005", "QB"), won("9006", "RB"), won("9007", "WR"), won("9008", "TE")]);
    let pThird = makeParticipant(thirdP, "Third", [won("9009", "QB"), won("9010", "RB"), won("9011", "WR"), won("9012", "TE")]);
    registerRoom(room, [(me, pMe), (otherP, pOther), (thirdP, pThird)], ?{ startWeek = 1 });

    // Distinct single-week scores: Me=30, Other=23, Third=23 (Other/Third tie).
    addStats(ptsStats("9001", 1, 12.0)); addStats(ptsStats("9002", 1, 8.0)); addStats(ptsStats("9003", 1, 7.0)); addStats(ptsStats("9004", 1, 3.0));
    addStats(ptsStats("9005", 1, 10.0)); addStats(ptsStats("9006", 1, 5.0)); addStats(ptsStats("9007", 1, 5.0)); addStats(ptsStats("9008", 1, 3.0));
    addStats(ptsStats("9009", 1, 10.0)); addStats(ptsStats("9010", 1, 5.0)); addStats(ptsStats("9011", 1, 5.0)); addStats(ptsStats("9012", 1, 3.0));

    let res = await getWeeklyStandings("w2", 1);
    switch (res) {
      case (#err e) check("W2: weekly standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        check("W2: three entries", entries.size() == 3);
        // Descending total: Me(30) first.
        check("W2: rank 1 is Me", entries[0].participantId == me);
        // The two tied at 23 must be ordered ascending by participantId.
        var sorted = true;
        var i = 0;
        while (i + 1 < entries.size()) {
          if (entries[i].totalPoints < entries[i + 1].totalPoints) { sorted := false };
          if (approxEq(entries[i].totalPoints, entries[i + 1].totalPoints)
              and Principal.compare(entries[i].participantId, entries[i + 1].participantId) != #less) {
            sorted := false;
          };
          i += 1;
        };
        check("W2: deterministic descending-total/ascending-id order", sorted);
      };
    };
  };

  // 24. Ties produce the same ordering behavior as getStandings (all tied →
  //     ascending participantId).
  func testWeeklyStandingsTieBreak() : async () {
    clearStats();
    markLive([1]);
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("w3", roster, #halfPpr, [me, otherP, thirdP]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    let pOther = makeParticipant(otherP, "Other", [won("9005", "QB"), won("9006", "RB"), won("9007", "WR"), won("9008", "TE")]);
    let pThird = makeParticipant(thirdP, "Third", [won("9009", "QB"), won("9010", "RB"), won("9011", "WR"), won("9012", "TE")]);
    registerRoom(room, [(me, pMe), (otherP, pOther), (thirdP, pThird)], ?{ startWeek = 1 });

    // All three score exactly 23 → all tie.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9002", 1, 5.0)); addStats(ptsStats("9003", 1, 5.0)); addStats(ptsStats("9004", 1, 3.0));
    addStats(ptsStats("9005", 1, 10.0)); addStats(ptsStats("9006", 1, 5.0)); addStats(ptsStats("9007", 1, 5.0)); addStats(ptsStats("9008", 1, 3.0));
    addStats(ptsStats("9009", 1, 10.0)); addStats(ptsStats("9010", 1, 5.0)); addStats(ptsStats("9011", 1, 5.0)); addStats(ptsStats("9012", 1, 3.0));

    let res = await getWeeklyStandings("w3", 1);
    switch (res) {
      case (#err e) check("W3: weekly standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        check("W3: three entries", entries.size() == 3);
        var allTied = true;
        for (e in entries.values()) {
          if (not approxEq(e.totalPoints, 23.0)) { allTied := false };
        };
        check("W3: all tied at 23", allTied);
        var sorted = true;
        var i = 0;
        while (i + 1 < entries.size()) {
          if (Principal.compare(entries[i].participantId, entries[i + 1].participantId) != #less) {
            sorted := false;
          };
          i += 1;
        };
        check("W3: deterministic ascending participantId order", sorted);
      };
    };
  };

  // 25. Fully unsynced week returns a valid all-zero, deterministically-ordered
  //     list (0, not an error) — consistent with how getStandings treats
  //     unsynced weeks within its sum.
  func testWeeklyStandingsFullyUnsynced() : async () {
    clearStats();
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("w4", roster, #halfPpr, [me, otherP]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    let pOther = makeParticipant(otherP, "Other", [won("9005", "QB"), won("9006", "RB"), won("9007", "WR"), won("9008", "TE")]);
    registerRoom(room, [(me, pMe), (otherP, pOther)], ?{ startWeek = 1 });

    // No stats at all for week 3 → fully unsynced week.
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9002", 1, 5.0)); addStats(ptsStats("9003", 1, 5.0)); addStats(ptsStats("9004", 1, 3.0));

    let res = await getWeeklyStandings("w4", 3);
    switch (res) {
      case (#err e) check("W4: fully unsynced week returns ok (got err " # e # ")", false);
      case (#ok entries) {
        check("W4: two entries", entries.size() == 2);
        var allZero = true;
        for (e in entries.values()) {
          if (not approxEq(e.totalPoints, 0.0)) { allZero := false };
        };
        check("W4: all entries zero", allZero);
        // Deterministic order: all tied at 0 → ascending participantId.
        var sorted = true;
        var i = 0;
        while (i + 1 < entries.size()) {
          if (Principal.compare(entries[i].participantId, entries[i + 1].participantId) != #less) {
            sorted := false;
          };
          i += 1;
        };
        check("W4: deterministic ascending participantId order", sorted);
      };
    };
  };

  // 26. Missing individual player stats within an otherwise-synced week
  //     contribute 0 for that player without erroring.
  func testWeeklyStandingsMissingPlayerStats() : async () {
    clearStats();
    markLive([1]);
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("w5", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9006", "RB"),
      won("9003", "WR"), won("9007", "WR"), won("9004", "TE"), won("9011", "WR"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });

    // WR3 has no stats → 0 points, benched. Total = 78.
    addStats(ptsStats("9001", 1, 10.0));
    addStats(ptsStats("9002", 1, 15.0));
    addStats(ptsStats("9006", 1, 12.0));
    addStats(ptsStats("9003", 1, 18.0));
    addStats(ptsStats("9007", 1, 14.0));
    addStats(ptsStats("9004", 1, 9.0));

    let res = await getWeeklyStandings("w5", 1);
    switch (res) {
      case (#err e) check("W5: weekly standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        switch (findStanding(entries, me)) {
          case (?e) check("W5: single-week 78 (WR3 missing = 0)", approxEq(e.totalPoints, 78.0));
          case null check("W5: Me present", false);
        };
      };
    };
  };

  // 27. Access control: non-participant caller is rejected.
  func testWeeklyStandingsAccessDenied() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    // Room participants do NOT include the caller (me).
    let room = makeRoom("w6", roster, #halfPpr, [otherP]);
    let pOther = makeParticipant(otherP, "Other", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    registerRoom(room, [(otherP, pOther)], ?{ startWeek = 1 });
    addStats(ptsStats("9001", 1, 10.0));

    let res = await getWeeklyStandings("w6", 1);
    switch (res) {
      case (#ok _) check("W6: non-participant denied", false);
      case (#err e) check("W6: non-participant denied", e == "Not a participant in this room");
    };
  };

  // 28. Access control: non-#BestBall room is rejected.
  func testWeeklyStandingsNonBestBall() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeLifecycleRoom("w7", #Completed, #Auction, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoom(room, [(me, pMe)], null);

    let res = await getWeeklyStandings("w7", 1);
    switch (res) {
      case (#ok _) check("W7: non-Best-Ball rejected", false);
      case (#err e) check("W7: non-Best-Ball rejected", e == "Room is not a Best Ball room");
    };
  };

  // 29. Invalid week (< startWeek or > FINAL_WEEK) is rejected with #err.
  func testWeeklyStandingsInvalidWeek() : async () {
    clearStats();
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("w8", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 2 });
    addStats(ptsStats("9001", 2, 10.0));

    // week 1 < startWeek(2) → rejected.
    let resLow = await getWeeklyStandings("w8", 1);
    switch (resLow) {
      case (#ok _) check("W8: week below startWeek rejected", false);
      case (#err e) check("W8: week below startWeek rejected", e == "Week out of range");
    };
    // week 18 > FINAL_WEEK(17) → rejected.
    let resHigh = await getWeeklyStandings("w8", 18);
    switch (resHigh) {
      case (#ok _) check("W8: week above FINAL_WEEK rejected", false);
      case (#err e) check("W8: week above FINAL_WEEK rejected", e == "Week out of range");
    };
    // Boundary weeks are accepted.
    let resStart = await getWeeklyStandings("w8", 2);
    switch (resStart) {
      case (#err e) check("W8: startWeek boundary accepted (got err " # e # ")", false);
      case (#ok _) check("W8: startWeek boundary accepted", true);
    };
    let resEnd = await getWeeklyStandings("w8", 17);
    switch (resEnd) {
      case (#err e) check("W8: FINAL_WEEK boundary accepted (got err " # e # ")", false);
      case (#ok _) check("W8: FINAL_WEEK boundary accepted", true);
    };
  };

  // 13. A participant's optimal lineup changes between weeks (FLEX starter
  //     differs), and getWeeklyLineup reflects the change.
  func testLineupChangesBetweenWeeks() : async () {
    clearStats();
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("s8", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [
      won("9001", "QB"), won("9002", "RB"), won("9006", "RB"), won("9010", "RB"),
      won("9003", "WR"), won("9007", "WR"), won("9011", "WR"), won("9004", "TE"),
    ]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });

    // Week 1: RB3(15) beats WR3(5) for FLEX → FLEX = RB3, total 96.
    addStats(ptsStats("9001", 1, 10.0));
    addStats(ptsStats("9002", 1, 20.0));
    addStats(ptsStats("9006", 1, 10.0));
    addStats(ptsStats("9010", 1, 15.0));
    addStats(ptsStats("9003", 1, 18.0));
    addStats(ptsStats("9007", 1, 14.0));
    addStats(ptsStats("9011", 1, 5.0));
    addStats(ptsStats("9004", 1, 9.0));
    // Week 2: WR3(16) beats RB1(10) for FLEX → FLEX = WR3, total 99.
    addStats(ptsStats("9001", 2, 10.0));
    addStats(ptsStats("9002", 2, 10.0));
    addStats(ptsStats("9006", 2, 20.0));
    addStats(ptsStats("9010", 2, 12.0));
    addStats(ptsStats("9003", 2, 18.0));
    addStats(ptsStats("9007", 2, 14.0));
    addStats(ptsStats("9011", 2, 16.0));
    addStats(ptsStats("9004", 2, 9.0));

    let w1 = await getWeeklyLineup("s8", me, 1);
    let w2 = await getWeeklyLineup("s8", me, 2);
    switch (w1) {
      case (#err e) check("S8: week1 ok (got err " # e # ")", false);
      case (#ok v1) {
        check("S8: week1 total 96", approxEq(v1.total, 96.0));
        check("S8: week1 FLEX = RB3", flexStarter(v1) == ?"9010");
      };
    };
    switch (w2) {
      case (#err e) check("S8: week2 ok (got err " # e # ")", false);
      case (#ok v2) {
        check("S8: week2 total 99", approxEq(v2.total, 99.0));
        check("S8: week2 FLEX = WR3", flexStarter(v2) == ?"9011");
      };
    };
    // The FLEX starter must differ between the two weeks.
    var flex1 : ?Text = null;
    var flex2 : ?Text = null;
    switch (w1) { case (#ok v) flex1 := flexStarter(v); case (#err _) {} };
    switch (w2) { case (#ok v) flex2 := flexStarter(v); case (#err _) {} };
    check("S8: FLEX starter changes between weeks", flex1 != flex2);
  };

  // ── Best Ball lifecycle guardrail tests ───────────────────────────────────
  // These exercise the lifecycle methods on AuctionMixin: endAuction (with its
  // gameType-aware startWeek validation and atomic BestBallConfig write) and
  // the roster-lock invariant (assertRosterLocked, reached via
  // finalizeNomination through the public sweepNominations path). The former
  // setBestBallConfig/convertRoomToBestBall methods were removed entirely.

  // A room fixture with controllable state and gameType for lifecycle tests.
  func makeLifecycleRoom(id : Text, state : Types.AuctionState, gameType : Types.GameType, participants : [Types.UserId]) : Types.Room {
    {
      id;
      name = "Lifecycle Room";
      admin = me;
      participants;
      state;
      gameType;
      competitionMode = #Cumulative;
      playoffTeams = 0;
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
      rosterSettings = null;
      teamCount = null;
      leagueFormat = null;
      season;
      scoringFormat = #halfPpr;
    };
  };

  // Register a room WITHOUT a BestBallConfig entry (for lifecycle tests).
  func registerRoomNoConfig(room : Types.Room, pm : [(Types.UserId, Types.Participant)]) {
    rooms.add(room.id, room);
    let inner = Map.empty<Types.UserId, Types.Participant>();
    for ((uid, p) in pm.values()) { inner.add(uid, p); };
    participants.add(room.id, inner);
  };

  // 20. An existing (pre-migration) Best Ball room — backfilled to
  //     gameType = #BestBall with a BestBallConfig entry — still passes the new
  //     gameType-based gate in getWeeklyLineup/getStandings.
  func testBackfilledBestBallRoomPassesGate() : async () {
    clearStats();
    markLive([1]);
    let roster = AuctionLib.defaultRosterSettings();
    let room = makeRoom("lc7", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });
    addStats(ptsStats("9001", 1, 10.0));
    addStats(ptsStats("9002", 1, 5.0));
    addStats(ptsStats("9003", 1, 5.0));
    addStats(ptsStats("9004", 1, 3.0));

    let wl = await getWeeklyLineup("lc7", me, 1);
    switch (wl) {
      case (#err e) check("LC7: backfilled Best Ball room passes getWeeklyLineup gate (got err " # e # ")", false);
      case (#ok _) check("LC7: backfilled Best Ball room passes getWeeklyLineup gate", true);
    };
    let st = await getStandings("lc7");
    switch (st) {
      case (#err e) check("LC7: backfilled Best Ball room passes getStandings gate (got err " # e # ")", false);
      case (#ok _) check("LC7: backfilled Best Ball room passes getStandings gate", true);
    };
  };

  // 21. Roster-lock invariant: applyWin works normally during a live auction
  //     (does not break), and the guard fires (traps) when a roster mutation is
  //     attempted on a #Completed room via the finalizeNomination path.
  func testRosterLockInvariant() : async () {
    // (a) applyWin works normally — mutates wonPlayers, increments spent, and
    //     clears committed for the nomination. This is the "does not break
    //     normal applyWin during a live auction" half of the invariant.
    let p = makeParticipant(me, "Me", []);
    let player : Types.Player = {
      id = "9001"; name = "9001"; position = "QB"; team = "TST";
      byeWeek = null; adp = 0.0; headshotUrl = null; yearsExp = 0;
    };
    let updated = AuctionLib.applyWin(p, player, 25, 1, me, 0);
    check("LC8: applyWin appends wonPlayer", updated.wonPlayers.size() == 1);
    check("LC8: applyWin increments spent", updated.spent == 25);
    check("LC8: applyWin clears committed", updated.committed.size() == 0);

    // (b) The guard fires when a roster mutation is attempted on a #Completed
    //     room. Set up a completed room with an expired active nomination that
    //     has a bid leader, then sweep it — finalizeNomination reaches
    //     assertRosterLocked and traps because the room is #Completed.
    let room = makeLifecycleRoom("lc8", #Completed, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    let nom : Types.Nomination = {
      id = 1;
      roomId = "lc8";
      playerId = "9001";
      playerName = "9001";
      position = "QB";
      team = "TST";
      imageUrl = null;
      nominatedBy = me;
      state = #Active;
      currentBid = 25;
      bidLeader = ?me;
      timerStartedAt = 0;
      timerDurationSecs = 1;
      timerPausedAt = null;
      timerElapsedSecs = 0;
    };
    nominations.add(1, nom);
    var trapped = false;
    try {
      await sweepNominations("lc8");
    } catch (_) {
      trapped := true;
    };
    check("LC8: roster-lock guard traps on #Completed room", trapped);
  };

  // ── New lifecycle tests (gameType at creation, fixed season end) ─────────

  // createRoom with gameType = #BestBall succeeds and stores the gameType.
  func testCreateRoomBestBallSucceeds() : async () {
    let res = await createRoom(#BestBall, #Cumulative, 0, "BB Room", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (res) {
      case (#err e) check("CR1: createRoom #BestBall succeeds (got err " # e # ")", false);
      case (#ok roomId) {
        check("CR1: createRoom #BestBall succeeds", true);
        switch (rooms.get(roomId)) {
          case (?r) check("CR1: gameType stored as #BestBall", r.gameType == #BestBall);
          case null check("CR1: room present", false);
        };
      };
    };
  };

  // createRoom with gameType = #Guillotine is rejected explicitly.
  func testCreateRoomGuillotineRejected() : async () {
    let res = await createRoom(#Guillotine, #Cumulative, 0, "Guillotine Room", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (res) {
      case (#ok _) check("CR2: createRoom #Guillotine rejected", false);
      case (#err e) check("CR2: createRoom #Guillotine rejected", e == "Guillotine is not yet implemented");
    };
  };

  // endAuction on an #Auction room rejects a provided startWeek.
  func testEndAuctionAuctionRejectsStartWeek() : async () {
    let room = makeLifecycleRoom("ea1", #Active, #Auction, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    let res = await endAuction("ea1", ?5);
    switch (res) {
      case (#ok _) check("EA1: #Auction room rejects provided startWeek", false);
      case (#err e) check("EA1: #Auction room rejects provided startWeek", e == "startWeek is not applicable to an Auction room");
    };
  };

  // endAuction on a #BestBall room rejects a missing startWeek.
  func testEndAuctionBestBallRejectsMissingStartWeek() : async () {
    let room = makeLifecycleRoom("ea2", #Active, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    let res = await endAuction("ea2", null);
    switch (res) {
      case (#ok _) check("EA2: #BestBall room rejects missing startWeek", false);
      case (#err e) check("EA2: #BestBall room rejects missing startWeek", e == "startWeek is required for a Best Ball room");
    };
  };

  // endAuction on a #BestBall room rejects startWeek = 0.
  func testEndAuctionBestBallRejectsStartWeekZero() : async () {
    let room = makeLifecycleRoom("ea3", #Active, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    let res = await endAuction("ea3", ?0);
    switch (res) {
      case (#ok _) check("EA3: #BestBall room rejects startWeek 0", false);
      case (#err e) check("EA3: #BestBall room rejects startWeek 0", e == "startWeek must be at least 1");
    };
  };

  // endAuction on a #BestBall room rejects startWeek = 18 (> FINAL_WEEK).
  func testEndAuctionBestBallRejectsStartWeekTooHigh() : async () {
    let room = makeLifecycleRoom("ea4", #Active, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    let res = await endAuction("ea4", ?18);
    switch (res) {
      case (#ok _) check("EA4: #BestBall room rejects startWeek 18", false);
      case (#err e) check("EA4: #BestBall room rejects startWeek 18", e == "startWeek must be at most 17");
    };
  };

  // endAuction on a #BestBall room accepts startWeek in 1..17 and writes the config.
  func testEndAuctionBestBallAcceptsValidStartWeek() : async () {
    let room = makeLifecycleRoom("ea5", #Active, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    let res = await endAuction("ea5", ?5);
    switch (res) {
      case (#err e) check("EA5: #BestBall room accepts startWeek 5 (got err " # e # ")", false);
      case (#ok _) {
        check("EA5: #BestBall room accepts startWeek 5", true);
        switch (rooms.get("ea5")) {
          case (?r) check("EA5: room completed", r.state == #Completed);
          case null check("EA5: room present", false);
        };
        switch (bestBallConfigs.get("ea5")) {
          case (?c) check("EA5: BestBallConfig written with startWeek 5", c.startWeek == 5);
          case null check("EA5: BestBallConfig written", false);
        };
      };
    };
  };

  // endAuction failure (bad startWeek) leaves the room in its pre-completion state.
  func testEndAuctionFailureLeavesRoomUnchanged() : async () {
    let room = makeLifecycleRoom("ea6", #Active, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    let res = await endAuction("ea6", ?18);
    switch (res) {
      case (#ok _) check("EA6: rejected endAuction leaves room unchanged", false);
      case (#err _) {
        switch (rooms.get("ea6")) {
          case (?r) check("EA6: room state unchanged (#Active)", r.state == #Active);
          case null check("EA6: room present", false);
        };
        check("EA6: no BestBallConfig written", bestBallConfigs.get("ea6") == null);
      };
    };
  };

  // getBestBallConfig returns the new { startWeek } shape (no endWeek field).
  func testGetBestBallConfigNewShape() : async () {
    let room = makeLifecycleRoom("ea7", #Active, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoomNoConfig(room, [(me, pMe)]);
    ignore await endAuction("ea7", ?3);
    switch (await getBestBallConfig("ea7")) {
      case (?c) check("GC1: getBestBallConfig returns startWeek 3", c.startWeek == 3);
      case null check("GC1: getBestBallConfig returns config", false);
    };
  };

  // getStandings excludes weeks beyond FINAL_WEEK (week 18 contributes nothing).
  func testStandingsExcludesBeyondFinalWeek() : async () {
    clearStats();
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("s9", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });
    // Week 18 (23) is beyond FINAL_WEEK(17) and must be excluded → total 0.
    addStats(ptsStats("9001", 18, 10.0));
    addStats(ptsStats("9002", 18, 5.0));
    addStats(ptsStats("9003", 18, 5.0));
    addStats(ptsStats("9004", 18, 3.0));

    let res = await getStandings("s9");
    switch (res) {
      case (#err e) check("S9: standings returns ok (got err " # e # ")", false);
      case (#ok entries) {
        switch (findStanding(entries, me)) {
          case (?e) check("S9: week 18 excluded (total 0)", approxEq(e.totalPoints, 0.0));
          case null check("S9: Me present", false);
        };
      };
    };
  };

  // ── deleteRoom Best Ball guard tests ──────────────────────────────────────

  // 30. A Best Ball room with a BestBallConfig but zero finalized weeks deletes
  //     successfully. The BestBallConfig alone no longer blocks deletion — only
  //     a genuinely finalized (#finalized) week in startWeek..FINAL_WEEK does.
  func testDeleteRoomBestBallNoSettledWeek() : async () {
    let room = makeLifecycleRoom("dr1", #Completed, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 5 });

    let res = await deleteRoom("dr1");
    switch (res) {
      case (#err e) check("DR1: Best Ball room with no settled week deletes (got err " # e # ")", false);
      case (#ok _) {
        check("DR1: Best Ball room with no settled week deletes", true);
        check("DR1: room removed", rooms.get("dr1") == null);
      };
    };
  };

  // 31. A Best Ball room with at least one finalized week is still rejected — the
  //     regression check. Marking one week in startWeek..FINAL_WEEK as #finalized
  //     must keep the original historical-data protection intact.
  func testDeleteRoomBestBallSettledWeekRejected() : async () {
    let room = makeLifecycleRoom("dr2", #Completed, #BestBall, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 5 });

    // Mark week 7 (within startWeek 5..FINAL_WEEK 17) as finalized.
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 7, #finalized, null, ?0);

    let res = await deleteRoom("dr2");
    switch (res) {
      case (#ok _) check("DR2: Best Ball room with settled week rejected", false);
      case (#err e) {
        check("DR2: Best Ball room with settled week rejected", e == "Cannot delete room because it contains historical Best Ball data");
        check("DR2: room still exists", rooms.get("dr2") != null);
      };
    };
  };

  // ── Best Ball caching + automatic finalization tests ──────────────────────

  // Automatic finalization fires via the sync-flow trigger: syncing a subsequent
  // week finalizes every earlier #partial week and writes each participant's
  // score into the finalizedWeeklyScores cache at that moment.
  func testAutomaticFinalizationWritesCache() : async () {
    clearStats();
    syncStatuses.clear();
    scores.clear();
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("fc1", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });
    // Week 1 synced (23 points) → #partial.
    ignore await syncWeeklyStats("fc1", season, 1, [ptsStats("9001", 1, 10.0), ptsStats("9002", 1, 5.0), ptsStats("9003", 1, 5.0), ptsStats("9004", 1, 3.0)]);
    // Week 1 is #partial (live), not yet finalized.
    check("FC1: week1 partial before finalization", SyncStatusLib.isWeekFinalized(syncStatuses, season, 1) == false);
    // Week 2 synced → triggers finalizePriorPartialWeeks, finalizing week 1.
    ignore await syncWeeklyStats("fc1", season, 2, [ptsStats("9001", 2, 10.0), ptsStats("9002", 2, 5.0), ptsStats("9003", 2, 5.0), ptsStats("9004", 2, 3.0)]);
    // Week 1 is now finalized and its score is cached.
    check("FC1: week1 finalized after week2 sync", SyncStatusLib.isWeekFinalized(syncStatuses, season, 1));
    let cached = BestBallCachingLib.getFinalizedScore(scores, "fc1", season, 1, me);
    switch (cached) {
      case (?v) check("FC1: week1 cached score 23", approxEq(v, 23.0));
      case null check("FC1: week1 cached score present", false);
    };
    // Week 2 is the live (#partial) week — not cached.
    check("FC1: week2 partial (live)", SyncStatusLib.isWeekFinalized(syncStatuses, season, 2) == false);
    check("FC1: week2 not cached", BestBallCachingLib.getFinalizedScore(scores, "fc1", season, 2, me) == null);
  };

  // getStandings returns identical scores for a finalized week whether read
  // fresh from pre-existing test data or from the cache — no discrepancy
  // introduced by the caching layer.
  func testStandingsFinalizedFreshVsCache() : async () {
    clearStats();
    syncStatuses.clear();
    scores.clear();
    let roster = { AuctionLib.defaultRosterSettings() with qb = 1; rb = 1; wr = 1; te = 1; flex = 0; superflex = 0 };
    let room = makeRoom("fc2", roster, #halfPpr, [me]);
    let pMe = makeParticipant(me, "Me", [won("9001", "QB"), won("9002", "RB"), won("9003", "WR"), won("9004", "TE")]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });
    // Week 1: 23 points. Week 2: 30 points (live).
    addStats(ptsStats("9001", 1, 10.0)); addStats(ptsStats("9002", 1, 5.0)); addStats(ptsStats("9003", 1, 5.0)); addStats(ptsStats("9004", 1, 3.0));
    addStats(ptsStats("9001", 2, 12.0)); addStats(ptsStats("9002", 2, 8.0)); addStats(ptsStats("9003", 2, 7.0)); addStats(ptsStats("9004", 2, 3.0));
    // Finalize week 1 and cache its score (as finalization would).
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 1, #finalized, null, ?0);
    scores.add(BestBallCachingLib.finalizedScoreKey("fc2", season, 1, me), 23.0);
    // Week 2 is the live (#partial) week.
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 2, #partial, null, ?0);
    // getStandings: finalized week 1 read from cache (23), live week 2 computed (30) → 53.
    let res = await getStandings("fc2");
    switch (res) {
      case (#err e) check("FC2: standings ok (got err " # e # ")", false);
      case (#ok entries) {
        switch (findStanding(entries, me)) {
          case (?e) check("FC2: cumulative 53 (cached 23 + live 30)", approxEq(e.totalPoints, 53.0));
          case null check("FC2: Me present", false);
        };
      };
    };
    // The cached value equals the fresh computation for the finalized week.
    let fresh = LineupLib.calculateOptimalWeeklyLineup(room, pMe, 1, func(playerId : Text, s : Nat, w : Nat) : ?Types.WeeklyPlayerStats {
      stats.get(playerId # "|" # s.toText() # "|" # w.toText());
    }).total;
    check("FC2: cached equals fresh computation", approxEq(23.0, fresh));
  };

  // ── Entry point ───────────────────────────────────────────────────────────
  public func runTests() : async () {
    me := await whoAmI();
    // Register the caller as the admin so deleteRoom's admin guard passes.
    adminPrincipalStore.add("admin", me);

    await testWeeklyLineupValid();
    await testWeeklyLineupUnsynced();
    await testWeeklyLineupMissingStats();
    await testWeeklyLineupAccessDenied();
    await testWeeklyLineupNonBestBall();

    await testStandingsMultiple();
    await testStandingsUnsyncedWeek();
    await testStandingsMissingPlayerStats();
    await testStandingsStartWeek();
    await testStandingsEndWeek();
    await testStandingsTieBreak();
    await testStandingsNonBestBall();
    await testLineupChangesBetweenWeeks();

    await testWeeklyStandingsSingleWeek();
    await testWeeklyStandingsOrdering();
    await testWeeklyStandingsTieBreak();
    await testWeeklyStandingsFullyUnsynced();
    await testWeeklyStandingsMissingPlayerStats();
    await testWeeklyStandingsAccessDenied();
    await testWeeklyStandingsNonBestBall();
    await testWeeklyStandingsInvalidWeek();

    await testBackfilledBestBallRoomPassesGate();
    await testRosterLockInvariant();

    await testCreateRoomBestBallSucceeds();
    await testCreateRoomGuillotineRejected();
    await testEndAuctionAuctionRejectsStartWeek();
    await testEndAuctionBestBallRejectsMissingStartWeek();
    await testEndAuctionBestBallRejectsStartWeekZero();
    await testEndAuctionBestBallRejectsStartWeekTooHigh();
    await testEndAuctionBestBallAcceptsValidStartWeek();
    await testEndAuctionFailureLeavesRoomUnchanged();
    await testGetBestBallConfigNewShape();
    await testStandingsExcludesBeyondFinalWeek();

    await testDeleteRoomBestBallNoSettledWeek();
    await testDeleteRoomBestBallSettledWeekRejected();

    await testAutomaticFinalizationWritesCache();
    await testStandingsFinalizedFreshVsCache();

    if (failures > 0) {
      let first = switch (firstFailure) { case (?n) n; case null "unknown" };
      Debug.print("BEST BALL TESTS: " # failures.toText() # " FAILURE(S), first: " # first);
      Runtime.trap("best ball tests failed: " # first);
    } else {
      Debug.print("ALL BEST BALL TESTS PASSED");
    };
  };

  public shared query ({ caller }) func whoAmI() : async Principal { caller };
};
