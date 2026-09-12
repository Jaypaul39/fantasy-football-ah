import Types "../types/auction-types";
import SyncStatusTypes "../types/sync-status";
import SyncStatusLib "../lib/sync-status";
import AuctionLib "../lib/auction-types";
import LineupLib "../lib/lineup";
import BestBallCachingLib "../lib/best-ball-caching";
import BestBallCachingTypes "../types/best-ball-caching";
import AuctionMixin "../mixins/auction-types-api";
import SyncStatusApi "../mixins/sync-status-api";
import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";
import Time "mo:core/Time";

// Phase 10 — Weekly sync detection (hybrid: timer-flagged, admin-executed).
//
// Runs via `mops test` (replica mode) from the app root. This file is an
// unnamed `actor { ... }` with a `public func runTests() : async ()`, the mops
// replica-test convention.
//
// Covers:
//   - partial-vs-finalized lifecycle: a submission with zero usable stats is
//     recorded as #partial (the mutable, non-terminal active state), NOT a
//     terminal/locked state, and remains retry-eligible. `stored == 0`
//     mid-progress must not imply "nothing happened".
//   - atomic guard: a #partial week is retry-eligible (repeated syncs succeed
//     without locking); a #finalized week is terminal and rejects later
//     submissions.
//   - a week receiving 3+ sequential partial syncs remains non-terminal (the
//     first stores data; subsequent syncs within the cooldown window no-op
//     cleanly without error or duplicate writes).
//   - deduplicated (season, week) computation unions ranges across multiple
//     #BestBall rooms, including overlapping ranges on the same season.
//   - syncWeeklyStats upserts stats and returns the stored count while now
//     recording the sync status, and now takes a roomId with participant
//     authorization (global admin OR participant of the room with a matching
//     season) plus a server-side write-coordination cooldown.
//   - participant authorization: success for a room the caller is in; rejection
//     for a roomId they are not a participant of, for a roomId that does not
//     resolve, and when the season param does not match the room's actual
//     season; a finalized week rejects any sync (participant or admin).
//   - cooldown: two calls within the window (first succeeds, second no-ops
//     without error); a call outside the window succeeds normally.
//   - flagNeedingAttention flags only the live (#partial) week, excluding
//     #finalized weeks and #notYetAttempted future weeks.
//
// The sync-status domain logic (lib/sync-status.mo) is pure and tested directly
// with injected state. syncWeeklyStats lives on AuctionMixin, so that test
// instantiates the full mixin state shape main.mo wires.

