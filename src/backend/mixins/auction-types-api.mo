import Types "../types/auction-types";
import AuctionLib "../lib/auction-types";
import Map "mo:core/Map";
import List "mo:core/List";
import Set "mo:core/Set";
import Time "mo:core/Time";
import Principal "mo:core/Principal";
import Int "mo:core/Int";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Text "mo:core/Text";
import Char "mo:core/Char";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Error "mo:core/Error";
import OutCall "mo:caffeineai-http-outcalls/outcall";
import AdminAuthLib "../lib/admin-auth";
import Result "mo:core/Result";
// Buffer replaced with List — mo:core 2.5.0 does not include Buffer

// Public API mixin for the Fantasy Football Auction platform.
// State is injected; no business logic lives here — delegates to lib/.
// Note: nomination IDs come from the injected nextNominationIdState counter, which is
// monotonically incrementing and never shrinks. nominations.size() MUST NOT be used to
// generate IDs — deleteRoom removes nominations from the map, which would shrink the
// size and cause ID collisions (and thus inherited bid history) across rooms.

mixin (
  rooms              : Map.Map<Types.RoomId, Types.Room>,
  participants       : Map.Map<Types.RoomId, Map.Map<Types.UserId, Types.Participant>>,
  nominations        : Map.Map<Types.NominationId, Types.Nomination>,
  nominationsByRoom  : Map.Map<Types.RoomId, [Types.NominationId]>,
  bids               : Map.Map<Types.RoomId, Map.Map<Types.NominationId, List.List<Types.Bid>>>,
  proxyBids          : Map.Map<Types.RoomId, Map.Map<Types.NominationId, Map.Map<Types.UserId, Types.ProxyBid>>>,
  nominatedByRoom    : Map.Map<Types.RoomId, Set.Set<Text>>,
  draftedPlayerIds   : Map.Map<Types.RoomId, Set.Set<Text>>,
  players            : Map.Map<Text, Types.Player>,
  profiles           : Map.Map<Types.UserId, Types.UserProfile>,
  userRooms          : Map.Map<Types.UserId, List.List<Types.RoomId>>,
  nominationHistory  : Map.Map<Types.RoomId, Map.Map<Types.NominationId, List.List<Types.BidHistoryEvent>>>,
  roomMessages       : Map.Map<Types.RoomId, List.List<Types.ChatMessage>>,
  adminPrincipalStore : Map.Map<Text, Types.UserId>,
  activeAdpDataset   : Map.Map<Text, Types.ADPDataset>,
  nominationQueue    : Map.Map<Text, Text>,
  giphyApiKeyStore        : Map.Map<Text, Text>,
  oneSignalApiKeyStore    : Map.Map<Text, Text>,
  oneSignalPlayerIds      : Map.Map<Text, Text>,
  roomIdState             : { var next : Nat },
  nextMsgIdState          : { var next : Nat },
  nextNominationIdState  : { var next : Nat },
  getOrCreateBids         : (Types.RoomId) -> Map.Map<Types.NominationId, List.List<Types.Bid>>,
  getOrCreateProxyBids    : (Types.RoomId) -> Map.Map<Types.NominationId, Map.Map<Types.UserId, Types.ProxyBid>>,
  getOrCreateNominationHistory : (Types.RoomId) -> Map.Map<Types.NominationId, List.List<Types.BidHistoryEvent>>,
  rssCacheContent : { var content : ?Text },
  rssCacheTimestamp : { var timestamp : Nat },
  rssFeedUrlsStore : Map.Map<Text, [Text]>,
  rssRefreshIntervalSecs : { var seconds : Nat },
  lastRssFetchStatus : { var status : [(Text, Bool)] },
  activeRoomIds : Set.Set<Types.RoomId>,
  playerPriceHistory : Map.Map<Text, List.List<Types.PlayerPriceRecord>>,
  notificationQueue : List.List<Types.PendingNotification>,
  nextNotificationId : { var next : Nat },
  byeWeeksStore : Map.Map<Text, [(Text, Nat)]>,
  notificationsQueuedTotal : { var count : Nat },
  notificationsProcessedTotal : { var count : Nat },
  notificationsSentTotal : { var count : Nat },
  notificationsExpiredTotal : { var count : Nat },
  notificationsRetriedTotal : { var count : Nat },
  notificationsFailedTotal : { var count : Nat },
  notificationWorkerEntryCount : { var count : Nat },
  lastNotificationWorkerStartedAt : { var value : Int },
  lastNotificationWorkerCompletedAt : { var value : Int },
  lastNotificationWorkerError : { var error : ?Text },
  processingNotifications : { var value : Bool },
  bestBallConfigs : Map.Map<Types.RoomId, Types.BestBallConfig>,
  weeklyPlayerStats : Map.Map<Text, Types.WeeklyPlayerStats>,
) {

  // ── Notification worker tuning constants ─────────────────────────────────────
  // These govern the backend notification queue drain triggered at enqueue time.
  // Declared `transient let` inside the mixin body (not at module top-level per
  // M0228) so they are NOT persisted as stable state — they are re-initialized
  // from these literals on every (re)start. Under enhanced orthogonal persistence
  // a bare `let` in a mixin is implicitly stable (IC0503 at runtime) and cannot
  // have an initializer (M0250 at compile time); `transient` opts out of stable
  // storage so the literals are legal here.
  transient let MAX_QUEUE_SIZE : Nat = 1000;
  transient let MAX_NOTIFICATIONS_PER_RUN : Nat = 50;
  transient let MAX_NOTIFICATION_PROCESSING_NANOS : Nat = 12_000_000_000;
  transient let NOTIFICATION_EXPIRY_NANOS : Nat = 300_000_000_000;
  transient let MAX_SEND_ATTEMPTS : Nat = 3;
  transient let MAX_NOTIFICATION_BODY_LENGTH : Nat = 100;

  // ─────────────────────────────────────────────────────────────────────────
  // Weekly stats sync (admin-only)
  // ─────────────────────────────────────────────────────────────────────────

  /// Compose the composite stable-storage key for a weekly stats entry.
  /// Follows the exact convention already used by queueKey:
  ///   playerId # "|" # Nat.toText(season) # "|" # Nat.toText(week)
  func statsKey(playerId : Text, season : Nat, week : Nat) : Text {
    playerId # "|" # season.toText() # "|" # week.toText();
  };

  /// Admin-only endpoint that receives a typed batch of raw weekly player stats
  /// and upserts them into weeklyPlayerStats. The backend does NOT fetch or
  /// parse anything itself — the frontend fetches from Sleeper and sends the
  /// typed batch here.
  ///
  /// For each entry in the batch:
  ///   - verifies entry.season == season and entry.week == week; mismatched
  ///     entries are skipped (counted in a diagnostic) without failing the call
  ///   - upserts valid entries keyed by statsKey(entry.playerId, season, week),
  ///     so re-running an already-synced week cleanly overwrites (no duplicates)
  ///
  /// Returns #ok with the count of entries successfully stored.
  public shared ({ caller }) func syncWeeklyStats(
    season : Nat,
    week : Nat,
    batch : [Types.WeeklyPlayerStats],
  ) : async { #ok : Nat; #err : Text } {
    // Only the registered admin (or hardcoded admin principal) may call this.
    // Same authorization pattern as importPlayers.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can sync weekly stats";
    };

    var stored = 0;
    var skipped = 0;
    for (entry in batch.vals()) {
      // Skip entries whose season/week don't match the requested sync target.
      // A mismatched entry is counted in the diagnostic, not a whole-call error.
      if (entry.season != season or entry.week != week) {
        skipped += 1;
      } else {
        // Upsert keyed by the composite key — re-syncing an already-synced week
        // cleanly overwrites existing entries (no duplicates) via the composite
        // key's upsert semantics.
        weeklyPlayerStats.add(statsKey(entry.playerId, season, week), entry);
        stored += 1;
      };
    };
    Debug.print(
      "[DIAG-WEEKLY-STATS] sync season=" # season.toText()
      # " week=" # week.toText()
      # " stored=" # stored.toText()
      # " skipped=" # skipped.toText()
    );
    #ok stored;
  };

  /// Public query that computes fantasy points for a stored WeeklyPlayerStats
  /// entry at statsKey(playerId, season, week) under the given ScoringFormat.
  ///
  /// Returns null when no entry exists for that key — keeping null (no data)
  /// and zero (a real zero-point performance) distinguishable. Callable by any
  /// authenticated caller with no room-specific authorization, since it reads
  /// shared NFL stats data.
  public query func getPlayerWeeklyPoints(
    playerId : Text,
    season : Nat,
    week : Nat,
    format : Types.ScoringFormat,
  ) : async ?Float {
    switch (weeklyPlayerStats.get(statsKey(playerId, season, week))) {
      case (?stats) ?AuctionLib.calculatePlayerPoints(stats, format);
      case null null;
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /// Compose a Map key for the nomination queue from a roomId and userId.
  /// Uses "|" separator — safe since roomId (Nat-as-Text) never contains "|".
  func queueKey(roomId : Types.RoomId, userId : Types.UserId) : Text {
    roomId # "|" # userId.toText();
  };

  /// Check if caller is admin of the given room
  func isAdmin(room : Types.Room, caller : Types.UserId) : Bool {
    Principal.equal(room.admin, caller);
  };

  /// Get participant map for a room (creates empty if missing)
  func getRoomParticipants(roomId : Types.RoomId) : Map.Map<Types.UserId, Types.Participant> {
    switch (participants.get(roomId)) {
      case (?pm) pm;
      case null {
        let pm = Map.empty<Types.UserId, Types.Participant>();
        participants.add(roomId, pm);
        pm;
      };
    };
  };

  /// Reconcile the inner participants map for a room so it contains exactly the
  /// users in room.participants. Adds missing participant records (synthesizing
  /// a default Participant from the room's startingBudget) and removes entries
  /// for users no longer in room.participants. Returns the reconciled map.
  /// This makes room.participants the authoritative source of truth for the
  /// participant count (Fix 4) and heals any drift between the two stores.
  func reconcileParticipantsMap(roomId : Types.RoomId, room : Types.Room) : Map.Map<Types.UserId, Types.Participant> {
    let pm = getRoomParticipants(roomId);
    // Remove entries for users no longer in room.participants.
    // Collect keys to remove first to avoid mutating during iteration.
    var toRemove = List.empty<Types.UserId>();
    pm.forEach(func(userId, _p) {
      if (not AuctionLib.isParticipant(room, userId)) {
        toRemove.add(userId);
      };
    });
    toRemove.forEach(func(userId) { pm.remove(userId) });
    // Add missing entries for users in room.participants without a record.
    // Synthesize a default Participant using the room's startingBudget and the
    // resolved display name (profile or truncated principal).
    for (userId in room.participants.vals()) {
      switch (pm.get(userId)) {
        case (?_) {};
        case null {
          pm.add(userId, AuctionLib.newParticipant(userId, displayNameFor(userId), room.startingBudget));
        };
      };
    };
    pm;
  };

  /// Get the nominated-players set for a room
  func getRoomNominatedSet(roomId : Types.RoomId) : Set.Set<Text> {
    switch (nominatedByRoom.get(roomId)) {
      case (?s) s;
      case null {
        let s = Set.empty<Text>();
        nominatedByRoom.add(roomId, s);
        s;
      };
    };
  };

  /// Get the authoritative drafted-players set for a room. This is the single
  /// source of truth for which players have already been drafted (won) in the
  /// room. It is populated in every nomination-close path with a winning bid
  /// and is NEVER removed when a participant leaves or is removed.
  func getRoomDraftedSet(roomId : Types.RoomId) : Set.Set<Text> {
    switch (draftedPlayerIds.get(roomId)) {
      case (?s) s;
      case null {
        let s = Set.empty<Text>();
        draftedPlayerIds.add(roomId, s);
        s;
      };
    };
  };

  /// Resolve display name for a user: profile > truncated principal
  func displayNameFor(userId : Types.UserId) : Text {
    AuctionLib.resolveDisplayName(profiles, userId);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Notification queue helpers
  // ─────────────────────────────────────────────────────────────────────────

  /// Escape a Text value for safe inclusion as a JSON string literal.
  /// Escapes the required JSON metacharacters: " \ and the control chars
  /// newline, carriage return, and tab.
  func jsonEscape(s : Text) : Text {
    var out = "";
    for (ch in s.chars()) {
      switch (ch) {
        case ('\u{22}') out := out # "\\\"";
        case ('\\') out := out # "\\\\";
        case ('\n') out := out # "\\n";
        case ('\r') out := out # "\\r";
        case ('\t') out := out # "\\t";
        case (_) out := out # ch.toText();
      };
    };
    out;
  };

  /// Truncate `s` to at most `maxLen` characters. If truncation occurs,
  /// appends "..." so the caller sees the value was shortened.
  func truncateText(s : Text, maxLen : Nat) : Text {
    if (s.size() <= maxLen) s
    else {
      var out = "";
      var i = 0;
      for (ch in s.chars()) {
        if (i >= maxLen) return out # "...";
        out := out # ch.toText();
        i += 1;
      };
      out # "...";
    };
  };

  /// Enqueue a pending notification for a user. Cheap synchronous side effect —
  /// no HTTP outcall is made here. The drain is triggered fire-and-forget by
  /// the async public update method that called enqueueNotification (it adds
  /// `ignore _processNotificationQueue();` as its last statement), so the
  /// enclosing update call returns immediately.
  /// Title is capped at 50 chars; body is capped at MAX_NOTIFICATION_BODY_LENGTH;
  /// queue is capped at MAX_QUEUE_SIZE (oldest evicted when full).
  func enqueueNotification(userId : Types.UserId, title : Text, body : Text) {
    // Cap the queue: if at capacity, evict the oldest entry (index 0).
    if (notificationQueue.size() >= MAX_QUEUE_SIZE) {
      let kept = notificationQueue.sliceToArray(1, notificationQueue.size());
      notificationQueue.clear();
      notificationQueue.addAll(kept.values());
    };
    let notif : Types.PendingNotification = {
      id        = nextNotificationId.next;
      userId;
      title     = truncateText(title, 50);
      body      = truncateText(body, MAX_NOTIFICATION_BODY_LENGTH);
      createdAt = Time.now();
      attempts  = 0;
    };
    nextNotificationId.next += 1;
    notificationQueue.add(notif);
    notificationsQueuedTotal.count += 1;
  };

  /// Drain the notification queue: send up to MAX_NOTIFICATIONS_PER_RUN notifications
  /// via the OneSignal REST API using an IC management canister HTTP outcall.
  /// Drops expired notifications (older than NOTIFICATION_EXPIRY_NANOS) and those
  /// that have exceeded MAX_SEND_ATTEMPTS. Bounded by MAX_NOTIFICATION_PROCESSING_NANOS.
  ///
  /// The processingNotifications guard and all worker instrumentation live here,
  /// not in enqueueNotification. enqueueNotification only fires this function
  /// fire-and-forget; this function decides whether to actually run. Two
  /// notifications enqueued in quick succession cannot trigger overlapping
  /// drains because the second invocation sees the guard set and returns 0.
  private func _processNotificationQueue() : async Nat {
    if (processingNotifications.value) return 0;
    processingNotifications.value := true;
    notificationWorkerEntryCount.count += 1;
    lastNotificationWorkerStartedAt.value := Time.now();
    try {
      if (notificationQueue.size() == 0) return 0;
      let apiKey = switch (oneSignalApiKeyStore.get("key")) {
        case null return 0;
        case (?k) k;
      };
      let startTime = Time.now();
      var processed = 0;
      // Drain oldest-first. We rebuild the queue from entries that survive this run
      // (re-queued failures under MAX_SEND_ATTEMPTS, plus unprocessed tail entries).
      let survivors = List.empty<Types.PendingNotification>();
      while (notificationQueue.size() > 0) {
        if (processed >= MAX_NOTIFICATIONS_PER_RUN) {
          // Move the entire remaining tail into survivors unchanged.
          let remaining = notificationQueue.sliceToArray(0, notificationQueue.size());
          notificationQueue.clear();
          survivors.addAll(remaining.values());
          break;
        };
        if (Time.now() - startTime > MAX_NOTIFICATION_PROCESSING_NANOS) {
          let remaining = notificationQueue.sliceToArray(0, notificationQueue.size());
          notificationQueue.clear();
          survivors.addAll(remaining.values());
          break;
        };
        // Pop oldest (index 0).
        let notif = notificationQueue.at(0);
        let tail = notificationQueue.sliceToArray(1, notificationQueue.size());
        notificationQueue.clear();
        notificationQueue.addAll(tail.values());

        // Expiry check: drop if older than NOTIFICATION_EXPIRY_NANOS.
        let age = Time.now() - notif.createdAt;
        if (age > NOTIFICATION_EXPIRY_NANOS) {
          processed += 1;
          notificationsProcessedTotal.count += 1;
          notificationsExpiredTotal.count += 1;
          continue;
        };

        // Look up the recipient's OneSignal player ID.
        let playerId = switch (oneSignalPlayerIds.get(notif.userId.toText())) {
          case null { processed += 1; notificationsProcessedTotal.count += 1; continue };
          case (?pid) pid;
        };

        // Build the OneSignal REST payload.
        let payload =
          "{"
          # "\"app_id\":\"1b488a94-8768-4292-a6a9-64a9fd5329c3\","
          # "\"include_player_ids\":[\"" # jsonEscape(playerId) # "\"],"
          # "\"headings\":{\"en\":\"" # jsonEscape(notif.title) # "\"},"
          # "\"contents\":{\"en\":\"" # jsonEscape(notif.body) # "\"}"
          # "}";

        let headers : [OutCall.Header] = [
          { name = "Authorization"; value = "Basic " # apiKey },
          { name = "Content-Type"; value = "application/json" },
          { name = "Idempotency-Key"; value = notif.id.toText() },
        ];

        var success = false;
        try {
          let responseText = await OutCall.httpPostRequest(
            "https://onesignal.com/api/v1/notifications",
            headers,
            payload,
            transform,
          );
          // OutCall.httpPostRequest returns the response body as Text, not a
          // structured response with a status code. OneSignal's success responses
          // include a top-level "id" field; error responses include an "errors"
          // field. Treat the presence of "errors" as failure.
          success := not responseText.contains(#text "\"errors\"");
        } catch (_) {
          success := false;
        };

        processed += 1;
        notificationsProcessedTotal.count += 1;
        if (success) {
          notificationsSentTotal.count += 1;
        } else {
          // Re-queue only if under the attempt cap.
          if (notif.attempts + 1 < MAX_SEND_ATTEMPTS) {
            survivors.add({ notif with attempts = notif.attempts + 1 });
            notificationsRetriedTotal.count += 1;
          } else {
            notificationsFailedTotal.count += 1;
          };
        };
      };
      // Append any survivors after the unprocessed tail (preserve FIFO order).
      notificationQueue.addAll(survivors.values());
      processed;
    } catch (e) {
      lastNotificationWorkerError.error := ?e.message();
      0;
    } finally {
      lastNotificationWorkerCompletedAt.value := Time.now();
      processingNotifications.value := false;
    };
  };

  /// Add a roomId to a user's room list (idempotent)
  func addUserRoom(userId : Types.UserId, roomId : Types.RoomId) {
    switch (userRooms.get(userId)) {
      case (?list) {
        // Only add if not already present
        let already = list.find(func(r) { r == roomId }) != null;
        if (not already) list.add(roomId);
      };
      case null {
        let list = List.empty<Types.RoomId>();
        list.add(roomId);
        userRooms.add(userId, list);
      };
    };
  };

  /// Remove a userId from a room's readyParticipants list (idempotent)
  func removeFromReadyParticipants(room : Types.Room, userId : Types.UserId) : Types.Room {
    let updated = room.readyParticipants.filter(func(uid : Types.UserId) : Bool {
      not Principal.equal(uid, userId)
    });
    { room with readyParticipants = updated };
  };

  /// Remove a userId from a room's paidParticipants list (idempotent).
  /// Mirrors removeFromReadyParticipants — keeps paidParticipants in sync when
  /// a participant leaves or is removed from the room.
  func removeFromPaidParticipants(room : Types.Room, userId : Types.UserId) : Types.Room {
    let updated = room.paidParticipants.filter(func(uid : Types.UserId) : Bool {
      not Principal.equal(uid, userId)
    });
    { room with paidParticipants = updated };
  };

  /// Remove a roomId from a user's room list
  func removeUserRoom(userId : Types.UserId, roomId : Types.RoomId) {
    switch (userRooms.get(userId)) {
      case null {};
      case (?list) {
        let filtered = list.filter(func(r) { r != roomId });
        userRooms.add(userId, filtered);
      };
    };
  };

  /// Rebuild the entire userRooms index from the authoritative room.participants
  /// arrays. For every room, ensures each participant has that room in their
  /// userRooms list (via addUserRoom) and removes orphaned entries referencing
  /// rooms where the user is no longer a participant (via removeUserRoom).
  /// This is the one-time repair run on upgrade (Fix 2) and is also reused by
  /// getUserRooms self-healing (Fix 1) to reconcile a single user's index.
  /// When userIdFilter is null, the entire index is reconciled; when set, only
  /// that user's index is reconciled (cheaper per-call path for getUserRooms).
  func reconcileUserRoomsIndex(userIdFilter : ?Types.UserId) {
    // Build a set of (userId, roomId) pairs the user is actually a participant
    // of, keyed by userId → set of roomIds. This is the authoritative membership.
    let authoritative : Map.Map<Types.UserId, Set.Set<Types.RoomId>> = Map.empty();
    rooms.forEach(func(roomId, room) {
      for (uid in room.participants.vals()) {
        switch (authoritative.get(uid)) {
          case (?s) s.add(roomId);
          case null {
            let s = Set.empty<Types.RoomId>();
            s.add(roomId);
            authoritative.add(uid, s);
          };
        };
      };
    });

    // For the filtered user (or every user with an existing index entry), ensure
    // their userRooms list exactly matches the authoritative set.
    let usersToReconcile : List.List<Types.UserId> = switch (userIdFilter) {
      case (?uid) {
        let l = List.empty<Types.UserId>();
        l.add(uid);
        l;
      };
      case null {
        // Reconcile every user that currently has an index entry OR is a
        // participant in any room (covers both stale and missing entries).
        let l = List.empty<Types.UserId>();
        userRooms.forEach(func(uid, _list) { l.add(uid) });
        authoritative.forEach(func(uid, _s) {
          // addUserRoom-style dedup: only add if not already present
          let already = l.find(func(u) { u == uid }) != null;
          if (not already) l.add(uid);
        });
        l;
      };
    };

    usersToReconcile.forEach(func(userId) {
      let authRooms : Set.Set<Types.RoomId> = switch (authoritative.get(userId)) {
        case (?s) s;
        case null Set.empty();
      };
      // Add any missing rooms the user is a participant of.
      authRooms.forEach(func(roomId) { addUserRoom(userId, roomId) });
      // Remove orphaned rooms the user is no longer a participant of.
      switch (userRooms.get(userId)) {
        case null {};
        case (?list) {
          list.forEach(func(roomId) {
            if (not authRooms.contains(roomId)) {
              removeUserRoom(userId, roomId);
            };
          });
        };
      };
    })
  };

  /// Defensive consistency check for the three membership stores:
  ///   (1) room.participants — the [UserId] array on each Room (authoritative)
  ///   (2) participants inner map — Map.Map<RoomId, Map.Map<UserId, Participant>>
  ///   (3) userRooms index — Map.Map<UserId, List.List<RoomId>>
  ///
  /// Verifies, for a given roomId (when ?roomId) or globally (when null):
  ///   (a) every participant in room.participants has the room in their userRooms
  ///   (b) every userRooms entry corresponds to an existing room
  ///   (c) every userRooms entry represents a participant that actually exists
  ///       in that room's room.participants
  ///
  /// DIAGNOSTIC ONLY: logs drift via Debug.print using the [DIAG-MEMBERSHIP] tag
  /// convention. Does NOT repair, throw, or mutate state. Safe to call after any
  /// membership mutation.
  func checkMembershipConsistency(roomIdFilter : ?Types.RoomId) {
    // (a) For each room in scope, every participant in room.participants must
    //     have the room in their userRooms list.
    let roomsInScope : List.List<Types.RoomId> = switch (roomIdFilter) {
      case (?rid) {
        let l = List.empty<Types.RoomId>();
        l.add(rid);
        l;
      };
      case null {
        let l = List.empty<Types.RoomId>();
        rooms.forEach(func(rid, _r) { l.add(rid) });
        l;
      };
    };
    roomsInScope.forEach(func(roomId) {
      switch (rooms.get(roomId)) {
        case null {
          // Room no longer exists (e.g. after deleteRoom) — skip; (b)/(c)
          // below will catch any orphaned userRooms entries referencing it.
        };
        case (?room) {
          for (uid in room.participants.vals()) {
            let hasRoom = switch (userRooms.get(uid)) {
              case null false;
              case (?list) list.find(func(r) { r == roomId }) != null;
            };
            if (not hasRoom) {
              Debug.print(
                "[DIAG-MEMBERSHIP] drift: participant missing from userRooms"
                # " # roomId=" # roomId
                # " # userId=" # uid.toText()
                # " # store=room.participants"
              );
            };
          };
        };
      };
    });

    // (b) + (c) For every userRooms entry, the referenced room must exist and
    //     the user must be a participant in that room's room.participants.
    userRooms.forEach(func(userId, list) {
      list.forEach(func(roomId) {
        switch (rooms.get(roomId)) {
          case null {
            Debug.print(
              "[DIAG-MEMBERSHIP] drift: userRooms entry references missing room"
              # " # roomId=" # roomId
              # " # userId=" # userId.toText()
              # " # store=userRooms"
            );
          };
          case (?room) {
            let isParticipant = room.participants.find(func(uid) { Principal.equal(uid, userId) }) != null;
            if (not isParticipant) {
              Debug.print(
                "[DIAG-MEMBERSHIP] drift: userRooms entry not in room.participants"
                # " # roomId=" # roomId
                # " # userId=" # userId.toText()
                # " # store=userRooms"
              );
            };
          };
        };
      });
    });
  };

  /// Append a BidHistoryEvent to the nomination's history log (room-scoped)
  func appendNominationEvent(
    roomId    : Types.RoomId,
    nomId     : Types.NominationId,
    eventType : Types.BidHistoryEventType,
    userId    : Types.UserId,
    playerName : Text,
    amount    : Nat,
    now       : Types.Timestamp,
    isAutoBid : ?Bool,
  ) {
    let displayName = displayNameFor(userId);
    let event : Types.BidHistoryEvent = {
      eventType;
      userId;
      displayName;
      playerName;
      amount;
      timestamp = now;
      isAutoBid;
    };
    let roomHistory = getOrCreateNominationHistory(roomId);
    let history : List.List<Types.BidHistoryEvent> = switch (roomHistory.get(nomId)) {
      case (?h) h;
      case null {
        let h = List.empty<Types.BidHistoryEvent>();
        roomHistory.add(nomId, h);
        h;
      };
    };
    if (history.size() >= 200) { return; };
    history.add(event);
  };

  /// Close or expire a nomination — update spent budget if there is a winner,
  /// clear committed for all participants.
  /// GUARD: Sets state to #Closed or #Expired BEFORE any budget operations so that
  /// any concurrent or duplicate call (from polling, sweep, or proxy bid trigger) will
  /// see the non-#Active state and exit immediately without re-applying budget changes.
  func finalizeNomination(nomId : Types.NominationId, now : Types.Timestamp, _forceExpire : Bool) {
    switch (nominations.get(nomId)) {
      case null {};
      case (?nom) {
        // ATOMIC GUARD: exit immediately if nomination is already closed/expired.
        // This is the idempotency guard — any second invocation returns here.
        if (nom.state != #Active) {

          return;
        };

        switch (nom.bidLeader) {
          case null {
            // No winner — expire immediately (state written first, before any side effects)
            nominations.add(nomId, { nom with state = #Expired });

            // Return committed amounts: clear committed for all participants in this room
            let pm = getRoomParticipants(nom.roomId);
            pm.forEach(func(userId, p) {
              let updated = AuctionLib.clearCommitted(p, nomId);
              pm.add(userId, updated);
                            });
                                        activeRoomIds.remove(nom.roomId);

            // Clear proxy bids for this nomination
            getOrCreateProxyBids(nom.roomId).remove(nomId);
            // Advance nomination turn even on expiry (no winner)
            advanceNominatorIndex(nom.roomId, now, false);
          };
          case (?winner) {
            // CLOSE STATE FIRST — before any budget writes.
            // Any second call to finalizeNomination will see #Closed and return at the guard above.
            nominations.add(nomId, { nom with state = #Closed });

            // Record the player as drafted in this room's authoritative set.
            // This runs for EVERY nomination that closes with a winning bid
            // (bidLeader != null), covering BOTH the normal applyWin award path
            // AND the roster-cap-skip path below (where finalWinner is null and
            // applyWin is never called). This is what prevents an already-drafted
            // player from ever reappearing on the nomination list.
            getRoomDraftedSet(nom.roomId).add(nom.playerId);


            // Roster cap check: if the winner's roster is already full, skip the award.
            // Cleanup (committed, proxy bids) still runs regardless.
            let room4finalize = rooms.get(nom.roomId);
            let finalWinner : ?Types.UserId =
              switch (room4finalize) {
                case (?r) {
                  switch (r.settings.maxRosterSize) {
                    case (?cap) {
                      let pm4cap = getRoomParticipants(nom.roomId);
                      switch (pm4cap.get(winner)) {
                        case (?wp) {
                          if (wp.wonPlayers.size() >= cap) {

                            null;
                          } else {
                            ?winner;
                          };
                        };
                        case null { ?winner };
                      };
                    };
                    case null { ?winner };
                  };
                };
                case null { ?winner };
              };

            let pm = getRoomParticipants(nom.roomId);
            switch (finalWinner) {
              case null {
                // No award (roster full or winner record missing) — clear committed and proxy bids
                pm.forEach(func(userId, p) {
                  let updated = AuctionLib.clearCommitted(p, nomId);
                  pm.add(userId, updated);
                });
                getOrCreateProxyBids(nom.roomId).remove(nomId);
              };
              case (?fw) {
                switch (pm.get(fw)) {
                  case null {
                    // Winner participant record missing — still clear committed and proxy bids
                    pm.forEach(func(userId, p) {
                      let updated = AuctionLib.clearCommitted(p, nomId);
                      pm.add(userId, updated);
                    });
                    getOrCreateProxyBids(nom.roomId).remove(nomId);
                  };
                  case (?p) {
                    // Find player in global map to get full player record
                    let playerOpt = players.get(nom.playerId);
                    let player : Types.Player = switch (playerOpt) {
                      case (?pl) pl;
                      case null {
                        {
                          id = nom.playerId;
                          name = nom.playerName;
                          position = nom.position;
                          team = nom.team;
                          byeWeek = AuctionLib.byeWeekForTeam(nom.team);
                          adp = 0.0;
                          headshotUrl = null;
                          yearsExp = 0;
                        };
                      };
                    };
                    // Apply win: spent += currentBid exactly once, committed cleared, wonPlayers updated
                    let updated = AuctionLib.applyWin(p, player, nom.currentBid, nomId, nom.nominatedBy, now);
                    pm.add(fw, updated);
                    // Append nominationEnded event to bid history
                    appendNominationEvent(nom.roomId, nomId, #nominationEnded, fw, nom.playerName, nom.currentBid, now, null);
                    addSystemMessage(nom.roomId, "🏆 " # nom.playerName # " won by " # displayNameFor(fw) # " for $" # nom.currentBid.toText() # "!", now);
                    // Trigger 1: notify the winner (cheap synchronous side effect, no HTTP).
                    enqueueNotification(fw, "You won " # nom.playerName # "!", "Winning bid: $" # nom.currentBid.toText());
                    // Clear committed for all OTHER participants (non-winners return their commitment)
                    pm.forEach(func(userId, participant) {
                      if (not Principal.equal(userId, fw)) {
                        let cleared = AuctionLib.clearCommitted(participant, nomId);
                        pm.add(userId, cleared);
                      };
                    });
                    // Clear all proxy bids for this nomination
                    getOrCreateProxyBids(nom.roomId).remove(nomId);
                  };
                };
              };
            };
          };
        };

        switch (rooms.get(nom.roomId)) {
          case null {};
          case (?room) {
            if (room.state == #Active) {
              let activeCountAfter = activeNominationCount(nom.roomId);
              let maxPicks = room.settings.maxActivePicks;
              let wasWaitingForSlot =
                room.nominationTurnPausedAt != null
                and room.nominatorIndex < room.participants.size();

              if (wasWaitingForSlot and activeCountAfter < maxPicks) {
                // A slot just opened for the currently-waiting nominator —
                // unpause them, do NOT advance the index.
                switch (rooms.get(nom.roomId)) {
                  case (?updatedRoom) {
                    rooms.add(nom.roomId, {
                      updatedRoom with
                      nominationTurnPausedAt = null;
                      nominationTurnStartedAt = now;
                    });
                    // Trigger 4: notify the unpaused nominator that a slot opened.
                    let participantCount4 = updatedRoom.participants.size();
                    if (participantCount4 > 0) {
                      let nominator4 = updatedRoom.participants[updatedRoom.nominatorIndex % participantCount4];
                      enqueueNotification(nominator4, "Your turn to nominate!", "A slot opened up — open the app to nominate a player");
                    };
                  };
                  case null {};
                };
              };
              // If nobody was waiting on this closure, do nothing — the current
              // nominator's turn is unaffected by other nominations closing.
              // Turn advancement happens only via timer expiry (sweep auto-skip)
              // or via the slot-opening unpause above.
            };
          };
        };

        // Auto-nomination retry: a nomination just resolved/closed, freeing a
        // slot under maxActivePicks. Check for any participant in this room
        // with a preserved queue entry that was blocked for slot availability,
        // and call tryAutoNominate for them now. Iterates the room's
        // participants map (not the full nominations map) and checks each
        // participant's nominationQueue entry.
        switch (rooms.get(nom.roomId)) {
          case null {};
          case (?retryRoom) {
            if (retryRoom.state == #Active) {
              let retryPm = getRoomParticipants(nom.roomId);
              if (activeNominationCount(nom.roomId) < retryRoom.settings.maxActivePicks) {
                // Determine the CURRENT nominator for the room. The index may
                // exceed the participant count, so mod it like the other turn
                // ownership checks do.
                let participantCount = retryRoom.participants.size();
                let currentNominator : ?Types.UserId =
                  if (participantCount == 0) { null }
                  else { ?retryRoom.participants[retryRoom.nominatorIndex % participantCount] };
                // Track whether the current nominator's retry successfully
                // created a nomination, so the turn can be advanced exactly
                // once after the loop (never recursively from inside it).
                var currentNominatorTurnFulfilled = false;
                retryPm.forEach(func(userId, _p) {
                  if (nominationQueue.get(queueKey(nom.roomId, userId)) != null) {
                    // Record whether the queue entry exists before the attempt.
                    let hadQueueEntry = nominationQueue.get(queueKey(nom.roomId, userId)) != null;
                    tryAutoNominate(nom.roomId, userId, now);
                    // Queue entries are removed ONLY after successful
                    // auto-nomination, so the entry being gone after the call
                    // is the success signal. A failed attempt leaves the entry
                    // intact and is not treated as fulfilling the turn.
                    let stillQueued = nominationQueue.get(queueKey(nom.roomId, userId)) != null;
                    let succeeded = hadQueueEntry and not stillQueued;
                    if (succeeded) {
                      switch (currentNominator) {
                        case (?cn) {
                          if (Principal.equal(cn, userId)) {
                            currentNominatorTurnFulfilled := true;
                          };
                        };
                        case null {};
                      };
                    };
                  };
                });
                // If the current nominator's retry successfully created a
                // nomination, advance the turn exactly once to the next
                // eligible participant so the turn pointer does not remain
                // parked on them while their auto-nominated player is auctioned.
                if (currentNominatorTurnFulfilled) {
                  advanceNominatorIndex(nom.roomId, now, false);
                };
              };
            };
          };
        };
      };
    };
  };

  /// Auto-nominate a queued player for the given nominator if a slot is available.
  /// Fires at turn start (from advanceNominatorIndex) and when a slot opens (from finalizeNomination).
  /// Preserves queue if slots are full; clears queue if player is unavailable.
  /// On success, advances the turn with skipAutoNominate=true to prevent infinite chaining.
  func tryAutoNominate(roomId : Types.RoomId, nominator : Types.UserId, now : Types.Timestamp) {
    // Guard: skip if this nominator already has an active nomination in the room
    var hasActiveNomination = false;
    nominations.forEach(func(_nid, n) {
      if (n.roomId == roomId and n.state == #Active and Principal.equal(n.nominatedBy, nominator)) {
        hasActiveNomination := true;
      };
    });
    if (hasActiveNomination) return;

    switch (nominationQueue.get(queueKey(roomId, nominator))) {
      case (?queuedPlayerId) {
        switch (rooms.get(roomId)) {
          case null {};
          case (?room) {
            // Compute active count once to avoid inconsistent reads
            let activeCount = activeNominationCount(roomId);

            if (activeCount >= room.settings.maxActivePicks) {
              // Slots full — preserve queue for retry when a slot opens

            } else {
              let nominatedSet = getRoomNominatedSet(roomId);
              let playerExists = switch (players.get(queuedPlayerId)) {
                case (?_) true;
                case null false;
              };
              if (playerExists and not nominatedSet.contains(queuedPlayerId)) {
                switch (nominatePlayerCore(roomId, nominator, queuedPlayerId, now)) {
                  case (#ok _) {
                    // Delete AFTER acting — the nomination succeeded, so the
                    // queued pick is consumed. Removing only on success means a
                    // failed attempt preserves the participant's queued
                    // selection for a later legitimate retry instead of
                    // discarding it silently.

                    // Do NOT advance the index here — the index was already correctly
                    // positioned at this nominator's turn by the caller. Auto-nominating
                    // fulfills that turn; the next slot closure or turn-timer expiry
                    // will naturally advance to the following participant.
                    nominationQueue.remove(queueKey(roomId, nominator));
                  };
                  case (#err msg) {
                    // Silent failure — leave the queue entry in place so the
                    // participant's queued selection is preserved for a later
                    // legitimate retry. The user may also nominate manually.
                  };
                };
              } else {
                // Player unavailable — clear queue
                nominationQueue.remove(queueKey(roomId, nominator));

              };
            };
          };
        };
      };
      case null {};
    };
  };

  /// Advance nominatorIndex to the next participant (mod count), reset turn timer.
  ///
  /// Restructured as a bounded loop (capped at participant count) that, per
  /// candidate: (1) checks skip conditions — zero availableBudget, full roster
  /// (wonPlayers.size() >= cap when room.settings.maxRosterSize is Some(cap)),
  /// skipNominationTurn == true — and if any skip, advances the index and
  /// continues to the next candidate; (2) attempts auto-nomination if the
  /// candidate has a queued pick — on success, treats their turn as used,
  /// advances the index, and continues to the next candidate; (3) if no queued
  /// pick, stops advancing there (this candidate is the current nominator).
  ///
  /// CRITICAL: this loop is self-contained — it does NOT call
  /// advanceNominatorIndex from inside tryAutoNominate, avoiding mutual
  /// recursion. tryAutoNominate remains standalone (creates a nomination from a
  /// queued pick, does NOT advance the index itself). The notification of the
  /// new nominator (when a slot is available) is applied only when the loop
  /// stops at a candidate with no queued pick.
  func advanceNominatorIndex(roomId : Types.RoomId, now : Types.Timestamp, skipAutoNominate : Bool) {
    switch (rooms.get(roomId)) {
      case null {};
      case (?room) {
        let count = room.participants.size();
        if (count == 0) return;
        let pm = getRoomParticipants(roomId);

        // Bounded loop: iterate up to `count` candidates starting from the
        // next index. The loop stops when it finds a candidate that is not
        // skipped and has no queued pick (that candidate becomes the current
        // nominator), or when it has consumed `count` candidates (every
        // candidate was either skipped or auto-nominated).
        var nextIndex = (room.nominatorIndex + 1) % count;
        var steps = 0;
        var stopped = false;
        while (steps < count and not stopped) {
          let candidateId = room.participants[nextIndex];
          // (1) Skip conditions: zero budget, full roster, skipNominationTurn.
          var shouldSkip = false;
          switch (pm.get(candidateId)) {
            case null {
              // No participant record yet — allow (they have starting budget).
              // Default skipNominationTurn = false for a synthesized record.
            };
            case (?p) {
              if (AuctionLib.availableBudget(p) <= 0) {
                shouldSkip := true;
              } else {
                switch (room.settings.maxRosterSize) {
                  case null {};
                  case (?cap) {
                    if (p.wonPlayers.size() >= cap) shouldSkip := true;
                  };
                };
                if (p.skipNominationTurn) shouldSkip := true;
              };
            };
          };
          if (shouldSkip) {
            // Skip this candidate — advance and continue to the next.
            nextIndex := (nextIndex + 1) % count;
            steps += 1;
          } else {
            // (2) Attempt auto-nomination if the candidate has a queued pick.
            var autoNominated = false;
            if (not skipAutoNominate) {
              let hasQueuedPick = nominationQueue.get(queueKey(roomId, candidateId)) != null;
              if (hasQueuedPick) {
                // Commit this candidate's turn to storage BEFORE attempting
                // auto-nomination. tryAutoNominate -> nominatePlayerCore checks
                // turn ownership by freshly reading room.nominatorIndex, so the
                // candidate's index must be genuinely live in storage here or
                // every in-loop auto-nomination is rejected as "Not your turn".
                rooms.add(roomId, {
                  room with
                  nominatorIndex = nextIndex;
                  nominationTurnStartedAt = now;
                });
                tryAutoNominate(roomId, candidateId, now);
                // Success signal: tryAutoNominate now removes the queue entry
                // ONLY on genuine success (nominatePlayerCore returned #ok), so
                // checking whether it is still present after the call remains a
                // valid signal of success/failure. If the entry is gone, the
                // nomination was created and this turn is consumed; if it is
                // still present, the attempt failed and the queued selection is
                // preserved for a later retry.
                let stillQueued = nominationQueue.get(queueKey(roomId, candidateId)) != null;
                if (not stillQueued) {
                  autoNominated := true;
                };
              };
            };
            if (autoNominated) {
              // Turn consumed by auto-nomination — advance and continue.
              nextIndex := (nextIndex + 1) % count;
              steps += 1;
            } else {
              // (3) No queued pick (or auto-nom skipped) — stop here.
              // This candidate is the current nominator; do NOT advance past.
              stopped := true;
            };
          };
        };

        rooms.add(roomId, {
          room with
          nominatorIndex = nextIndex;
          nominationTurnStartedAt = now;
        });

        // Notify the new nominator it's their turn, but only if the loop
        // stopped at a candidate with no queued pick (i.e. they need to act
        // manually) AND a live slot is actually available. Auto-nominated
        // candidates already had their nomination created and do not need a
        // "your turn" notification.
        if (stopped) {
          switch (rooms.get(roomId)) {
            case null {};
            case (?updatedRoom) {
              let newNominator = updatedRoom.participants[nextIndex];
              if (activeNominationCount(roomId) < updatedRoom.settings.maxActivePicks) {
                enqueueNotification(newNominator, "Your turn to nominate!", "You're up — open the app to nominate a player");
              };
            };
          };
        };
      };
    };
  };

  /// Sweep active nominations for a room and finalize any whose timers have run out.
  /// Also auto-advances the nominator index when the nomination turn timer expires
  /// and no nomination was made in that window.
  func sweepExpiredNominations(roomId : Types.RoomId) {
    let now = Time.now();
    // Collect expired nomination IDs first — avoid mutating map during iteration
    var expiredIds = List.empty<Types.NominationId>();
    nominations.forEach(func(nomId, nom) {
      if (nom.roomId == roomId and nom.state == #Active) {
        if (AuctionLib.isTimerExpired(nom, now)) {
          expiredIds.add(nomId);
        };
      };
    });
    expiredIds.forEach(func(nomId) {
      finalizeNomination(nomId, now, true);
    });
    // Diagnostic: count active nominations before sweep
    var beforeSweepCount = 0;
    var beforeSweepIds = List.empty<Types.NominationId>();
    nominations.forEach(func(nid, n) {
      if (n.roomId == roomId and n.state == #Active) {
        beforeSweepCount += 1;
        beforeSweepIds.add(nid);
      };
    });
    var finalizedIds = List.empty<Types.NominationId>();
    expiredIds.forEach(func(nid) {
      finalizedIds.add(nid);
    });
    // Diagnostic: count active nominations after sweep
    var afterSweepCount = 0;
    nominations.forEach(func(_nid, n) {
      if (n.roomId == roomId and n.state == #Active) {
        afterSweepCount += 1;
      };
    });


    // Auto-skip: if the nomination turn timer has expired and the current nominator
    // has not made any active nominations, advance to the next nominator.
    // advanceNominatorIndex will also skip zero-budget participants automatically.
    switch (rooms.get(roomId)) {
      case null {};
      case (?room) {
        if (room.state == #Active) {
          let activeCount = activeNominationCount(roomId);
          let maxPicks = room.settings.maxActivePicks;
          // Update nominationTurnPausedAt: set when slots full, clear when a slot opens
          if (activeCount >= maxPicks) {
            // Slots full — pause the nomination turn timer if not already paused
            if (room.nominationTurnPausedAt == null) {
              rooms.add(roomId, { room with nominationTurnPausedAt = ?now });
            };
          } else {
            // Slot(s) available — clear the pause so the timer resumes
            if (room.nominationTurnPausedAt != null) {
              rooms.add(roomId, {
                room with
                nominationTurnPausedAt = null;
                nominationTurnStartedAt = now;
              });
            };
          };
          // Re-fetch room after potential update
          switch (rooms.get(roomId)) {
            case null {};
            case (?updatedRoom) {
              if (updatedRoom.settings.nomTimerSecs > 0) {
                var continueLoop = true;
                var loopCount = 0;
                let maxSkips = 100;

                while (continueLoop and loopCount < maxSkips) {
                  switch (rooms.get(roomId)) {
                    case null { continueLoop := false };
                    case (?currentRoom) {
                      let activeCountNow = activeNominationCount(roomId);
                      let maxPicksNow = currentRoom.settings.maxActivePicks;

                      if (activeCountNow >= maxPicksNow) {
                        continueLoop := false;
                      } else {
                        let remaining = AuctionLib.nominationTurnSecsRemaining(
                          currentRoom,
                          now,
                          activeCountNow,
                          maxPicksNow
                        );

                        if (remaining <= 0) {
                          let hasActiveNom = switch (getCurrentNomination(roomId)) {
                            case (?_) true;
                            case null false;
                          };

                          if (not hasActiveNom) {
                            advanceNominatorIndex(roomId, now, false);
                            loopCount += 1;
                          } else {
                            continueLoop := false;
                          };
                        } else {
                          continueLoop := false;
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  };

  /// Get the current active nomination for the current nominator in a room, if any.
  /// Returns the first active nomination made by the current nominator.
  func getCurrentNomination(roomId : Types.RoomId) : ?Types.Nomination {
    switch (rooms.get(roomId)) {
      case null null;
      case (?room) {
        let participantCount = room.participants.size();
        if (participantCount == 0) return null;
        let currentNominator = room.participants[room.nominatorIndex % participantCount];
        var found : ?Types.Nomination = null;
        nominations.forEach(func(_nomId, nom) {
          if (nom.roomId == roomId and nom.state == #Active
              and Principal.equal(nom.nominatedBy, currentNominator)) {
            found := ?nom;
          };
        });
        found;
      };
    };
  };

  /// Count active nominations for a room
  func activeNominationCount(roomId : Types.RoomId) : Nat {
    var count = 0;
    // Use the per-room index instead of scanning the full nominations map.
    // Falls back to a full scan only when the room has no index entry yet
    // (e.g. a room whose nominations predate the index and haven't been
    // backfilled — defensive, not the hot path).
    switch (nominationsByRoom.get(roomId)) {
      case (?ids) {
        for (nomId in ids.vals()) {
          switch (nominations.get(nomId)) {
            case null {};
            case (?nom) {
              if (nom.state == #Active) count += 1;
            };
          };
        };
      };
      case null {
        nominations.forEach(func(_id, nom) {
          if (nom.roomId == roomId and nom.state == #Active) {
            count += 1;
          };
        });
      };
    };
    count;
  };

  /// Compute a participant's projected roster size: wonPlayers.size() plus the
  /// count of distinct active nominations in the room (read from
  /// nominationsByRoom, NOT a full scan) where the participant is currently
  /// bidLeader. When checking for a specific nomination being acted on, pass
  /// its nomId via includeNomId so it is counted even if it is not yet in the
  /// nominations map (e.g. during nominatePlayerCore before the nomination is
  /// committed). Pass null for includeNomId when the nomination is already in
  /// the map or when no specific nomination is being acted on.
  func projectedRosterSize(
    roomId          : Types.RoomId,
    userId          : Types.UserId,
    includeNomId    : ?Types.NominationId,
  ) : Nat {
    let pm = getRoomParticipants(roomId);
    let wonCount : Nat = switch (pm.get(userId)) {
      case null 0;
      case (?p) p.wonPlayers.size();
    };
    var leadingActiveCount = 0;
    // Count active nominations where this user is bidLeader, via the per-room
    // index. Falls back to a full scan only when no index entry exists yet.
    switch (nominationsByRoom.get(roomId)) {
      case (?ids) {
        for (nomId in ids.vals()) {
          switch (nominations.get(nomId)) {
            case null {};
            case (?nom) {
              if (nom.state == #Active) {
                switch (nom.bidLeader) {
                  case null {};
                  case (?leader) {
                    if (Principal.equal(leader, userId)) leadingActiveCount += 1;
                  };
                };
              };
            };
          };
        };
      };
      case null {
        nominations.forEach(func(_id, nom) {
          if (nom.roomId == roomId and nom.state == #Active) {
            switch (nom.bidLeader) {
              case null {};
              case (?leader) {
                if (Principal.equal(leader, userId)) leadingActiveCount += 1;
              };
            };
          };
        });
      };
    };
    // Include the nomination being acted on if it is not yet in the map and
    // the user is its (prospective) leader.
    switch (includeNomId) {
      case null {};
      case (?nomId) {
        var alreadyCounted = false;
        switch (nominationsByRoom.get(roomId)) {
          case null {};
          case (?ids) {
            for (existingId in ids.vals()) {
              if (existingId == nomId) alreadyCounted := true;
            };
          };
        };
        if (not alreadyCounted) {
          switch (nominations.get(nomId)) {
            case null {
              // Not yet in the map — count it as a prospective leading active
              // nomination for this user (the caller is acting on it as the
              // nominator/leader).
              leadingActiveCount += 1;
            };
            case (?nom) {
              if (nom.state == #Active) {
                switch (nom.bidLeader) {
                  case null {};
                  case (?leader) {
                    if (Principal.equal(leader, userId)) {
                      // Already counted above via the index scan; nothing to add.
                    } else {
                      // In the map but not yet counted as this user's lead —
                      // only count if the user is the prospective leader. The
                      // caller decides inclusion via includeNomId, so count it.
                      leadingActiveCount += 1;
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
    wonCount + leadingActiveCount;
  };

  /// Validate that a participant's roster is not already at the room's maxRosterSize cap.
  /// Also enforces the roster over-commitment safeguard: rejects if the
  /// participant's projected roster size (wonPlayers plus distinct active
  /// nominations where they are currently bidLeader, including the nomination
  /// being acted on) would exceed the cap. The includeNomId parameter lets the
  /// caller count a nomination that is not yet in the map; pass null when the
  /// nomination is already committed or when no specific nomination is in play.
  /// Returns #ok if bidding is allowed, or #err with a message if the roster is full.
  func assertCanBid(
    participant : Types.Participant,
    room        : Types.Room,
    roomId      : Types.RoomId,
    includeNomId : ?Types.NominationId,
  ) : { #ok; #err : Text } {
    switch (room.settings.maxRosterSize) {
      case (?cap) {
        if (participant.wonPlayers.size() >= cap) {
          return #err "Your roster is full";
        };
        // Over-commitment safeguard: projected roster size (won + active leads
        // including the nomination being acted on) must not exceed cap.
        let projected = projectedRosterSize(roomId, participant.userId, includeNomId);
        if (projected > cap) {
          return #err "Cannot bid: would exceed roster cap with active nominations you are leading";
        };
      };
      case null {};
    };
    #ok;
  };

  /// Update committed amount in participant map for a given nomination
  func updateParticipantCommitted(
    roomId : Types.RoomId,
    userId : Types.UserId,
    nomId : Types.NominationId,
    amount : Nat,
  ) {
    let pm = getRoomParticipants(roomId);
    switch (pm.get(userId)) {
      case null {};
      case (?p) {
        let updated = AuctionLib.updateCommitted(p, nomId, amount);
        pm.add(userId, updated);
      };
    };
  };

  /// Build a ParticipantView for the API boundary.
  /// If viewerIsOwner is true, returns a #private_ budget (full breakdown).
  /// Otherwise returns a #public_ budget (totalBudget - spentBudget only).
  func toParticipantView(p : Types.Participant, viewerIsOwner : Bool) : Types.ParticipantView {
    let budgetView : Types.ParticipantBudgetView = if (viewerIsOwner) {
      let sumCommitted = p.committed.foldLeft(0 : Nat, func(acc : Nat, e : (Types.NominationId, Nat)) : Nat { acc + e.1 });
      let totalInt : Int = p.budget;
      let usedInt : Int = p.spent + sumCommitted;
      let availInt = totalInt - usedInt;
      let avail : Nat = if (availInt <= 0) 0 else availInt.toNat();
      #private_ {
        totalBudget     = p.budget;
        spentBudget     = p.spent;
        committedBudget = sumCommitted;
        availableBudget = avail;
      };
    } else {
      let totalInt : Int = p.budget;
      let spentInt : Int = p.spent;
      let pubAvailInt = totalInt - spentInt;
      let pubAvail : Nat = if (pubAvailInt <= 0) 0 else pubAvailInt.toNat();
      #public_ {
        totalBudget           = p.budget;
        spentBudget           = p.spent;
        publicAvailableBudget = pubAvail;
      };
    };
    let avatarUrl : ?Text = switch (profiles.get(p.userId)) {
      case (?prof) prof.avatarUrl;
      case null null;
    };
    {
      userId      = p.userId;
      displayName = p.displayName;
      wonPlayers  = p.wonPlayers;
      budgetView;
      avatarUrl;
      skipNominationTurn = p.skipNominationTurn;
    };
  };

  /// Build RoomView for a given caller and room
  func buildRoomView(room : Types.Room, caller : Types.UserId, now : Types.Timestamp) : Types.RoomView {
    let pm : Map.Map<Types.UserId, Types.Participant> = switch (participants.get(room.id)) {
      case (?m) m;
      case null Map.empty();
    };

    // Memoize display-name resolution for the duration of this request. The same
    // user can appear as a participant, a nomination leader, and the current
    // nominator within one room-state read; resolving each via a fresh profiles
    // lookup repeats the same O(log n) map access. Cache per-user results so each
    // profile is looked up at most once per request. Output is identical to
    // displayNameFor (same profile > truncated-principal fallback).
    let nameCache = Map.empty<Types.UserId, Text>();
    func cachedDisplayName(uid : Types.UserId) : Text {
      switch (nameCache.get(uid)) {
        case (?name) name;
        case null {
          let name = displayNameFor(uid);
          nameCache.add(uid, name);
          name;
        };
      };
    };

    // Collect all participants in room order, applying privacy rules per participant
    let participantList : [Types.ParticipantView] = room.participants.map(func(uid : Types.UserId) : Types.ParticipantView {
      let p = switch (pm.get(uid)) {
        case (?p_) p_;
        case null AuctionLib.newParticipant(uid, cachedDisplayName(uid), room.startingBudget);
      };
      toParticipantView(p, Principal.equal(uid, caller));
    });

    // Active and completed nominations — read from the per-room index
    // (nominationsByRoom) instead of scanning the full nominations map.
    var activeNoms = List.empty<Types.NominationView>();
    var completedNoms = List.empty<Types.NominationView>();
    let roomNomIds : [Types.NominationId] = switch (nominationsByRoom.get(room.id)) {
      case null [];
      case (?ids) ids;
    };
    for (nomId in roomNomIds.vals()) {
      switch (nominations.get(nomId)) {
        case null {};
        case (?nom) {
          let leaderName = switch (nom.bidLeader) {
            case null null;
            case (?lid) ?cachedDisplayName(lid);
          };
          let view = AuctionLib.toNominationView(nom, now, leaderName);
          if (nom.state == #Active) {
            activeNoms.add(view);
          } else {
            completedNoms.add(view);
          };
        };
      };
    };
    // Caller's proxy bids — scoped to this room only. Iterate the room's own
    // nomination->user->proxyBid map (via getOrCreateProxyBids(room.id))
    // instead of scanning proxyBids for every room in the canister.
    var myProxies = List.empty<Types.ProxyBid>();
    let roomProxyMap = getOrCreateProxyBids(room.id);
    roomProxyMap.forEach(func(_nomId, userMap) {
      switch (userMap.get(caller)) {
        case null {};
        case (?pb) myProxies.add(pb);
      };
    });

    // Nomination turn info: look up nominator by index into participants array
    let participantCount = room.participants.size();
    let nominatorId : ?Types.UserId = if (participantCount == 0 or room.state != #Active) {
      null;
    } else {
      let idx = room.nominatorIndex % participantCount;
      ?room.participants[idx];
    };
    let nominatorName : ?Text = switch (nominatorId) {
      case null null;
      case (?uid) ?cachedDisplayName(uid);
    };

    {
      room;
      participants = participantList;
      activeNominations = activeNoms.toArray();
      completedNominations = completedNoms.toArray();
      myProxyBids = myProxies.toArray();
      nominationTimerSecsRemaining = AuctionLib.nominationTurnSecsRemaining(room, now, activeNoms.size(), room.settings.maxActivePicks);
      currentNominatorId = nominatorId;
      currentNominatorName = nominatorName;
      queuedPlayerId = nominationQueue.get(queueKey(room.id, caller));
      draftedPlayerIds = getRoomDraftedSet(room.id).toArray();
    };
  };

  /// Return the persisted display name for a given user principal, or null if not set.
  /// Public query — callable by any authenticated user.
  public shared query func getDisplayName(userId : Types.UserId) : async ?Text {
    switch (profiles.get(userId)) {
      case (?p) {
        if (p.displayName.size() == 0) null
        else ?p.displayName;
      };
      case null null;
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // User identity
  // ─────────────────────────────────────────────────────────────────────────

  /// Set (or update) the caller's display name globally.
  /// Also propagates the name change to all rooms the caller has joined.
  /// If no admin has been set yet, the first user to call this becomes the admin.
  public shared ({ caller }) func setDisplayName(
    name : Text,
  ) : async { #ok : (); #err : Text } {
    if (name.size() == 0) return #err "Display name cannot be empty";
    // Update or create profile
    let existing = profiles.get(caller);
    let profile : Types.UserProfile = switch (existing) {
      case (?p) ({ p with displayName = name });
      case null ({ userId = caller; displayName = name; avatarUrl = null });
    };
    profiles.add(caller, profile);

    // Admin bootstrap: if no admin is set yet, the first user to register becomes admin.
    // This covers users who registered before the admin feature was added.
    switch (adminPrincipalStore.get("admin")) {
      case null {
        adminPrincipalStore.add("admin", caller);
      };
      case (?_) {};  // admin already set — do not overwrite
    };

    // Propagate display name to all participant records across all rooms
    participants.forEach(func(_roomId, pm) {
      switch (pm.get(caller)) {
        case null {};
        case (?p) {
          pm.add(caller, { p with displayName = name });
        };
      };
    });

    #ok ();
  };

  /// Store the avatar URL for the caller's profile.
  /// Passing an empty string clears the avatar (sets avatarUrl = null).
  public shared ({ caller }) func setAvatarUrl(
    url : Text,
  ) : async { #ok : (); #err : Text } {
    let avatarUrl : ?Text = if (url == "") null else ?url;
    let existing = profiles.get(caller);
    let profile : Types.UserProfile = switch (existing) {
      case (?p) ({ p with avatarUrl });
      case null {
        { userId = caller; displayName = ""; avatarUrl };
      };
    };
    profiles.add(caller, profile);
    #ok ();
  };

  /// Return the caller's global profile (principal, displayName, avatarUrl).
  public shared query ({ caller }) func getProfile() : async Types.UserProfile {
    switch (profiles.get(caller)) {
      case (?p) p;
      case null {
        { userId = caller; displayName = ""; avatarUrl = null };
      };
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Room management
  // ─────────────────────────────────────────────────────────────────────────

  public shared ({ caller }) func createRoom(
    name : Text,
    startingBudget : Nat,
    settings : Types.AuctionSettings,
    isPublic : Bool,
    password : ?Text,
    playerFilter : ?Types.PlayerFilter,
    maxRosterSize : ?Nat,
    rosterSettings : ?Types.RosterSettings,
    teamCount : ?Nat,
    leagueFormat : ?Text,
    season : Nat,
    scoringFormat : Types.ScoringFormat,
  ) : async { #ok : Types.RoomId; #err : Text } {
    if (name.size() == 0) return #err "Room name cannot be empty";
    if (startingBudget == 0) return #err "Starting budget must be greater than 0";

    // Uniqueness check — case-insensitive, against all rooms
    let lowerName = name.toLower();
    var nameExists = false;
    rooms.forEach(func(_id, r) {
      if (r.name.toLower() == lowerName) { nameExists := true };
    });
    if (nameExists) return #err "A room with that name already exists";

    // Private rooms must have a password
    if (not isPublic) {
      switch (password) {
        case null return #err "A password is required for private rooms";
        case (?pw) {
          if (pw.size() == 0) return #err "A password is required for private rooms";
        };
      };
    };

    let now = Time.now();
    let roomId : Types.RoomId = roomIdState.next.toText();
    roomIdState.next += 1;
    let filter : Types.PlayerFilter = switch (playerFilter) {
      case (?f) f;
      case null AuctionLib.defaultPlayerFilter();
    };
    let resolvedAdpDataset = switch (settings.adpDataset) {
      case ("rookies") "rookies";
      case _ "all";
    };
    let settingsWithCap : Types.AuctionSettings = { settings with maxRosterSize; adpDataset = resolvedAdpDataset };
    let room = AuctionLib.newRoom(roomId, name, caller, startingBudget, settingsWithCap, now, isPublic, password, filter, rosterSettings, teamCount, leagueFormat, season, scoringFormat);
    rooms.add(roomId, room);
    // Add admin as first participant
    let pm = getRoomParticipants(roomId);
    let displayName = switch (profiles.get(caller)) {
      case (?p) p.displayName;
      case null "";
    };
    pm.add(caller, AuctionLib.newParticipant(caller, displayName, startingBudget));
    // Track room in admin's room list
    addUserRoom(caller, roomId);
    // Defensive consistency check (diagnostic only — logs drift, does not repair)
    checkMembershipConsistency(?roomId);
    #ok roomId;
  };

  public shared ({ caller }) func joinRoom(
    roomId : Types.RoomId,
    password : ?Text,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (AuctionLib.isParticipant(room, caller)) return #err "Already in room";
        if (room.state != #Waiting) return #err "Auction has already started";

        // Enforce participant limit
        if (room.participants.size() >= room.settings.maxParticipants) {
          return #err "Room is full";
        };

        // Password validation for private rooms
        switch (room.password) {
          case (?roomPw) {
            // Room has a password — caller must supply the correct one
            let provided = switch (password) {
              case null return #err "This is a private room. A password is required to join.";
              case (?pw) pw;
            };
            if (provided != roomPw) return #err "Incorrect password";
          };
          case null {
            // Public room — no password required
          };
        };

        // Derive display name from profile if available, else use empty string
        let displayName = switch (profiles.get(caller)) {
          case (?p) p.displayName;
          case null "";
        };

        sweepExpiredNominations(roomId);

        // Re-fetch room after sweep to avoid overwriting sweep's updates
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        // Add caller to room participant list
        let updatedRoom = { roomAfterSweep with participants = roomAfterSweep.participants.concat([caller]) };
        rooms.add(roomId, updatedRoom);

        // Add participant record
        let pm = getRoomParticipants(roomId);
        pm.add(caller, AuctionLib.newParticipant(caller, displayName, roomAfterSweep.startingBudget));

        // Track room in user's room list
        addUserRoom(caller, roomId);

        let now = Time.now();
        addSystemMessage(roomId, "👋 " # displayNameFor(caller) # " joined the room.", now);

        // Defensive consistency check (diagnostic only — logs drift, does not repair)
        checkMembershipConsistency(?roomId);

        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  public shared ({ caller }) func leaveRoom(
    roomId : Types.RoomId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (Principal.equal(room.admin, caller)) return #err "Admin cannot leave the room";
        if (not AuctionLib.isParticipant(room, caller)) return #err "Not in room";

        sweepExpiredNominations(roomId);

        // Re-fetch room after sweep to avoid overwriting sweep's updates
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        let updatedParticipants = roomAfterSweep.participants.filter(func(uid) { not Principal.equal(uid, caller) });
        let roomWithoutParticipant = { roomAfterSweep with participants = updatedParticipants };
        let roomWithoutReady = removeFromReadyParticipants(roomWithoutParticipant, caller);
        let roomWithoutPaid = removeFromPaidParticipants(roomWithoutReady, caller);
        rooms.add(roomId, roomWithoutPaid);

        let pm = getRoomParticipants(roomId);
        pm.remove(caller);

        // Remove room from user's room list
        removeUserRoom(caller, roomId);

        // Defensive consistency check (diagnostic only — logs drift, does not repair)
        checkMembershipConsistency(?roomId);

        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Return all rooms the caller has joined as RoomSummary list.
  ///
  /// Self-healing (Fix 1): this is now an UPDATE func (not query) so it can
  /// repair the userRooms index when it has drifted. It does NOT trust the
  /// userRooms index alone — it iterates every room and uses
  /// AuctionLib.isParticipant (which checks room.participants, the
  /// authoritative source) to decide membership. If a room the caller is a
  /// participant of is missing from their userRooms index, it is added; if the
  /// index contains a room the caller is no longer a participant of, it is
  /// removed. The participant count is sourced from room.participants.size()
  /// (Fix 4), and the inner participants map is reconciled first.
  public shared ({ caller }) func getUserRooms() : async [Types.RoomSummary] {
    // Reconcile this caller's userRooms index against authoritative membership.
    reconcileUserRoomsIndex(?caller);
    // Now build the result from the authoritative source: every room where the
    // caller is a participant (per room.participants), regardless of the index.
    var result = List.empty<Types.RoomSummary>();
    rooms.forEach(func(roomId, room) {
      if (AuctionLib.isParticipant(room, caller)) {
        // Reconcile the inner participants map to room.participants (Fix 4),
        // then use room.participants.size() as the authoritative count.
        let pm = reconcileParticipantsMap(roomId, room);
        ignore pm; // reconciled in place; count comes from room.participants
        result.add(AuctionLib.toRoomSummary(room, room.participants.size()));
      };
    });
    result.toArray();
  };

  /// One-time repair entry point called from the actor's postupgrade hook
  /// (Fix 2). Rebuilds the entire userRooms index from room.participants and
  /// reconciles every room's inner participants map. Public so main.mo can
  /// invoke it; not intended for end-user calls.
  public shared func reconcileMembershipIndexes() : async () {
    // Rebuild the full userRooms index from authoritative room.participants.
    reconcileUserRoomsIndex(null);
    // Reconcile every room's inner participants map to room.participants.
    rooms.forEach(func(roomId, room) {
      let pm = reconcileParticipantsMap(roomId, room);
      ignore pm; // reconciled in place
    });
  };

  /// Admin-only: remove another user from the room
  public shared ({ caller }) func removeUserFromRoom(
    roomId : Types.RoomId,
    userId : Types.UserId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (Principal.equal(userId, caller)) return #err "Cannot remove yourself";
        if (not AuctionLib.isParticipant(room, userId)) return #err "User not in room";

        let updatedParticipants = room.participants.filter(func(uid) { not Principal.equal(uid, userId) });
        let roomWithoutParticipant = { room with participants = updatedParticipants };
        let roomWithoutReady = removeFromReadyParticipants(roomWithoutParticipant, userId);
        let roomWithoutPaid = removeFromPaidParticipants(roomWithoutReady, userId);
        rooms.add(roomId, roomWithoutPaid);

        let pm = getRoomParticipants(roomId);
        pm.remove(userId);

        // Keep the userRooms index in sync — without this, the removed user would
        // still see this room in MY ROOMS (the drift source). All three membership
        // stores (room.participants, participants inner map, userRooms) are updated
        // together here.
        removeUserRoom(userId, roomId);

        // Defensive consistency check (diagnostic only — logs drift, does not repair)
        checkMembershipConsistency(?roomId);

        #ok ();
      };
    };
  };

  /// Admin-only: reassign a participant's slot from one principal to another.
  ///
  /// Transfers ALL participant-specific state from oldPrincipal to newPrincipal
  /// so the user keeps their roster, budget, bid history, nomination position,
  /// proxy bids, and nomination queue entry under the new principal. Works on
  /// Active and Paused rooms (does NOT gate on room.state) — this is the recovery
  /// path for a user who is locked out of their original principal.
  ///
  /// Updates ALL THREE membership stores atomically:
  ///   (1) room.participants — replaces oldPrincipal with newPrincipal at the
  ///       SAME array index to preserve nomination order position.
  ///   (2) participants inner map — moves the Participant record from the old
  ///       key to the new key, preserving budget, spent, committed, wonPlayers,
  ///       displayName, and all other fields.
  ///   (3) userRooms — removes roomId from oldPrincipal's list and adds it to
  ///       newPrincipal's list.
  ///
  /// Also transfers participant-specific data keyed by principal:
  ///   - bids (per nomination List<Bid>) — rewrites Bid.userId for the user's bids
  ///   - proxyBids (per nomination Map<UserId, ProxyBid>) — moves the entry and
  ///     rewrites ProxyBid.userId
  ///   - nominationHistory (per nomination List<BidHistoryEvent>) — rewrites
  ///     BidHistoryEvent.userId for the user's events
  ///   - nominationQueue (keyed by "roomId|userId.toText()") — moves the entry
  ///   - nominations (Nomination.nominatedBy / Nomination.bidLeader) — rewrites
  ///     any reference to oldPrincipal so the user's active nominations and bid
  ///     leadership are preserved under the new principal
  ///
  /// Guard: admin-only — same global admin guard pattern as deleteRoom /
  /// getOneSignalPlayerIds (hardcoded principal OR adminPrincipalStore.get("admin")).
  public shared ({ caller }) func transferParticipantIdentity(
    roomId : Types.RoomId,
    oldPrincipal : Types.UserId,
    newPrincipal : Types.UserId,
  ) : async { #ok : Text; #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can transfer participant identity";
    };

    if (Principal.equal(oldPrincipal, newPrincipal)) {
      return #err "oldPrincipal and newPrincipal must be different";
    };

    let room = switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?r) r;
    };

    // oldPrincipal must currently be a participant in the room.
    if (not AuctionLib.isParticipant(room, oldPrincipal)) {
      return #err "oldPrincipal is not a participant in this room";
    };
    // newPrincipal must NOT already be a participant (prevent duplicates).
    if (AuctionLib.isParticipant(room, newPrincipal)) {
      return #err "newPrincipal is already a participant in this room";
    };
    // Cannot transfer the room admin's slot — would orphan the room's admin
    // reference (room.admin would no longer match any participant).
    if (Principal.equal(oldPrincipal, room.admin)) {
      return #err "Cannot transfer the room admin's identity; reassign the room admin first";
    };

    // ── (1) room.participants array — replace oldPrincipal with newPrincipal
    //         at the SAME index to preserve nomination order position. ────────
    let updatedParticipants : [Types.UserId] = room.participants.map(
      func(uid : Types.UserId) : Types.UserId {
        if (Principal.equal(uid, oldPrincipal)) newPrincipal else uid;
      }
    );
    // readyParticipants is a parallel [UserId] list — keep it in sync too so the
    // transferred user's ready status follows them under the new principal.
    let updatedReady : [Types.UserId] = room.readyParticipants.map(
      func(uid : Types.UserId) : Types.UserId {
        if (Principal.equal(uid, oldPrincipal)) newPrincipal else uid;
      }
    );
    rooms.add(roomId, { room with participants = updatedParticipants; readyParticipants = updatedReady });

    // ── (2) participants inner map — move the Participant record from the old
    //         key to the new key, preserving all fields (only userId changes). ─
    let pm = getRoomParticipants(roomId);
    let participantRecord = switch (pm.get(oldPrincipal)) {
      case null {
        // Should not happen — oldPrincipal is in room.participants and the map
        // is reconciled above. Synthesize a default to avoid trapping the
        // transfer mid-flight; reconcileParticipantsMap will heal this on next
        // read.
        AuctionLib.newParticipant(newPrincipal, displayNameFor(newPrincipal), room.startingBudget);
      };
      case (?p) { pm.remove(oldPrincipal); { p with userId = newPrincipal } };
    };
    pm.add(newPrincipal, participantRecord);

    // ── (3) userRooms — remove roomId from oldPrincipal's list, add to
    //         newPrincipal's list. ─────────────────────────────────────────────
    removeUserRoom(oldPrincipal, roomId);
    addUserRoom(newPrincipal, roomId);

    // ── Transfer participant-specific data keyed by principal. ───────────────
    // Collect this room's nomination IDs first (we iterate nominations by room).
    let roomNomIds = List.empty<Types.NominationId>();
    nominations.forEach(func(nomId, nom) {
      if (nom.roomId == roomId) {
        roomNomIds.add(nomId);
      };
    });

    // bids: per nomination List<Bid> — rewrite Bid.userId for the user's bids.
    let bidsMap = getOrCreateBids(roomId);
    roomNomIds.forEach(func(nomId) {
      switch (bidsMap.get(nomId)) {
        case null {};
        case (?bidList) {
          let rewritten = List.empty<Types.Bid>();
          bidList.forEach(func(b : Types.Bid) {
            if (Principal.equal(b.userId, oldPrincipal)) {
              rewritten.add({ b with userId = newPrincipal });
            } else {
              rewritten.add(b);
            };
          });
          bidsMap.add(nomId, rewritten);
        };
      };
    });

    // proxyBids: per nomination Map<UserId, ProxyBid> — move entry and rewrite
    // ProxyBid.userId.
    let proxyBidsMap = getOrCreateProxyBids(roomId);
    roomNomIds.forEach(func(nomId) {
      switch (proxyBidsMap.get(nomId)) {
        case null {};
        case (?nomProxyMap) {
          switch (nomProxyMap.get(oldPrincipal)) {
            case null {};
            case (?pb) {
              nomProxyMap.remove(oldPrincipal);
              nomProxyMap.add(newPrincipal, { pb with userId = newPrincipal });
            };
          };
        };
      };
    });

    // nominationHistory: per nomination List<BidHistoryEvent> — rewrite
    // BidHistoryEvent.userId for the user's events.
    let historyMap = getOrCreateNominationHistory(roomId);
    roomNomIds.forEach(func(nomId) {
      switch (historyMap.get(nomId)) {
        case null {};
        case (?eventList) {
          let rewritten = List.empty<Types.BidHistoryEvent>();
          eventList.forEach(func(e : Types.BidHistoryEvent) {
            if (Principal.equal(e.userId, oldPrincipal)) {
              rewritten.add({ e with userId = newPrincipal });
            } else {
              rewritten.add(e);
            };
          });
          historyMap.add(nomId, rewritten);
        };
      };
    });

    // nominationQueue: keyed by "roomId|userId.toText()" — move entry from old
    // key to new key (preserves the user's queued nomination player id).
    let oldQueueKey = queueKey(roomId, oldPrincipal);
    let newQueueKey = queueKey(roomId, newPrincipal);
    switch (nominationQueue.get(oldQueueKey)) {
      case null {};
      case (?queuedPlayerId) {
        nominationQueue.remove(oldQueueKey);
        nominationQueue.add(newQueueKey, queuedPlayerId);
      };
    };

    // nominations: rewrite Nomination.nominatedBy and Nomination.bidLeader
    // references from oldPrincipal to newPrincipal so the user's active
    // nominations and bid leadership follow them under the new principal.
    roomNomIds.forEach(func(nomId) {
      switch (nominations.get(nomId)) {
        case null {};
        case (?nom) {
          var changed = false;
          var nominatedBy = nom.nominatedBy;
          var bidLeader = nom.bidLeader;
          if (Principal.equal(nom.nominatedBy, oldPrincipal)) {
            nominatedBy := newPrincipal;
            changed := true;
          };
          switch (nom.bidLeader) {
            case null {};
            case (?leader) {
              if (Principal.equal(leader, oldPrincipal)) {
                bidLeader := ?newPrincipal;
                changed := true;
              };
            };
          };
          if (changed) {
            nominations.add(nomId, { nom with nominatedBy = nominatedBy; bidLeader = bidLeader });
          };
        };
      };
    });

    // Defensive consistency check (diagnostic only — logs drift, does not repair)
    checkMembershipConsistency(?roomId);

    #ok ("Transferred participant identity from " # oldPrincipal.toText() # " to " # newPrincipal.toText() # " in room " # roomId);
  };

  /// Toggle the caller's ready status in a room's readyParticipants list.
  /// If the caller is NOT in readyParticipants → add them (no duplicates).
  /// If the caller IS in readyParticipants → remove them.
  /// Returns #err if the room is not found or the caller is not a participant.
  public shared ({ caller }) func toggleReady(
    roomId : Types.RoomId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not AuctionLib.isParticipant(room, caller)) return #err "Not a participant in this room";
        sweepExpiredNominations(roomId);
        // Re-fetch room after sweep to avoid overwriting sweep's updates
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        let alreadyReady = roomAfterSweep.readyParticipants.find(func(uid : Types.UserId) : Bool {
          Principal.equal(uid, caller)
        }) != null;
        let newReadyParticipants : [Types.UserId] = if (alreadyReady) {
          // Remove caller from readyParticipants
          roomAfterSweep.readyParticipants.filter(func(uid : Types.UserId) : Bool {
            not Principal.equal(uid, caller)
          });
        } else {
          // Add caller — concat ensures no mutation of original
          roomAfterSweep.readyParticipants.concat([caller]);
        };
        rooms.add(roomId, { roomAfterSweep with readyParticipants = newReadyParticipants });
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Set the caller's skipNominationTurn flag for a room. When true,
  /// advanceNominatorIndex skips the caller's nomination turn (a standing
  /// toggle until turned off again). A participant can only set their own
  /// flag. Mirrors toggleReady's pattern for room/participant lookup and
  /// notification draining.
  public shared ({ caller }) func setSkipNominationTurn(
    roomId : Types.RoomId,
    skip : Bool,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not AuctionLib.isParticipant(room, caller)) return #err "Not a participant in this room";
        let pm = getRoomParticipants(roomId);
        switch (pm.get(caller)) {
          case null return #err "Participant record not found";
          case (?p) {
            pm.add(caller, { p with skipNominationTurn = skip });
          };
        };
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Host-only: toggle a participant's paid status in a room's
  /// paidParticipants list. Callable only when caller == room.admin. Adds
  /// targetUserId idempotently when paid=true (only if not already present),
  /// removes it when paid=false. Mirrors toggleReady's pattern. Paid status is
  /// informational only — does not affect starting the auction.
  public shared ({ caller }) func setParticipantPaid(
    roomId : Types.RoomId,
    targetUserId : Types.UserId,
    paid : Bool,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Only the host can toggle paid status";
        let alreadyPaid = room.paidParticipants.find(func(uid : Types.UserId) : Bool {
          Principal.equal(uid, targetUserId)
        }) != null;
        let newPaidParticipants : [Types.UserId] = if (paid) {
          if (alreadyPaid) {
            room.paidParticipants;
          } else {
            room.paidParticipants.concat([targetUserId]);
          };
        } else {
          room.paidParticipants.filter(func(uid : Types.UserId) : Bool {
            not Principal.equal(uid, targetUserId)
          });
        };
        rooms.add(roomId, { room with paidParticipants = newPaidParticipants });
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  public shared query ({ caller }) func getRoomState(
    roomId : Types.RoomId,
  ) : async { #ok : Types.RoomView; #err : Text } {
    switch (rooms.get(roomId)) {
      case null #err "Room not found";
      case (?room) {
        let now = Time.now();
        #ok (buildRoomView(room, caller, now));
      };
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Auction lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /// Admin-only: transition room from Waiting → Active
  public shared ({ caller }) func startAuction(
    roomId : Types.RoomId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (room.state != #Waiting) return #err "Room is not in Waiting state";
        sweepExpiredNominations(roomId);
        let now = Time.now();
        // Re-fetch room after sweep to avoid stale state
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        let participantCount = roomAfterSweep.participants.size();
        let firstNominator : ?Types.UserId = if (participantCount > 0) ?roomAfterSweep.participants[0] else null;
        rooms.add(roomId, {
          roomAfterSweep with
          state = #Active;
          nominatorIndex = 0;
          nominationTurnStartedAt = now;
        });
        addSystemMessage(roomId, "🚀 Auction has started!", now);
        // Fire auto-nomination for the first nominator if they have a queued player
        switch (firstNominator) {
          case null {};
          case (?nom) { tryAutoNominate(roomId, nom, now) };
        };
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Admin-only: transition room from Active → Paused (freezes all timers)
  public shared ({ caller }) func pauseAuction(
    roomId : Types.RoomId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (room.state != #Active) return #err "Room is not Active";
        sweepExpiredNominations(roomId);
        let now = Time.now();
        // Re-fetch room after sweep to avoid stale state
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        rooms.add(roomId, { roomAfterSweep with state = #Paused });
        activeRoomIds.remove(roomId);
        addSystemMessage(roomId, "⏸ Auction has been paused.", now);
        // Freeze all active nomination timers
        nominations.forEach(func(nomId, nom) {
          if (nom.roomId == roomId and nom.state == #Active and nom.timerPausedAt == null) {
            nominations.add(nomId, { nom with timerPausedAt = ?now });
          };
        });
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Admin-only: transition room from Paused → Active (resumes all timers)
  public shared ({ caller }) func resumeAuction(
    roomId : Types.RoomId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (room.state != #Paused) return #err "Room is not Paused";
        sweepExpiredNominations(roomId);
        let now = Time.now();
        // Re-fetch room after sweep to avoid stale state
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        rooms.add(roomId, { roomAfterSweep with state = #Active });
        addSystemMessage(roomId, "▶️ Auction has resumed.", now);
        // Resume all paused nomination timers: accumulate elapsed, reset startedAt
        let nanosPerSec : Int = 1_000_000_000;
        nominations.forEach(func(nomId, nom) {
          if (nom.roomId == roomId and nom.state == #Active) {
            switch (nom.timerPausedAt) {
              case null {};
              case (?pausedAt) {
                let extraElapsed : Int = (pausedAt - nom.timerStartedAt) / nanosPerSec;
                let totalElapsed = nom.timerElapsedSecs + (if (extraElapsed > 0) extraElapsed.toNat() else 0);
                nominations.add(nomId, {
                  nom with
                  timerStartedAt = now;
                  timerElapsedSecs = totalElapsed;
                  timerPausedAt = null;
                });
              };
            };
          };
        });
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Admin-only: transition room to Completed
  public shared ({ caller }) func endAuction(
    roomId : Types.RoomId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (room.state == #Completed) return #err "Room already Completed";
        sweepExpiredNominations(roomId);
        // Re-fetch room after sweep to avoid stale state
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        rooms.add(roomId, { roomAfterSweep with state = #Completed });
        activeRoomIds.remove(roomId);
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Admin-only: update room timer settings and max active picks.
  /// Allowed in Waiting state, Active (with no active nominations), or Paused.
  public shared ({ caller }) func updateRoomSettings(
    roomId : Types.RoomId,
    nomTimerSecs : Nat,
    bidTimerSecs : Nat,
    maxRosterSize : ?Nat,
    adpDataset : Text,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        let allowed = room.state == #Waiting or room.state == #Paused or
          (room.state == #Active and activeNominationCount(roomId) == 0);
        if (not allowed) return #err "Cannot update settings while auction is active with nominations in progress";
        sweepExpiredNominations(roomId);
        // Re-fetch room after sweep to avoid stale state
        let roomAfterSweep = switch (rooms.get(roomId)) {
          case (?r) r;
          case null return #err "Room not found";
        };
        let resolvedAdpDataset = switch (adpDataset) {
          case ("rookies") "rookies";
          case _ "all";
        };
        let newSettings = { roomAfterSweep.settings with nomTimerSecs; bidTimerSecs; maxRosterSize; adpDataset = resolvedAdpDataset };
        rooms.add(roomId, { roomAfterSweep with settings = newSettings });
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Nominations
  // ─────────────────────────────────────────────────────────────────────────

  /// Core nomination logic — all validation and state mutations except the
  /// caller identity check. Called by both nominatePlayer and auto-nomination.
  func nominatePlayerCore(
    roomId    : Types.RoomId,
    nominator : Types.UserId,
    playerId  : Text,
    now       : Types.Timestamp,
  ) : { #ok : Types.NominationId; #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (room.state != #Active) return #err "Auction is not active";

        // Enforce nomination turn — only the current nominator can nominate
        let participantCount = room.participants.size();
        if (participantCount > 0) {
          let currentNominatorIdx = room.nominatorIndex % participantCount;
          let currentNominator = room.participants[currentNominatorIdx];
          if (not Principal.equal(currentNominator, nominator)) {
            return #err "Not your turn to nominate";
          };
        };

        // Zero-balance guard: a participant with $0 available budget cannot nominate
        let pm0 = getRoomParticipants(roomId);
        switch (pm0.get(nominator)) {
          case (?callerP) {
            if (AuctionLib.availableBudget(callerP) == 0) {
              return #err "Cannot nominate: insufficient budget";
            };
          };
          case null {};  // no participant record yet — allow (will be created on join)
        };

        // Roster cap check + over-commitment safeguard: block nomination when
        // the nominator's roster is already full OR when their projected roster
        // size (won + active leads including this nomination) would exceed cap.
        // Uses assertCanBid so the projected safeguard is applied uniformly.
        // Reuses pm0 from the zero-balance guard above.
        switch (pm0.get(nominator)) {
          case (?participant) {
            switch (assertCanBid(participant, room, roomId, null)) {
              case (#err msg) return #err msg;
              case (#ok) {};
            };
          };
          case null {};
        };

        // Collect existing active nomination IDs for diagnostics.
        // Uses the per-room index (nominationsByRoom) instead of scanning the
        // full nominations map — cost scales with this room's history, not the
        // app's total lifetime history.
        var existingActiveIds = List.empty<Types.NominationId>();
        switch (nominationsByRoom.get(roomId)) {
          case null {};
          case (?ids) {
            for (nid in ids.vals()) {
              switch (nominations.get(nid)) {
                case null {};
                case (?n) {
                  if (n.state == #Active) existingActiveIds.add(nid);
                };
              };
            };
          };
        };


        // Check active nomination limit
        if (activeNominationCount(roomId) >= room.settings.maxActivePicks) {
          return #err "Maximum active nominations reached";
        };

        // Check if player already nominated in this room
        let nominatedSet = getRoomNominatedSet(roomId);
        if (nominatedSet.contains(playerId)) return #err "Player already nominated in this room";

        // Check if player already drafted (won) in this room — authoritative
        // room-scoped drafted set. Rejects re-nominating an already-drafted
        // player even if they are not in the nominated set (e.g. a player won
        // before this set existed, or whose nomination was closed with a
        // winning bid but skipped the roster-cap award path).
        if (getRoomDraftedSet(roomId).contains(playerId)) return #err "Player already drafted in this room";

        // Find player record in global map
        let player = switch (players.get(playerId)) {
          case null return #err "Player not found";
          case (?p) p;
        };

        // Enforce room-level player filter (backend validation — not frontend-only)
        if (not AuctionLib.playerMatchesFilter(player, room.playerFilter)) {
          return #err "Player is not eligible for nomination in this room (does not match position/type filter)";
        };

        // Generate a globally-unique, monotonically-increasing nomination ID from the
        // injected counter. Never use nominations.size() here — deleteRoom removes
        // nominations from the map, which would shrink the size and cause ID collisions
        // (overwriting an active nomination in another room and inheriting its bid history).
        let nomId = nextNominationIdState.next;
        nextNominationIdState.next += 1;

        // Use host-configured bid timer (never hardcode)
        let nom = AuctionLib.newNomination(nomId, roomId, player, nominator, room.settings.bidTimerSecs, now);
        nominations.add(nomId, nom);
        nominatedSet.add(playerId);

        // Auto-set $1 proxy bid for the nominator — every nomination starts with a valid bid and leader
        let proxyMap = Map.empty<Types.UserId, Types.ProxyBid>();
        proxyMap.add(nominator, { nominationId = nomId; userId = nominator; maxBid = 1 });
        getOrCreateProxyBids(roomId).add(nomId, proxyMap);
        // Set nomination currentBid = $1 and bidLeader = nominator
        nominations.add(nomId, { nom with currentBid = 1; bidLeader = ?nominator });
        // Lock $1 committed for the nominator
        updateParticipantCommitted(roomId, nominator, nomId, 1);

        // Append the new nomId to the per-room index. This is the authoritative
        // append point — every nomination ever created in this room is recorded
        // here, in creation order. The room-scoped pick number (used below in
        // the chat announcement) is the length of this list AFTER appending, so
        // a room's first nomination shows (#1) regardless of the global
        // NominationId counter (which increments across every room ever run).
        let existingRoomNoms : [Types.NominationId] = switch (nominationsByRoom.get(roomId)) {
          case null { [] : [Types.NominationId] };
          case (?ids) { ids };
        };
        let updatedRoomNoms = existingRoomNoms.concat([nomId]);
        nominationsByRoom.add(roomId, updatedRoomNoms);
        let roomPickNumber = updatedRoomNoms.size();

        // Collect all active nomination IDs after creation for diagnostics.
        // Uses the per-room index (nominationsByRoom) instead of scanning the
        // full nominations map — same rationale as existingActiveIds above.
        var afterActiveIds = List.empty<Types.NominationId>();
        switch (nominationsByRoom.get(roomId)) {
          case null {};
          case (?ids) {
            for (nid in ids.vals()) {
              switch (nominations.get(nid)) {
                case null {};
                case (?n) {
                  if (n.state == #Active) afterActiveIds.add(nid);
                };
              };
            };
          };
        };


        // Append nominationCreated event to bid history
        appendNominationEvent(roomId, nomId, #nominationCreated, nominator, player.name, 1, now, null);
        addSystemMessage(roomId, "📢 " # player.name # " has been nominated by " # displayNameFor(nominator) # "! (#" # roomPickNumber.toText() # ")", now);

        #ok nomId;
      };
    };
  };

  public shared ({ caller }) func nominatePlayer(
    roomId : Types.RoomId,
    playerId : Text,
  ) : async { #ok : Types.NominationId; #err : Text } {
    sweepExpiredNominations(roomId);
    // Identity check only: verify caller is a participant in the room
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not AuctionLib.isParticipant(room, caller)) return #err "Not in room";
      };
    };
    let now = Time.now();
    let result = nominatePlayerCore(roomId, caller, playerId, now);
    switch (result) {
      case (#ok _) {
        nominationQueue.remove(queueKey(roomId, caller));
        // Hand off to the next participant with skipAutoNominate = false so that
        // a next participant who already has a valid queued auto-nomination is
        // auto-nominated immediately when their turn becomes active, rather than
        // waiting for their nomination timer to expire.
        advanceNominatorIndex(roomId, now, false);
      };
      case (#err _) {};
    };
    ignore _processNotificationQueue();
    result;
  };

  public shared query func getNominations(
    roomId : Types.RoomId,
  ) : async [Types.NominationView] {
    let now = Time.now();
    var result = List.empty<Types.NominationView>();
    nominations.forEach(func(_id, nom) {
      if (nom.roomId == roomId) {
        let leaderName = switch (nom.bidLeader) {
          case null null;
          case (?lid) ?displayNameFor(lid);
        };
        result.add(AuctionLib.toNominationView(nom, now, leaderName));
      };
    });
    result.toArray();
  };

  /// Public update — triggers sweepExpiredNominations for a room.
  /// Frontend calls this to drive timer resolution without polling.
  public shared func sweepNominations(
    roomId : Types.RoomId,
  ) : async () {
    sweepExpiredNominations(roomId);
  };

  /// Store a pre-selected nomination for the caller in this room.
  /// Fires automatically when the caller's nomination turn starts (via sweepExpiredNominations).
  public shared ({ caller }) func setNominationQueue(
    roomId   : Types.RoomId,
    playerId : Text,
  ) : async { #ok : Text; #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not AuctionLib.isParticipant(room, caller)) return #err "Not in room";
        switch (players.get(playerId)) {
          case null return #err "Player not found";
          case (?_) {};
        };
        // Pre-validate: reject if player already nominated
        let nominatedSet = getRoomNominatedSet(roomId);
        if (nominatedSet.contains(playerId)) {
          return #err "Player already nominated";
        };
        // Overwrite any existing queue entry
        nominationQueue.add(queueKey(roomId, caller), playerId);
        #ok "Queued";
      };
    };
  };

  /// Clear the caller's queued nomination for the given room.
  public shared ({ caller }) func clearNominationQueue(
    roomId : Types.RoomId,
  ) : async () {
    nominationQueue.remove(queueKey(roomId, caller));
  };

  /// Return the caller's currently queued player for the given room, or null if none.
  public shared query ({ caller }) func getNominationQueue(
    roomId : Types.RoomId,
  ) : async ?Text {
    nominationQueue.get(queueKey(roomId, caller));
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Bidding — unified proxy bidding only (no separate placeBid)
  // ─────────────────────────────────────────────────────────────────────────

  /// Place a proxy (max) bid — the only bidding entry point.
  /// maxBid is private; only visible bid is public.
  /// Immediately resolves against existing proxy bids to set correct currentBid and leader.
  /// Visible bid starts at $1 when first bid placed, auto-increments by $1 when outbid.
  /// If caller is already the leader and increases max, visible bid does NOT change (no timer reset).
  public shared ({ caller }) func placeProxyBid(
    nominationId : Types.NominationId,
    roomId : Types.RoomId,
    maxBid : Nat,
  ) : async { #ok : (); #err : Text } {
    sweepExpiredNominations(roomId);

    switch (nominations.get(nominationId)) {
      case null return #err "Nomination not found";
      case (?nom) {
        if (nom.state != #Active) return #err "Nomination is not active";
        if (nom.roomId != roomId) return #err "Nomination does not belong to this room";

        switch (rooms.get(roomId)) {
          case null return #err "Room not found";
          case (?room) {
            if (not AuctionLib.isParticipant(room, caller)) return #err "Not in room";
            if (maxBid == 0) return #err "Max bid must be greater than 0";

            // Roster cap check: block bidding when the caller's roster is already full
            let pm0bid = getRoomParticipants(roomId);
            switch (pm0bid.get(caller)) {
              case (?callerP) {
                switch (assertCanBid(callerP, room, roomId, ?nominationId)) {
                  case (#err msg) return #err msg;
                  case (#ok) {};
                };
                // Budget reserve for empty roster slots: when maxRosterSize is
                // Some(cap), reject any bid that would exceed availableBudget -
                // remainingSlotsAfterThisPick, where remainingSlotsAfterThisPick
                // = max(0, cap - wonPlayers.size() - 1). This reserves budget
                // for the slots the participant still needs to fill after this
                // pick. Skipped entirely when maxRosterSize is null. Does NOT
                // change how availableBudget itself is calculated, or the
                // separate roster-full check above.
                switch (room.settings.maxRosterSize) {
                  case null {};
                  case (?cap) {
                    let remainingSlotsAfterThisPick = Nat.max(0, cap - callerP.wonPlayers.size() - 1);
                    let reserveCeiling : Int = AuctionLib.availableBudget(callerP) - remainingSlotsAfterThisPick;
                    let reserveCeilingNat : Nat = if (reserveCeiling <= 0) 0 else reserveCeiling.toNat();
                    if (maxBid > reserveCeilingNat) {
                      return #err "Bid exceeds budget reserve for remaining roster slots";
                    };
                  };
                };
              };
              case null {};
            };

            let now = Time.now();
            let increment = room.settings.minBidIncrement;

            // Get or create proxy bid map for this nomination
            let proxyMap : Map.Map<Types.UserId, Types.ProxyBid> = switch (getOrCreateProxyBids(roomId).get(nominationId)) {
              case (?m) m;
              case null {
                let m = Map.empty<Types.UserId, Types.ProxyBid>();
                getOrCreateProxyBids(roomId).add(nominationId, m);
                m;
              };
            };

            // Caller is already the current bid leader — same-leader proxy update
            let isCurrentLeader = switch (nom.bidLeader) {
              case (?lid) Principal.equal(lid, caller);
              case null false;
            };

            if (isCurrentLeader) {
              // Only update stored proxy max — DO NOT change visible bid, DO NOT reset timer
              let currentProxy = switch (proxyMap.get(caller)) {
                case (?pb) pb.maxBid;
                case null nom.currentBid;
              };

              // 1. Cannot go below current visible bid.
              // Leader is allowed to set maxBid == currentBid (removes proxy headroom
              // while keeping the winning position). Non-leaders must exceed it.
              if (maxBid < nom.currentBid) return #err "Max bid cannot be lower than the current bid";

              if (maxBid < currentProxy) {
                // 2. Lowering the proxy (maxBid > currentBid but < currentProxy): allow it
                proxyMap.add(caller, { nominationId; userId = caller; maxBid });
                // Replace committed entry with new lower value; releases the difference back to available
                updateParticipantCommitted(roomId, caller, nominationId, maxBid);
                // No visible bid change, no timer reset
                return #ok ();
              };

              // 3. Increasing the proxy (maxBid > currentProxy): keep existing increase logic
              // Budget validation for the increase: only the delta is added to committed
              let delta : Nat = if (maxBid > currentProxy) maxBid - currentProxy else 0;
              let pm = getRoomParticipants(roomId);
              switch (pm.get(caller)) {
                case null {};
                case (?p) {
                  let available = AuctionLib.availableBudget(p);
                  if (delta > available) return #err "Insufficient available budget";
                };
              };

              proxyMap.add(caller, { nominationId; userId = caller; maxBid });
              // Update committed: replace the existing committed entry with the new maxBid
              updateParticipantCommitted(roomId, caller, nominationId, maxBid);
              // No visible bid change, no timer reset
              return #ok ();
            };

            // --- New bidder or competing bid ---
            let incumbentMax : Nat = switch (nom.bidLeader) {
              case null 0;  // no incumbent
              case (?lid) {
                switch (proxyMap.get(lid)) {
                  case (?pb) pb.maxBid;
                  case null nom.currentBid;
                };
              };
            };

            // Basic check: must outbid current visible bid
            if (nom.bidLeader != null and maxBid <= nom.currentBid) {
              return #err "Max bid must be greater than current bid";
            };

            // Budget validation: new committed total (replacing any existing entry for this nom)
            // must not exceed totalBudget - spent
            let pm2 = getRoomParticipants(roomId);
            switch (pm2.get(caller)) {
              case null return #err "Participant not found";
              case (?p) {
                // Existing committed for this nomination (will be replaced, so subtract it)
                let existingCommit : Nat = switch (p.committed.find(func(e : (Types.NominationId, Nat)) : Bool { e.0 == nominationId })) {
                  case (?entry) entry.1;
                  case null 0;
                };
                let sumCommitted : Nat = p.committed.foldLeft(0 : Nat, func(acc : Nat, entry : (Types.NominationId, Nat)) : Nat { acc + entry.1 });
                let newSumCommitted : Int = sumCommitted - existingCommit + maxBid;
                let limit : Int = p.budget - p.spent;
                if (newSumCommitted > limit) return #err "Insufficient available budget";
              };
            };

            // Store the new challenger proxy
            proxyMap.add(caller, { nominationId; userId = caller; maxBid });

            // Resolve new visible bid
            let newVisibleBid = AuctionLib.resolveProxyBid(nom.currentBid, maxBid, incumbentMax, increment);

            // Determine new leader
            let newLeader : ?Types.UserId = if (incumbentMax == 0) {
              // First bid ever
              ?caller;
            } else if (maxBid > incumbentMax) {
              // Challenger wins
              ?caller;
            } else {
              // Incumbent stays
              nom.bidLeader;
            };

            // Determine if leadership changed
            let leaderChanged = switch (nom.bidLeader) {
              case null true;
              case (?old) not Principal.equal(old, switch (newLeader) { case (?l) l; case null old });
            };
            let previousLeader = nom.bidLeader;
            let previousBid = nom.currentBid;

            // Update nomination
            let updatedNom = if (leaderChanged) {
              // Reset timer: new leader took over
              {
                nom with
                currentBid = newVisibleBid;
                bidLeader = newLeader;
                timerStartedAt = now;
                timerElapsedSecs = 0;
                timerPausedAt = null;
              };
            } else {
              // Same leader (incumbent kept lead) — update visible bid but no timer reset
              {
                nom with
                currentBid = newVisibleBid;
                bidLeader = newLeader;
              };
            };
            nominations.add(nominationId, updatedNom);

            // Append leaderChanged event:
            // - When the leader actually changes (manual bid took the lead): isAutoBid = false
            // - When the incumbent's proxy auto-defends (challenger bid didn't exceed incumbent max): isAutoBid = true
            if (leaderChanged) {
              switch (newLeader) {
                case null {};
                case (?lid) {
                  appendNominationEvent(nom.roomId, nominationId, #leaderChanged, lid, nom.playerName, newVisibleBid, now, ?false);
                };
              };
            } else if (incumbentMax > 0 and not leaderChanged and newVisibleBid > nom.currentBid) {
              // Incumbent's proxy auto-incremented in response to a competing manual bid
              switch (nom.bidLeader) {
                case null {};
                case (?incumbentId) {
                  appendNominationEvent(nom.roomId, nominationId, #leaderChanged, incumbentId, nom.playerName, newVisibleBid, now, ?true);
                };
              };
            };

            // Record bid in history
            let bidHistory : List.List<Types.Bid> = switch (getOrCreateBids(roomId).get(nominationId)) {
              case (?h) h;
              case null {
                let h = List.empty<Types.Bid>();
                getOrCreateBids(roomId).add(nominationId, h);
                h;
              };
            };
            bidHistory.add({
              nominationId;
              userId = caller;
              amount = newVisibleBid;
              isProxy = true;
              timestamp = now;
            });

            // Update committed based on outcome:
            // - If challenger wins (leaderChanged): set challenger committed = maxBid, clear old leader
            // - If incumbent keeps lead: challenger loses, no committed for challenger (they have none to add)
            //   The incumbent's committed was already set when they first placed their bid.
            if (leaderChanged) {
              // Challenger took the lead
              switch (newLeader) {
                case null {};
                case (?lid) {
                  updateParticipantCommitted(roomId, lid, nominationId, maxBid);
                };
              };
              // Release committed for the previous leader
              switch (nom.bidLeader) {
                case null {};
                case (?oldLeader) {
                  updateParticipantCommitted(roomId, oldLeader, nominationId, 0);
                };
              };
            };
            // If incumbent stays leader (no leaderChanged), incumbent's committed remains unchanged.

            // Post system message when the leader changes (i.e. someone was outbid)
            if (leaderChanged) {
              switch (previousLeader) {
                case null {};
                case (?oldLeader) {
                  addSystemMessage(nom.roomId, "⚡ " # displayNameFor(oldLeader) # " has been outbid on " # nom.playerName # "! New bid: $" # newVisibleBid.toText() # "", now);
                };
              };
            };

            ignore _processNotificationQueue();
            #ok ();
          };
        };
      };
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Host controls — budget, participant management, nomination order, slots
  // ─────────────────────────────────────────────────────────────────────────

  /// Host-only: edit the total budget of a participant.
  /// newBudget must be >= spentBudget (cannot set below already-spent amount).
  public shared ({ caller }) func editParticipantBudget(
    roomId : Types.RoomId,
    targetUser : Types.UserId,
    newBudget : Nat,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (not AuctionLib.isParticipant(room, targetUser)) return #err "User not in room";
        let pm = getRoomParticipants(roomId);
        switch (pm.get(targetUser)) {
          case null return #err "Participant record not found";
          case (?p) {
            if (newBudget < p.spent) return #err "Budget cannot be set below already-spent amount";
            pm.add(targetUser, { p with budget = newBudget });
            #ok ();
          };
        };
      };
    };
  };

  /// Host-only: remove a participant from the room.
  /// Only allowed when the auction is in Waiting or Paused state.
  /// Cannot remove the room admin.
  public shared ({ caller }) func removeParticipant(
    roomId : Types.RoomId,
    targetUser : Types.UserId,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (room.state != #Waiting and room.state != #Paused) {
          return #err "Can only remove participants when auction is Waiting or Paused";
        };
        if (Principal.equal(targetUser, room.admin)) return #err "Cannot remove the room admin";
        if (not AuctionLib.isParticipant(room, targetUser)) return #err "User not in room";

        let updatedParticipants = room.participants.filter(func(uid) { not Principal.equal(uid, targetUser) });
        let roomWithoutParticipant = { room with participants = updatedParticipants };
        let roomWithoutReady = removeFromReadyParticipants(roomWithoutParticipant, targetUser);
        let roomWithoutPaid = removeFromPaidParticipants(roomWithoutReady, targetUser);
        rooms.add(roomId, roomWithoutPaid);

        let pm = getRoomParticipants(roomId);
        pm.remove(targetUser);

        removeUserRoom(targetUser, roomId);

        // Defensive consistency check (diagnostic only — logs drift, does not repair)
        checkMembershipConsistency(?roomId);

        #ok ();
      };
    };
  };

  /// Host-only: set the nomination order for the room.
  /// orderedUsers must contain exactly the principals currently in the room.
  /// Only allowed when the auction is in Waiting or Paused state.
  public shared ({ caller }) func setNominationOrder(
    roomId : Types.RoomId,
    orderedUsers : [Types.UserId],
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (room.state != #Waiting and room.state != #Paused) {
          return #err "Can only set nomination order when auction is Waiting or Paused";
        };
        // Validate all provided users are in the room
        for (uid in orderedUsers.vals()) {
          if (not AuctionLib.isParticipant(room, uid)) {
            return #err ("User not in room: " # uid.toText());
          };
        };
        // Validate that orderedUsers covers all current participants (no missing entries)
        if (orderedUsers.size() != room.participants.size()) {
          return #err "orderedUsers must include all participants in the room";
        };
        rooms.add(roomId, { room with participants = orderedUsers });
        #ok ();
      };
    };
  };

  /// Host-only: set the number of simultaneous active nominations (maxActivePicks).
  /// count must be between 1 and the number of participants in the room.
  public shared ({ caller }) func setActiveNominationCount(
    roomId : Types.RoomId,
    count : Nat,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        let participantCount = room.participants.size();
        if (count < 1) return #err "Active nomination count must be at least 1";
        if (participantCount > 0 and count > participantCount) {
          return #err "Active nomination count cannot exceed number of participants";
        };
        let newSettings = { room.settings with maxActivePicks = count };
        rooms.add(roomId, { room with settings = newSettings });
        #ok ();
      };
    };
  };

  /// Host-only: randomly shuffle the nomination order (participants array) in the room.
  /// Uses a Fisher-Yates shuffle seeded from Time.now().
  /// Only allowed when the auction is in Waiting or Paused state.
  public shared ({ caller }) func randomizeNominationOrder(
    roomId : Types.RoomId,
  ) : async { #ok : [Types.UserId]; #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) return #err "Not room admin";
        if (room.state != #Waiting and room.state != #Paused) {
          return #err "Can only randomize nomination order when auction is Waiting or Paused";
        };
        let arr = room.participants.toVarArray();
        let n = arr.size();
        if (n > 1) {
          // Fisher-Yates shuffle using Time.now() as entropy source
          var seed : Nat = Int.abs(Time.now());
          var i = n;
          while (i > 1) {
            i -= 1;
            // Linear congruential step — stays Nat, never wraps negative
            seed := (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
            let j : Nat = seed % (i + 1);
            let tmp = arr[i];
            arr[i] := arr[j];
            arr[j] := tmp;
          };
        };
        let shuffled = Array.tabulate(arr.size(), func i = arr[i]);
        rooms.add(roomId, { room with participants = shuffled });
        #ok shuffled;
      };
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Player search
  // ─────────────────────────────────────────────────────────────────────────

  public shared query func getPlayers(
    queryText : Text,
    position : ?Text,
  ) : async [Types.Player] {
    AuctionLib.filterPlayers(players, queryText, position);
  };

  /// Return players eligible under a room's playerFilter, optionally filtered by query text.
  /// Backend enforces the room's position and rookie/veteran filter.
  public shared query func getPlayersByRoom(
    roomId       : Types.RoomId,
    queryText    : Text,
    positionFilter : Text,
  ) : async [Types.Player] {
    // Look up the room to get its playerFilter
    let roomFilter : Types.PlayerFilter = switch (rooms.get(roomId)) {
      case null AuctionLib.defaultPlayerFilter();   // room not found → no restriction
      case (?room) room.playerFilter;
    };

    // If positionFilter is non-empty and not "ALL", narrow to that specific position
    // while keeping the room's rookie/veteran filterType.
    let effectiveFilter : Types.PlayerFilter = if (positionFilter == "" or positionFilter == "ALL") {
      roomFilter;
    } else {
      { positions = [positionFilter]; filterType = roomFilter.filterType };
    };

    AuctionLib.filterPlayersByRoom(players, queryText, effectiveFilter);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Admin: player import
  // ─────────────────────────────────────────────────────────────────────────

  /// Admin-only: batch import players from the Sleeper API.
  /// The frontend fetches from https://api.sleeper.app/v1/players/nfl and sends
  /// filtered, mapped batches here. NO backend HTTP outcall is made.
  /// Returns the total number of players now stored.
  /// Admin is assigned on first profile registration (setDisplayName), not here.
  public shared ({ caller }) func importPlayers(
    batch : [Types.Player],
  ) : async { #ok : Nat; #err : Text } {
    // Only the registered admin (or hardcoded admin principal) may call this
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can import players";
    };

    // Upsert each player into the map keyed by player.id.
    // Resolve byeWeek from the admin-importable byeWeeksStore so players without
    // a valid NFL team get null instead of 0. The frontend-supplied byeWeek is
    // ignored — the backend store is the single source of truth.
    let byeWeekMapping = switch (byeWeeksStore.get("mapping")) {
      case (?m) m;
      case null [];
    };
    let byeWeekLookup = Map.empty<Text, Nat>();
    for (entry in byeWeekMapping.vals()) {
      let (team, week) = entry;
      byeWeekLookup.add(team, week);
    };
    batch.forEach(func(p : Types.Player) {
      let byeWeek = byeWeekLookup.get(p.team);
      players.add(p.id, { p with byeWeek = byeWeek });
    });

    #ok (players.size());
  };

  /// Query: returns true if the caller is the registered global admin principal.
  /// Used by the frontend to show/hide the Admin section in the sidebar.
  public shared query ({ caller }) func checkIsAdmin() : async Bool {
    // Centralized global admin check (hardcoded principal OR registered admin).
    AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Room listing
  // ─────────────────────────────────────────────────────────────────────────

  /// Return ALL rooms (public and private) as RoomSummary list.
  /// Access-gated: only a global admin (isGlobalAdmin) receives the full list;
  /// any other caller receives an empty array so private-room metadata is never
  /// leaked to non-admins. AdminPanel relies on this for full visibility.
  public shared ({ caller }) func getRooms() : async [Types.RoomSummary] {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return [];
    };
    var result = List.empty<Types.RoomSummary>();
    rooms.forEach(func(_id, room) {
      // Reconcile the inner participants map to room.participants (Fix 4),
      // then use room.participants.size() as the authoritative count.
      let pm = reconcileParticipantsMap(room.id, room);
      ignore pm; // reconciled in place; count comes from room.participants
      result.add(AuctionLib.toRoomSummary(room, room.participants.size()));
    });
    result.toArray();
  };

  /// Return only public rooms (isPublic == true) as RoomSummary list for the lobby.
  public shared query func listPublicRooms() : async [Types.RoomSummary] {
    var result = List.empty<Types.RoomSummary>();
    rooms.forEach(func(_id, room) {
      if (room.isPublic) {
        // Reconcile the inner participants map to room.participants (Fix 4),
        // then use room.participants.size() as the authoritative count.
        let pm = reconcileParticipantsMap(room.id, room);
        ignore pm; // reconciled in place; count comes from room.participants
        result.add(AuctionLib.toRoomSummary(room, room.participants.size()));
      };
    });
    result.toArray();
  };

  /// Join a private room by password only (no room name/code field).
  /// Matches private rooms (isPublic == false) server-side by password and
  /// returns only the matched RoomId on success. On failure (no private room
  /// matches the password) returns a single generic error — it does NOT
  /// distinguish "no room exists with this password" from any other failure
  /// reason, so this endpoint cannot be used to enumerate private rooms or
  /// probe for valid passwords one at a time beyond what the existing
  /// single-password-field UX already allows.
  public shared ({ caller }) func joinPrivateRoomByPassword(password : Text) : async { #ok : Types.RoomId; #err : Text } {
    var matched : ?Types.RoomId = null;
    rooms.forEach(func(roomId, room) {
      if (matched == null and not room.isPublic) {
        switch (room.password) {
          case (?roomPw) {
            // Same password comparison logic as joinRoom.
            if (password == roomPw) matched := ?roomId;
          };
          case null {};
        };
      };
    });
    switch (matched) {
      case (?roomId) #ok roomId;
      case null #err "Invalid password. No private room matched.";
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Bid history (event-based, per nomination)
  // ─────────────────────────────────────────────────────────────────────────

  /// Return the stored event-based bid history for a nomination.
  /// Events are ordered oldest-first (append order).
  public shared query func getNominationHistory(
    nominationId : Types.NominationId,
  ) : async [Types.BidHistoryEvent] {
    let roomIdOpt = switch (nominations.get(nominationId)) {
      case (?n) ?n.roomId;
      case null null;
    };
    switch (roomIdOpt) {
      case null [];
      case (?rid) {
        switch (getOrCreateNominationHistory(rid).get(nominationId)) {
          case null [];
          case (?history) history.toArray();
        };
      };
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Chat (per room)
  // ─────────────────────────────────────────────────────────────────────────

    // ─── Chat message ID counter (injected as stable state in main.mo) ───

  /// Post a system-generated message to the room's chat.
  /// Deduplicates: if any of the last 10 messages in the room has the same text
  /// and a timestamp within 120 seconds of `now`, the message is dropped.
  func addSystemMessage(roomId : Types.RoomId, text : Text, now : Types.Timestamp) {
    let msgList : List.List<Types.ChatMessage> = switch (roomMessages.get(roomId)) {
      case (?l) l;
      case null {
        let l = List.empty<Types.ChatMessage>();
        roomMessages.add(roomId, l);
        l;
      };
    };
    // Dedup check: scan last 10 messages
    let total = msgList.size();
    let checkCount = if (total < 10) total else 10;
    if (checkCount > 0) {
      var i : Nat = if (total >= checkCount) total - checkCount else 0;
      var duplicate = false;
      while (i < total) {
          let existing = msgList.at(i);
          let timeDiff = if (now >= existing.timestamp) {
            now - existing.timestamp
          } else {
            existing.timestamp - now
          };
          if (existing.message == text and timeDiff < 120_000_000_000) {
            duplicate := true;
          };
          i += 1;
        };
      if (duplicate) return;
    };
    let msgId = nextMsgIdState.next;
    nextMsgIdState.next += 1;
    let systemUser = Principal.fromText("aaaaa-aa");
    let msg : Types.ChatMessage = {
      id = msgId;
      userId = systemUser;
      displayName = "System";
      message = text;
      timestamp = now;
      reactions = [];
    };
    if (msgList.size() >= 500) {
      let kept = msgList.sliceToArray(1, msgList.size());
      msgList.clear();
      msgList.addAll(kept.values());
    };
    msgList.add(msg);
  };

  /// Send a chat message to a room.
  /// Caller must be a participant in the room.
  public shared ({ caller }) func sendMessage(
    roomId  : Types.RoomId,
    message : Text,
  ) : async { #ok : (); #err : Text } {
    if (message.size() == 0) return #err "Message cannot be empty";
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not AuctionLib.isParticipant(room, caller)) return #err "Not in room";
        let now = Time.now();
        let displayName = displayNameFor(caller);
        let msgId = nextMsgIdState.next;
        nextMsgIdState.next += 1;
        let msg : Types.ChatMessage = {
          id = msgId;
          userId = caller;
          displayName;
          message;
          timestamp = now;
          reactions = [];
        };
        let msgList : List.List<Types.ChatMessage> = switch (roomMessages.get(roomId)) {
          case (?l) l;
          case null {
            let l = List.empty<Types.ChatMessage>();
            roomMessages.add(roomId, l);
            l;
          };
        };
        if (msgList.size() >= 500) {
          let kept = msgList.sliceToArray(1, msgList.size());
          msgList.clear();
          msgList.addAll(kept.values());
        };
        msgList.add(msg);
        // Trigger 3: scan room participants for @mentions and notify each
        // mentioned user (excluding the sender). Cheap synchronous side effect.
        for (participant in room.participants.vals()) {
          if (Principal.equal(participant, caller)) continue;
          let pname = displayNameFor(participant);
          if (pname.size() == 0) continue;
          if (message.contains(#text ("@" # pname))) {
            enqueueNotification(participant, displayNameFor(caller) # " mentioned you", message);
          };
        };
        ignore _processNotificationQueue();
        #ok ();
      };
    };
  };

  /// Get the most recent `limit` chat messages for a room (newest first).
  public shared query func getMessages(
    roomId : Types.RoomId,
    limit  : Nat,
  ) : async [Types.ChatMessage] {
    switch (roomMessages.get(roomId)) {
      case null [];
      case (?msgList) {
        let total = msgList.size();
        if (total == 0) return [];
        // Assign sequential IDs to legacy messages that have id == 0
        var needsIdUpdate = false;
        var i : Nat = 0;
        while (i < total) {
          if (msgList.at(i).id == 0) {
            needsIdUpdate := true;
          };
          i += 1;
        };
        if (needsIdUpdate) {
          var nextId : Nat = 1;
          let updatedList = List.empty<Types.ChatMessage>();
          i := 0;
          while (i < total) {
            let m = msgList.at(i);
            if (m.id == 0) {
              updatedList.add({ m with id = nextId });
              nextId += 1;
            } else {
              updatedList.add(m);
            };
            i += 1;
          };
          roomMessages.remove(roomId);
          roomMessages.add(roomId, updatedList);
          return updatedList.toArray();
        };
        // Messages are stored oldest-first (add appends), so reverse to get newest-first
        let reversed = msgList.reverse();
        let take = if (limit > total) total else limit;
        reversed.sliceToArray(0, take);
      };
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ADP dataset management
  // ─────────────────────────────────────────────────────────────────────────

  /// Admin-only: import an ADP dataset, keyed by datasetType ("all" or "rookies").
  /// entries: array of AdpEntry (name + adp required, position/team optional).
  /// Validates: max 2000 entries, non-numeric adp values rejected, duplicates ignored.
  public shared ({ caller }) func importADPDataset(
    entries     : [Types.AdpEntry],
    datasetType : ?Text,
  ) : async { #ok : Text; #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can import an ADP dataset";
    };

    if (entries.size() > 2000) {
      return #err "Dataset exceeds maximum of 2000 players";
    };

    // Resolve dataset key
    let key = switch (datasetType) {
      case (?t) { if (t == "rookies") "rookies" else "all" };
      case null { "all" };
    };

    // Deduplicate by normalized name, validate required fields
    let seen = Set.empty<Text>();
    let valid = List.empty<Types.AdpEntry>();
    entries.forEach(func(e : Types.AdpEntry) {
      if (e.name.size() == 0) return; // skip blank names
      let normKey = AuctionLib.normalizeName(e.name);
      if (not seen.contains(normKey)) {
        seen.add(normKey);
        valid.add(e);
      };
    });

    if (valid.size() == 0) {
      return #err "No valid entries in dataset";
    };

    let now = Time.now();
    let dataset : Types.ADPDataset = {
      entries     = valid.toArray();
      importedAt  = now;
      lastUpdated = now;
    };

    // Store dataset keyed by type ("all" or "rookies")
    activeAdpDataset.add(key, dataset);

    #ok ("ADP dataset imported: " # valid.size().toText() # " entries (key: " # key # ")");
  };

  /// Return the current active ADP dataset, or null if none has been imported.
  /// Returns "all" dataset for backwards compatibility.
  public shared query func getADPDataset() : async ?Types.ADPDataset {
    activeAdpDataset.get("all");
  };

  /// Alias for getADPDataset — returns the "all" ADP dataset with lastUpdated timestamp.
  public shared query func getActiveADPDataset() : async ?Types.ADPDataset {
    activeAdpDataset.get("all");
  };

  /// Return the ADP dataset for a specific type ("all" or "rookies").
  /// Returns null if no dataset has been imported for that type.
  public shared query func getADPDatasetByType(
    datasetType : Text,
  ) : async ?Types.ADPDataset {
    let key = if (datasetType == "rookies") "rookies" else "all";
    activeAdpDataset.get(key);
  };

  /// Admin-only: remove the ADP dataset for a specific type ("all" or "rookies").
  public shared ({ caller }) func removeADPDataset(
    datasetType : Text,
  ) : async { #ok : Text; #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can remove an ADP dataset";
    };

    let key = if (datasetType == "rookies") "rookies" else "all";
    activeAdpDataset.remove(key);
    #ok ("Removed ADP dataset: " # key);
  };

  /// Return all players enriched with ADP values from the active dataset.
  /// Players with no ADP match retain their existing adp value (0.0 for imported players).
  /// If no dataset is active, returns all players with their original adp values.
  public shared query func getPlayersWithADP() : async [Types.Player] {
    switch (activeAdpDataset.get("all")) {
      case null {
        // No ADP dataset — return players as-is
        let result = List.empty<Types.Player>();
        players.forEach(func(_id, p) { result.add(p) });
        result.toArray();
      };
      case (?dataset) {
        AuctionLib.enrichPlayersWithADP(players, dataset);
      };
    };
  };

  /// Admin-only: clear all players from the players map.
  /// Returns #ok(()) on success or #err if caller is not admin.
  public shared ({ caller }) func clearPlayers() : async { #ok : (); #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can clear players";
    };

    // Collect all keys then remove each one
    let keys = List.empty<Text>();
    players.forEach(func(k, _v) { keys.add(k) });
    keys.forEach(func(k) { players.remove(k) });

    #ok ();
  };

  /// Admin-only: delete a room and ALL associated data.
  /// Removes the room from: rooms, participants, nominations, bids, proxyBids,
  /// nominatedByRoom, nominationHistory, and roomMessages.
  /// Returns #ok(()) on success or #err("Room not found") if the room does not exist.
  ///
  /// Best Ball protection: if a BestBallConfig exists for this room, deletion
  /// is refused — the room contains historical Best Ball data — and no removal
  /// logic runs at all.
  public shared ({ caller }) func deleteRoom(roomId : Types.RoomId) : async { #ok : (); #err : Text } {
    // Admin guard — centralized global admin check. Runs FIRST so a non-admin
    // caller is rejected before any Best Ball data is revealed.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can delete rooms";
    };

    // Best Ball protection — check BEFORE any removal logic. If a BestBallConfig
    // exists for this room, refuse to delete and leave the room and its data
    // fully intact.
    if (bestBallConfigs.get(roomId) != null) {
      return #err "Cannot delete room because it contains historical Best Ball data";
    };

    // Verify the room exists and capture its participants array BEFORE any
    // removal. room.participants is the authoritative membership source; we
    // must iterate it while the room record still exists so we can clean every
    // former participant's userRooms index entry (prevents orphaned entries).
    let roomParticipants : [Types.UserId] = switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) room.participants;
    };

    // Collect all nomination IDs that belong to this room
    let roomNomIds = List.empty<Types.NominationId>();
    nominations.forEach(func(nomId, nom) {
      if (nom.roomId == roomId) {
        roomNomIds.add(nomId);
      };
    });

    // Remove bids, proxyBids, and nominationHistory for each nomination in this room
    roomNomIds.forEach(func(nomId) {
      getOrCreateBids(roomId).remove(nomId);
      getOrCreateProxyBids(roomId).remove(nomId);
      getOrCreateNominationHistory(roomId).remove(nomId);
    });

    // Remove all nominations that belong to this room
    roomNomIds.forEach(func(nomId) {
      nominations.remove(nomId);
    });

    // Remove remaining room-level maps
    activeRoomIds.remove(roomId);
    participants.remove(roomId);
    nominatedByRoom.remove(roomId);
    roomMessages.remove(roomId);

    // Clean the userRooms index for every former participant BEFORE removing
    // the room itself. This is the three-store synchronization step for
    // deleteRoom: room.participants is gone (via rooms.remove below), the
    // participants inner map is gone (above), and now each user's userRooms
    // entry for this room is removed. Without this, every former participant
    // would have an orphaned roomId in their userRooms list.
    for (uid in roomParticipants.vals()) {
      removeUserRoom(uid, roomId);
    };

    // Remove the room itself
    rooms.remove(roomId);

    // Defensive consistency check (diagnostic only — logs drift, does not
    // repair). After deletion, no userRooms entry should reference this room.
    checkMembershipConsistency(?roomId);

    #ok ();
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Best Ball configuration
  // ─────────────────────────────────────────────────────────────────────────

  /// Room admin only: set or overwrite the room's BestBallConfig, marking that
  /// this room has Best Ball tracking enabled and recording its week range.
  /// Does not calculate or fetch anything — it only records the marker.
  /// The backend accepts whatever endWeek is passed; the frontend/caller
  /// defaults endWeek to 18 (a full NFL regular season) when not specified.
  public shared ({ caller }) func setBestBallConfig(
    roomId : Types.RoomId,
    startWeek : Nat,
    endWeek : Nat,
  ) : async Result.Result<(), Text> {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not isAdmin(room, caller)) {
          return #err "Only the room admin can set Best Ball configuration";
        };
        bestBallConfigs.add(roomId, { startWeek; endWeek });
        #ok ();
      };
    };
  };

  /// Any room participant can read the room's BestBallConfig.
  /// Returns null when the room has no Best Ball tracking enabled.
  public query func getBestBallConfig(roomId : Types.RoomId) : async ?Types.BestBallConfig {
    bestBallConfigs.get(roomId);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Giphy API key management
  // ─────────────────────────────────────────────────────────────────────────

  /// Admin-only: store the Giphy API key.
  /// If the key is empty after trimming, stores null (removes any existing key).
  /// Returns #ok with a confirmation message, or #err if the caller is not admin.
  public shared ({ caller }) func setGiphyApiKey(
    key : Text,
  ) : async { #ok : Text; #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can set the Giphy API key";
    };

    let trimmed = key.trim(#char ' ');
    if (trimmed.size() == 0) {
      // Empty — remove any stored key
      giphyApiKeyStore.remove("key");
      return #ok "Giphy API key cleared";
    };

    giphyApiKeyStore.add("key", trimmed);
    #ok "Giphy API key saved";
  };

  /// Public query — retrieve the Giphy API key.
  /// Callable by any authenticated (non-anonymous) user.
  /// Returns null if no key is stored. Never exposed to anonymous callers.
  public shared query ({ caller }) func getGiphyApiKey() : async ?Text {
    if (caller.isAnonymous()) return null;
    giphyApiKeyStore.get("key");
  };

  // ─────────────────────────────────────────────────────────────────────────
  // OneSignal API key management
  // ─────────────────────────────────────────────────────────────────────────

  /// Admin-only: store the OneSignal REST API key.
  /// If the key is empty after trimming, stores null (removes any existing key).
  /// Returns #ok with a confirmation message, or #err if the caller is not admin.
  public shared ({ caller }) func setOneSignalApiKey(
    key : Text,
  ) : async { #ok : Text; #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can set the OneSignal API key";
    };

    let trimmed = key.trim(#char ' ');
    if (trimmed.size() == 0) {
      // Empty — remove any stored key
      oneSignalApiKeyStore.remove("key");
      return #ok "OneSignal API key cleared";
    };

    oneSignalApiKeyStore.add("key", trimmed);
    #ok "OneSignal API key saved";
  };

  /// Admin-only query — retrieve the OneSignal REST API key.
  /// The REST API key must NEVER be exposed to non-admin callers.
  /// Returns null for anonymous callers and non-admin callers.
  public shared query ({ caller }) func getOneSignalApiKey() : async ?Text {
    if (caller.isAnonymous()) return null;
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) return null;
    oneSignalApiKeyStore.get("key");
  };

  // ─────────────────────────────────────────────────────────────────────────
  // OneSignal Player ID management
  // ─────────────────────────────────────────────────────────────────────────

  /// Any authenticated user: store their OneSignal Player ID tied to their principal.
  /// If id is empty after trimming, removes the entry.
  public shared ({ caller }) func setOneSignalPlayerId(
    id : Text,
  ) : async () {
    if (caller.isAnonymous()) return;
    let trimmed = id.trim(#char ' ');
    if (trimmed.size() == 0) {
      oneSignalPlayerIds.remove(caller.toText());
    } else {
      oneSignalPlayerIds.add(caller.toText(), trimmed);
    };
  };

  /// Admin-only query — retrieve all stored principal → OneSignal Player ID mappings.
  /// Returns an empty array for non-admin callers.
  public shared query ({ caller }) func getOneSignalPlayerIds() : async [(Text, Text)] {
    if (caller.isAnonymous()) return [];
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) return [];
    oneSignalPlayerIds.entries().toArray();
  };

  /// Admin-only diagnostic: send a single test push notification to the caller's
  /// own stored OneSignal player ID, bypassing the notification queue entirely.
  /// Mirrors the real outcall in processNotificationQueue exactly (same endpoint,
  /// same payload shape, same app_id, same auth header) but returns the raw
  /// OneSignal response so the admin can diagnose key/permission issues directly.
  /// Does NOT read from or write to notificationQueue.
  public shared ({ caller }) func sendTestPush() : async {
    #ok : { body : Text; playerId : Text; looksSuccessful : Bool };
    #err : Text;
  } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Unauthorized";
    };

    let apiKey = switch (oneSignalApiKeyStore.get("key")) {
      case null return #err "No OneSignal API key is currently saved.";
      case (?k) k;
    };

    let playerId = switch (oneSignalPlayerIds.get(caller.toText())) {
      case null return #err "No OneSignal player ID is stored for your own account. Open the Profile tab and enable push notifications for yourself first, then try again.";
      case (?pid) pid;
    };

    // Same payload shape and app_id literal as processNotificationQueue (line 226).
    let payload =
      "{"
      # "\"app_id\":\"1b488a94-8768-4292-a6a9-64a9fd5329c3\","
      # "\"include_player_ids\":[\"" # jsonEscape(playerId) # "\"],"
      # "\"headings\":{\"en\":\"Test notification\"},"
      # "\"contents\":{\"en\":\"This is a test push from the admin panel.\"}"
      # "}";

    let headers : [OutCall.Header] = [
      { name = "Authorization"; value = "Basic " # apiKey },
      { name = "Content-Type"; value = "application/json" },
      { name = "Idempotency-Key"; value = "test-" # Int.abs(Time.now()).toText() },
    ];

    try {
      let responseText = await OutCall.httpPostRequest(
        "https://onesignal.com/api/v1/notifications",
        headers,
        payload,
        transform,
      );
      let looksSuccessful = not responseText.contains(#text "\"errors\"");
      #ok { body = responseText; playerId = playerId; looksSuccessful = looksSuccessful };
    } catch (e) {
      #err ("HTTP outcall failed: " # e.message());
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Notification observability (admin-only)
  // ─────────────────────────────────────────────────────────────────────────

  /// Admin-only query — return the six notification lifecycle counters.
  /// Non-admin callers receive all zeros (same guard pattern as getOneSignalPlayerIds).
  public shared query ({ caller }) func getNotificationCounters() : async {
    queued : Nat;
    processed : Nat;
    sent : Nat;
    expired : Nat;
    retried : Nat;
    failed : Nat;
  } {
    if (caller.isAnonymous()) return { queued = 0; processed = 0; sent = 0; expired = 0; retried = 0; failed = 0 };
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return { queued = 0; processed = 0; sent = 0; expired = 0; retried = 0; failed = 0 };
    };
    {
      queued = notificationsQueuedTotal.count;
      processed = notificationsProcessedTotal.count;
      sent = notificationsSentTotal.count;
      expired = notificationsExpiredTotal.count;
      retried = notificationsRetriedTotal.count;
      failed = notificationsFailedTotal.count;
    };
  };

  /// Admin-only query — return heartbeat and notification-worker diagnostics.
  /// Non-admin callers receive all fields zeroed/null (same guard pattern as
  /// getNotificationCounters).
  public shared query ({ caller }) func getHeartbeatDiagnostics() : async {
    notificationWorkerEntryCount : Nat;
    lastNotificationWorkerStartedAt : Int;
    lastNotificationWorkerCompletedAt : Int;
    lastNotificationWorkerError : ?Text;
  } {
    if (caller.isAnonymous()) {
      return {
        notificationWorkerEntryCount = 0;
        lastNotificationWorkerStartedAt = 0;
        lastNotificationWorkerCompletedAt = 0;
        lastNotificationWorkerError = null;
      };
    };
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return {
        notificationWorkerEntryCount = 0;
        lastNotificationWorkerStartedAt = 0;
        lastNotificationWorkerCompletedAt = 0;
        lastNotificationWorkerError = null;
      };
    };
    {
      notificationWorkerEntryCount = notificationWorkerEntryCount.count;
      lastNotificationWorkerStartedAt = lastNotificationWorkerStartedAt.value;
      lastNotificationWorkerCompletedAt = lastNotificationWorkerCompletedAt.value;
      lastNotificationWorkerError = lastNotificationWorkerError.error;
    };
  };

  /// Admin-only query — return each joined participant's principal ID (as Text)
  /// paired with their display name for the given room, so the admin can see and
  /// copy the principal IDs of all joined participants. Works on rooms in any
  /// state (Waiting, Active, Paused, Completed) since the admin needs to inspect
  /// principals in a live Active room. Rejects non-admin callers with #err.
  public shared query ({ caller }) func getRoomParticipantPrincipals(
    roomId : Types.RoomId,
  ) : async { #ok : [{ principal : Text; displayName : Text }]; #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Unauthorized: only the admin can view participant principal IDs.";
    };

    // Resolve the room; room.participants is the authoritative membership source.
    let room = switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?r) r;
    };

    // Build the principal/displayName list from the authoritative participants
    // array. Resolve each display name via the inner participants map first
    // (authoritative per-room record), falling back to the global profile or
    // truncated principal via displayNameFor.
    let pm = switch (participants.get(roomId)) {
      case (?pm) pm;
      case null Map.empty<Types.UserId, Types.Participant>();
    };
    let result = List.empty<{ principal : Text; displayName : Text }>();
    for (userId in room.participants.vals()) {
      let name = switch (pm.get(userId)) {
        case (?p) p.displayName;
        case null displayNameFor(userId);
      };
      result.add({ principal = userId.toText(); displayName = name });
    };
    #ok(result.toArray());
  };

  /// Admin-only query — return a snapshot of the current notification queue.
  /// Each entry exposes id, userId (as Text), title, attempts, and age in seconds.
  /// Non-admin callers receive an empty array (same guard pattern as getOneSignalPlayerIds).
  public shared query ({ caller }) func getNotificationQueueSnapshot() : async [{
    id : Nat;
    userId : Text;
    title : Text;
    attempts : Nat;
    ageSeconds : Nat;
  }] {
    if (caller.isAnonymous()) return [];
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) return [];
    let now = Time.now();
    notificationQueue.map<Types.PendingNotification, { id : Nat; userId : Text; title : Text; attempts : Nat; ageSeconds : Nat }>(
      func(n : Types.PendingNotification) : { id : Nat; userId : Text; title : Text; attempts : Nat; ageSeconds : Nat } {
        {
          id = n.id;
          userId = n.userId.toText();
          title = n.title;
          attempts = n.attempts;
          ageSeconds = Int.abs(now - n.createdAt) / 1_000_000_000;
        };
      }
    ).toArray();
  };

  /// Admin-only — manually drain the notification queue now.
  /// Thin wrapper around processNotificationQueue; does not modify that function's
  /// signature, auth, or the timer's unguarded call to it.
  /// Returns #ok with the number of notifications processed, or #err "Unauthorized".
  public shared ({ caller }) func adminDrainQueueNow() : async { #ok : Nat; #err : Text } {
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Unauthorized";
    };
    let processedCount = await _processNotificationQueue();
    #ok processedCount;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RSS feed sources & refresh interval management
  // ─────────────────────────────────────────────────────────────────────────

  /// Admin-only: set the list of RSS feed URLs to aggregate.
  /// Clears the RSS cache so the next fetch uses the new URLs.
  public shared ({ caller }) func setRssFeedUrls(
    urls : [Text],
  ) : async { #ok : (); #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can set the RSS feed URLs";
    };

    rssFeedUrlsStore.add("urls", urls);
    // Clear the RSS cache so the next fetch uses the new URLs
    rssCacheTimestamp.timestamp := 0;
    #ok ();
  };

  /// Public query — retrieve the configured RSS feed URLs.
  /// Returns the default list if nothing has been configured yet.
  public shared query ({ caller }) func getRssFeedUrls() : async [Text] {
    if (caller.isAnonymous()) return [];
    switch (rssFeedUrlsStore.get("urls")) {
      case (?urls) urls;
      case null ["https://www.espn.com/espn/rss/nfl/news"];
    };
  };

  /// Admin-only: set the RSS cache refresh interval in seconds.
  /// Minimum is 60 seconds. Clears the cache so the new interval takes effect.
  public shared ({ caller }) func setRssRefreshIntervalSecs(
    seconds : Nat,
  ) : async { #ok : (); #err : Text } {
    // Admin guard — centralized global admin check.
    if (not AdminAuthLib.isGlobalAdmin(adminPrincipalStore, caller)) {
      return #err "Only the admin can set the RSS refresh interval";
    };

    if (seconds < 60) return #err "Minimum refresh interval is 60 seconds";
    rssRefreshIntervalSecs.seconds := seconds;
    #ok ();
  };

  /// Public query — retrieve the configured RSS refresh interval in seconds.
  public shared query ({ caller }) func getRssRefreshIntervalSecs() : async Nat {
    if (caller.isAnonymous()) return 900;
    rssRefreshIntervalSecs.seconds;
  };

  /// Public query — per-feed outcome of the most recent RSS fetch.
  /// Each tuple is (feedUrl, succeeded). Returns [] for anonymous callers,
  /// consistent with getRssFeedUrls. On cache-hit returns, the previous real
  /// fetch's status is preserved (not overwritten).
  public shared query ({ caller }) func getLastRssFetchStatus() : async [(Text, Bool)] {
    if (caller.isAnonymous()) return [];
    lastRssFetchStatus.status;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Chat message reactions
  // ─────────────────────────────────────────────────────────────────────────

  public shared ({ caller }) func toggleMessageReaction(
    roomId    : Types.RoomId,
    messageId : Nat,
    emoji     : Text,
  ) : async { #ok : (); #err : Text } {
    switch (rooms.get(roomId)) {
      case null return #err "Room not found";
      case (?room) {
        if (not AuctionLib.isParticipant(room, caller)) return #err "Not in room";
        switch (roomMessages.get(roomId)) {
          case null return #err "Room has no messages";
          case (?msgList) {
            let total = msgList.size();
            var foundIdx : ?Nat = null;
            var i : Nat = 0;
            while (i < total) {
              if (msgList.at(i).id == messageId) {
                foundIdx := ?i;
                break;
              };
              i += 1;
            };
            switch (foundIdx) {
              case null return #err "Message not found";
              case (?idx) {
                let msg = msgList.at(idx);
                let newReactions = List.empty<(Text, [Types.UserId])>();
                var emojiFound = false;
                for ((existingEmoji, users) in msg.reactions.vals()) {
                  if (existingEmoji == emoji) {
                    emojiFound := true;
                    let userList = List.empty<Types.UserId>();
                    var callerFound = false;
                    for (u in users.vals()) {
                      if (Principal.equal(u, caller)) {
                        callerFound := true;
                      } else {
                        userList.add(u);
                      };
                    };
                    if (not callerFound) {
                      // Caller not in list — add them
                      let added = List.empty<Types.UserId>();
                      for (u in users.vals()) { added.add(u) };
                      added.add(caller);
                      newReactions.add((emoji, added.toArray()));
                    } else if (userList.size() > 0) {
                      // Caller was in list and others remain
                      newReactions.add((emoji, userList.toArray()));
                    };
                    // If caller was in list and no others remain, skip adding this emoji
                  } else {
                    newReactions.add((existingEmoji, users));
                  };
                };
                if (not emojiFound) {
                  newReactions.add((emoji, [caller]));
                };
                let updatedMsg : Types.ChatMessage = {
                  msg with reactions = newReactions.toArray();
                };
                let newMsgList = List.empty<Types.ChatMessage>();
                for (m in msgList.values()) {
                  if (m.id == messageId) {
                    newMsgList.add(updatedMsg);
                  } else {
                    newMsgList.add(m);
                  };
                };
                roomMessages.remove(roomId);
                roomMessages.add(roomId, newMsgList);
                #ok ();
              };
            };
          };
        };
      };
    };
  };

  public func fetchRssFeeds() : async Text {
    let nowSec = Int.abs(Time.now() / 1_000_000_000); // seconds
    let cacheAge = if (nowSec >= rssCacheTimestamp.timestamp) {
      Int.abs(nowSec : Int - rssCacheTimestamp.timestamp : Int)
    } else {
      0
    };
    if (cacheAge < rssRefreshIntervalSecs.seconds) {
      switch (rssCacheContent.content) {
        // Cache hit — preserve the previous real fetch's per-feed status.
        case (?cached) { return cached };
        case null {};
      };
    };

    let feedUrls = switch (rssFeedUrlsStore.get("urls")) {
      case (?urls) urls;
      case null ["https://www.espn.com/espn/rss/nfl/news"];
    };

    var combinedXml = "";
    var anySuccess = false;
    // Per-feed outcome of this fetch: (feedUrl, succeeded).
    // Populated as each feed is processed; stored into lastRssFetchStatus
    // right before returning, regardless of overall success.
    var fetchStatus : [(Text, Bool)] = [];

    for (url in feedUrls.vals()) {
      try {
        let body = await OutCall.httpGetRequest(url, [], transform);
        let trimmed = body.trimStart(#text " \n\r\t");
        let isValidRss = trimmed.contains(#text "<rss") or trimmed.contains(#text "<channel") or trimmed.contains(#text "<?xml");
        if (isValidRss and trimmed.size() > 0) {
          combinedXml := combinedXml # "\n\n" # body;
          anySuccess := true;
          fetchStatus := fetchStatus.concat([(url, true)]);
        } else {
          Debug.print("RSS feed skipped (empty or malformed): " # url);
          fetchStatus := fetchStatus.concat([(url, false)]);
        };
      } catch (e) {
        Debug.print("RSS feed failed: " # url # " — " # e.message());
        fetchStatus := fetchStatus.concat([(url, false)]);
      };
    };

    // Store the per-feed status of this real fetch right before returning.
    lastRssFetchStatus.status := fetchStatus;

    if (anySuccess) {
      rssCacheContent.content := ?combinedXml;
      rssCacheTimestamp.timestamp := nowSec;
      return combinedXml;
    } else {
      return "";
    };
  };

  public query func transform(raw : OutCall.TransformationInput) : async OutCall.TransformationOutput {
    return {
      raw.response with
      headers = [];
    };
  };
};
