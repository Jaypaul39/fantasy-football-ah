import Types "../types/auction-types";
import SyncStatusTypes "../types/sync-status";
import SyncStatusLib "../lib/sync-status";
import AuctionLib "../lib/auction-types";
import H2HLib "../lib/h2h";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import BestBallCachingTypes "../types/best-ball-caching";
import H2HApi "../mixins/h2h-api";
import H2HBracketApi "../mixins/h2h-bracket-api";
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

// Phase 12a — Head-to-Head (H2H) regular-season backend tests.
//
// Runs via `mops test` (replica mode). This file is an unnamed `actor { ... }`
// with a `public func runTests() : async ()`, the mops replica-test convention.
//
// It instantiates the H2H mixin (mixins/h2h-api.mo), the Best Ball mixin
// (mixins/best-ball-api.mo), and the Auction mixin (mixins/auction-types-api.mo)
// with the same state shape main.mo wires. The pure schedule helpers in
// lib/h2h.mo are tested directly; the public methods (createRoom, endAuction,
// getH2HStandings, getStandings, getWeeklyStandings) are exercised through the
// mixins with the actor's own principal as the caller.

actor {
  // ── State (mirrors main.mo's wiring) ──────────────────────────────────────
  let season = 2025;
  let rooms = Map.empty<Types.RoomId, Types.Room>();
  let participants = Map.empty<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>();
  let bestBallConfigs = Map.empty<Types.RoomId, Types.BestBallConfig>();
  let stats = Map.empty<Text, Types.WeeklyPlayerStats>();
  let syncStatuses = Map.empty<Text, SyncStatusTypes.SyncStatusRecord>();
  let scores = Map.empty<Text, Float>();

  var me : Types.UserId = Principal.anonymous();
  let otherP = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\01");
  let thirdP = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\02");
  let p4 = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\03");
  let p5 = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\04");
  let p6 = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\05");
  let p7 = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\06");
  let p8 = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\07");

  func calculateOptimalWeeklyLineupRaw(
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

  // Instrumented counter: increments on every call to the ACTUAL injected
  // calculateOptimalWeeklyLineup closure (the one passed into the real
  // H2HBracketApi mixin below). Wrapping the real closure — not a standalone
  // simulation — lets the tests prove how many optimizer calls the real
  // getPlayoffBracket path makes.
  var calculateOptimalWeeklyLineupCalls = 0;
  func calculateOptimalWeeklyLineup(
    room : Types.Room,
    participant : Types.Participant,
    week : Nat,
  ) : LineupLib.LineupResult {
    calculateOptimalWeeklyLineupCalls += 1;
    calculateOptimalWeeklyLineupRaw(room, participant, week);
  };

  include H2HApi(rooms, participants, bestBallConfigs, syncStatuses, scores, calculateOptimalWeeklyLineup);
  include H2HBracketApi(rooms, participants, bestBallConfigs, syncStatuses, scores, calculateOptimalWeeklyLineup, getH2HStandings);
  include BestBallApi(rooms, participants, bestBallConfigs, syncStatuses, scores, calculateOptimalWeeklyLineup);

  // ── AuctionMixin state (for createRoom/endAuction lifecycle tests) ────────
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
  func makeRoom(id : Text, state : Types.AuctionState, gameType : Types.GameType, competitionMode : Types.CompetitionMode, playoffTeams : Nat, participants : [Types.UserId]) : Types.Room {
    {
      id;
      name = "H2H Room";
      admin = me;
      participants;
      state;
      gameType;
      competitionMode;
      playoffTeams;
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

  func clearStats() {
    stats.clear();
  };

  // Under the caching model, getH2HStandings/getStandings/getWeeklyStandings
  // only score a week that is #finalized (read from the cache) or #partial
  // (live, computed dynamically). Mark the given weeks as #partial so they are
  // computed dynamically from the injected stats, preserving each test's
  // original assertions about final values. Clears any prior sync status first
  // to avoid cross-test contamination; callers that also need later weeks
  // #finalized (e.g. playoff weeks) add those records after this call.
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

  func registerRoomNoConfig(room : Types.Room, pm : [(Types.UserId, Types.Participant)]) {
    rooms.add(room.id, room);
    let inner = Map.empty<Types.UserId, Types.Participant>();
    for ((uid, p) in pm.values()) { inner.add(uid, p); };
    participants.add(room.id, inner);
  };

  func findH2H(entries : [H2HStandingEntry], uid : Types.UserId) : ?H2HStandingEntry {
    entries.find(func e = e.participant == uid);
  };

  func findStanding(entries : [StandingsEntry], uid : Types.UserId) : ?StandingsEntry {
    entries.find(func e = e.participantId == uid);
  };

  // Register a #BestBall + #HeadToHead playoff room with `users` as participants.
  // Each participant i owns players QB{i}/RB{i}/WR{i}/TE{i} so weekly scores can be
  // set independently via setParticipantWeekScore.
  func registerPlayoffRoom(id : Text, playoffTeams : Nat, users : [Types.UserId]) {
    let room = makeRoom(id, #Completed, #BestBall, #HeadToHead, playoffTeams, users);
    let pm = List.empty<(Types.UserId, Types.Participant)>();
    var idx = 0;
    for (u in users.values()) {
      pm.add((u, makeParticipant(u, "P" # idx.toText(), [won("QB" # idx.toText(), "QB"), won("RB" # idx.toText(), "RB"), won("WR" # idx.toText(), "WR"), won("TE" # idx.toText(), "TE")])));
      idx += 1;
    };
    registerRoom(room, pm.toArray(), ?{ startWeek = 1 });
  };

  // Set participant `i`'s total weekly score to `pts` for week `w` by encoding the
  // points as the QB's rush yards (all other owned players contribute 0).
  func setParticipantWeekScore(i : Nat, w : Nat, pts : Float) {
    addStats(ptsStats("QB" # i.toText(), w, pts));
    addStats(ptsStats("RB" # i.toText(), w, 0.0));
    addStats(ptsStats("WR" # i.toText(), w, 0.0));
    addStats(ptsStats("TE" # i.toText(), w, 0.0));
  };

  // Populate the finalized-score cache for a week with the given per-participant
  // scores (index-aligned with `users`). Mirrors what finalization writes to the
  // cache, so bracket resolution reads the same values the optimizer would have
  // produced for a finalized week.
  func cacheWeek(roomId : Text, w : Nat, users : [Types.UserId], pts : [Float]) {
    var i = 0;
    while (i < users.size()) {
      scores.add(BestBallCachingLib.finalizedScoreKey(roomId, season, w, users[i]), pts[i]);
      i += 1;
    };
  };

  // ── Pure helper tests ─────────────────────────────────────────────────────

  // numberOfRounds: 0 for 0/1 participants; count-1 even; count odd.
  func testNumberOfRounds() {
    check("NR1: numberOfRounds(0) == 0", H2HLib.numberOfRounds(0) == 0);
    check("NR2: numberOfRounds(1) == 0", H2HLib.numberOfRounds(1) == 0);
    check("NR3: numberOfRounds(2) == 1", H2HLib.numberOfRounds(2) == 1);
    check("NR4: numberOfRounds(4) == 3", H2HLib.numberOfRounds(4) == 3);
    check("NR5: numberOfRounds(5) == 5", H2HLib.numberOfRounds(5) == 5);
    check("NR6: numberOfRounds(6) == 5", H2HLib.numberOfRounds(6) == 5);
    check("NR7: numberOfRounds(8) == 7", H2HLib.numberOfRounds(8) == 7);
  };

  // playoffRounds / regularSeasonEnd / playoffStartWeek for 0/4/6/8.
  func testPlayoffHelpers() {
    check("PH1: playoffRounds(0) == 0", H2HLib.playoffRounds(0) == 0);
    check("PH2: playoffRounds(4) == 2", H2HLib.playoffRounds(4) == 2);
    check("PH3: playoffRounds(6) == 3", H2HLib.playoffRounds(6) == 3);
    check("PH4: playoffRounds(8) == 3", H2HLib.playoffRounds(8) == 3);
    check("PH5: regularSeasonEnd(0) == 17", H2HLib.regularSeasonEnd(0) == 17);
    check("PH6: regularSeasonEnd(4) == 15", H2HLib.regularSeasonEnd(4) == 15);
    check("PH7: regularSeasonEnd(6) == 14", H2HLib.regularSeasonEnd(6) == 14);
    check("PH8: regularSeasonEnd(8) == 14", H2HLib.regularSeasonEnd(8) == 14);
    check("PH9: playoffStartWeek(0) == 18", H2HLib.playoffStartWeek(0) == 18);
    check("PH10: playoffStartWeek(4) == 16", H2HLib.playoffStartWeek(4) == 16);
    check("PH11: playoffStartWeek(8) == 15", H2HLib.playoffStartWeek(8) == 15);
  };

  // orderedParticipants sorts by Principal.compare.
  func testOrderedParticipants() {
    let room = makeRoom("op1", #Completed, #BestBall, #HeadToHead, 0, [me, otherP, thirdP]);
    let ordered = H2HLib.orderedParticipants(room);
    check("OP1: sorted size 3", ordered.size() == 3);
    var sorted = true;
    var i = 0;
    while (i + 1 < ordered.size()) {
      if (Principal.compare(ordered[i], ordered[i + 1]) != #less) { sorted := false };
      i += 1;
    };
    check("OP2: ascending Principal.compare order", sorted);
  };

  // ── Schedule correctness ──────────────────────────────────────────────────

  // Return the matchups for a specific week from a schedule.
  func matchupsForWeek(schedule : [H2HLib.Matchup], week : Nat) : [H2HLib.Matchup] {
    schedule.filter(func m = m.week == week);
  };

  // For n=4, one full cycle (3 weeks) covers all 6 pairs exactly once, and a
  // repeated cycle (season longer than numberOfRounds) replays identical pairings.
  func testScheduleN4() {
    let room = makeRoom("s4", #Completed, #BestBall, #HeadToHead, 0, [me, otherP, thirdP, p4]);
    let cfg = { startWeek = 1 };
    let schedule = H2HLib.regularSeasonSchedule(room, cfg);
    // regularSeasonEnd(0) = 17, so 17 weeks.
    check("S4A: 17 weeks of matchups", schedule.size() == 17 * 2);
    // First cycle (weeks 1-3) must contain all 6 unique pairs exactly once.
    let pairs = List.empty<(Types.UserId, Types.UserId)>();
    var w = 1;
    while (w <= 3) {
      for (m in matchupsForWeek(schedule, w).values()) {
        pairs.add((m.home, m.away));
      };
      w += 1;
    };
    let pairArr = pairs.toArray();
    check("S4B: 6 pairs in first cycle", pairArr.size() == 6);
    // All pairs distinct.
    var distinct = true;
    var i = 0;
    while (i < pairArr.size()) {
      var j = i + 1;
      while (j < pairArr.size()) {
        let same = (pairArr[i].0 == pairArr[j].0 and pairArr[i].1 == pairArr[j].1)
          or (pairArr[i].0 == pairArr[j].1 and pairArr[i].1 == pairArr[j].0);
        if (same) { distinct := false };
        j += 1;
      };
      i += 1;
    };
    check("S4C: all pairs distinct in first cycle", distinct);
    // Repeated cycle: week 4 == week 1, week 5 == week 2, week 6 == week 3.
    func sameWeek(a : [H2HLib.Matchup], b : [H2HLib.Matchup]) : Bool {
      if (a.size() != b.size()) return false;
      var k = 0;
      while (k < a.size()) {
        let samePair = (a[k].home == b[k].home and a[k].away == b[k].away)
          or (a[k].home == b[k].away and a[k].away == b[k].home);
        if (not samePair) return false;
        k += 1;
      };
      true;
    };
    check("S4D: week 4 repeats week 1", sameWeek(matchupsForWeek(schedule, 4), matchupsForWeek(schedule, 1)));
    check("S4E: week 5 repeats week 2", sameWeek(matchupsForWeek(schedule, 5), matchupsForWeek(schedule, 2)));
    check("S4F: week 6 repeats week 3", sameWeek(matchupsForWeek(schedule, 6), matchupsForWeek(schedule, 3)));
  };

  // For n=5 (odd), numberOfRounds=5; each week has 2 matchups (one bye), and
  // all 10 pairs appear exactly once across the 5-round cycle.
  func testScheduleN5() {
    let room = makeRoom("s5", #Completed, #BestBall, #HeadToHead, 0, [me, otherP, thirdP, p4, p5]);
    let cfg = { startWeek = 1 };
    let schedule = H2HLib.regularSeasonSchedule(room, cfg);
    check("S5A: 5 rounds", H2HLib.numberOfRounds(5) == 5);
    // First cycle (weeks 1-5) has 2 matchups per week = 10 pairs.
    let pairs = List.empty<(Types.UserId, Types.UserId)>();
    var w = 1;
    while (w <= 5) {
      for (m in matchupsForWeek(schedule, w).values()) {
        pairs.add((m.home, m.away));
      };
      w += 1;
    };
    let pairArr = pairs.toArray();
    check("S5B: 10 pairs in first cycle", pairArr.size() == 10);
    var distinct = true;
    var i = 0;
    while (i < pairArr.size()) {
      var j = i + 1;
      while (j < pairArr.size()) {
        let same = (pairArr[i].0 == pairArr[j].0 and pairArr[i].1 == pairArr[j].1)
          or (pairArr[i].0 == pairArr[j].1 and pairArr[i].1 == pairArr[j].0);
        if (same) { distinct := false };
        j += 1;
      };
      i += 1;
    };
    check("S5C: all pairs distinct in first cycle", distinct);
  };

  // For n=6, numberOfRounds=5; each week has 3 matchups = 15 pairs per cycle.
  func testScheduleN6() {
    let room = makeRoom("s6", #Completed, #BestBall, #HeadToHead, 0, [me, otherP, thirdP, p4, p5, p6]);
    let cfg = { startWeek = 1 };
    let schedule = H2HLib.regularSeasonSchedule(room, cfg);
    check("S6A: 5 rounds", H2HLib.numberOfRounds(6) == 5);
    let pairs = List.empty<(Types.UserId, Types.UserId)>();
    var w = 1;
    while (w <= 5) {
      for (m in matchupsForWeek(schedule, w).values()) {
        pairs.add((m.home, m.away));
      };
      w += 1;
    };
    let pairArr = pairs.toArray();
    check("S6B: 15 pairs in first cycle", pairArr.size() == 15);
    var distinct = true;
    var i = 0;
    while (i < pairArr.size()) {
      var j = i + 1;
      while (j < pairArr.size()) {
        let same = (pairArr[i].0 == pairArr[j].0 and pairArr[i].1 == pairArr[j].1)
          or (pairArr[i].0 == pairArr[j].1 and pairArr[i].1 == pairArr[j].0);
        if (same) { distinct := false };
        j += 1;
      };
      i += 1;
    };
    check("S6C: all pairs distinct in first cycle", distinct);
  };

  // For n=8, numberOfRounds=7; each week has 4 matchups = 28 pairs per cycle.
  func testScheduleN8() {
    let room = makeRoom("s8", #Completed, #BestBall, #HeadToHead, 0, [me, otherP, thirdP, p4, p5, p6, p7, p8]);
    let cfg = { startWeek = 1 };
    let schedule = H2HLib.regularSeasonSchedule(room, cfg);
    check("S8A: 7 rounds", H2HLib.numberOfRounds(8) == 7);
    let pairs = List.empty<(Types.UserId, Types.UserId)>();
    var w = 1;
    while (w <= 7) {
      for (m in matchupsForWeek(schedule, w).values()) {
        pairs.add((m.home, m.away));
      };
      w += 1;
    };
    let pairArr = pairs.toArray();
    check("S8B: 28 pairs in first cycle", pairArr.size() == 28);
    var distinct = true;
    var i = 0;
    while (i < pairArr.size()) {
      var j = i + 1;
      while (j < pairArr.size()) {
        let same = (pairArr[i].0 == pairArr[j].0 and pairArr[i].1 == pairArr[j].1)
          or (pairArr[i].0 == pairArr[j].1 and pairArr[i].1 == pairArr[j].0);
        if (same) { distinct := false };
        j += 1;
      };
      i += 1;
    };
    check("S8C: all pairs distinct in first cycle", distinct);
  };

  // ── createRoom configuration-family tests ─────────────────────────────────

  func testCreateRoomConfigFamilies() : async () {
    // Family 1: Auction accepts-and-ignores competitionMode/playoffTeams.
    let r1 = await createRoom(#Auction, #HeadToHead, 8, "CF Auction H2H", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r1) {
      case (#ok _) check("CF1: Auction accepts-and-ignores H2H/8", true);
      case (#err e) check("CF1: Auction accepts-and-ignores H2H/8 (got err " # e # ")", false);
    };
    // Family 2: Best Ball / Cumulative requires playoffTeams = 0.
    let r2 = await createRoom(#BestBall, #Cumulative, 0, "CF Cum 0", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r2) {
      case (#ok _) check("CF2: Cumulative/0 accepted", true);
      case (#err e) check("CF2: Cumulative/0 accepted (got err " # e # ")", false);
    };
    let r3 = await createRoom(#BestBall, #Cumulative, 4, "CF Cum 4", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r3) {
      case (#ok _) check("CF3: Cumulative/4 rejected", false);
      case (#err _) check("CF3: Cumulative/4 rejected", true);
    };
    // Family 3: Best Ball / H2H without playoffs requires playoffTeams = 0.
    let r4 = await createRoom(#BestBall, #HeadToHead, 0, "CF H2H 0", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r4) {
      case (#ok _) check("CF4: H2H/0 accepted", true);
      case (#err e) check("CF4: H2H/0 accepted (got err " # e # ")", false);
    };
    // Family 4: Best Ball / H2H with playoffs requires exactly 4, 6, or 8.
    let r5 = await createRoom(#BestBall, #HeadToHead, 4, "CF H2H 4", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r5) {
      case (#ok _) check("CF5: H2H/4 accepted", true);
      case (#err e) check("CF5: H2H/4 accepted (got err " # e # ")", false);
    };
    let r6 = await createRoom(#BestBall, #HeadToHead, 6, "CF H2H 6", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r6) {
      case (#ok _) check("CF6: H2H/6 accepted", true);
      case (#err e) check("CF6: H2H/6 accepted (got err " # e # ")", false);
    };
    let r7 = await createRoom(#BestBall, #HeadToHead, 8, "CF H2H 8", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r7) {
      case (#ok _) check("CF7: H2H/8 accepted", true);
      case (#err e) check("CF7: H2H/8 accepted (got err " # e # ")", false);
    };
    // Invalid H2H playoff counts rejected.
    let r8 = await createRoom(#BestBall, #HeadToHead, 2, "CF H2H 2", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r8) {
      case (#ok _) check("CF8: H2H/2 rejected", false);
      case (#err _) check("CF8: H2H/2 rejected", true);
    };
    let r9 = await createRoom(#BestBall, #HeadToHead, 10, "CF H2H 10", 200, AuctionLib.defaultSettings(), true, null, null, null, null, null, null, 2026, #halfPpr);
    switch (r9) {
      case (#ok _) check("CF9: H2H/10 rejected", false);
      case (#err _) check("CF9: H2H/10 rejected", true);
    };
  };

  // ── endAuction H2H playoff validation tests ───────────────────────────────

  // endAuction rejects playoffTeams > participant count.
  func testEndAuctionPlayoffTeamsExceedsParticipants() : async () {
    // 4 participants, playoffTeams = 8 (> 4).
    let room = makeRoom("ea1", #Active, #BestBall, #HeadToHead, 8, [me, otherP, thirdP, p4]);
    let pm = [
      (me, makeParticipant(me, "Me", [])),
      (otherP, makeParticipant(otherP, "Other", [])),
      (thirdP, makeParticipant(thirdP, "Third", [])),
      (p4, makeParticipant(p4, "P4", [])),
    ];
    registerRoomNoConfig(room, pm);
    let res = await endAuction("ea1", ?1);
    switch (res) {
      case (#ok _) check("EA1: playoffTeams > participants rejected", false);
      case (#err e) check("EA1: playoffTeams > participants rejected", e == "playoffTeams cannot exceed the number of participants");
    };
  };

  // Floor check exact worked case: 8 participants / 8-team playoffs.
  // regularSeasonEnd(8)=14, numberOfRounds(8)=7.
  //   startWeek=8: 14-8+1=7 >= 7 → ACCEPT
  //   startWeek=9: 14-9+1=6 < 7  → REJECT
  func testEndAuctionFloorWorkedCase() : async () {
    let eight = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    let pm = [
      (me, makeParticipant(me, "Me", [])),
      (otherP, makeParticipant(otherP, "Other", [])),
      (thirdP, makeParticipant(thirdP, "Third", [])),
      (p4, makeParticipant(p4, "P4", [])),
      (p5, makeParticipant(p5, "P5", [])),
      (p6, makeParticipant(p6, "P6", [])),
      (p7, makeParticipant(p7, "P7", [])),
      (p8, makeParticipant(p8, "P8", [])),
    ];
    // startWeek = 8 → accept.
    let room8 = makeRoom("ea8", #Active, #BestBall, #HeadToHead, 8, eight);
    registerRoomNoConfig(room8, pm);
    let res8 = await endAuction("ea8", ?8);
    switch (res8) {
      case (#err e) check("EA8: startWeek 8 accepted (got err " # e # ")", false);
      case (#ok _) check("EA8: startWeek 8 accepted", true);
    };
    // startWeek = 9 → reject.
    let room9 = makeRoom("ea9", #Active, #BestBall, #HeadToHead, 8, eight);
    registerRoomNoConfig(room9, pm);
    let res9 = await endAuction("ea9", ?9);
    switch (res9) {
      case (#ok _) check("EA9: startWeek 9 rejected", false);
      case (#err e) check("EA9: startWeek 9 rejected", e == "Not enough weeks for a full regular season before playoffs begin");
    };
  };

  // Underflow guard: a start week later than regularSeasonEnd(playoffTeams)
  // must return a clean #err, not trap on Nat underflow. regularSeasonEnd
  // differs per playoff size: 4→15, 6→14, 8→14.
  func testEndAuctionLateStartWeekUnderflow() : async () {
    // 4-team playoffs: regularSeasonEnd(4)=15, numberOfRounds(4)=3.
    // startWeek=16 (> 15) → must #err, not trap.
    let four = [me, otherP, thirdP, p4];
    let pm4 = [
      (me, makeParticipant(me, "Me", [])),
      (otherP, makeParticipant(otherP, "Other", [])),
      (thirdP, makeParticipant(thirdP, "Third", [])),
      (p4, makeParticipant(p4, "P4", [])),
    ];
    let room4 = makeRoom("ea4u", #Active, #BestBall, #HeadToHead, 4, four);
    registerRoomNoConfig(room4, pm4);
    let res4 = await endAuction("ea4u", ?16);
    switch (res4) {
      case (#ok _) check("EA4U: late startWeek 16 rejected (4-team)", false);
      case (#err e) check("EA4U: late startWeek 16 rejected (4-team)", e == "Not enough weeks for a full regular season before playoffs begin");
    };

    // 6-team playoffs: regularSeasonEnd(6)=14, numberOfRounds(6)=5.
    // startWeek=15 (> 14) → must #err, not trap.
    let six = [me, otherP, thirdP, p4, p5, p6];
    let pm6 = [
      (me, makeParticipant(me, "Me", [])),
      (otherP, makeParticipant(otherP, "Other", [])),
      (thirdP, makeParticipant(thirdP, "Third", [])),
      (p4, makeParticipant(p4, "P4", [])),
      (p5, makeParticipant(p5, "P5", [])),
      (p6, makeParticipant(p6, "P6", [])),
    ];
    let room6 = makeRoom("ea6u", #Active, #BestBall, #HeadToHead, 6, six);
    registerRoomNoConfig(room6, pm6);
    let res6 = await endAuction("ea6u", ?15);
    switch (res6) {
      case (#ok _) check("EA6U: late startWeek 15 rejected (6-team)", false);
      case (#err e) check("EA6U: late startWeek 15 rejected (6-team)", e == "Not enough weeks for a full regular season before playoffs begin");
    };

    // 8-team playoffs: regularSeasonEnd(8)=14, numberOfRounds(8)=7.
    // startWeek=17 (> 14) → must #err, not trap.
    let eight = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    let pm8 = [
      (me, makeParticipant(me, "Me", [])),
      (otherP, makeParticipant(otherP, "Other", [])),
      (thirdP, makeParticipant(thirdP, "Third", [])),
      (p4, makeParticipant(p4, "P4", [])),
      (p5, makeParticipant(p5, "P5", [])),
      (p6, makeParticipant(p6, "P6", [])),
      (p7, makeParticipant(p7, "P7", [])),
      (p8, makeParticipant(p8, "P8", [])),
    ];
    let room8 = makeRoom("ea8u", #Active, #BestBall, #HeadToHead, 8, eight);
    registerRoomNoConfig(room8, pm8);
    let res8 = await endAuction("ea8u", ?17);
    switch (res8) {
      case (#ok _) check("EA8U: late startWeek 17 rejected (8-team)", false);
      case (#err e) check("EA8U: late startWeek 17 rejected (8-team)", e == "Not enough weeks for a full regular season before playoffs begin");
    };
  };

  // Boundary: startWeek == regularSeasonEnd(playoffTeams) is NOT caught by the
  // new guard (guard is strictly `>`); it is evaluated by the existing floor
  // logic normally. For 8-team playoffs, regularSeasonEnd(8)=14, numberOfRounds(8)=7,
  // so startWeek=14 gives 14-14+1=1 < 7 → floor REJECT (no trap, not the guard).
  func testEndAuctionBoundaryStartWeekEqualsRegularSeasonEnd() : async () {
    let eight = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    let pm8 = [
      (me, makeParticipant(me, "Me", [])),
      (otherP, makeParticipant(otherP, "Other", [])),
      (thirdP, makeParticipant(thirdP, "Third", [])),
      (p4, makeParticipant(p4, "P4", [])),
      (p5, makeParticipant(p5, "P5", [])),
      (p6, makeParticipant(p6, "P6", [])),
      (p7, makeParticipant(p7, "P7", [])),
      (p8, makeParticipant(p8, "P8", [])),
    ];
    let room = makeRoom("eabnd", #Active, #BestBall, #HeadToHead, 8, eight);
    registerRoomNoConfig(room, pm8);
    let res = await endAuction("eabnd", ?14);
    switch (res) {
      case (#ok _) check("EABND: startWeek == regularSeasonEnd floor-rejected", false);
      case (#err e) check("EABND: startWeek == regularSeasonEnd floor-rejected (no trap)", e == "Not enough weeks for a full regular season before playoffs begin");
    };
  };

  // #Cumulative rooms and #HeadToHead rooms without playoffs skip the Phase 12a
  // H2H floor-check block entirely, so a late start week is NOT caught by the
  // new guard — only the 1..17 range check applies. Confirm endAuction behavior
  // is unchanged for both.
  func testEndAuctionNonPlayoffUnaffected() : async () {
    // #Cumulative room: startWeek=17 (late) is accepted (only 1..17 range applies).
    let cum = makeRoom("eacum", #Active, #BestBall, #Cumulative, 0, [me]);
    registerRoomNoConfig(cum, [(me, makeParticipant(me, "Me", []))]);
    let resCum = await endAuction("eacum", ?17);
    switch (resCum) {
      case (#err e) check("EACUM: cumulative late startWeek 17 accepted (got err " # e # ")", false);
      case (#ok _) check("EACUM: cumulative late startWeek 17 accepted", true);
    };

    // #HeadToHead room without playoffs (playoffTeams=0): startWeek=17 accepted.
    let h2h0 = makeRoom("eah2h0", #Active, #BestBall, #HeadToHead, 0, [me]);
    registerRoomNoConfig(h2h0, [(me, makeParticipant(me, "Me", []))]);
    let resH2H0 = await endAuction("eah2h0", ?17);
    switch (resH2H0) {
      case (#err e) check("EAH2H0: H2H no-playoff late startWeek 17 accepted (got err " # e # ")", false);
      case (#ok _) check("EAH2H0: H2H no-playoff late startWeek 17 accepted", true);
    };
  };

  // ── getH2HStandings tests ─────────────────────────────────────────────────

  // Unsynced week produces no result; genuine ties recorded correctly.
  func testH2HStandingsResults() : async () {
    clearStats();
    markLive([1, 3]);
    let room = makeRoom("h1", #Completed, #BestBall, #HeadToHead, 0, [me, otherP]);
    let pMe = makeParticipant(me, "Me", [won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE")]);
    let pOther = makeParticipant(otherP, "Other", [won("QB2", "QB"), won("RB2", "RB"), won("WR2", "WR"), won("TE2", "TE")]);
    registerRoom(room, [(me, pMe), (otherP, pOther)], ?{ startWeek = 1 });
    // Week 1: Me=30, Other=20 → Me wins.
    addStats(ptsStats("QB1", 1, 12.0)); addStats(ptsStats("RB1", 1, 8.0)); addStats(ptsStats("WR1", 1, 7.0)); addStats(ptsStats("TE1", 1, 3.0));
    addStats(ptsStats("QB2", 1, 10.0)); addStats(ptsStats("RB2", 1, 5.0)); addStats(ptsStats("WR2", 1, 3.0)); addStats(ptsStats("TE2", 1, 2.0));
    // Week 2: unsynced (no stats) → no result.
    // Week 3: Me=20, Other=20 → tie.
    addStats(ptsStats("QB1", 3, 8.0)); addStats(ptsStats("RB1", 3, 5.0)); addStats(ptsStats("WR1", 3, 4.0)); addStats(ptsStats("TE1", 3, 3.0));
    addStats(ptsStats("QB2", 3, 8.0)); addStats(ptsStats("RB2", 3, 5.0)); addStats(ptsStats("WR2", 3, 4.0)); addStats(ptsStats("TE2", 3, 3.0));

    let res = await getH2HStandings("h1");
    switch (res) {
      case (#err e) check("H1: getH2HStandings ok (got err " # e # ")", false);
      case (#ok entries) {
        check("H1: two entries", entries.size() == 2);
        switch (findH2H(entries, me)) {
          case (?e) {
            check("H1: Me wins 1", e.wins == 1);
            check("H1: Me losses 0", e.losses == 0);
            check("H1: Me ties 1", e.ties == 1);
            check("H1: Me pointsFor 50", approxEq(e.pointsFor, 50.0));
            check("H1: Me gamesPlayed 2 (unsynced week excluded)", e.gamesPlayed == 2);
          };
          case null check("H1: Me present", false);
        };
        switch (findH2H(entries, otherP)) {
          case (?e) {
            check("H1: Other wins 0", e.wins == 0);
            check("H1: Other losses 1", e.losses == 1);
            check("H1: Other ties 1", e.ties == 1);
            check("H1: Other pointsFor 40", approxEq(e.pointsFor, 40.0));
            check("H1: Other gamesPlayed 2", e.gamesPlayed == 2);
          };
          case null check("H1: Other present", false);
        };
      };
    };
  };

  // Deterministic ordering: wins desc, pointsFor desc, Principal asc.
  // Me scores 100 every week, Other 50, Third 10 — so regardless of which
  // specific matchups the circle method produces, Me beats whoever it plays,
  // Other beats Third, and Third beats nobody. Over one full 3-week cycle
  // (numberOfRounds(3)=3) the win counts are forced: Me 2, Other 1, Third 0.
  func testH2HStandingsOrdering() : async () {
    clearStats();
    markLive([1, 2, 3]);
    let room = makeRoom("h2", #Completed, #BestBall, #HeadToHead, 0, [me, otherP, thirdP]);
    let pMe = makeParticipant(me, "Me", [won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE")]);
    let pOther = makeParticipant(otherP, "Other", [won("QB2", "QB"), won("RB2", "RB"), won("WR2", "WR"), won("TE2", "TE")]);
    let pThird = makeParticipant(thirdP, "Third", [won("QB3", "QB"), won("RB3", "RB"), won("WR3", "WR"), won("TE3", "TE")]);
    registerRoom(room, [(me, pMe), (otherP, pOther), (thirdP, pThird)], ?{ startWeek = 1 });
    // Weeks 1..3 (one full cycle): Me=100, Other=50, Third=10 each week.
    var w = 1;
    while (w <= 3) {
      addStats(ptsStats("QB1", w, 40.0)); addStats(ptsStats("RB1", w, 30.0)); addStats(ptsStats("WR1", w, 20.0)); addStats(ptsStats("TE1", w, 10.0));
      addStats(ptsStats("QB2", w, 20.0)); addStats(ptsStats("RB2", w, 15.0)); addStats(ptsStats("WR2", w, 10.0)); addStats(ptsStats("TE2", w, 5.0));
      addStats(ptsStats("QB3", w, 4.0));  addStats(ptsStats("RB3", w, 3.0));  addStats(ptsStats("WR3", w, 2.0));  addStats(ptsStats("TE3", w, 1.0));
      w += 1;
    };
    let res = await getH2HStandings("h2");
    switch (res) {
      case (#err e) check("H2: getH2HStandings ok (got err " # e # ")", false);
      case (#ok entries) {
        check("H2: three entries", entries.size() == 3);
        // Me has 2 wins → rank 1.
        check("H2: rank 1 is Me", entries[0].participant == me);
        // Other has 1 win → rank 2.
        check("H2: rank 2 is Other", entries[1].participant == otherP);
        // Third has 0 wins → rank 3.
        check("H2: rank 3 is Third", entries[2].participant == thirdP);
        switch (findH2H(entries, me)) {
          case (?e) {
            check("H2: Me wins 2", e.wins == 2);
            check("H2: Me pointsFor 200", approxEq(e.pointsFor, 200.0));
          };
          case null check("H2: Me present", false);
        };
      };
    };
  };

  // getH2HStandings rejects non-H2H rooms.
  func testH2HStandingsRejectsNonH2H() : async () {
    clearStats();
    // A #Cumulative Best Ball room.
    let room = makeRoom("h3", #Completed, #BestBall, #Cumulative, 0, [me]);
    let pMe = makeParticipant(me, "Me", []);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });
    let res = await getH2HStandings("h3");
    switch (res) {
      case (#ok _) check("H3: getH2HStandings rejects cumulative room", false);
      case (#err e) check("H3: getH2HStandings rejects cumulative room", e == "Room is not a Head-to-Head Best Ball room");
    };
    // An #Auction room.
    let roomA = makeRoom("h4", #Completed, #Auction, #Cumulative, 0, [me]);
    registerRoom(roomA, [(me, pMe)], null);
    let resA = await getH2HStandings("h4");
    switch (resA) {
      case (#ok _) check("H3: getH2HStandings rejects auction room", false);
      case (#err e) check("H3: getH2HStandings rejects auction room", e == "Room is not a Head-to-Head Best Ball room");
    };
  };

  // getStandings / getWeeklyStandings reject H2H rooms.
  func testCumulativeRejectsH2H() : async () {
    clearStats();
    let room = makeRoom("h5", #Completed, #BestBall, #HeadToHead, 0, [me]);
    let pMe = makeParticipant(me, "Me", [won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE")]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });
    addStats(ptsStats("QB1", 1, 10.0));
    let s = await getStandings("h5");
    switch (s) {
      case (#ok _) check("H5: getStandings rejects H2H room", false);
      case (#err e) check("H5: getStandings rejects H2H room", e == "Room is a Head-to-Head room; use getH2HStandings");
    };
    let ws = await getWeeklyStandings("h5", 1);
    switch (ws) {
      case (#ok _) check("H5: getWeeklyStandings rejects H2H room", false);
      case (#err e) check("H5: getWeeklyStandings rejects H2H room", e == "Room is a Head-to-Head room; use getH2HStandings");
    };
  };

  // ── Cumulative regression test ────────────────────────────────────────────
  // A #Cumulative room's getStandings still sums startWeek..FINAL_WEEK unchanged.
  func testCumulativeRegression() : async () {
    clearStats();
    markLive([1, 2]);
    let room = makeRoom("cr1", #Completed, #BestBall, #Cumulative, 0, [me]);
    let pMe = makeParticipant(me, "Me", [won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE")]);
    registerRoom(room, [(me, pMe)], ?{ startWeek = 1 });
    // Weeks 1 and 2 synced (23 each); weeks 3-17 unsynced (0). Cumulative = 46.
    addStats(ptsStats("QB1", 1, 10.0)); addStats(ptsStats("QB1", 2, 10.0));
    addStats(ptsStats("RB1", 1, 5.0));  addStats(ptsStats("RB1", 2, 5.0));
    addStats(ptsStats("WR1", 1, 5.0));  addStats(ptsStats("WR1", 2, 5.0));
    addStats(ptsStats("TE1", 1, 3.0));  addStats(ptsStats("TE1", 2, 3.0));
    let res = await getStandings("cr1");
    switch (res) {
      case (#err e) check("CR1: cumulative getStandings ok (got err " # e # ")", false);
      case (#ok entries) {
        check("CR1: one entry", entries.size() == 1);
        switch (findStanding(entries, me)) {
          case (?e) check("CR1: cumulative sums startWeek..FINAL_WEEK unchanged (46)", approxEq(e.totalPoints, 46.0));
          case null check("CR1: Me present", false);
        };
      };
    };
  };

  // ── Phase 11 verification test ────────────────────────────────────────────
  // isWeekFinalized / isSeasonFinal still work under the derived calendar
  // (startWeek..FINAL_WEEK, no stored endWeek). Verified: no change needed.
  func testPhase11DerivedCalendar() {
    syncStatuses.clear();
    // A #Cumulative Best Ball room with startWeek = 1, and one with startWeek = 5.
    let room = makeRoom("p11", #Completed, #BestBall, #Cumulative, 0, [me]);
    rooms.add("p11", room);
    bestBallConfigs.add("p11", { startWeek = 1 });
    let roomB = makeRoom("p11b", #Completed, #BestBall, #Cumulative, 0, [me]);
    rooms.add("p11b", roomB);
    bestBallConfigs.add("p11b", { startWeek = 5 });
    // Nothing finalized → neither room is final.
    check("P11: not final before any week finalized", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "p11"));
    check("P11: startWeek 5 room not final before any week finalized", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "p11b"));
    // Finalize weeks 1..4 only.
    var w = 1;
    while (w <= 4) {
      ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, w, #finalized, null, ?0);
      w += 1;
    };
    check("P11: isWeekFinalized true for week 1", SyncStatusLib.isWeekFinalized(syncStatuses, season, 1));
    // p11 (startWeek=1) still not final — weeks 5..17 unfinalized.
    check("P11: startWeek 1 room not final with only weeks 1-4 finalized", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "p11"));
    // p11b (startWeek=5) not final — weeks 5..17 unfinalized.
    check("P11: startWeek 5 room not final with only weeks 1-4 finalized", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "p11b"));
    // Finalize weeks 5..17.
    w := 5;
    while (w <= AuctionLib.FINAL_WEEK) {
      ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, w, #finalized, null, ?0);
      w += 1;
    };
    check("P11: startWeek 1 room final when all weeks finalized", SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "p11"));
    check("P11: startWeek 5 room final when all weeks finalized", SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "p11b"));
  };

  // ── Phase 12b: playoff bracket tests ──────────────────────────────────────

  // Bracket shape + week assignments for 4/6/8 teams, matching the calendar
  // exactly as specified (weeks fall out of playoffStartWeek/playoffRounds).
  func testPlayoffBracketShape() {
    // 4-team: playoffStartWeek(4)=16. Semis w16, championship w17.
    let b4 = H2HLib.playoffBracket(4, H2HLib.playoffStartWeek(4));
    check("PB4A: 3 games", b4.size() == 3);
    check("PB4B: game0 S1vS4 w16", b4[0].home == #Seed 1 and b4[0].away == #Seed 4 and b4[0].week == 16);
    check("PB4C: game1 S2vS3 w16", b4[1].home == #Seed 2 and b4[1].away == #Seed 3 and b4[1].week == 16);
    check("PB4D: game2 w0vw1 w17", b4[2].home == #WinnerOf 0 and b4[2].away == #WinnerOf 1 and b4[2].week == 17);

    // 6-team: playoffStartWeek(6)=15. R1 w15, semis w16, championship w17.
    let b6 = H2HLib.playoffBracket(6, H2HLib.playoffStartWeek(6));
    check("PB6A: 5 games", b6.size() == 5);
    check("PB6B: game0 S3vS6 w15", b6[0].home == #Seed 3 and b6[0].away == #Seed 6 and b6[0].week == 15);
    check("PB6C: game1 S4vS5 w15", b6[1].home == #Seed 4 and b6[1].away == #Seed 5 and b6[1].week == 15);
    check("PB6D: game2 S1vw1 w16", b6[2].home == #Seed 1 and b6[2].away == #WinnerOf 1 and b6[2].week == 16);
    check("PB6E: game3 S2vw0 w16", b6[3].home == #Seed 2 and b6[3].away == #WinnerOf 0 and b6[3].week == 16);
    check("PB6F: game4 w2vw3 w17", b6[4].home == #WinnerOf 2 and b6[4].away == #WinnerOf 3 and b6[4].week == 17);

    // 8-team: playoffStartWeek(8)=15. QF w15, semis w16, championship w17.
    let b8 = H2HLib.playoffBracket(8, H2HLib.playoffStartWeek(8));
    check("PB8A: 7 games", b8.size() == 7);
    check("PB8B: QF all w15", b8[0].week == 15 and b8[1].week == 15 and b8[2].week == 15 and b8[3].week == 15);
    check("PB8C: QF pairings", b8[0].home == #Seed 1 and b8[0].away == #Seed 8 and b8[1].home == #Seed 4 and b8[1].away == #Seed 5 and b8[2].home == #Seed 3 and b8[2].away == #Seed 6 and b8[3].home == #Seed 2 and b8[3].away == #Seed 7);
    check("PB8D: SF both w16", b8[4].week == 16 and b8[5].week == 16);
    check("PB8E: SF pairings", b8[4].home == #WinnerOf 0 and b8[4].away == #WinnerOf 1 and b8[5].home == #WinnerOf 2 and b8[5].away == #WinnerOf 3);
    check("PB8F: champ w17", b8[6].home == #WinnerOf 4 and b8[6].away == #WinnerOf 5 and b8[6].week == 17);
  };

  // 1-based seed indexing: #Seed 1 maps to standings index 0, #Seed 8 to index 7.
  func testSeedIndexing() : async () {
    clearStats();
    markLive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    let users = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    registerPlayoffRoom("seed1", 8, users);
    // Distinct regular-season scores so the standings ordering is deterministic.
    var w = 1;
    while (w <= 14) {
      var i = 0;
      while (i < 8) {
        setParticipantWeekScore(i, w, 100.0 + i.toFloat());
        i += 1;
      };
      w += 1;
    };
    let standings = switch (await getH2HStandings("seed1")) {
      case (#err e) { check("SEED: standings ok", false); return };
      case (#ok s) s;
    };
    let bracket = switch (await getPlayoffBracket("seed1")) {
      case (#err e) { check("SEED: bracket ok", false); return };
      case (#ok b) b;
    };
    // Game 0 home = Seed 1 → standings index 0 (NOT index 1).
    switch (bracket.games[0].home) {
      case (#resolved c) check("SEED: #Seed 1 maps to standings index 0", c.participant == standings[0].participant and c.seed == 1);
      case _ check("SEED: game0 home resolved", false);
    };
    // Game 0 away = Seed 8 → standings index 7.
    switch (bracket.games[0].away) {
      case (#resolved c) check("SEED: #Seed 8 maps to standings index 7", c.participant == standings[7].participant and c.seed == 8);
      case _ check("SEED: game0 away resolved", false);
    };
  };

  // 6-team byes: Seeds 1 and 2 resolve immediately with no game/sync dependency.
  func testSixTeamByes() : async () {
    clearStats();
    syncStatuses.clear();
    let users = [me, otherP, thirdP, p4, p5, p6];
    registerPlayoffRoom("bye6", 6, users);
    // No weeks synced — no game can resolve, but Seeds 1-2 must still resolve.
    let bracket = switch (await getPlayoffBracket("bye6")) {
      case (#err e) { check("BYE: bracket ok", false); return };
      case (#ok b) b;
    };
    // Game 2 home = Seed 1 → resolved immediately, no sync dependency.
    switch (bracket.games[2].home) {
      case (#resolved c) check("BYE: Seed 1 resolves immediately (no sync)", c.seed == 1);
      case _ check("BYE: Seed 1 home resolved", false);
    };
    // Game 3 home = Seed 2 → resolved immediately, no sync dependency.
    switch (bracket.games[3].home) {
      case (#resolved c) check("BYE: Seed 2 resolves immediately (no sync)", c.seed == 2);
      case _ check("BYE: Seed 2 home resolved", false);
    };
    // Game 2 away = winner(1): both underlying slots resolved, week 15 unsynced → pendingOnSync.
    switch (bracket.games[2].away) {
      case (#pendingOnSync) check("BYE: winner(1) pendingOnSync (week unsynced)", true);
      case _ check("BYE: winner(1) pendingOnSync", false);
    };
    // Game 2 status: home resolved, away pendingOnSync → pendingOnDependency.
    switch (bracket.games[2].status) {
      case (#pendingOnDependency) check("BYE: game2 pendingOnDependency", true);
      case _ check("BYE: game2 pendingOnDependency", false);
    };
  };

  // pending-on-sync: both slots resolved but the week is unsynced.
  func testPendingOnSync() : async () {
    clearStats();
    syncStatuses.clear();
    let users = [me, otherP, thirdP, p4, p5, p6];
    registerPlayoffRoom("pos6", 6, users);
    // No weeks synced.
    let bracket = switch (await getPlayoffBracket("pos6")) {
      case (#err e) { check("POS: bracket ok", false); return };
      case (#ok b) b;
    };
    // Game 0 (Seed3 v Seed6, week 15): both slots resolved, week unsynced → pendingOnSync.
    switch (bracket.games[0].status) {
      case (#pendingOnSync) check("POS: game0 pendingOnSync (both slots known, week unsynced)", true);
      case _ check("POS: game0 pendingOnSync", false);
    };
    switch (bracket.games[0].home) {
      case (#resolved _) check("POS: game0 home resolved", true);
      case _ check("POS: game0 home resolved", false);
    };
    switch (bracket.games[0].away) {
      case (#resolved _) check("POS: game0 away resolved", true);
      case _ check("POS: game0 away resolved", false);
    };
  };

  // pending-on-dependency: at least one underlying slot unresolved even if that
  // game's own week is synced.
  func testPendingOnDependency() : async () {
    clearStats();
    syncStatuses.clear();
    let users = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    registerPlayoffRoom("pod8", 8, users);
    // Sync week 16 (semifinal week) but NOT week 15 (quarterfinal week).
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 16, #finalized, null, ?0);
    let bracket = switch (await getPlayoffBracket("pod8")) {
      case (#err e) { check("POD: bracket ok", false); return };
      case (#ok b) b;
    };
    // Game 4 (winner(0) v winner(1), week 16): week 16 synced, but the winners are
    // unresolved because week 15 (QF) is unsynced → pendingOnDependency.
    switch (bracket.games[4].status) {
      case (#pendingOnDependency) check("POD: game4 pendingOnDependency (week synced but slots unresolved)", true);
      case _ check("POD: game4 pendingOnDependency", false);
    };
    // Game 0 (QF, week 15): both slots resolved, week 15 unsynced → pendingOnSync.
    switch (bracket.games[0].status) {
      case (#pendingOnSync) check("POD: game0 pendingOnSync", true);
      case _ check("POD: game0 pendingOnSync", false);
    };
  };

  // Seed-carryforward tie-break: an upset winner (worse seed) advances, then ties
  // a better-seeded opponent — the better original seed advances.
  func testSeedCarryforwardTieBreak() : async () {
    clearStats();
    syncStatuses.clear();
    markLive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    let users = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    registerPlayoffRoom("tie8", 8, users);
    // Regular season weeks 1-14: participant i scores 100+i → seed order by score.
    // Seed 1 = users[7] (p8), Seed 4 = users[4] (p5), Seed 8 = users[0] (me).
    var w = 1;
    while (w <= 14) {
      var i = 0;
      while (i < 8) {
        setParticipantWeekScore(i, w, 100.0 + i.toFloat());
        i += 1;
      };
      w += 1;
    };
    // Week 15 QF: upset — Seed 8 (me) beats Seed 1 (p8); Seed 4 (p5) beats Seed 5 (p4).
    setParticipantWeekScore(0, 15, 50.0); setParticipantWeekScore(7, 15, 10.0);
    setParticipantWeekScore(4, 15, 50.0); setParticipantWeekScore(3, 15, 10.0);
    // Other QF games (Game 2: p6 v thirdP; Game 3: p7 v otherP).
    setParticipantWeekScore(5, 15, 40.0); setParticipantWeekScore(2, 15, 20.0);
    setParticipantWeekScore(6, 15, 40.0); setParticipantWeekScore(1, 15, 20.0);
    // Week 16 SF: me (seed 8) ties p5 (seed 4) → p5 advances (4 < 8).
    setParticipantWeekScore(0, 16, 30.0); setParticipantWeekScore(4, 16, 30.0);
    setParticipantWeekScore(5, 16, 30.0); setParticipantWeekScore(6, 16, 30.0);
    // Populate the finalized-score cache for the finalized weeks so bracket
    // resolution reads the same values the optimizer would produce.
    cacheWeek("tie8", 15, users, [50.0, 20.0, 20.0, 10.0, 50.0, 40.0, 40.0, 10.0]);
    cacheWeek("tie8", 16, users, [30.0, 0.0, 0.0, 0.0, 30.0, 30.0, 30.0, 0.0]);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 15, #finalized, null, ?0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 16, #finalized, null, ?0);
    let bracket = switch (await getPlayoffBracket("tie8")) {
      case (#err e) { check("TIE: bracket ok", false); return };
      case (#ok b) b;
    };
    // Game 4 (SF): winner(0)=me(seed8) v winner(1)=p5(seed4), week 16, tie → p5 advances.
    switch (bracket.games[4].status) {
      case (#resolved r) check("TIE: game4 winner is p5 (better seed 4)", r.winner == p5);
      case _ check("TIE: game4 resolved", false);
    };
    // Game 4 home slot = winner(0) = me with seed 8 carried forward.
    switch (bracket.games[4].home) {
      case (#resolved c) check("TIE: home carries seed 8", c.participant == me and c.seed == 8);
      case _ check("TIE: game4 home resolved", false);
    };
  };

  // Full end-to-end 8-team bracket: QF through championship, champion resolves.
  func testFullEightTeamBracket() : async () {
    clearStats();
    syncStatuses.clear();
    markLive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    let users = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    registerPlayoffRoom("full8", 8, users);
    // Seed order by regular-season score: Seed 1 = users[7] (p8), ..., Seed 8 = users[0] (me).
    var w = 1;
    while (w <= 14) {
      var i = 0;
      while (i < 8) {
        setParticipantWeekScore(i, w, 100.0 + i.toFloat());
        i += 1;
      };
      w += 1;
    };
    // Week 15 QF: higher seeds win.
    setParticipantWeekScore(7, 15, 50.0); setParticipantWeekScore(0, 15, 10.0); // S1 beats S8
    setParticipantWeekScore(4, 15, 50.0); setParticipantWeekScore(3, 15, 10.0); // S4 beats S5
    setParticipantWeekScore(5, 15, 50.0); setParticipantWeekScore(2, 15, 10.0); // S3 beats S6
    setParticipantWeekScore(6, 15, 50.0); setParticipantWeekScore(1, 15, 10.0); // S2 beats S7
    // Week 16 SF: S1 beats S4; S2 beats S3.
    setParticipantWeekScore(7, 16, 50.0); setParticipantWeekScore(4, 16, 10.0);
    setParticipantWeekScore(6, 16, 50.0); setParticipantWeekScore(5, 16, 10.0);
    // Week 17 champ: S1 beats S2.
    setParticipantWeekScore(7, 17, 50.0); setParticipantWeekScore(6, 17, 10.0);
    // Populate the finalized-score cache for the finalized weeks so bracket
    // resolution reads the same values the optimizer would produce.
    cacheWeek("full8", 15, users, [10.0, 10.0, 10.0, 10.0, 50.0, 50.0, 50.0, 50.0]);
    cacheWeek("full8", 16, users, [0.0, 0.0, 0.0, 0.0, 10.0, 10.0, 50.0, 50.0]);
    cacheWeek("full8", 17, users, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 10.0, 50.0]);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 15, #finalized, null, ?0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 16, #finalized, null, ?0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 17, #finalized, null, ?0);
    let bracket = switch (await getPlayoffBracket("full8")) {
      case (#err e) { check("FULL8: bracket ok", false); return };
      case (#ok b) b;
    };
    var allResolved = true;
    for (g in bracket.games.values()) {
      switch (g.status) {
        case (#resolved _) {};
        case _ allResolved := false;
      };
    };
    check("FULL8: all games resolved", allResolved);
    switch (bracket.champion) {
      case (#some c) check("FULL8: champion is p8 (seed 1)", c.participant == p8 and c.seed == 1);
      case (#inProgress) check("FULL8: champion resolved", false);
    };
    switch (bracket.games[6].status) {
      case (#resolved r) check("FULL8: champ game winner p8", r.winner == p8);
      case _ check("FULL8: champ game resolved", false);
    };
  };

  // Instrumented-counter proof that the REAL getPlayoffBracket path makes ZERO
  // calculateOptimalWeeklyLineup calls for an all-finalized 8-team bracket
  // (every finalized week — regular season AND playoffs — reads from the cache
  // via BestBallCachingLib.getFinalizedScore ?? 0.0), and that the counter
  // actually fires (non-zero) for a live-week bracket. This measures the real
  // patched resolveSlot/resolveGame/getPlayoffBracket, not a standalone
  // simulation.
  func testBracketOptimizerCallCounter() : async () {
    // ── All-finalized 8-team bracket: expect ZERO optimizer calls ──────────
    clearStats();
    syncStatuses.clear();
    scores.clear();
    let users = [me, otherP, thirdP, p4, p5, p6, p7, p8];
    registerPlayoffRoom("cnt8", 8, users);
    // Regular season weeks 1-14 finalized: participant i scores 100+i → seed
    // order Seed 1 = users[7] (p8), ..., Seed 8 = users[0] (me).
    var w = 1;
    while (w <= 14) {
      cacheWeek("cnt8", w, users, [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0]);
      ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, w, #finalized, null, ?0);
      w += 1;
    };
    // Playoff weeks 15/16/17 finalized (same winners as testFullEightTeamBracket).
    cacheWeek("cnt8", 15, users, [10.0, 10.0, 10.0, 10.0, 50.0, 50.0, 50.0, 50.0]);
    cacheWeek("cnt8", 16, users, [0.0, 0.0, 0.0, 0.0, 10.0, 10.0, 50.0, 50.0]);
    cacheWeek("cnt8", 17, users, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 10.0, 50.0]);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 15, #finalized, null, ?0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 16, #finalized, null, ?0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 17, #finalized, null, ?0);

    calculateOptimalWeeklyLineupCalls := 0;
    let bracket = switch (await getPlayoffBracket("cnt8")) {
      case (#err e) { check("CNT: bracket ok", false); return };
      case (#ok b) b;
    };
    check("CNT: all-finalized 8-team bracket makes ZERO optimizer calls", calculateOptimalWeeklyLineupCalls == 0);
    var allResolved = true;
    for (g in bracket.games.values()) {
      switch (g.status) {
        case (#resolved _) {};
        case _ allResolved := false;
      };
    };
    check("CNT: all games resolved", allResolved);
    switch (bracket.champion) {
      case (#some c) check("CNT: champion is p8 (seed 1)", c.participant == p8 and c.seed == 1);
      case (#inProgress) check("CNT: champion resolved", false);
    };

    // ── Live-week bracket: expect NON-ZERO optimizer calls ─────────────────
    // Regular season weeks 1-14 finalized (seeding reads cache), but week 15
    // (R1) is live (#partial) so its Seed slots compute dynamically — proving
    // the counter fires on the real path and is not trivially always zero.
    clearStats();
    syncStatuses.clear();
    scores.clear();
    let users6 = [me, otherP, thirdP, p4, p5, p6];
    registerPlayoffRoom("cnt6", 6, users6);
    w := 1;
    while (w <= 14) {
      cacheWeek("cnt6", w, users6, [100.0, 101.0, 102.0, 103.0, 104.0, 105.0]);
      ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, w, #finalized, null, ?0);
      w += 1;
    };
    // Week 15 (R1) live: Seed3 (p4) = 50, Seed6 (me) = 40 → p4 wins from stats.
    setParticipantWeekScore(3, 15, 50.0); setParticipantWeekScore(0, 15, 40.0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 15, #partial, null, ?0);

    calculateOptimalWeeklyLineupCalls := 0;
    let bracketLive = switch (await getPlayoffBracket("cnt6")) {
      case (#err e) { check("CNT: live bracket ok", false); return };
      case (#ok b) b;
    };
    check("CNT: live-week bracket makes NON-ZERO optimizer calls", calculateOptimalWeeklyLineupCalls > 0);
    // Game 0 home = Seed3 (p4): live week → computed dynamically from stats (50).
    switch (bracketLive.games[0].home) {
      case (#resolved c) check("CNT: live game0 home p4 dynamic score 50", c.participant == p4 and approxEq(c.score, 50.0));
      case _ check("CNT: live game0 home resolved", false);
    };
  };

  // Full end-to-end 6-team bracket: Seeds 1-2 enter the semifinal without any
  // Week 15 game, while Seeds 3-6 resolve through the real first-round games.
  func testFullSixTeamBracket() : async () {
    clearStats();
    syncStatuses.clear();
    markLive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    let users = [me, otherP, thirdP, p4, p5, p6];
    registerPlayoffRoom("full6", 6, users);
    // Seed order by regular-season score: Seed 1 = users[5] (p6), Seed 2 = users[4] (p5),
    // Seed 3 = users[3] (p4), Seed 4 = users[2] (thirdP), Seed 5 = users[1] (otherP),
    // Seed 6 = users[0] (me).
    var w = 1;
    while (w <= 14) {
      var i = 0;
      while (i < 6) {
        setParticipantWeekScore(i, w, 100.0 + i.toFloat());
        i += 1;
      };
      w += 1;
    };
    // Week 15 R1: Seed3 (p4) beats Seed6 (me); Seed4 (thirdP) beats Seed5 (otherP).
    setParticipantWeekScore(3, 15, 50.0); setParticipantWeekScore(0, 15, 10.0);
    setParticipantWeekScore(2, 15, 50.0); setParticipantWeekScore(1, 15, 10.0);
    // Week 16 SF: Seed1 (p6) beats winner(1)=thirdP; Seed2 (p5) beats winner(0)=p4.
    setParticipantWeekScore(5, 16, 50.0); setParticipantWeekScore(2, 16, 10.0);
    setParticipantWeekScore(4, 16, 50.0); setParticipantWeekScore(3, 16, 10.0);
    // Week 17 champ: Seed1 (p6) beats Seed2 (p5).
    setParticipantWeekScore(5, 17, 50.0); setParticipantWeekScore(4, 17, 10.0);
    // Populate the finalized-score cache for the finalized weeks so bracket
    // resolution reads the same values the optimizer would produce.
    cacheWeek("full6", 15, users, [10.0, 10.0, 50.0, 50.0, 0.0, 0.0]);
    cacheWeek("full6", 16, users, [0.0, 0.0, 10.0, 10.0, 50.0, 50.0]);
    cacheWeek("full6", 17, users, [0.0, 0.0, 0.0, 0.0, 10.0, 50.0]);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 15, #finalized, null, ?0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 16, #finalized, null, ?0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 17, #finalized, null, ?0);
    let bracket = switch (await getPlayoffBracket("full6")) {
      case (#err e) { check("FULL6: bracket ok", false); return };
      case (#ok b) b;
    };
    var allResolved = true;
    for (g in bracket.games.values()) {
      switch (g.status) {
        case (#resolved _) {};
        case _ allResolved := false;
      };
    };
    check("FULL6: all games resolved", allResolved);
    switch (bracket.champion) {
      case (#some c) check("FULL6: champion is p6 (seed 1)", c.participant == p6 and c.seed == 1);
      case (#inProgress) check("FULL6: champion resolved", false);
    };
    // Seeds 1-2 occupy semifinal slots directly (Game 2 home = p6, Game 3 home = p5).
    switch (bracket.games[2].home) {
      case (#resolved c) check("FULL6: game2 home is Seed1 (p6)", c.participant == p6 and c.seed == 1);
      case _ check("FULL6: game2 home resolved", false);
    };
    switch (bracket.games[3].home) {
      case (#resolved c) check("FULL6: game3 home is Seed2 (p5)", c.participant == p5 and c.seed == 2);
      case _ check("FULL6: game3 home resolved", false);
    };
  };

  // Live week computes dynamically, never cached: a #Seed slot in a live
  // (#partial) week resolves from the injected stats even when a conflicting
  // cache entry exists. Confirms the bracket never reads the cache for a live
  // week.
  func testLiveWeekComputesDynamically() : async () {
    clearStats();
    syncStatuses.clear();
    scores.clear();
    markLive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    let users = [me, otherP, thirdP, p4, p5, p6];
    registerPlayoffRoom("live6", 6, users);
    // Regular season weeks 1-14 for seeding.
    var w = 1;
    while (w <= 14) {
      var i = 0;
      while (i < 6) {
        setParticipantWeekScore(i, w, 100.0 + i.toFloat());
        i += 1;
      };
      w += 1;
    };
    // Week 15 (R1) live (#partial): Seed slots compute dynamically.
    // Seed3 (p4) = 50, Seed6 (me) = 40 → p4 wins from stats.
    setParticipantWeekScore(3, 15, 50.0); setParticipantWeekScore(0, 15, 40.0);
    // Conflicting cache entry for p4 week 15 (would make p4 score 10 if read).
    scores.add(BestBallCachingLib.finalizedScoreKey("live6", season, 15, p4), 10.0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 15, #partial, null, ?0);

    let bracket = switch (await getPlayoffBracket("live6")) {
      case (#err e) { check("LIVE: bracket ok", false); return };
      case (#ok b) b;
    };
    // Game 0 home = Seed3 (p4): live week → computed from stats (50), NOT cache (10).
    switch (bracket.games[0].home) {
      case (#resolved c) check("LIVE: game0 home p4 dynamic score 50 (not cache 10)", c.participant == p4 and approxEq(c.score, 50.0));
      case _ check("LIVE: game0 home resolved", false);
    };
    // Game 0 status: week 15 live → pendingOnSync.
    switch (bracket.games[0].status) {
      case (#pendingOnSync) check("LIVE: game0 pendingOnSync (live week)", true);
      case _ check("LIVE: game0 pendingOnSync", false);
    };
  };

  // Mixed case: an earlier round finalized, a later round live, with the later
  // round's #WinnerOf depending on the earlier round. Confirms the finalized
  // side reads from cache, the live side computes dynamically, and recursion
  // does not reintroduce optimizer calls for the finalized side.
  func testMixedFinalizedLive() : async () {
    clearStats();
    syncStatuses.clear();
    scores.clear();
    markLive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    let users = [me, otherP, thirdP, p4, p5, p6];
    registerPlayoffRoom("mixed6", 6, users);
    // Regular season weeks 1-14: participant i scores 100+i → seed order.
    var w = 1;
    while (w <= 14) {
      var i = 0;
      while (i < 6) {
        setParticipantWeekScore(i, w, 100.0 + i.toFloat());
        i += 1;
      };
      w += 1;
    };
    // Week 15 (R1) finalized: cache values DIFFER from stats to prove cache reads.
    //   Game 0: Seed3 (p4) v Seed6 (me). Cache: p4=100, me=10. Stats: p4=10, me=100.
    //   Game 1: Seed4 (thirdP) v Seed5 (otherP). Cache: thirdP=100, otherP=10.
    setParticipantWeekScore(3, 15, 10.0); setParticipantWeekScore(0, 15, 100.0); // stats (would make me win)
    setParticipantWeekScore(2, 15, 10.0); setParticipantWeekScore(1, 15, 100.0);
    cacheWeek("mixed6", 15, users, [10.0, 10.0, 100.0, 100.0, 0.0, 0.0]); // cache (p4, thirdP win)
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 15, #finalized, null, ?0);
    // Week 16 (SF) live: #Seed slots compute dynamically from stats.
    setParticipantWeekScore(5, 16, 50.0); setParticipantWeekScore(4, 16, 40.0);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 16, #partial, null, ?0);

    let bracket = switch (await getPlayoffBracket("mixed6")) {
      case (#err e) { check("MIXED: bracket ok", false); return };
      case (#ok b) b;
    };
    // Game 0 (R1, finalized): winner from cache = p4 (not me, who would win from stats).
    switch (bracket.games[0].status) {
      case (#resolved r) check("MIXED: game0 winner p4 (from cache)", r.winner == p4);
      case _ check("MIXED: game0 resolved", false);
    };
    // Game 2 (SF, live): home = Seed1 (p6) computed dynamically (score 50).
    switch (bracket.games[2].home) {
      case (#resolved c) check("MIXED: game2 home p6 dynamic score 50", c.participant == p6 and approxEq(c.score, 50.0));
      case _ check("MIXED: game2 home resolved", false);
    };
    // Game 2 away = winner(1) = thirdP from cache (score 100), not from stats.
    switch (bracket.games[2].away) {
      case (#resolved c) check("MIXED: game2 away thirdP from cache score 100", c.participant == thirdP and approxEq(c.score, 100.0));
      case _ check("MIXED: game2 away resolved", false);
    };
    // Game 2 status: week 16 live → pendingOnSync.
    switch (bracket.games[2].status) {
      case (#pendingOnSync) check("MIXED: game2 pendingOnSync (live week)", true);
      case _ check("MIXED: game2 pendingOnSync", false);
    };
  };

  // getPlayoffBracket rejects #Cumulative and non-playoff H2H rooms with distinct messages.
  func testPlayoffBracketRejections() : async () {
    clearStats();
    // #Cumulative room.
    let cum = makeRoom("rej1", #Completed, #BestBall, #Cumulative, 0, [me]);
    registerRoom(cum, [(me, makeParticipant(me, "Me", []))], ?{ startWeek = 1 });
    let r1 = await getPlayoffBracket("rej1");
    switch (r1) {
      case (#ok _) check("REJ: cumulative rejected", false);
      case (#err e) check("REJ: cumulative rejected (distinct msg)", e == "Room is a Cumulative room; playoffs require a Head-to-Head room");
    };
    // H2H room with playoffTeams == 0.
    let h2h0 = makeRoom("rej2", #Completed, #BestBall, #HeadToHead, 0, [me]);
    registerRoom(h2h0, [(me, makeParticipant(me, "Me", []))], ?{ startWeek = 1 });
    let r2 = await getPlayoffBracket("rej2");
    switch (r2) {
      case (#ok _) check("REJ: playoffTeams 0 rejected", false);
      case (#err e) check("REJ: playoffTeams 0 rejected (distinct msg)", e == "Room has no playoffs (playoffTeams is 0)");
    };
  };
  // ── Best Ball caching: getH2HStandings reads finalized weeks from cache ──
  // A finalized week's score is read from the cache (not recomputed), while the
  // single live (#partial) week is computed dynamically. This confirms the
  // caching layer applies to H2H standings, not just cumulative standings.
  func testH2HStandingsCaching() : async () {
    clearStats();
    syncStatuses.clear();
    scores.clear();
    let room = makeRoom("hcache", #Completed, #BestBall, #HeadToHead, 0, [me, otherP]);
    let pMe = makeParticipant(me, "Me", [won("QB1", "QB"), won("RB1", "RB"), won("WR1", "WR"), won("TE1", "TE")]);
    let pOther = makeParticipant(otherP, "Other", [won("QB2", "QB"), won("RB2", "RB"), won("WR2", "WR"), won("TE2", "TE")]);
    registerRoom(room, [(me, pMe), (otherP, pOther)], ?{ startWeek = 1 });
    // Week 1 finalized: Me=30, Other=20 → Me wins. Cache those scores.
    addStats(ptsStats("QB1", 1, 12.0)); addStats(ptsStats("RB1", 1, 8.0)); addStats(ptsStats("WR1", 1, 7.0)); addStats(ptsStats("TE1", 1, 3.0));
    addStats(ptsStats("QB2", 1, 10.0)); addStats(ptsStats("RB2", 1, 5.0)); addStats(ptsStats("WR2", 1, 3.0)); addStats(ptsStats("TE2", 1, 2.0));
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 1, #finalized, null, ?0);
    scores.add(BestBallCachingLib.finalizedScoreKey("hcache", season, 1, me), 30.0);
    scores.add(BestBallCachingLib.finalizedScoreKey("hcache", season, 1, otherP), 20.0);
    // Week 2 live (#partial): Me=20, Other=20 → tie.
    addStats(ptsStats("QB1", 2, 8.0)); addStats(ptsStats("RB1", 2, 5.0)); addStats(ptsStats("WR1", 2, 4.0)); addStats(ptsStats("TE1", 2, 3.0));
    addStats(ptsStats("QB2", 2, 8.0)); addStats(ptsStats("RB2", 2, 5.0)); addStats(ptsStats("WR2", 2, 4.0)); addStats(ptsStats("TE2", 2, 3.0));
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, season, 2, #partial, null, ?0);

    let res = await getH2HStandings("hcache");
    switch (res) {
      case (#err e) check("HC: getH2HStandings ok (got err " # e # ")", false);
      case (#ok entries) {
        check("HC: two entries", entries.size() == 2);
        switch (findH2H(entries, me)) {
          case (?e) {
            // Week 1 (cached 30) beats week 2 (computed 20) → 1 win, 1 tie.
            check("HC: Me wins 1", e.wins == 1);
            check("HC: Me losses 0", e.losses == 0);
            check("HC: Me ties 1", e.ties == 1);
            check("HC: Me pointsFor 50 (cached 30 + live 20)", approxEq(e.pointsFor, 50.0));
            check("HC: Me gamesPlayed 2", e.gamesPlayed == 2);
          };
          case null check("HC: Me present", false);
        };
        switch (findH2H(entries, otherP)) {
          case (?e) {
            check("HC: Other wins 0", e.wins == 0);
            check("HC: Other losses 1", e.losses == 1);
            check("HC: Other ties 1", e.ties == 1);
            check("HC: Other pointsFor 40 (cached 20 + live 20)", approxEq(e.pointsFor, 40.0));
            check("HC: Other gamesPlayed 2", e.gamesPlayed == 2);
          };
          case null check("HC: Other present", false);
        };
      };
    };
  };

  // ── Entry point ───────────────────────────────────────────────────────────
  public func runTests() : async () {
    me := await whoAmI();
    adminPrincipalStore.add("admin", me);

    testNumberOfRounds();
    testPlayoffHelpers();
    testOrderedParticipants();
    testScheduleN4();
    testScheduleN5();
    testScheduleN6();
    testScheduleN8();

    await testCreateRoomConfigFamilies();
    await testEndAuctionPlayoffTeamsExceedsParticipants();
    await testEndAuctionFloorWorkedCase();
    await testEndAuctionLateStartWeekUnderflow();
    await testEndAuctionBoundaryStartWeekEqualsRegularSeasonEnd();
    await testEndAuctionNonPlayoffUnaffected();

    await testH2HStandingsResults();
    await testH2HStandingsOrdering();
    await testH2HStandingsCaching();
    await testH2HStandingsRejectsNonH2H();
    await testCumulativeRejectsH2H();
    await testCumulativeRegression();
    testPhase11DerivedCalendar();

    // Phase 12b: playoff bracket.
    testPlayoffBracketShape();
    await testSeedIndexing();
    await testSixTeamByes();
    await testPendingOnSync();
    await testPendingOnDependency();
    await testSeedCarryforwardTieBreak();
    await testFullEightTeamBracket();
    await testBracketOptimizerCallCounter();
    await testFullSixTeamBracket();
    await testLiveWeekComputesDynamically();
    await testMixedFinalizedLive();
    await testPlayoffBracketRejections();

    if (failures > 0) {
      let first = switch (firstFailure) { case (?n) n; case null "unknown" };
      Debug.print("H2H TESTS: " # failures.toText() # " FAILURE(S), first: " # first);
      Runtime.trap("h2h tests failed: " # first);
    } else {
      Debug.print("ALL H2H TESTS PASSED");
    };
  };

  public shared query ({ caller }) func whoAmI() : async Principal { caller };
};
