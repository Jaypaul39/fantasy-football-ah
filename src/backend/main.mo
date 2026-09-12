import Types "types/auction-types";
import AuctionMixin "mixins/auction-types-api";
import ByeWeeksApi "mixins/bye-weeks-api";
import AdminAuthTypes "types/admin-auth";
import AdminAuthApi "mixins/admin-auth-api";
import BestBallApi "mixins/best-ball-api";
import H2HApi "mixins/h2h-api";
import H2HBracketApi "mixins/h2h-bracket-api";
import ApiDocMixin "mixins/api-doc";
import LineupLib "lib/lineup";
import SyncStatusApi "mixins/sync-status-api";
import SyncStatusLib "lib/sync-status";
import SyncStatusTypes "types/sync-status";
import BestBallCachingApi "mixins/best-ball-caching-api";
import BestBallCachingLib "lib/best-ball-caching";
import BestBallCachingTypes "types/best-ball-caching";
import Timer "mo:core/Timer";
import Nat "mo:core/Nat";
import Text "mo:core/Text";





import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";
import Cycles "mo:core/Cycles";
import Iter "mo:core/Iter";
import Principal "mo:core/Principal";
import Array "mo:core/Array";
import OQL "mo:caffeineai-oql";
import Expose "mo:caffeineai-oql/Expose";
import Entity "mo:caffeineai-oql/Entity";
import MapEntity "mo:caffeineai-oql/MapEntity";
import TextValue "mo:caffeineai-oql/TextValue";
import IntValue "mo:caffeineai-oql/IntValue";
import NatValue "mo:caffeineai-oql/NatValue";
import BoolValue "mo:caffeineai-oql/BoolValue";
import PrincipalValue "mo:caffeineai-oql/PrincipalValue";
import FloatValue "mo:caffeineai-oql/FloatValue";



// Composition root — owns all state, delegates everything to mixins.
// No public methods or business logic here.
// Migration: adds adpDataset field to AuctionSettings for all existing rooms;
// migrates Player.byeWeek from Nat to ?Nat via the verified 2025 NFL lookup table;
// adds notificationQueue and nextNotificationId stable fields.