actor {
  // ── State (mirrors main.mo's wiring) ──────────────────────────────────────
  let syncStatuses = Map.empty<Text, SyncStatusTypes.SyncStatusRecord>();
  let rooms = Map.empty<Types.RoomId, Types.Room>();
  let bestBallConfigs = Map.empty<Types.RoomId, Types.BestBallConfig>();
  let weeklyPlayerStats = Map.empty<Text, Types.WeeklyPlayerStats>();
  let scores = Map.empty<Text, Float>();

  // The caller for every mixin call made from within this actor. Computed once
  // at the start of runTests via a self-call; the same principal is what the
  // mixin's shared methods observe as `caller`.
  var me : Types.UserId = Principal.anonymous();
  let otherP = Principal.fromBlob("\00\00\00\00\00\00\00\00\00\01");

  // ── AuctionMixin state (for the syncWeeklyStats integration test) ─────────
  let participants = Map.empty<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>();
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

  // The Phase 3 calculator closure, wired exactly as main.mo wires it, reading
  // from weeklyPlayerStats (the stats map passed to AuctionMixin).
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
        weeklyPlayerStats.get(playerId # "|" # s.toText() # "|" # w.toText());
      },
    );
  };

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
    lastNotificationWorkerError, processingNotifications, bestBallConfigs,
    weeklyPlayerStats, syncStatuses, finalizePriorPartialWeeks,
  );

  include SyncStatusApi(syncStatuses, rooms, bestBallConfigs, participants, scores, calculateOptimalWeeklyLineup, adminPrincipalStore);

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

  // ── Fixture builders ──────────────────────────────────────────────────────
  func makeRoom(id : Text, season : Nat, gameType : Types.GameType) : Types.Room {
    {
      id;
      name = "Test Room";
      admin = me;
      participants = [];
      state = #Completed;
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

  func statsEntry(playerId : Text, season : Nat, week : Nat) : Types.WeeklyPlayerStats {
    {
      playerId;
      season;
      week;
      passYds = 0;
      passTds = 0;
      ints = 0;
      rushYds = 0;
      rushTds = 0;
      receptions = 0;
      recYds = 0;
      recTds = 0;
      fumblesLost = 0;
      twoPtConversions = 0;
    };
  };

  func hasPair(pairs : [(Nat, Nat)], season : Nat, week : Nat) : Bool {
    pairs.any(func((s, w)) = s == season and w == week);
  };

  // ── computeDedupSeasonWeeks tests ─────────────────────────────────────────
  func testDedupUnionsOverlappingRanges() {
    rooms.clear();
    bestBallConfigs.clear();
    // Room A: season 2026, startWeek 1. Room B: season 2026, startWeek 3.
    // Both seasons run from their startWeek through FINAL_WEEK (17), so the
    // union on the same season is weeks 1..17 (17 unique pairs).
    rooms.add("a", makeRoom("a", 2026, #BestBall));
    rooms.add("b", makeRoom("b", 2026, #BestBall));
    bestBallConfigs.add("a", { startWeek = 1 });
    bestBallConfigs.add("b", { startWeek = 3 });

    let pairs = SyncStatusLib.computeDedupSeasonWeeks(rooms, bestBallConfigs);
    check("D1: 17 unique pairs", pairs.size() == 17);
    check("D1: has (2026,1)", hasPair(pairs, 2026, 1));
    check("D1: has (2026,3)", hasPair(pairs, 2026, 3));
    check("D1: has (2026,17)", hasPair(pairs, 2026, 17));
  };

  func testDedupDistinctSeasons() {
    rooms.clear();
    bestBallConfigs.clear();
    // Room A: season 2025, startWeek 1. Room B: season 2026, startWeek 1.
    // Both run to FINAL_WEEK (17) → 17 + 17 = 34 pairs.
    rooms.add("a", makeRoom("a", 2025, #BestBall));
    rooms.add("b", makeRoom("b", 2026, #BestBall));
    bestBallConfigs.add("a", { startWeek = 1 });
    bestBallConfigs.add("b", { startWeek = 1 });

    let pairs = SyncStatusLib.computeDedupSeasonWeeks(rooms, bestBallConfigs);
    check("D2: 34 unique pairs", pairs.size() == 34);
    check("D2: has (2025,1)", hasPair(pairs, 2025, 1));
    check("D2: has (2026,1)", hasPair(pairs, 2026, 1));
  };

  func testDedupIgnoresNonBestBall() {
    rooms.clear();
    bestBallConfigs.clear();
    // A room with a BestBallConfig entry but gameType #Auction is NOT counted.
    rooms.add("a", makeRoom("a", 2026, #Auction));
    bestBallConfigs.add("a", { startWeek = 1 });

    let pairs = SyncStatusLib.computeDedupSeasonWeeks(rooms, bestBallConfigs);
    check("D3: non-Best-Ball room ignored", pairs.size() == 0);
  };

  // ── recordSyncStatus atomic guard tests ───────────────────────────────────
  func testEmptyVsPartial() {
    syncStatuses.clear();
    // A submission with zero usable stats is recorded as #partial (the mutable,
    // non-terminal active state), NOT a terminal/locked state, and remains
    // retry-eligible. `stored == 0` mid-progress must not imply "nothing
    // happened" — a partial sync where most owned players haven't played yet
    // stays #partial.
    let r = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 1, #partial, null, null);
    switch (r) {
      case (#err e) check("E1: partial recorded ok (got err " # e # ")", false);
      case (#ok rec) {
        check("E1: status is #partial", rec.status == #partial);
        check("E1: lastSuccessfulAt null", rec.lastSuccessfulAt == null);
      };
    };
    // #partial is retry-eligible: a later #partial submission succeeds.
    let r2 = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 1, #partial, null, ?100);
    switch (r2) {
      case (#err e) check("E1: partial retry-eligible (got err " # e # ")", false);
      case (#ok rec) check("E1: stays #partial", rec.status == #partial);
    };
  };

  func testAtomicGuard() {
    syncStatuses.clear();
    // First submission marks the week #partial (non-terminal).
    let first = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 2, #partial, null, ?200);
    switch (first) {
      case (#err e) check("G1: first partial ok (got err " # e # ")", false);
      case (#ok rec) check("G1: first status #partial", rec.status == #partial);
    };
    // A #partial week is NOT terminal: a later submission for the same
    // (season, week) succeeds (retry-eligible) and updates the record.
    let second = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 2, #partial, null, ?250);
    switch (second) {
      case (#err e) check("G1: partial retry succeeds (got err " # e # ")", false);
      case (#ok rec) check("G1: second partial succeeds", rec.status == #partial);
    };
    // The stored record reflects the latest attempt.
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 2)) {
      case (?rec) {
        check("G1: status still #partial", rec.status == #partial);
        check("G1: lastSuccessfulAt updated", rec.lastSuccessfulAt == ?250);
      };
      case null check("G1: record present", false);
    };
  };

  func testFinalizedGuard() {
    syncStatuses.clear();
    // A #finalized week is terminal: a later submission is rejected.
    let first = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 3, #partial, null, ?200);
    switch (first) {
      case (#err e) check("FG1: first partial ok (got err " # e # ")", false);
      case (#ok _) {};
    };
    // Transition to #finalized (as finalization would).
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 3, #finalized, null, ?200);
    // A later submission for the finalized week is rejected.
    let second = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 3, #partial, null, ?250);
    switch (second) {
      case (#ok _) check("FG1: finalized week rejects later submission", false);
      case (#err e) check("FG1: finalized week rejects later submission", e == "Already finalized");
    };
    // The stored record is still #finalized.
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 3)) {
      case (?rec) check("FG1: status still #finalized", rec.status == #finalized);
      case null check("FG1: record present", false);
    };
  };

  func testNotYetAttemptedPromotion() {
    syncStatuses.clear();
    // #notYetAttempted may be promoted to #partial (a sync attempt).
    let r = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 4, #notYetAttempted, null, null);
    switch (r) {
      case (#err e) check("NYA1: notYetAttempted recorded ok (got err " # e # ")", false);
      case (#ok rec) check("NYA1: status #notYetAttempted", rec.status == #notYetAttempted);
    };
    let r2 = SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 4, #partial, null, ?100);
    switch (r2) {
      case (#err e) check("NYA1: promoted to #partial (got err " # e # ")", false);
      case (#ok rec) check("NYA1: promoted to #partial", rec.status == #partial);
    };
  };

  // ── flagNeedingAttention tests ────────────────────────────────────────────
  func testFlagNeedingAttention() {
    syncStatuses.clear();
    // Pre-seed: week 1 finalized, week 2 partial (live), week 3 notYetAttempted
    // (future), week 4 has no record yet.
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 1, #finalized, null, ?100);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 2, #partial, null, ?200);
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 3, #notYetAttempted, null, null);
    // Pairs: weeks 1-4.
    let pairs = [(2026, 1), (2026, 2), (2026, 3), (2026, 4)];

    let flagged = SyncStatusLib.flagNeedingAttention(syncStatuses, pairs);
    // Live week = highest #partial = week 2. Only week 2 (partial) is flagged.
    // Week 1 (finalized) excluded, week 3 (notYetAttempted future) excluded,
    // week 4 (notYetAttempted future, after the live week) excluded.
    check("FL1: 1 flagged", flagged.size() == 1);
    check("FL1: week2 flagged", flagged.any(func r = r.week == 2));
    check("FL1: week1 not flagged", not flagged.any(func r = r.week == 1));
    check("FL1: week3 not flagged", not flagged.any(func r = r.week == 3));
    check("FL1: week4 not flagged", not flagged.any(func r = r.week == 4));
    // Week 1 remains #finalized (not touched).
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 1)) {
      case (?rec) check("FL1: week1 still finalized", rec.status == #finalized);
      case null check("FL1: week1 record present", false);
    };
  };

  func testFlagNeedingAttentionNoLiveRecord() {
    syncStatuses.clear();
    // No week is #partial, and the live week (startWeek = min week = 1) has no
    // record. flagNeedingAttention creates a #notYetAttempted record for the
    // live week and flags it.
    let pairs = [(2026, 1), (2026, 2), (2026, 3)];
    let flagged = SyncStatusLib.flagNeedingAttention(syncStatuses, pairs);
    check("FL2: 1 flagged", flagged.size() == 1);
    check("FL2: week1 flagged", flagged.any(func r = r.week == 1));
    // The live week record was created as #notYetAttempted.
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 1)) {
      case (?rec) check("FL2: week1 created notYetAttempted", rec.status == #notYetAttempted);
      case null check("FL2: week1 record created", false);
    };
  };

  // ── syncWeeklyStats integration tests ─────────────────────────────────────
  func testSyncWeeklyStatsEmptyBatch() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Empty batch → zero usable stats → status #partial (the mutable,
    // non-terminal active state), returns #ok 0. `stored == 0` mid-progress
    // must NOT imply "nothing happened" — the week stays #partial, never locked.
    let res = await syncWeeklyStats("admin", 2026, 10, []);
    switch (res) {
      case (#err e) check("SW1: empty batch ok (got err " # e # ")", false);
      case (#ok n) check("SW1: stored 0", n == 0);
    };
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 10)) {
      case (?rec) check("SW1: status #partial", rec.status == #partial);
      case null check("SW1: record created", false);
    };
  };

  func testSyncWeeklyStatsValidBatch() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Non-empty batch with valid entries → status #partial, returns stored count.
    let batch = [statsEntry("1001", 2026, 11), statsEntry("1002", 2026, 11)];
    let res = await syncWeeklyStats("admin", 2026, 11, batch);
    switch (res) {
      case (#err e) check("SW2: valid batch ok (got err " # e # ")", false);
      case (#ok n) check("SW2: stored 2", n == 2);
    };
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 11)) {
      case (?rec) {
        check("SW2: status #partial", rec.status == #partial);
        check("SW2: lastSuccessfulAt set", rec.lastSuccessfulAt != null);
      };
      case null check("SW2: record created", false);
    };
    // Stats were actually upserted (existing behavior unchanged).
    check("SW2: stats upserted", weeklyPlayerStats.get("1001|2026|11") != null);
  };

  func testSyncWeeklyStatsMismatchedBatch() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A batch whose entries all mismatch the requested (season, week) → zero
    // valid entries stored → status #partial (not a terminal/locked state).
    let batch = [statsEntry("1001", 2026, 99)];
    let res = await syncWeeklyStats("admin", 2026, 12, batch);
    switch (res) {
      case (#err e) check("SW3: mismatched batch ok (got err " # e # ")", false);
      case (#ok n) check("SW3: stored 0", n == 0);
    };
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 12)) {
      case (?rec) check("SW3: status #partial", rec.status == #partial);
      case null check("SW3: record created", false);
    };
  };

  func testSyncWeeklyStatsRepeatedPartial() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A week receiving 3+ sequential partial syncs within the cooldown window:
    // the first sync stores data and marks the week #partial; subsequent syncs
    // within the cooldown window no-op cleanly (return #ok 0, no error, no
    // duplicate write). The week stays #partial (non-terminal) throughout —
    // never locked. This reflects the new server-side write-coordination
    // cooldown: near-simultaneous duplicate writes are absorbed as no-ops,
    // while the week remains retry-eligible for a later (outside-window) sync.
    let first = await syncWeeklyStats("admin", 2026, 13, [statsEntry("1001", 2026, 13)]);
    switch (first) {
      case (#err e) check("SW4: first partial sync ok (got err " # e # ")", false);
      case (#ok n) check("SW4: first stored 1", n == 1);
    };
    let second = await syncWeeklyStats("admin", 2026, 13, [statsEntry("1002", 2026, 13)]);
    switch (second) {
      case (#err e) check("SW4: second partial sync ok (got err " # e # ")", false);
      case (#ok n) check("SW4: second no-op stored 0", n == 0);
    };
    let third = await syncWeeklyStats("admin", 2026, 13, [statsEntry("1003", 2026, 13)]);
    switch (third) {
      case (#err e) check("SW4: third partial sync ok (got err " # e # ")", false);
      case (#ok n) check("SW4: third no-op stored 0", n == 0);
    };
    // The week is still #partial (non-terminal) after 3 syncs — never locked.
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 13)) {
      case (?rec) check("SW4: status still #partial after 3 syncs", rec.status == #partial);
      case null check("SW4: record present", false);
    };
    // Only the first sync's stats were stored (the later calls no-op'd).
    check("SW4: P1 upserted", weeklyPlayerStats.get("1001|2026|13") != null);
    check("SW4: P2 not stored (no-op)", weeklyPlayerStats.get("1002|2026|13") == null);
    check("SW4: P3 not stored (no-op)", weeklyPlayerStats.get("1003|2026|13") == null);
  };

  // ── Phase 11: finalized-week rejection tests ──────────────────────────────
  func testSyncWeeklyStatsRejectsFinalizedResync() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // First: sync a valid batch → #partial.
    let batch = [statsEntry("1001", 2026, 14)];
    let first = await syncWeeklyStats("admin", 2026, 14, batch);
    switch (first) {
      case (#err e) check("SW5: first sync ok (got err " # e # ")", false);
      case (#ok n) check("SW5: first stored 1", n == 1);
    };
    // Finalize the week (as the automatic finalization flow would).
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 14, #finalized, null, ?0);
    // A resync of the now-finalized week must be rejected with the
    // finalized-week error, and must NOT write any state.
    let second = await syncWeeklyStats("admin", 2026, 14, [statsEntry("1002", 2026, 14)]);
    switch (second) {
      case (#ok _) check("SW5: finalized resync rejected", false);
      case (#err e) check("SW5: finalized resync rejected", e == "Week 14 of 2026 is finalized and cannot be resynced");
    };
    // The stored record is still #finalized and no new stats were written.
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 14)) {
      case (?rec) check("SW5: status still #finalized", rec.status == #finalized);
      case null check("SW5: record present", false);
    };
    check("SW5: no stats written on rejected resync", weeklyPlayerStats.get("1002|2026|14") == null);
  };

  func testSyncWeeklyStatsPartialStillWorks() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A #partial week is NOT terminal and remains retry-eligible: a resync succeeds.
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 15, #partial, null, ?0);
    let res = await syncWeeklyStats("admin", 2026, 15, [statsEntry("1001", 2026, 15)]);
    switch (res) {
      case (#err e) check("SW6: partial week resync ok (got err " # e # ")", false);
      case (#ok n) check("SW6: partial week resync stored 1", n == 1);
    };
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 15)) {
      case (?rec) check("SW6: stays #partial", rec.status == #partial);
      case null check("SW6: record present", false);
    };
  };

  // ── Phase 11: derived final helper tests ──────────────────────────────────
  func testIsWeekFinalized() {
    syncStatuses.clear();
    // No record → not finalized.
    check("SD1: no record not finalized", not SyncStatusLib.isWeekFinalized(syncStatuses, 2026, 1));
    // #notYetAttempted and #partial are NOT finalized.
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 1, #notYetAttempted, null, null);
    check("SD1: notYetAttempted not finalized", not SyncStatusLib.isWeekFinalized(syncStatuses, 2026, 1));
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 2, #partial, null, null);
    check("SD1: partial not finalized", not SyncStatusLib.isWeekFinalized(syncStatuses, 2026, 2));
    // #finalized IS finalized.
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 4, #finalized, null, ?100);
    check("SD1: finalized is finalized", SyncStatusLib.isWeekFinalized(syncStatuses, 2026, 4));
  };

  func testIsSeasonFinal() {
    syncStatuses.clear();
    rooms.clear();
    bestBallConfigs.clear();
    // A Best Ball season is final only when EVERY week from startWeek through
    // FINAL_WEEK (17) is finalized. There is no stored end week — the season
    // always runs to the FINAL_WEEK constant.

    // Room A: #BestBall, startWeek 1, all weeks 1..FINAL_WEEK finalized → final.
    rooms.add("f1", makeRoom("f1", 2026, #BestBall));
    bestBallConfigs.add("f1", { startWeek = 1 });
    var w = 1;
    while (w <= AuctionLib.FINAL_WEEK) {
      ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, w, #finalized, null, ?w);
      w += 1;
    };
    check("SD2: all weeks to FINAL_WEEK finalized → final", SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "f1"));

    // Room B: #BestBall, startWeek 1, week 2 is #partial → NOT final.
    rooms.add("f2", makeRoom("f2", 2027, #BestBall));
    bestBallConfigs.add("f2", { startWeek = 1 });
    w := 1;
    while (w <= AuctionLib.FINAL_WEEK) {
      if (w != 2) {
        ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2027, w, #finalized, null, ?w);
      };
      w += 1;
    };
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2027, 2, #partial, null, null);
    check("SD2: partial week → not final", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "f2"));

    // Room C: #BestBall, startWeek 1, week 2 is #notYetAttempted → NOT final.
    rooms.add("f3", makeRoom("f3", 2028, #BestBall));
    bestBallConfigs.add("f3", { startWeek = 1 });
    w := 1;
    while (w <= AuctionLib.FINAL_WEEK) {
      if (w != 2) {
        ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2028, w, #finalized, null, ?w);
      };
      w += 1;
    };
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2028, 2, #notYetAttempted, null, null);
    check("SD2: notYetAttempted week → not final", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "f3"));

    // Room D: #BestBall, startWeek 1, week 2 has no record → NOT final.
    rooms.add("f4", makeRoom("f4", 2029, #BestBall));
    bestBallConfigs.add("f4", { startWeek = 1 });
    w := 1;
    while (w <= AuctionLib.FINAL_WEEK) {
      if (w != 2) {
        ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2029, w, #finalized, null, ?w);
      };
      w += 1;
    };
    check("SD2: missing week → not final", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "f4"));

    // Room E: #Auction (non-BestBall) with a config → never final.
    rooms.add("f5", makeRoom("f5", 2030, #Auction));
    bestBallConfigs.add("f5", { startWeek = 1 });
    w := 1;
    while (w <= AuctionLib.FINAL_WEEK) {
      ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2030, w, #finalized, null, ?w);
      w += 1;
    };
    check("SD2: non-BestBall room never final", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "f5"));

    // Room F: #BestBall with NO config → never final.
    rooms.add("f6", makeRoom("f6", 2031, #BestBall));
    check("SD2: no config never final", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "f6"));

    // Room G: nonexistent room → never final.
    check("SD2: missing room never final", not SyncStatusLib.isSeasonFinal(rooms, bestBallConfigs, syncStatuses, "nope"));
  };

  // ── Participant authorization + cooldown tests (Phase: sync) ──────────────
  // These run with `me` NOT registered as the global admin, so the participant
  // authorization path is exercised. `me` is the actor's own principal (the
  // caller the mixin's shared methods observe).

  func testParticipantSyncSuccess() : async () {
    rooms.clear();
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A room where `me` is a participant, season 2026.
    let room = makeRoom("pr1", 2026, #BestBall);
    rooms.add("pr1", { room with participants = [me] });
    let res = await syncWeeklyStats("pr1", 2026, 16, [statsEntry("1001", 2026, 16)]);
    switch (res) {
      case (#err e) check("PA1: participant sync ok (got err " # e # ")", false);
      case (#ok n) check("PA1: participant stored 1", n == 1);
    };
    // Stats were upserted.
    check("PA1: stats upserted", weeklyPlayerStats.get("1001|2026|16") != null);
  };

  func testParticipantRejectedNotInRoom() : async () {
    rooms.clear();
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A room where `me` is NOT a participant.
    let room = makeRoom("pr2", 2026, #BestBall);
    rooms.add("pr2", { room with participants = [otherP] });
    let res = await syncWeeklyStats("pr2", 2026, 17, [statsEntry("1001", 2026, 17)]);
    switch (res) {
      case (#ok _) check("PA2: non-participant rejected", false);
      case (#err e) check("PA2: non-participant rejected", e == "Not a participant in this room");
    };
    // No state was written.
    check("PA2: no stats written", weeklyPlayerStats.get("1001|2026|17") == null);
  };

  func testParticipantRejectedRoomNotFound() : async () {
    rooms.clear();
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A roomId that does not resolve to a real room.
    let res = await syncWeeklyStats("nope", 2026, 18, [statsEntry("1001", 2026, 18)]);
    switch (res) {
      case (#ok _) check("PA3: missing room rejected", false);
      case (#err e) check("PA3: missing room rejected", e == "Room not found");
    };
    check("PA3: no stats written", weeklyPlayerStats.get("1001|2026|18") == null);
  };

  func testParticipantRejectedSeasonMismatch() : async () {
    rooms.clear();
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A room where `me` IS a participant, but the season param does not match
    // the room's actual season.
    let room = makeRoom("pr4", 2026, #BestBall);
    rooms.add("pr4", { room with participants = [me] });
    let res = await syncWeeklyStats("pr4", 2027, 1, [statsEntry("1001", 2027, 1)]);
    switch (res) {
      case (#ok _) check("PA4: season mismatch rejected", false);
      case (#err e) check("PA4: season mismatch rejected", e == "Season mismatch: room pr4 is in season 2026");
    };
    check("PA4: no stats written", weeklyPlayerStats.get("1001|2027|1") == null);
  };

  func testParticipantFinalizedRejected() : async () {
    rooms.clear();
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A room where `me` is a participant; the week is finalized. The finalized
    // guard must reject the sync for a participant too (not just the admin).
    let room = makeRoom("pr5", 2026, #BestBall);
    rooms.add("pr5", { room with participants = [me] });
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 2, #finalized, null, ?0);
    let res = await syncWeeklyStats("pr5", 2026, 2, [statsEntry("1001", 2026, 2)]);
    switch (res) {
      case (#ok _) check("PA5: participant finalized resync rejected", false);
      case (#err e) check("PA5: participant finalized resync rejected", e == "Week 2 of 2026 is finalized and cannot be resynced");
    };
    check("PA5: no stats written", weeklyPlayerStats.get("1001|2026|2") == null);
  };

  func testCooldownNoOp() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Two calls within the cooldown window: the first succeeds and stores data;
    // the second no-ops cleanly (returns #ok 0, no error, no duplicate write).
    let first = await syncWeeklyStats("admin", 2026, 3, [statsEntry("1001", 2026, 3)]);
    switch (first) {
      case (#err e) check("C1: first sync ok (got err " # e # ")", false);
      case (#ok n) check("C1: first stored 1", n == 1);
    };
    let second = await syncWeeklyStats("admin", 2026, 3, [statsEntry("1002", 2026, 3)]);
    switch (second) {
      case (#err e) check("C1: second no-op ok (got err " # e # ")", false);
      case (#ok n) check("C1: second no-op stored 0", n == 0);
    };
    // The no-op did not write the second batch.
    check("C1: P1 stored", weeklyPlayerStats.get("1001|2026|3") != null);
    check("C1: P2 not stored (no-op)", weeklyPlayerStats.get("1002|2026|3") == null);
    // The week is still #partial (non-terminal).
    switch (SyncStatusLib.getSyncStatus(syncStatuses, 2026, 3)) {
      case (?rec) check("C1: status #partial", rec.status == #partial);
      case null check("C1: record present", false);
    };
  };

  func testCooldownExpired() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // First sync sets lastSuccessfulAt to now.
    let first = await syncWeeklyStats("admin", 2026, 4, [statsEntry("1001", 2026, 4)]);
    switch (first) {
      case (#err e) check("C2: first sync ok (got err " # e # ")", false);
      case (#ok n) check("C2: first stored 1", n == 1);
    };
    // Backdate lastSuccessfulAt to beyond the cooldown window (simulating a
    // call that happens after the window has elapsed).
    ignore SyncStatusLib.recordSyncStatus(syncStatuses, 2026, 4, #partial, null, ?(Time.now() - 200_000_000_000));
    // A call outside the cooldown window succeeds normally.
    let second = await syncWeeklyStats("admin", 2026, 4, [statsEntry("1002", 2026, 4)]);
    switch (second) {
      case (#err e) check("C2: outside-window sync ok (got err " # e # ")", false);
      case (#ok n) check("C2: outside-window stored 1", n == 1);
    };
    check("C2: P2 stored", weeklyPlayerStats.get("1002|2026|4") != null);
  };

  // ── Phase 5C: per-entry stats validation tests ────────────────────────────
  func testValidationSkipsOnlyInvalidEntry() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A batch with one invalid entry (corrupt rushYds below the -50 floor) and
    // two valid entries: the valid entries store, the invalid entry is skipped,
    // and the reported skip count reflects it. One bad entry must not block the
    // others.
    let valid1 = { statsEntry("2001", 2026, 5) with rushYds = 120 };
    let invalid = { statsEntry("2002", 2026, 5) with rushYds = -9999 };
    let valid2 = { statsEntry("2003", 2026, 5) with recYds = 80 };
    let res = await syncWeeklyStats("admin", 2026, 5, [valid1, invalid, valid2]);
    switch (res) {
      case (#err e) check("V1: mixed batch ok (got err " # e # ")", false);
      case (#ok n) check("V1: stored 2 (invalid skipped)", n == 2);
    };
    check("V1: valid1 stored", weeklyPlayerStats.get("2001|2026|5") != null);
    check("V1: invalid skipped (not stored)", weeklyPlayerStats.get("2002|2026|5") == null);
    check("V1: valid2 stored", weeklyPlayerStats.get("2003|2026|5") != null);
  };

  func testValidationPreservesZeroStats() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A player who didn't score (all zeros) must validate and store as 0, not
    // be flagged as suspicious or skipped.
    let res = await syncWeeklyStats("admin", 2026, 6, [statsEntry("3001", 2026, 6)]);
    switch (res) {
      case (#err e) check("Z1: zero-stat entry ok (got err " # e # ")", false);
      case (#ok n) check("Z1: zero-stat stored 1", n == 1);
    };
    switch (weeklyPlayerStats.get("3001|2026|6")) {
      case (?s) check("Z1: zero stats preserved", s.passYds == 0 and s.passTds == 0 and s.receptions == 0);
      case null check("Z1: zero-stat entry stored", false);
    };
  };

  func testValidationAllowsRecordPerformance() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // A known-legitimate historically-large performance near a real record must
    // still validate and store. Norm Van Brocklin's 554-yard passing game (the
    // all-time single-game record) is well under the 1000-yard bound.
    let big = {
      statsEntry("4001", 2026, 7) with
      passYds = 554;
      passTds = 7;
    };
    let res = await syncWeeklyStats("admin", 2026, 7, [big]);
    switch (res) {
      case (#err e) check("R1: record performance ok (got err " # e # ")", false);
      case (#ok n) check("R1: record performance stored 1", n == 1);
    };
    check("R1: record performance stored", weeklyPlayerStats.get("4001|2026|7") != null);
  };

  func testValidationRejectsNegativeYardage() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Small negative yardage is legitimate real-world NFL data and must be
    // accepted and stored: rushYds = -8, plus small negative passYds/recYds.
    // Only obviously corrupt values below the generous -50 floor (e.g. -9999)
    // are rejected/skipped. One bad entry skips only itself.
    let negRush = { statsEntry("5001", 2026, 8) with rushYds = -8 };
    let negPass = { statsEntry("5002", 2026, 8) with passYds = -1 };
    let negRec = { statsEntry("5003", 2026, 8) with recYds = -3 };
    let corrupt = { statsEntry("5004", 2026, 8) with rushYds = -9999 };
    let res = await syncWeeklyStats("admin", 2026, 8, [negRush, negPass, negRec, corrupt]);
    switch (res) {
      case (#err e) check("N1: negative yardage batch ok (got err " # e # ")", false);
      case (#ok n) check("N1: small negatives stored, corrupt skipped (stored 3)", n == 3);
    };
    // Small negatives are accepted and stored with their exact values.
    switch (weeklyPlayerStats.get("5001|2026|8")) {
      case (?s) check("N1: rushYds -8 stored", s.rushYds == -8);
      case null check("N1: rushYds -8 stored", false);
    };
    switch (weeklyPlayerStats.get("5002|2026|8")) {
      case (?s) check("N1: passYds -1 stored", s.passYds == -1);
      case null check("N1: passYds -1 stored", false);
    };
    switch (weeklyPlayerStats.get("5003|2026|8")) {
      case (?s) check("N1: recYds -3 stored", s.recYds == -3);
      case null check("N1: recYds -3 stored", false);
    };
    // The corrupt value below the -50 floor is skipped.
    check("N1: corrupt -9999 skipped", weeklyPlayerStats.get("5004|2026|8") == null);
  };

  func testValidationRejectsMalformedIdentifiers() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Non-numeric and empty playerIds are rejected individually.
    let nonNumeric = { statsEntry("abc", 2026, 9) with rushYds = 50 };
    let empty = { statsEntry("", 2026, 9) with rushYds = 50 };
    let valid = { statsEntry("6001", 2026, 9) with rushYds = 50 };
    let res = await syncWeeklyStats("admin", 2026, 9, [nonNumeric, empty, valid]);
    switch (res) {
      case (#err e) check("M1: malformed id batch ok (got err " # e # ")", false);
      case (#ok n) check("M1: stored 1 (malformed skipped)", n == 1);
    };
    check("M1: non-numeric skipped", weeklyPlayerStats.get("abc|2026|9") == null);
    check("M1: empty skipped", weeklyPlayerStats.get("|2026|9") == null);
    check("M1: valid stored", weeklyPlayerStats.get("6001|2026|9") != null);
  };

  func testValidationRejectsOutOfRangeWeekSeason() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Out-of-range week (outside 1-18) and season (outside 2000-2100) are
    // rejected individually. A valid entry in the same batch still stores.
    let badWeek = { statsEntry("7001", 2026, 19) with rushYds = 50 };
    let badSeason = { statsEntry("7002", 3000, 10) with rushYds = 50 };
    let valid = { statsEntry("7003", 2026, 10) with rushYds = 50 };
    let res = await syncWeeklyStats("admin", 2026, 10, [badWeek, badSeason, valid]);
    switch (res) {
      case (#err e) check("W1: out-of-range batch ok (got err " # e # ")", false);
      case (#ok n) check("W1: stored 1 (out-of-range skipped)", n == 1);
    };
    check("W1: badWeek skipped", weeklyPlayerStats.get("7001|2026|10") == null);
    check("W1: badSeason skipped", weeklyPlayerStats.get("7002|3000|10") == null);
    check("W1: valid stored", weeklyPlayerStats.get("7003|2026|10") != null);
  };

  func testValidationRejectsOutOfRangeWeekTarget() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Sync target week 19 (out of range): the entry matches the target so the
    // mismatch check passes, and the week validation rejects it directly.
    let res = await syncWeeklyStats("admin", 2026, 19, [statsEntry("7101", 2026, 19)]);
    switch (res) {
      case (#err e) check("W2: out-of-range week target ok (got err " # e # ")", false);
      case (#ok n) check("W2: out-of-range week skipped (stored 0)", n == 0);
    };
    check("W2: out-of-range week not stored", weeklyPlayerStats.get("7101|2026|19") == null);
  };

  func testValidationRejectsOutOfRangeSeasonTarget() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Sync target season 3000 (out of range): the entry matches the target so
    // the mismatch check passes, and the season validation rejects it directly.
    let res = await syncWeeklyStats("admin", 3000, 10, [statsEntry("7201", 3000, 10)]);
    switch (res) {
      case (#err e) check("W3: out-of-range season target ok (got err " # e # ")", false);
      case (#ok n) check("W3: out-of-range season skipped (stored 0)", n == 0);
    };
    check("W3: out-of-range season not stored", weeklyPlayerStats.get("7201|3000|10") == null);
  };

  func testValidationRejectsExcessiveCounts() : async () {
    syncStatuses.clear();
    weeklyPlayerStats.clear();
    // Touchdown/interception/fumble/reception counts above the generous bounds
    // are rejected individually.
    let tooManyPassTds = { statsEntry("8001", 2026, 11) with passTds = 16 };
    let tooManyInts = { statsEntry("8002", 2026, 11) with ints = 16 };
    let tooManyRec = { statsEntry("8003", 2026, 11) with receptions = 41 };
    let res = await syncWeeklyStats("admin", 2026, 11, [tooManyPassTds, tooManyInts, tooManyRec]);
    switch (res) {
      case (#err e) check("E1: excessive counts batch ok (got err " # e # ")", false);
      case (#ok n) check("E1: all excessive skipped (stored 0)", n == 0);
    };
    check("E1: tooManyPassTds skipped", weeklyPlayerStats.get("8001|2026|11") == null);
    check("E1: tooManyInts skipped", weeklyPlayerStats.get("8002|2026|11") == null);
    check("E1: tooManyRec skipped", weeklyPlayerStats.get("8003|2026|11") == null);
  };

  // ── Entry point ───────────────────────────────────────────────────────────
  public func runTests() : async () {
    me := await whoAmI();
    // Register the caller as the admin so syncWeeklyStats's auth check passes.
    adminPrincipalStore.add("admin", me);

    testDedupUnionsOverlappingRanges();
    testDedupDistinctSeasons();
    testDedupIgnoresNonBestBall();

    testEmptyVsPartial();
    testAtomicGuard();
    testFinalizedGuard();
    testNotYetAttemptedPromotion();
    testFlagNeedingAttention();
    testFlagNeedingAttentionNoLiveRecord();

    await testSyncWeeklyStatsEmptyBatch();
    await testSyncWeeklyStatsValidBatch();
    await testSyncWeeklyStatsMismatchedBatch();
    await testSyncWeeklyStatsRepeatedPartial();

    await testSyncWeeklyStatsRejectsFinalizedResync();
    await testSyncWeeklyStatsPartialStillWorks();
    testIsWeekFinalized();
    testIsSeasonFinal();

    // Cooldown tests run with `me` as admin (the cooldown applies to all callers).
    await testCooldownNoOp();
    await testCooldownExpired();

    // Phase 5C per-entry validation tests run with `me` as admin.
    await testValidationSkipsOnlyInvalidEntry();
    await testValidationPreservesZeroStats();
    await testValidationAllowsRecordPerformance();
    await testValidationRejectsNegativeYardage();
    await testValidationRejectsMalformedIdentifiers();
    await testValidationRejectsOutOfRangeWeekSeason();
    await testValidationRejectsOutOfRangeWeekTarget();
    await testValidationRejectsOutOfRangeSeasonTarget();
    await testValidationRejectsExcessiveCounts();

    // Participant authorization tests run with `me` NOT registered as the global
    // admin, so the participant path is exercised. Remove `me` from the admin
    // store; the hardcoded admin principal is a different principal, so `me` is
    // no longer authorized via the admin path.
    adminPrincipalStore.remove("admin");
    await testParticipantSyncSuccess();
    await testParticipantRejectedNotInRoom();
    await testParticipantRejectedRoomNotFound();
    await testParticipantRejectedSeasonMismatch();
    await testParticipantFinalizedRejected();

    if (failures > 0) {
      let first = switch (firstFailure) { case (?n) n; case null "unknown" };
      Debug.print("SYNC STATUS TESTS: " # failures.toText() # " FAILURE(S), first: " # first);
      Runtime.trap("sync status tests failed: " # first);
    } else {
      Debug.print("ALL SYNC STATUS TESTS PASSED");
    };
  };

  public shared query ({ caller }) func whoAmI() : async Principal { caller };
};