actor {
  // ── Stable state ──────────────────────────────────────────────────────────
  // All stable fields are declared type-only (no inline initializers) under
  // enhanced orthogonal persistence. Initial values come from the migration
  // chain in src/backend/migrations/. See the migration file for fresh-install
  // seeding (byeWeeksStore default mapping, nextNominationIdState = 1,
  // rssRefreshIntervalSecs = 900) and upgrade pass-through behavior.

  // rooms: roomId → Room
  let rooms : Map.Map<Types.RoomId, Types.Room>;

  // roomIdState: monotonically incrementing counter for room ID generation.
  // Wrapped in a record so the mixin receives a mutable reference.
  let roomIdState : { var next : Nat };

  // nextMsgIdState: monotonically incrementing counter for chat message IDs.
  // Wrapped in a record so the mixin receives a mutable reference.
  let nextMsgIdState : { var next : Nat };

  // participants: roomId → (userId → Participant)
  let participants : Map.Map<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>;

  // nominations: nominationId → Nomination
  let nominations : Map.Map<Types.NominationId, Types.Nomination>;

  // nominationsByRoom: roomId → [nominationId] — per-room index of nomination IDs
  // in creation order. Appended to at nomination creation time. Replaces the
  // full-map scan in buildRoomView and the afterActiveIds loop with an O(room)
  // lookup. Backfilled once during postupgrade by scanning the existing
  // nominations map. Performance index only — not user-facing, not exposed via
  // OQL. Type-only declaration (M0250); initial value comes from the migration
  // chain (Map.new — backfill happens in postupgrade).
  let nominationsByRoom : Map.Map<Types.RoomId, [Types.NominationId]>;

  // nextNominationIdState: monotonically incrementing counter for nomination IDs.
  // Never shrinks — deleteRoom removes nominations from the map but the counter
  // keeps climbing so new IDs never collide with closed records. Seeded to 1 on
  // fresh install by the migration; the postupgrade hook corrects it upward to
  // max(existing IDs)+1 when the persisted value would be too low.
  // Wrapped in a record so the mixin receives a mutable reference.
  let nextNominationIdState : { var next : Nat };

  // bids: roomId → (nominationId → bid history)
  let bids : Map.Map<Types.RoomId, Map.Map<Types.NominationId, List.List<Types.Bid>>>;

  // proxyBids: roomId → (nominationId → (userId → ProxyBid))  [private, never exposed]
  let proxyBids : Map.Map<Types.RoomId, Map.Map<Types.NominationId, Map.Map<Types.UserId, Types.ProxyBid>>>;

  // nominatedByRoom: roomId → Set<playerId> — prevents duplicate nominations
  let nominatedByRoom : Map.Map<Types.RoomId, Set.Set<Text>>;

  // draftedPlayerIds: roomId → Set<playerId> — authoritative room-scoped set of
  // players already drafted (won) in the room. Single source of truth for
  // excluding drafted players from the nomination list. Populated in every
  // nomination-close path with a winning bid and NEVER removed when a
  // participant leaves or is removed. Additive, backward compatible.
  let draftedPlayerIds : Map.Map<Types.RoomId, Set.Set<Text>>;

  // bestBallConfigs: roomId → BestBallConfig — marks a room as having Best Ball
  // tracking enabled and records its week range. Its presence protects the room
  // from deletion (see deleteRoom). No stats storage or scoring calculation
  // lives here — that is a later phase. Type-only declaration (M0250); initial
  // value (empty Map) comes from the migration chain.
  let bestBallConfigs : Map.Map<Types.RoomId, Types.BestBallConfig>;

  // weeklyPlayerStats: composite Text key → WeeklyPlayerStats — raw weekly
  // player statistics keyed by statsKey(playerId, season, week):
  //   playerId # "|" # Nat.toText(season) # "|" # Nat.toText(week)
  // Raw stat categories only — NO precomputed points (those are computed in a
  // later phase). Populated via the admin-only syncWeeklyStats endpoint, which
  // receives a typed batch from the frontend (no backend HTTP outcall). The
  // composite key gives upsert semantics: re-syncing a week overwrites cleanly.
  // Type-only declaration (M0250); initial value (empty Map) comes from the
  // migration chain.
  let weeklyPlayerStats : Map.Map<Text, Types.WeeklyPlayerStats>;

  // syncStatuses: composite "season|week" Text key → SyncStatusRecord — one
  // per-(season, week) sync status record for Best Ball weekly stats.
  // Operational/diagnostic only: records whether a (season, week) has been
  // synced, is empty (no data), failed, or not yet attempted. It is NOT wired
  // into any existing UI's sync-detection logic and does NOT change the
  // starters.length === 0 heuristic. The backend never fetches from Sleeper and
  // never makes an HTTPS outcall — this is visibility, not full autonomy. The
  // atomic duplicate-sync guard lives in recordSyncStatus (checked and set
  // within the same call). Type-only declaration (M0250); initial value (empty
  // Map) comes from the migration chain.
  let syncStatuses : Map.Map<Text, SyncStatusTypes.SyncStatusRecord>;

  // finalizedWeeklyScores: composite key → final optimal weekly-lineup total
  // (Float) for a #finalized week. Keyed by roomId|season|week|principal. The
  // permanent cache of each participant's final weekly score for weeks that
  // have transitioned to #finalized. Written exactly once at finalization time
  // (never recomputed or overwritten afterward); the single live (#partial)
  // week is never cached. Seeded empty by the migration; populated at
  // finalization and backfilled for pre-existing #synced→#finalized weeks by
  // the daily timer after upgrade. Type-only declaration (M0250); initial value
  // (empty Map) comes from the migration chain.
  let finalizedWeeklyScores : BestBallCachingTypes.FinalizedWeeklyScores;

  // profiles: userId → UserProfile — global user identity store
  let profiles : Map.Map<Types.UserId, Types.UserProfile>;

  // userRooms: userId → list of roomIds the user has joined (persists across sessions)
  let userRooms : Map.Map<Types.UserId, List.List<Types.RoomId>>;

  // adminPrincipalStore: single-entry map keyed by "admin" → first caller of importPlayers
  // Using a Map so it can be injected as a mutable reference into the mixin.
  let adminPrincipalStore : Map.Map<Text, Types.UserId>;

  // recoveryPasswordHash: SHA-256 hash of the admin recovery password, hex-encoded
  // as Text. null until set via setRecoveryPassword. Record-wrapped so the mixin
  // receives a mutable reference (same pattern as rssCacheContent).
  let recoveryPasswordHash : { var value : ?Text };

  // recoveryAttempts: caller principal text → RecoveryAttempt, tracking failed
  // recoverAdmin attempts for basic rate limiting. Type-only declaration; initial
  // value (empty Map) comes from the migration chain.
  let recoveryAttempts : Map.Map<Text, AdminAuthTypes.RecoveryAttempt>;

  // players: playerId → Player — keyed by id for O(log n) lookup and bulk import
  // Populated via importPlayers() admin endpoint; starts empty.
  let players : Map.Map<Text, Types.Player>;

  // nominationHistory: roomId → (nominationId → event log) (event-based bid history, NOT proxy resolution)
  let nominationHistory : Map.Map<Types.RoomId, Map.Map<Types.NominationId, List.List<Types.BidHistoryEvent>>>;

  // roomMessages: roomId → chat messages (newest-first, prepend on add)
  let roomMessages : Map.Map<Types.RoomId, List.List<Types.ChatMessage>>;

  // activeAdpDataset: keyed by dataset type ("all" | "rookies") → ADPDataset
  // Supports independent datasets for all-player and rookie drafts.
  // Backwards-compat: existing "active" key read by old code is now "all".
  let activeAdpDataset : Map.Map<Text, Types.ADPDataset>;

  // nominationQueue: compositeKey → playerId — server-side pre-selected nomination queue.
  // Key is encoded as "roomId|userId.toText()" to avoid tuple compare issues.
  let nominationQueue : Map.Map<Text, Text>;

  // giphyApiKeyStore: single-entry map keyed by "key" → Giphy API key (Text)
  // Using a Map so it can be injected as a mutable reference into the mixin.
  let giphyApiKeyStore : Map.Map<Text, Text>;

  // oneSignalApiKeyStore: single-entry map keyed by "key" → OneSignal REST API key (Text)
  // Admin-only. Never exposed publicly. Same pattern as giphyApiKeyStore.
  let oneSignalApiKeyStore : Map.Map<Text, Text>;

  // oneSignalPlayerIds: principalText → OneSignal Player ID
  // Each user stores their own player ID; admin can read all.
  let oneSignalPlayerIds : Map.Map<Text, Text>;

  // playerPriceHistory: playerKey → list of PlayerPriceRecord (capped at 500 per player)
  let playerPriceHistory : Map.Map<Text, List.List<Types.PlayerPriceRecord>>;

  // rssCacheContent: cached RSS feed content (ESPN NFL news)
  let rssCacheContent : { var content : ?Text };

  // rssCacheTimestamp: last fetch timestamp in seconds
  let rssCacheTimestamp : { var timestamp : Nat };

  // rssFeedUrlsStore: single-entry map keyed by "urls" → admin-configured RSS feed URLs ([Text])
  // Same pattern as giphyApiKeyStore / oneSignalApiKeyStore.
  let rssFeedUrlsStore : Map.Map<Text, [Text]>;

  // byeWeeksStore: single-entry map keyed by "mapping" → admin-importable NFL team → bye week
  // mapping ([(Text, Nat)]). Seeded with the default 2025 NFL bye-week mapping on fresh
  // install by the migration so the app works out of the box before any admin import.
  // Admin can replace it via setByeWeeks (JSON/CSV-importable from the frontend).
  // Same single-entry Map pattern as rssFeedUrlsStore / giphyApiKeyStore.
  let byeWeeksStore : Map.Map<Text, [(Text, Nat)]>;

  // rssRefreshIntervalSecs: admin-configured RSS cache refresh interval in seconds.
  // Seeded to 900 (15 minutes) on fresh install by the migration.
  // Wrapped in a record so the mixin receives a mutable reference.
  let rssRefreshIntervalSecs : { var seconds : Nat };

  // lastRssFetchStatus: per-feed outcome of the most recent RSS fetch.
  // Each tuple is (feedUrl, succeeded). Empty until the first real fetch runs.
  // On cache-hit returns, the previous real fetch's status is preserved.
  let lastRssFetchStatus : { var status : [(Text, Bool)] };

  // activeRoomIds: set of currently active rooms
  let activeRoomIds : Set.Set<Types.RoomId>;

  // notificationQueue: pending notifications awaiting delivery by the backend worker.
  // Drained by _processNotificationQueue, triggered fire-and-forget at enqueue time
  // (via the async public update methods that call enqueueNotification).
  // Uses the existing object-style List API (List.empty, .add, .filter, etc.).
  let notificationQueue : List.List<Types.PendingNotification>;

  // nextNotificationId: monotonically incrementing counter for notification IDs.
  // Wrapped in a record so the mixin receives a mutable reference (same pattern as nextMsgIdState).
  let nextNotificationId : { var next : Nat };

  // Notification lifecycle counters — observability for the admin panel.
  // Each is wrapped in a record so the mixin receives a mutable reference
  // (same pattern as nextNotificationId / nextMsgIdState).
  //   notificationsQueuedTotal    — incremented once per enqueueNotification call
  //   notificationsProcessedTotal — incremented at every processed += 1 site
  //   notificationsSentTotal      — incremented after a successful OneSignal send
  //   notificationsExpiredTotal   — incremented at the expiry-drop branch
  //   notificationsRetriedTotal   — incremented when a failed send is re-queued
  //   notificationsFailedTotal    — incremented when a failed send exceeds the attempt cap
  let notificationsQueuedTotal : { var count : Nat };
  let notificationsProcessedTotal : { var count : Nat };
  let notificationsSentTotal : { var count : Nat };
  let notificationsExpiredTotal : { var count : Nat };
  let notificationsRetriedTotal : { var count : Nat };
  let notificationsFailedTotal : { var count : Nat };

  // Notification-worker instrumentation — read-only visibility into exactly
  // when the worker runs. Same stable-state ownership pattern as the six
  // notification counters above (declared here, injected into the mixin as
  // constructor params so the mixin receives mutable references).
  //   notificationWorkerEntryCount    — incremented when the worker block is entered
  //   lastNotificationWorkerStartedAt — Time.now() when the worker block is entered
  //   lastNotificationWorkerCompletedAt — Time.now() when the worker block exits (success or failure)
  //   lastNotificationWorkerError     — ?Error.message of the most recent failure, null if none
  let notificationWorkerEntryCount : { var count : Nat };
  let lastNotificationWorkerStartedAt : { var value : Int };
  let lastNotificationWorkerCompletedAt : { var value : Int };
  let lastNotificationWorkerError : { var error : ?Text };

  // Reentrancy guard for the event-triggered notification drain. The drain is
  // fired from enqueueNotification (fire-and-forget) instead of a recurring
  // timer; this guard prevents two notifications enqueued in quick succession
  // from triggering overlapping drains. Wrapped in a record so the mixin
  // receives a mutable reference (same pattern as the worker instrumentation
  // fields above). Declared BEFORE the include so the mixin can see it.
  let processingNotifications : { var value : Bool };

  // ── Mixin composition ─────────────────────────────────────────────────────

  /// Get or create the bids inner map for a room
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

  /// Get or create the proxyBids inner map for a room
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

  /// Get or create the nominationHistory inner map for a room
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

  include AuctionMixin(rooms, participants, nominations, nominationsByRoom, bids, proxyBids, nominatedByRoom, draftedPlayerIds, players, profiles, userRooms, nominationHistory, roomMessages, adminPrincipalStore, activeAdpDataset, nominationQueue, giphyApiKeyStore, oneSignalApiKeyStore, oneSignalPlayerIds, roomIdState, nextMsgIdState, nextNominationIdState, getOrCreateBids, getOrCreateProxyBids, getOrCreateNominationHistory, rssCacheContent, rssCacheTimestamp, rssFeedUrlsStore, rssRefreshIntervalSecs, lastRssFetchStatus, activeRoomIds, playerPriceHistory, notificationQueue, nextNotificationId, byeWeeksStore, notificationsQueuedTotal, notificationsProcessedTotal, notificationsSentTotal, notificationsExpiredTotal, notificationsRetriedTotal, notificationsFailedTotal, notificationWorkerEntryCount, lastNotificationWorkerStartedAt, lastNotificationWorkerCompletedAt, lastNotificationWorkerError, processingNotifications, bestBallConfigs, weeklyPlayerStats, syncStatuses, func(season : Nat, week : Nat) : Nat {
    BestBallCachingLib.finalizePriorPartialWeeks(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup, season, week);
  });

  include ByeWeeksApi(byeWeeksStore, players, adminPrincipalStore);

  include AdminAuthApi(adminPrincipalStore, recoveryPasswordHash, recoveryAttempts);

  // ── Internal weekly lineup calculator (Phase 3) ───────────────────────────
  // Internal (non-public) helper that wires the pure lineup optimizer in
  // lib/lineup.mo to the weeklyPlayerStats map. Not exposed as a public method
  // in this phase; Phase 4's getWeeklyLineup/getStandings will call it. It
  // reads only — it never mutates wonPlayers, rosterSettings, WeeklyPlayerStats,
  // or any persistent auction data.
  func calculateOptimalWeeklyLineup(
    room : Types.Room,
    participant : Types.Participant,
    week : Nat,
  ) : LineupLib.LineupResult {
    LineupLib.calculateOptimalWeeklyLineup(
      room,
      participant,
      week,
      func(playerId : Text, season : Nat, week : Nat) : ?Types.WeeklyPlayerStats {
        weeklyPlayerStats.get(playerId # "|" # season.toText() # "|" # week.toText());
      },
    );
  };

  // ── Best Ball weekly lineup + standings read APIs (Phase 4) ───────────────
  // Read-only queries that consume the Phase 3 calculator above as the single
  // source of truth. The calculator func is injected so the mixin never
  // duplicates lineup optimization or scoring logic.
  include BestBallApi(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup);

  // ── Head-to-Head regular-season standings (Phase 12a) ─────────────────────
  // Read-only query that resolves each team's weekly H2H result via the derived
  // round-robin schedule (lib/h2h.mo) and the Phase 3 optimal-lineup calculator
  // as the single source of truth. No new stable storage — the schedule is
  // derived on demand from immutable room inputs.
  include H2HApi(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup);

  // ── Head-to-Head playoff bracket resolution (Phase 12b) ───────────────────
  // Read-only query that derives the fixed-slot playoff bracket for a
  // #HeadToHead room with playoffTeams > 0, resolving each game's slots
  // recursively from the regular-season standings ordering and the Phase 3
  // optimal-lineup calculator as the single source of truth. No new stable
  // storage — the bracket, every game, and the champion are pure computations
  // over already-persisted data.
  include H2HBracketApi(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup, getH2HStandings);

  // ── Weekly sync status (Phase 10) ─────────────────────────────────────────
  // Per-(season, week) sync status tracking for Best Ball weekly stats.
  // Operational/diagnostic only — records what is missing so the admin panel
  // can show it and the frontend can auto-sync flagged weeks. The backend never
  // fetches from Sleeper and never makes an HTTPS outcall; the actual
  // fetch+parse+submit happens in an authenticated admin's browser session.
  // This is visibility, not full autonomy.
  include SyncStatusApi(syncStatuses, rooms, bestBallConfigs, participants, finalizedWeeklyScores, calculateOptimalWeeklyLineup, adminPrincipalStore);

  // ── Best Ball caching + automatic finalization (Phase: caching) ──────────
  // Host/admin recovery endpoints for the finalized-weekly-score cache and the
  // automatic finalization lifecycle. Normal operation is fully automatic —
  // finalization is triggered by the synchronization flow (syncWeeklyStats →
  // finalizePriorPartialWeeks) and the daily timer as a backstop; the public
  // methods here exist ONLY as recovery mechanisms.
  include BestBallCachingApi(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup, adminPrincipalStore);

  // ── Behavioral API documentation ─────────────────────────────────────────
  // Exposes getApiDoc, a static Markdown document describing the public API.
  include ApiDocMixin();

  // ── OQL Data Intelligence exposure ────────────────────────────────────────
  // Exposes every primary persisted collection as a queryable entity via the
  // caffeineai-oql Expose mixin. Manual mode is used throughout because every
  // entity record carries non-primitive fields (options, variants, nested
  // records, arrays). Top-level maps use .toEntityManual; nested maps/lists are
  // flattened with Iter.flatMap and exposed via OQL.Entity.manual. Each entity
  // carries .sample(...) so schema discovery works even when a collection is
  // empty at build time. Admin-only data uses .controllerOnly(); per-user data
  // (profile, userRoom) uses .controllerOrScoped() + .ownedBy(...).

  // Sample principal used to seed .sample(...) templates for Principal fields.
  transient let anyP = Principal.fromText("aaaaa-aa");

  // Sentinel helpers for option/variant → primitive conversions. Each returns
  // ONE OQL.Value variant so the reported schema type is stable across rows.
  func optText(t : ?Text) : Text { switch t { case null ""; case (?v) v } };
  func optNat(n : ?Nat) : Nat { switch n { case null 0; case (?v) v } };
  func optInt(i : ?Int) : Int { switch i { case null 0; case (?v) v } };
  func auctionStateText(s : Types.AuctionState) : Text {
    switch s { case (#Waiting) "Waiting"; case (#Active) "Active"; case (#Paused) "Paused"; case (#Completed) "Completed" }
  };
  func competitionModeText(m : Types.CompetitionMode) : Text {
    switch m { case (#Cumulative) "Cumulative"; case (#HeadToHead) "HeadToHead" }
  };
  func nominationStateText(s : Types.NominationState) : Text {
    switch s { case (#Active) "Active"; case (#Closed) "Closed"; case (#Expired) "Expired" }
  };
  func bidHistoryEventText(e : Types.BidHistoryEventType) : Text {
    switch e { case (#nominationCreated) "nominationCreated"; case (#leaderChanged) "leaderChanged"; case (#nominationEnded) "nominationEnded" }
  };
  func optBool(b : ?Bool) : Bool { switch b { case null false; case (?v) v } };
  func scoringFormatText(s : Types.ScoringFormat) : Text {
    switch s {
      case (#std) "std";
      case (#halfPpr) "halfPpr";
      case (#ppr) "ppr";
      case (#custom(_)) "custom";
    }
  };
  func syncStatusText(s : SyncStatusTypes.SyncStatus) : Text {
    switch s {
      case (#notYetAttempted) "notYetAttempted";
      case (#partial) "partial";
      case (#finalized) "finalized";
    }
  };

  // Flattened row types for nested-map entities. Each is a flat record of
  // primitive fields so OQL.Entity.manual can expose them with .payload.
  type ParticipantRow = {
    roomId : Types.RoomId;
    userId : Types.UserId;
    displayName : Text;
    budget : Nat;
    spent : Nat;
    committedCount : Nat;
    wonPlayersCount : Nat;
    skipNominationTurn : Bool;
  };
  type BidRow = {
    roomId : Types.RoomId;
    nominationId : Types.NominationId;
    userId : Types.UserId;
    amount : Nat;
    isProxy : Bool;
    timestamp : Types.Timestamp;
  };
  type BidHistoryEventRow = {
    roomId : Types.RoomId;
    nominationId : Types.NominationId;
    eventType : Text;
    userId : Types.UserId;
    displayName : Text;
    playerName : Text;
    amount : Nat;
    timestamp : Types.Timestamp;
    isAutoBid : Bool;
  };
  type ChatMessageRow = {
    roomId : Types.RoomId;
    id : Nat;
    userId : Types.UserId;
    displayName : Text;
    message : Text;
    timestamp : Types.Timestamp;
    reactionsCount : Nat;
  };
  type PlayerPriceRecordRow = {
    playerKey : Text;
    playerId : Text;
    playerName : Text;
    position : Text;
    winningBid : Nat;
    budgetPct : Float;
    totalBudget : Nat;
    numTeams : Nat;
    leagueType : Text;
    winningUserId : Types.UserId;
    roomId : Types.RoomId;
    closedAt : Types.Timestamp;
  };
  type UserRoomRow = {
    userId : Types.UserId;
    roomId : Types.RoomId;
  };
  type BestBallConfigRow = {
    roomId : Types.RoomId;
    startWeek : Nat;
  };
  type SyncStatusRow = {
    season : Nat;
    week : Nat;
    lastAttemptedAt : Int;
    status : Text;
    lastError : Text;
    lastSuccessfulAt : Int;
  };
  type FinalizedScoreRow = {
    roomId : Types.RoomId;
    season : Nat;
    week : Nat;
    principal : Types.UserId;
    score : Float;
  };

  // Flattened iterators over nested maps/lists.
  func participantRows() : Iter.Iter<ParticipantRow> {
    participants.entries().flatMap(
      func((roomId, userMap)) {
        userMap.entries().map(
          func((userId, p)) {
            {
              roomId;
              userId;
              displayName = p.displayName;
              budget = p.budget;
              spent = p.spent;
              committedCount = p.committed.size();
              wonPlayersCount = p.wonPlayers.size();
              skipNominationTurn = p.skipNominationTurn;
            }
          }
        )
      }
    )
  };
  func bidRows() : Iter.Iter<BidRow> {
    bids.entries().flatMap(
      func((roomId, nomMap)) {
        nomMap.entries().flatMap(
          func((nomId, bidList)) {
            bidList.values().map(
              func(b) {
                {
                  roomId;
                  nominationId = nomId;
                  userId = b.userId;
                  amount = b.amount;
                  isProxy = b.isProxy;
                  timestamp = b.timestamp;
                }
              }
            )
          }
        )
      }
    )
  };
  func bidHistoryEventRows() : Iter.Iter<BidHistoryEventRow> {
    nominationHistory.entries().flatMap(
      func((roomId, nomMap)) {
        nomMap.entries().flatMap(
          func((nomId, eventList)) {
            eventList.values().map(
              func(e) {
                {
                  roomId;
                  nominationId = nomId;
                  eventType = bidHistoryEventText(e.eventType);
                  userId = e.userId;
                  displayName = e.displayName;
                  playerName = e.playerName;
                  amount = e.amount;
                  timestamp = e.timestamp;
                  isAutoBid = optBool(e.isAutoBid);
                }
              }
            )
          }
        )
      }
    )
  };
  func chatMessageRows() : Iter.Iter<ChatMessageRow> {
    roomMessages.entries().flatMap(
      func((roomId, msgList)) {
        msgList.values().map(
          func(m) {
            {
              roomId;
              id = m.id;
              userId = m.userId;
              displayName = m.displayName;
              message = m.message;
              timestamp = m.timestamp;
              reactionsCount = m.reactions.size();
            }
          }
        )
      }
    )
  };
  func playerPriceRecordRows() : Iter.Iter<PlayerPriceRecordRow> {
    playerPriceHistory.entries().flatMap(
      func((playerKey, recList)) {
        recList.values().map(
          func(r) {
            {
              playerKey;
              playerId = optText(r.playerId);
              playerName = r.playerName;
              position = r.position;
              winningBid = r.winningBid;
              budgetPct = r.budgetPct;
              totalBudget = r.totalBudget;
              numTeams = r.numTeams;
              leagueType = r.leagueType;
              winningUserId = r.winningUserId;
              roomId = r.roomId;
              closedAt = r.closedAt;
            }
          }
        )
      }
    )
  };
  func userRoomRows() : Iter.Iter<UserRoomRow> {
    userRooms.entries().flatMap(
      func((userId, roomList)) {
        roomList.values().map(
          func(roomId) { { userId; roomId } }
        )
      }
    )
  };
  func bestBallConfigRows() : Iter.Iter<BestBallConfigRow> {
    bestBallConfigs.entries().map(
      func((roomId, cfg)) {
        {
          roomId;
          startWeek = cfg.startWeek;
        }
      }
    )
  };
  func syncStatusRows() : Iter.Iter<SyncStatusRow> {
    syncStatuses.entries().map(
      func((_key, r)) {
        {
          season = r.season;
          week = r.week;
          lastAttemptedAt = r.lastAttemptedAt;
          status = syncStatusText(r.status);
          lastError = optText(r.lastError);
          lastSuccessfulAt = optInt(r.lastSuccessfulAt);
        }
      }
    )
  };
  func finalizedScoreRows() : Iter.Iter<FinalizedScoreRow> {
    finalizedWeeklyScores.entries().map(
      func((key, score)) {
        // Composite key format (see lib/best-ball-caching.finalizedScoreKey):
        //   roomId # "|" # season.toText() # "|" # week.toText() # "|" # principal.toText()
        // Split on "|" to recover the four components. Keys are always produced
        // by the backend's own finalizedScoreKey, so the split is well-formed.
        let parts = key.split(#text "|").toArray();
        {
          roomId = parts[0];
          season = Nat.fromText(parts[1]) ?? 0;
          week = Nat.fromText(parts[2]) ?? 0;
          principal = Principal.fromText(parts[3]);
          score;
        }
      }
    )
  };

  include Expose({
    entities = [
      // room — top-level map, controllerOnly. Room has many non-primitive
      // fields (variant state, nested settings/playerFilter, option fields,
      // arrays); exposed via .toEntityManual with sentinel conversions.
      rooms.toEntityManual("room", "Room", "id")
        .payload("id", func r = r.id)
        .payload("name", func r = r.name)
        .payload("admin", func r = r.admin)
        .payload("state", func r = auctionStateText(r.state))
        .payload("startingBudget", func r = r.startingBudget)
        .payload("createdAt", func r = r.createdAt)
        .payload("nominatorIndex", func r = r.nominatorIndex)
        .payload("nominationTurnStartedAt", func r = r.nominationTurnStartedAt)
        .payload("isPublic", func r = r.isPublic)
        .payload("password", func r = optText(r.password))
        .payload("nominationTurnPausedAt", func r = optInt(r.nominationTurnPausedAt))
        .payload("participantsCount", func r = r.participants.size())
        .payload("readyParticipantsCount", func r = r.readyParticipants.size())
        .payload("paidParticipantsCount", func r = r.paidParticipants.size())
        .payload("teamCount", func r = optNat(r.teamCount))
        .payload("leagueFormat", func r = optText(r.leagueFormat))
        .payload("season", func r = r.season)
        .payload("scoringFormat", func r = scoringFormatText(r.scoringFormat))
        .payload("competitionMode", func r = competitionModeText(r.competitionMode))
        .payload("playoffTeams", func r = r.playoffTeams)
        .payload("settingsNomTimerSecs", func r = r.settings.nomTimerSecs)
        .payload("settingsBidTimerSecs", func r = r.settings.bidTimerSecs)
        .payload("settingsMinBidIncrement", func r = r.settings.minBidIncrement)
        .payload("settingsMaxActivePicks", func r = r.settings.maxActivePicks)
        .payload("settingsMaxParticipants", func r = r.settings.maxParticipants)
        .payload("settingsMaxRosterSize", func r = optNat(r.settings.maxRosterSize))
        .payload("settingsAdpDataset", func r = r.settings.adpDataset)
        .payload("playerFilterType", func r = r.playerFilter.filterType)
        .payload("playerFilterPositionsCount", func r = r.playerFilter.positions.size())
        .sample({
          id = ""; name = ""; admin = anyP; state = #Waiting; gameType = #Auction; competitionMode = #Cumulative; playoffTeams = 0; startingBudget = 0;
          createdAt = 0; nominatorIndex = 0; nominationTurnStartedAt = 0;
          isPublic = true; password = null; participants = []; settings = {
            nomTimerSecs = 0; bidTimerSecs = 0; minBidIncrement = 0;
            maxActivePicks = 0; maxParticipants = 0; maxRosterSize = null;
            adpDataset = "";
          };
          playerFilter = { positions = []; filterType = "" };
          nominationTurnPausedAt = null; readyParticipants = [];
          paidParticipants = [];
          rosterSettings = null; teamCount = null; leagueFormat = null;
          season = 0; scoringFormat = #halfPpr;
        })
        .controllerOnly()
        .build(),

      // nomination — top-level map, controllerOnly.
      nominations.toEntityManual("nomination", "Nomination", "id")
        .payload("id", func n = n.id)
        .payload("roomId", func n = n.roomId)
        .payload("playerId", func n = n.playerId)
        .payload("playerName", func n = n.playerName)
        .payload("position", func n = n.position)
        .payload("team", func n = n.team)
        .payload("imageUrl", func n = optText(n.imageUrl))
        .payload("nominatedBy", func n = n.nominatedBy)
        .payload("state", func n = nominationStateText(n.state))
        .payload("currentBid", func n = n.currentBid)
        .payload("bidLeader", func n = switch (n.bidLeader) { case null anyP; case (?u) u })
        .payload("timerStartedAt", func n = n.timerStartedAt)
        .payload("timerDurationSecs", func n = n.timerDurationSecs)
        .payload("timerPausedAt", func n = optInt(n.timerPausedAt))
        .payload("timerElapsedSecs", func n = n.timerElapsedSecs)
        .sample({
          id = 0; roomId = ""; playerId = ""; playerName = ""; position = "";
          team = ""; imageUrl = null; nominatedBy = anyP; state = #Active;
          currentBid = 0; bidLeader = null; timerStartedAt = 0;
          timerDurationSecs = 0; timerPausedAt = null; timerElapsedSecs = 0;
        })
        .controllerOnly()
        .build(),

      // player — top-level map, controllerOnly.
      players.toEntityManual("player", "Player", "id")
        .payload("id", func p = p.id)
        .payload("name", func p = p.name)
        .payload("position", func p = p.position)
        .payload("team", func p = p.team)
        .payload("byeWeek", func p = optNat(p.byeWeek))
        .payload("adp", func p = p.adp)
        .payload("headshotUrl", func p = optText(p.headshotUrl))
        .payload("yearsExp", func p = p.yearsExp)
        .sample({
          id = ""; name = ""; position = ""; team = ""; byeWeek = null;
          adp = 0.0; headshotUrl = null; yearsExp = 0;
        })
        .controllerOnly()
        .build(),

      // profile — top-level map, controllerOrScoped, owned by userId.
      profiles.toEntityManual("profile", "UserProfile", "userId")
        .payload("userId", func p = p.userId)
        .payload("displayName", func p = p.displayName)
        .payload("avatarUrl", func p = optText(p.avatarUrl))
        .sample({ userId = anyP; displayName = ""; avatarUrl = null })
        .ownedBy("userId")
        .controllerOrScoped()
        .build(),

      // participant — flattened from nested map, controllerOnly.
      OQL.Entity.manual<ParticipantRow>("participant", participantRows, "ParticipantRow", "roomId")
        .payload("roomId", func r = r.roomId)
        .payload("userId", func r = r.userId)
        .payload("displayName", func r = r.displayName)
        .payload("budget", func r = r.budget)
        .payload("spent", func r = r.spent)
        .payload("committedCount", func r = r.committedCount)
        .payload("wonPlayersCount", func r = r.wonPlayersCount)
        .payload("skipNominationTurn", func r = r.skipNominationTurn)
        .sample({ roomId = ""; userId = anyP; displayName = ""; budget = 0; spent = 0; committedCount = 0; wonPlayersCount = 0; skipNominationTurn = false })
        .controllerOnly()
        .build(),

      // bid — flattened from nested map+list, controllerOnly.
      OQL.Entity.manual<BidRow>("bid", bidRows, "BidRow", "roomId")
        .payload("roomId", func r = r.roomId)
        .payload("nominationId", func r = r.nominationId)
        .payload("userId", func r = r.userId)
        .payload("amount", func r = r.amount)
        .payload("isProxy", func r = r.isProxy)
        .payload("timestamp", func r = r.timestamp)
        .sample({ roomId = ""; nominationId = 0; userId = anyP; amount = 0; isProxy = false; timestamp = 0 })
        .controllerOnly()
        .build(),

      // bidHistoryEvent — flattened from nested map+list, controllerOnly.
      OQL.Entity.manual<BidHistoryEventRow>("bidHistoryEvent", bidHistoryEventRows, "BidHistoryEventRow", "roomId")
        .payload("roomId", func r = r.roomId)
        .payload("nominationId", func r = r.nominationId)
        .payload("eventType", func r = r.eventType)
        .payload("userId", func r = r.userId)
        .payload("displayName", func r = r.displayName)
        .payload("playerName", func r = r.playerName)
        .payload("amount", func r = r.amount)
        .payload("timestamp", func r = r.timestamp)
        .payload("isAutoBid", func r = r.isAutoBid)
        .sample({ roomId = ""; nominationId = 0; eventType = ""; userId = anyP; displayName = ""; playerName = ""; amount = 0; timestamp = 0; isAutoBid = false })
        .controllerOnly()
        .build(),

      // chatMessage — flattened from nested map+list, controllerOnly.
      OQL.Entity.manual<ChatMessageRow>("chatMessage", chatMessageRows, "ChatMessageRow", "roomId")
        .payload("roomId", func r = r.roomId)
        .payload("id", func r = r.id)
        .payload("userId", func r = r.userId)
        .payload("displayName", func r = r.displayName)
        .payload("message", func r = r.message)
        .payload("timestamp", func r = r.timestamp)
        .payload("reactionsCount", func r = r.reactionsCount)
        .sample({ roomId = ""; id = 0; userId = anyP; displayName = ""; message = ""; timestamp = 0; reactionsCount = 0 })
        .controllerOnly()
        .build(),

      // playerPriceRecord — flattened from nested map+list, controllerOnly.
      OQL.Entity.manual<PlayerPriceRecordRow>("playerPriceRecord", playerPriceRecordRows, "PlayerPriceRecordRow", "playerKey")
        .payload("playerKey", func r = r.playerKey)
        .payload("playerId", func r = r.playerId)
        .payload("playerName", func r = r.playerName)
        .payload("position", func r = r.position)
        .payload("winningBid", func r = r.winningBid)
        .payload("budgetPct", func r = r.budgetPct)
        .payload("totalBudget", func r = r.totalBudget)
        .payload("numTeams", func r = r.numTeams)
        .payload("leagueType", func r = r.leagueType)
        .payload("winningUserId", func r = r.winningUserId)
        .payload("roomId", func r = r.roomId)
        .payload("closedAt", func r = r.closedAt)
        .sample({ playerKey = ""; playerId = ""; playerName = ""; position = ""; winningBid = 0; budgetPct = 0.0; totalBudget = 0; numTeams = 0; leagueType = ""; winningUserId = anyP; roomId = ""; closedAt = 0 })
        .controllerOnly()
        .build(),

      // userRoom — flattened from nested map+list, controllerOrScoped, owned by userId.
      OQL.Entity.manual<UserRoomRow>("userRoom", userRoomRows, "UserRoomRow", "userId")
        .payload("userId", func r = r.userId)
        .payload("roomId", func r = r.roomId)
        .sample({ userId = anyP; roomId = "" })
        .ownedBy("userId")
        .controllerOrScoped()
        .build(),

      // bestBallConfig — top-level map (roomId → BestBallConfig), controllerOnly.
      // Room-scoped config data, matching the authorization convention used for
      // the other room-scoped tables (room, nomination, participant, bid, …).
      // roomId is the map key (not a field of BestBallConfig), so it is promoted
      // via manual mode over .entries().
      OQL.Entity.manual<BestBallConfigRow>("bestBallConfig", bestBallConfigRows, "BestBallConfigRow", "roomId")
        .payload("roomId", func r = r.roomId)
        .payload("startWeek", func r = r.startWeek)
        .sample({ roomId = ""; startWeek = 0 })
        .controllerOnly()
        .build(),

      // weeklyPlayerStats — top-level map (composite Text key →
      // WeeklyPlayerStats), controllerOnly. Raw weekly player statistics synced
      // via the admin-only syncWeeklyStats endpoint. Every field is a primitive
      // (Text/Nat) and queryable, so it is exposed directly via .toEntityManual.
      // The composite key (playerId|season|week) is the map key, not a field, so
      // playerId/season/week are exposed as payload columns instead. Raw stat
      // categories only — no precomputed points (those are computed in a later
      // phase and never stored).
      weeklyPlayerStats.toEntityManual("weeklyPlayerStats", "WeeklyPlayerStats", "playerId")
        .payload("playerId", func s = s.playerId)
        .payload("season", func s = s.season)
        .payload("week", func s = s.week)
        .payload("passYds", func s = s.passYds)
        .payload("passTds", func s = s.passTds)
        .payload("ints", func s = s.ints)
        .payload("rushYds", func s = s.rushYds)
        .payload("rushTds", func s = s.rushTds)
        .payload("receptions", func s = s.receptions)
        .payload("recYds", func s = s.recYds)
        .payload("recTds", func s = s.recTds)
        .payload("fumblesLost", func s = s.fumblesLost)
        .payload("twoPtConversions", func s = s.twoPtConversions)
        .sample({
          playerId = ""; season = 0; week = 0; passYds = 0; passTds = 0; ints = 0;
          rushYds = 0; rushTds = 0; receptions = 0; recYds = 0; recTds = 0;
          fumblesLost = 0; twoPtConversions = 0;
        })
        .controllerOnly()
        .build(),

      // syncStatus — top-level map (composite "season|week" Text key →
      // SyncStatusRecord), controllerOnly. Operational/diagnostic per-(season,
      // week) sync status for Best Ball weekly stats. The composite key is the
      // map key, not a field, so season/week are exposed as payload columns.
      // The status variant is collapsed to a Text tag and the option fields
      // (lastError, lastSuccessfulAt) use sentinel conversions so every column
      // is a stable primitive. Admin-only diagnostic data, matching the
      // controllerOnly convention of the other operational tables.
      OQL.Entity.manual<SyncStatusRow>("syncStatus", syncStatusRows, "SyncStatusRow", "season")
        .payload("season", func r = r.season)
        .payload("week", func r = r.week)
        .payload("lastAttemptedAt", func r = r.lastAttemptedAt)
        .payload("status", func r = r.status)
        .payload("lastError", func r = r.lastError)
        .payload("lastSuccessfulAt", func r = r.lastSuccessfulAt)
        .sample({ season = 0; week = 0; lastAttemptedAt = 0; status = "notYetAttempted"; lastError = ""; lastSuccessfulAt = 0 })
        .controllerOnly()
        .build(),

      // finalizedWeeklyScore — flattened from the finalizedWeeklyScores map
      // (composite Text key → Float), controllerOnly. The permanent cache of
      // each participant's final optimal weekly-lineup total for #finalized
      // weeks. The composite key (roomId|season|week|principal) is the map key,
      // not a field, so the four components are recovered by splitting the key
      // and exposed as payload columns alongside the cached `score` (Float).
      // Room-scoped data, matching the controllerOnly convention of the other
      // room-scoped tables (participant, bid, bestBallConfig, …).
      OQL.Entity.manual<FinalizedScoreRow>("finalizedWeeklyScore", finalizedScoreRows, "FinalizedScoreRow", "roomId")
        .payload("roomId", func r = r.roomId)
        .payload("season", func r = r.season)
        .payload("week", func r = r.week)
        .payload("principal", func r = r.principal)
        .payload("score", func r = r.score)
        .sample({ roomId = ""; season = 0; week = 0; principal = anyP; score = 0.0 })
        .controllerOnly()
        .build(),
    ];
  });

  // ── Weekly sync-status daily timer (Phase 10) ─────────────────────────────
  // Once-per-day job: compute the deduplicated (season, week) set across all
  // #BestBall rooms' startWeek..endWeek ranges, then for each pair ensure a
  // status record exists and is marked as needing attention (anything not
  // #synced). It never fetches from Sleeper and never makes an HTTPS outcall —
  // this is visibility, not full autonomy. The recurring timer is NOT persisted
  // across canister upgrades (mo:core/Timer), so it is re-registered in the
  // postupgrade hook below.
  func runDailySyncCheck() : async () {
    let pairs = SyncStatusLib.computeDedupSeasonWeeks(rooms, bestBallConfigs);
    // Backstop: re-enforce the finalization invariant — at most one live
    // (#partial) week per season. For each season, finalize every #partial week
    // below the live week (the highest #partial week, or startWeek if none).
    // This is the same rule the sync flow enforces, applied here as a safety
    // net so a completed-but-unfinalized week can never accumulate.
    let bySeason = Map.empty<Nat, List.List<Nat>>();
    for ((season, week) in pairs.values()) {
      switch (bySeason.get(season)) {
        case (?weeks) weeks.add(week);
        case null {
          let weeks = List.empty<Nat>();
          weeks.add(week);
          bySeason.add(season, weeks);
        };
      };
    };
    bySeason.forEach(func(season, weeks) {
      let live = SyncStatusLib.liveWeekForSeason(syncStatuses, season, weeks.toArray());
      ignore BestBallCachingLib.finalizePriorPartialWeeks(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup, season, live);
    });
    // Post-migration backfill: populate the cache for pre-existing #finalized
    // weeks lacking entries. Idempotent — never overwrites existing entries.
    ignore BestBallCachingLib.backfillFinalizedScores(rooms, participants, bestBallConfigs, syncStatuses, finalizedWeeklyScores, calculateOptimalWeeklyLineup);
    // Flag the live week for partial sync.
    ignore SyncStatusLib.flagNeedingAttention(syncStatuses, pairs);
  };

  /// One-time membership index repair on upgrade (Fix 2).
  /// Rebuilds the entire userRooms index from the authoritative room.participants
  /// arrays and reconciles every room's inner participants map. This repairs all
  /// existing rooms without requiring users to leave and rejoin. Called
  /// automatically by the canister system after an upgrade via the system
  /// postupgrade hook; safe to call repeatedly (idempotent).
  ///
  /// Also performs two additional one-time repair passes on upgrade:
  ///
  ///   Fix 1 (Collision prevention): corrects nextNominationIdState.next upward
  ///   to max(existing nomination IDs) + 1 when the persisted value would be too
  ///   low. After a restart/upgrade where deleteRoom has shrunk the nominations
  ///   map below the highest ID ever issued, the counter must never restart
  ///   below existing IDs — otherwise new nominations.add(nomId) would overwrite
  ///   closed records and inherit their bid history. Only corrects upward; never
  ///   resets to zero. Idempotent.
  ///
  ///   Fix 2 (History repair): scans every room's nominationHistory and removes
  ///   contaminated bid history entries — entries whose embedded playerName
  ///   differs from the nomination's actual playerName (e.g. a "won Trevor
  ///   Lawrence" event inside an RJ Harvey nomination, a leftover from a prior
  ///   ID collision). Rebuilds each nomination's history list with only
  ///   matching entries. Nominations whose history is already clean are left
  ///   untouched. Idempotent.
  ///
  /// Note: postupgrade must be a non-async system function (M0127). The
  /// reconciliation logic is synchronous (it only mutates in-memory stable
  /// state), so we call the synchronous helper directly rather than awaiting
  /// the public async endpoint.
  system func postupgrade<system>() {
    reconcileUserRoomsIndex(null);
    rooms.forEach(func(roomId, room) {
      let pm = reconcileParticipantsMap(roomId, room);
      ignore pm;
    });

    // Fix 1: Correct nextNominationIdState upward to max(existing nomination IDs)+1
    // when the persisted value would be too low. Only corrects upward; never
    // lowers the counter. Idempotent — a second run is a no-op once corrected.
    if (nominations.size() > 0) {
      var maxId : Nat = 0;
      nominations.forEach(func(nomId, _nom) {
        if (nomId > maxId) maxId := nomId;
      });
      let required = maxId + 1;
      if (nextNominationIdState.next < required) {
        nextNominationIdState.next := required;
      };
    };

    // Fix 2: Repair contaminated bid history. For each room's nominationHistory,
    // for each nomination's event list, drop entries whose embedded playerName
    // does not match the nomination's actual playerName. Rebuild the list with
    // only matching entries. Idempotent — clean histories are unchanged.
    nominationHistory.forEach(func(roomId, roomHistory) {
      roomHistory.forEach(func(nomId, history) {
        // Only repair histories for nominations that still exist; orphaned
        // history entries (nomination deleted via deleteRoom) are left as-is
        // since they are no longer reachable via getNominationHistory.
        switch (nominations.get(nomId)) {
          case null {};
          case (?nom) {
            let expectedName = nom.playerName;
            // Filter in place: rebuild the list keeping only matching entries.
            // Use a flag to avoid rewriting the list when it is already clean
            // (idempotent no-op for clean histories).
            var contaminated = false;
            history.forEach(func(event) {
              if (event.playerName != expectedName) {
                contaminated := true;
              };
            });
            if (contaminated) {
              let cleaned = history.filter(func(event) {
                event.playerName == expectedName;
              });
              history.clear();
              cleaned.forEach(func(event) { history.add(event) });
            };
          };
        };
      });
    });

    // Fix 3: Backfill nominationsByRoom from the existing flat nominations map.
    // One-time scan that groups NominationIds by roomId into nominationsByRoom.
    // Guarded to run only once: when nominationsByRoom is empty but nominations
    // is not. Idempotent — a second run is a no-op once nominationsByRoom is
    // populated (and any new nominations are appended at creation time by
    // nominatePlayerCore, so this backfill only needs to cover pre-upgrade
    // nominations).
    if (nominationsByRoom.size() == 0 and nominations.size() > 0) {
      nominations.forEach(func(nomId, nom) {
        let existing : [Types.NominationId] = switch (nominationsByRoom.get(nom.roomId)) {
          case null [];
          case (?ids) ids;
        };
        nominationsByRoom.add(nom.roomId, existing.concat([nomId]));
      });
    };

    // Fix 4: Backfill the authoritative draftedPlayerIds set from existing
    // closed nominations with a winning bid. For each room, scan its closed
    // nominations (via nominationsByRoom index) and for every nomination with
    // state #Closed and bidLeader != null (a winning bid), add nom.playerId to
    // the room's drafted set. This repairs the current live room so already-
    // drafted players (e.g. Trevor Lawrence) are immediately excluded from the
    // nomination list. Idempotent — Set.add is naturally idempotent, so a
    // second run is a no-op.
    nominationsByRoom.forEach(func(roomId, ids) {
      let drafted = switch (draftedPlayerIds.get(roomId)) {
        case (?s) s;
        case null {
          let s = Set.empty<Text>();
          draftedPlayerIds.add(roomId, s);
          s;
        };
      };
      for (nomId in ids.vals()) {
        switch (nominations.get(nomId)) {
          case null {};
          case (?nom) {
            if (nom.state == #Closed and nom.bidLeader != null) {
              drafted.add(nom.playerId);
            };
          };
        };
      };
    });

    // Phase 10: Re-register the once-per-day weekly sync-status timer.
    // mo:core/Timer timers are NOT persisted across canister upgrades, so a
    // recurring timer must be re-registered in a post-upgrade hook. This is a
    // non-async postupgrade (M0127); Timer.recurringTimer<system> carries the
    // <system> capability and can be called here directly. The timer job
    // (runDailySyncCheck) only computes which (season, week) pairs need
    // attention and maintains the status record — it never fetches from Sleeper
    // and never makes an HTTPS outcall.
    ignore Timer.recurringTimer<system>(#seconds(86400), runDailySyncCheck);
  };

  public query func getCycleBalance() : async Nat {
    Cycles.balance()
  };

};
