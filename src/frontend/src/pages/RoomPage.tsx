import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronLeft,
  ClipboardList,
  Gavel,
  MessageCircle,
  Search,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ADPDataset as BackendADPDataset, Player } from "../backend.d.ts";
import { AuctionDashboard } from "../components/AuctionDashboard";
import { ChatPanel } from "../components/ChatPanel";
import DraftBoardTab from "../components/DraftBoardTab";
import { HostControls } from "../components/HostControls";
import { NewsTab } from "../components/NewsTab";
import NominateTab from "../components/NominateTab";
import { NominationTimerBanner } from "../components/NominationTimerBanner";
import { WaitingRoom } from "../components/WaitingRoom";
import { useAuth } from "../hooks/useAuth";
import { useBackend } from "../hooks/useBackend";
import {
  useMessages,
  useRoomPolling,
  useSendMessage,
} from "../hooks/useRoomPolling";
import type { ADPDataset } from "../lib/adp-types";
import {
  AuctionState,
  NominationState,
  getAvailableBudget,
  getPrivateBudget,
} from "../types";

type TabId = "auction" | "nominate" | "draft-board" | "chat" | "host-controls";

/** Inner component that has access to messages for unread tracking */
/** Inner component that has access to messages for unread tracking */
function RoomPageInner({ roomId }: { roomId: string }) {
  const { roomView, isLoading, error } = useRoomPolling(roomId);
  const { principal } = useAuth();
  const { actor } = useBackend();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const _sendMessage = useSendMessage(roomId);

  // ── ADP dataset for estimated auction values ──────────────────────────────
  const adpDatasetKey =
    roomView?.room?.settings?.adpDataset === "rookies" ||
    (roomView?.room?.playerFilter as { filterType?: string } | undefined)
      ?.filterType === "rookies"
      ? "rookies"
      : "all";

  const { data: backendADPDatasetForRoom } = useQuery<BackendADPDataset | null>(
    {
      queryKey: ["activeADPDataset", adpDatasetKey, roomId ?? "unknown"],
      queryFn: async () => {
        if (!actor) return null;
        try {
          if (adpDatasetKey === "rookies") {
            const result = await actor.getADPDatasetByType("rookies");
            if (result != null) return result;
          }
          return (await actor.getActiveADPDataset()) ?? null;
        } catch {
          return null;
        }
      },
      enabled: !!actor && roomView?.room?.rosterSettings != null,
      staleTime: 0,
    },
  );

  const adpDataset: ADPDataset | null =
    backendADPDatasetForRoom != null &&
    backendADPDatasetForRoom.entries.length > 0
      ? {
          entries: backendADPDatasetForRoom.entries.map((e) => ({
            name: e.name,
            adp: e.adp,
            position: e.position,
            team: e.team,
          })),
          importedAt: Number(backendADPDatasetForRoom.importedAt),
        }
      : null;

  // ── Player pool for Bye Week Warning ──────────────────────────────────────
  // Fetch the full player pool ONCE per room (empty queryText + positionFilter
  // returns all players eligible under the room's playerFilter). The pool is
  // static during an auction, so we cache it aggressively (5 min staleTime).
  // We build a Map<playerId, byeWeek> that NominationCard uses to surface a
  // bye-week collision warning for the current user's roster.
  const { data: playerPool } = useQuery<Player[]>({
    queryKey: ["playerPool", roomId],
    queryFn: async () => {
      if (!actor) return [];
      try {
        return await actor.getPlayersByRoom(roomId, "", "");
      } catch {
        return [];
      }
    },
    enabled: !!actor,
    staleTime: 300000,
  });

  const playerByeWeeks = useMemo(() => {
    const map = new Map<string, number>();
    if (!playerPool) return map;
    for (const p of playerPool) {
      // byeWeek is optional (?Nat) — players without a valid NFL team have
      // null/undefined and are excluded from the collision-warning map.
      if (p.byeWeek == null) continue;
      map.set(p.id, Number(p.byeWeek));
    }
    return map;
  }, [playerPool]);

  // ── Spectator mode detection ──────────────────────────────────────────────
  const isParticipant =
    principal != null &&
    roomView != null &&
    roomView.participants.some((p) => p.userId.toText() === principal.toText());
  const isSpectator =
    principal != null &&
    roomView != null &&
    !isParticipant &&
    (roomView.room.state === AuctionState.Active ||
      roomView.room.state === AuctionState.Paused);

  const [activeTab, setActiveTab] = useState<TabId>("auction");
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [chatView, setChatView] = useState<"chat" | "news">("chat");

  // ── Offline detection ─────────────────────────────────────────────────────
  const failureCountRef = useRef(0);
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    if (error) {
      failureCountRef.current += 1;
      if (failureCountRef.current >= 3) {
        setIsOffline(true);
      }
    } else if (roomView != null) {
      failureCountRef.current = 0;
      setIsOffline(false);
    }
  }, [error, roomView]);

  // ── Waiting room: start auction + countdown state ──────────────────────────
  const [isStarting, setIsStarting] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  // useRef guards — prevent duplicate system messages on re-renders
  const sentStartMsgRef = useRef(false);
  const sentStartedMsgRef = useRef(false);
  // Per-toggle dedup: track the last toggle timestamp to prevent double-fire
  const lastReadyToggleRef = useRef<number>(0);

  // Reset start guards when we leave waiting room (room becomes Active)
  // so they work if the room is ever reset
  const prevRoomStateRef = useRef<AuctionState | null>(null);
  useEffect(() => {
    if (!roomView) return;
    const newState = roomView.room.state;
    if (
      prevRoomStateRef.current === AuctionState.Waiting &&
      newState === AuctionState.Active
    ) {
      // Auction has started — reset flags for next time if needed
      sentStartMsgRef.current = false;
      sentStartedMsgRef.current = false;
    }
    prevRoomStateRef.current = newState;
  }, [roomView]);

  // Unread chat badge tracking
  const { messages, isLoading: isMessagesLoading } = useMessages(roomId);
  const [unreadCount, setUnreadCount] = useState(0);
  const [mentionCount, setMentionCount] = useState(0);
  const lastSeenCountRef = useRef<number | null>(null);
  const lastSeenTimestampRef = useRef<bigint>(BigInt(0));
  const isChatActive = activeTab === "chat";

  // Current user's display name (for mention detection)
  const myDisplayName = (() => {
    if (!roomView || !principal) return null;
    return (
      roomView.participants.find(
        (p) => p.userId.toText() === principal.toText(),
      )?.displayName ?? null
    );
  })();

  // When new messages arrive while NOT on Chat tab, increment unread count
  // Track by timestamp to avoid false positives from re-renders or array reindexing
  useEffect(() => {
    if (isMessagesLoading) return;
    // On first load: set baseline timestamp so there are no false unread counts
    if (lastSeenCountRef.current === null) {
      lastSeenCountRef.current = messages.length;
      const latest = messages[0]; // messages are newest-first from backend
      lastSeenTimestampRef.current = latest ? latest.timestamp : BigInt(0);
      return;
    }
    if (!isChatActive) {
      const newMessages = messages.filter(
        (msg) => msg.timestamp > lastSeenTimestampRef.current,
      );
      const otherUserMessages = newMessages.filter(
        (msg) =>
          msg.message.startsWith("SYSTEM:") ||
          principal == null ||
          msg.userId.toText() !== principal.toText(),
      );
      if (otherUserMessages.length > 0) {
        setUnreadCount((prev) => prev + otherUserMessages.length);
      }
      // Count messages that @mention the current user
      if (myDisplayName) {
        const mentionMessages = otherUserMessages.filter((msg) =>
          msg.message.includes(`@${myDisplayName}`),
        );
        if (mentionMessages.length > 0) {
          setMentionCount((prev) => prev + mentionMessages.length);
        }
      }
    }
    // Always advance the timestamp cursor
    const latest = messages[0]; // newest-first
    if (latest && latest.timestamp > lastSeenTimestampRef.current) {
      lastSeenTimestampRef.current = latest.timestamp;
    }
    lastSeenCountRef.current = messages.length;
  }, [messages, isChatActive, principal, myDisplayName, isMessagesLoading]);

  // When user switches to Chat tab, clear unread badge and advance timestamp cursor
  useEffect(() => {
    if (isChatActive) {
      setUnreadCount(0);
      setMentionCount(0);
      lastSeenCountRef.current = messages.length;
      const latest = messages[0]; // newest-first
      if (latest) lastSeenTimestampRef.current = latest.timestamp;
    }
  }, [isChatActive, messages]);

  // Nomination badge: show red dot on Nominate tab when it's the current user's turn and they're not on the nominate tab
  const isMyNominationTurn =
    roomView != null &&
    principal != null &&
    roomView.currentNominatorId != null &&
    roomView.currentNominatorId.toText() === principal.toText();
  const showNominateBadge = isMyNominationTurn && activeTab !== "nominate";

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["room", roomId] });
  };

  const handleTabClick = (id: TabId) => {
    setActiveTab(id);
  };

  // Check if any nomination is currently active before leaving
  const hasActiveNomination =
    roomView?.activeNominations.some(
      (n) => n.state === NominationState.Active,
    ) ?? false;

  const handleBackToRooms = () => {
    if (hasActiveNomination) {
      setShowLeaveDialog(true);
    } else {
      navigate({ to: "/" });
    }
  };

  // ── Ready toggle handler ────────────────────────────────────────────────────
  const handleReadyToggle = useCallback(async () => {
    if (!actor || !roomView) return;

    // Debounce: prevent double-fire within 1500ms
    const now = Date.now();
    if (now - lastReadyToggleRef.current < 1500) return;
    lastReadyToggleRef.current = now;

    const result = await actor.toggleReady(roomId);
    if (result.__kind__ === "err") return;

    // Refetch room state
    queryClient.invalidateQueries({ queryKey: ["room", roomId] });

    // System message: "[DisplayName] is ready"
    // Determine my display name from participants
    const me = roomView.participants.find(
      (p) => principal != null && p.userId.toText() === principal.toText(),
    );
    const _displayName = me?.displayName ?? "A participant";

    // Determine whether we just became ready (optimistically: if we WEREN'T ready before toggle)
    const _wasReady = roomView.room.readyParticipants.some(
      (rp) => principal != null && rp.toText() === principal.toText(),
    );

    // System message for ready status is generated by the backend
  }, [actor, roomId, roomView, principal, queryClient]);

  // ── Start auction handler (host only) ───────────────────────────────────────
  const handleStartAuction = useCallback(async () => {
    if (!actor || isStarting) return;

    // Prevent duplicate starts
    setIsStarting(true);

    // Step 1: call startAuction() backend
    try {
      await actor.startAuction(roomId);
    } catch {
      // Proceed with countdown even if startAuction fails (room may already be active)
    }

    // Step 3: frontend-only countdown 3 → 2 → 1 → 500ms pause → transition
    setCountdown(3);
    await new Promise<void>((resolve) => {
      let remaining = 3;
      const tick = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(tick);
          resolve();
        } else {
          setCountdown(remaining);
        }
      }, 1000);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Step 4: transition — clear countdown, room polling will now show Active
    setCountdown(null);
    setIsStarting(false);
    queryClient.invalidateQueries({ queryKey: ["room", roomId] });
  }, [actor, isStarting, roomId, queryClient]);

  if (isLoading && !roomView) {
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto">
        <Skeleton className="h-8 w-64 skeleton-shimmer" />
        <Skeleton className="h-10 w-full skeleton-shimmer" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-64 w-full skeleton-shimmer" />
            <Skeleton className="h-24 w-full skeleton-shimmer" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-48 w-full skeleton-shimmer" />
            <Skeleton className="h-48 w-full skeleton-shimmer" />
          </div>
        </div>
      </div>
    );
  }

  if (!roomView) {
    return (
      <div
        className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4"
        data-ocid="room-not-found"
      >
        <span className="text-5xl" role="img" aria-label="Football">
          🏈
        </span>
        <h2 className="font-display text-xl font-semibold text-foreground">
          Room not found
        </h2>
        <p className="text-muted-foreground text-sm">
          You may not be a participant, or the room ID is invalid.
        </p>
      </div>
    );
  }

  const { room, participants } = roomView;
  const isAdmin =
    principal != null && principal.toText() === room.admin.toText();

  // Redirect to auction tab if not admin and on host-controls tab
  const effectiveTab: TabId =
    activeTab === "host-controls" && !isAdmin ? "auction" : activeTab;

  // If spectator, force auction tab and hide host-controls
  const spectatorEffectiveTab: TabId = isSpectator ? "auction" : effectiveTab;

  // My budget for the header display
  const meParticipant = participants.find(
    (p) => principal != null && p.userId.toText() === principal.toText(),
  );
  const myBudget = (() => {
    if (!meParticipant) return null;
    const priv = getPrivateBudget(meParticipant.budgetView);
    if (priv) return priv.availableBudget;
    return getAvailableBudget(meParticipant.budgetView);
  })();

  // Build set of player IDs that are already nominated or awarded.
  // The authoritative source is the wonPlayers set across ALL participants —
  // every awarded player must be excluded from nomination even if a closed
  // nomination record was overwritten/corrupted by an ID collision. Active
  // nomination playerIds are kept so currently-open nominations still exclude
  // their player. completedNominations is intentionally NOT used because its
  // state can be contaminated; wonPlayers is the source of truth.
  const nominatedPlayerIds = new Set<string>([
    ...participants.flatMap((p) => p.wonPlayers.map((wp) => wp.playerId)),
    ...roomView.activeNominations.map((n) => n.playerId),
    ...roomView.draftedPlayerIds,
  ]);

  // Room bottom nav tabs
  const tabs: {
    id: TabId;
    label: string;
    icon: React.ReactNode;
    ocid: string;
    badge?: number;
    mentionAlert?: boolean;
    adminOnly?: boolean;
  }[] = [
    {
      id: "auction",
      label: "Auction",
      icon: <Gavel className="h-5 w-5" />,
      ocid: "room-nav-auction",
    },
    {
      id: "nominate",
      label: "Nominate",
      icon: <Search className="h-5 w-5" />,
      ocid: "room-nav-nominate",
      badge: showNominateBadge ? -1 : undefined, // -1 = red dot, no count
    },
    {
      id: "draft-board",
      label: "Draft Board",
      icon: <ClipboardList className="h-5 w-5" />,
      ocid: "room-nav-draft-board",
    },
    {
      id: "chat",
      label: "Chat",
      icon: <MessageCircle className="h-5 w-5" />,
      ocid: "room-nav-chat",
      badge: unreadCount,
      mentionAlert: mentionCount > 0,
    },
    ...(isAdmin
      ? [
          {
            id: "host-controls" as TabId,
            label: "Host",
            icon: <Settings className="h-5 w-5" />,
            ocid: "room-nav-host-controls",
            adminOnly: true,
          },
        ]
      : []),
  ];

  // ── Waiting Room branch ─────────────────────────────────────────────────────
  // Show waiting room when state is Waiting OR when isStarting (countdown in progress).
  // Never switch to auction UI while the countdown overlay is still running.
  if (room.state === AuctionState.Waiting || isStarting) {
    return (
      <div
        className="flex flex-col h-full animate-fade-in"
        data-ocid="room-dashboard-waiting"
      >
        {/* Persistent room header */}
        <div
          className="shrink-0 h-14 bg-card/70 backdrop-blur-md border-b border-border/50 flex items-center px-3 gap-2 z-10"
          data-ocid="room-header"
        >
          <button
            type="button"
            onClick={() => navigate({ to: "/" })}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors shrink-0 text-sm font-medium py-1 px-1.5 -ml-1 rounded hover:bg-muted/50"
            aria-label="Back to rooms lobby"
            data-ocid="room-back-btn"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden xs:inline">Rooms</span>
          </button>

          <div className="flex-1 min-w-0 text-center">
            <h2
              className="font-display font-bold text-base text-foreground truncate leading-tight"
              title={room.name}
            >
              {room.name}
            </h2>
            <p className="text-[10px] text-muted-foreground/70 leading-none mt-0.5 truncate">
              {Number(room.teamCount ?? participants.length)} Teams
              {" • "}
              {room.leagueFormat
                ? room.leagueFormat.charAt(0).toUpperCase() +
                  room.leagueFormat.slice(1)
                : room.rosterSettings &&
                    Number(room.rosterSettings.superflex) > 0
                  ? "Superflex"
                  : "Redraft"}
              {" • $"}
              {Number(room.startingBudget)} Budget
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground font-mono">
            <span
              className="hidden sm:inline bg-muted/50 rounded px-1.5 py-0.5"
              title="Participants"
            >
              {participants.length}/
              {Number(room.settings.maxParticipants ?? 12)}
            </span>
          </div>
        </div>

        {/* Waiting room body: participant list | chat */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden pb-0">
          {/* Left/top: waiting room participant list + controls */}
          <div className="flex-1 min-h-0 overflow-y-auto lg:max-w-md lg:border-r lg:border-border/60">
            <WaitingRoom
              roomView={roomView}
              myPrincipal={principal}
              isHost={isAdmin}
              isStarting={isStarting}
              countdown={countdown}
              onReadyToggle={handleReadyToggle}
              onStartAuction={handleStartAuction}
              roomId={room.id}
            />
          </div>

          {/* Right/bottom: shared ChatPanel — same instance tied to roomId */}
          <div
            className="flex-1 min-h-0 flex flex-col border-t border-border/60 lg:border-t-0"
            style={{ minHeight: "300px" }}
            data-ocid="waiting-room-chat"
          >
            <ChatPanel
              roomId={room.id}
              participants={roomView.participants}
              currentUserDisplayName={myDisplayName}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Auction / Paused / Completed branches — unchanged ──────────────────────
  return (
    <div
      className="flex flex-col h-full animate-fade-in"
      data-ocid="room-dashboard"
    >
      {/* ── Persistent room header ── */}
      <div
        className="shrink-0 h-14 bg-card/70 backdrop-blur-md border-b border-border/50 flex items-center px-3 gap-2 z-10"
        data-ocid="room-header"
      >
        {/* Back to Rooms */}
        <button
          type="button"
          onClick={handleBackToRooms}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors shrink-0 text-sm font-medium py-1 px-1.5 -ml-1 rounded hover:bg-muted/50"
          aria-label="Back to rooms lobby"
          data-ocid="room-back-btn"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="hidden xs:inline">Rooms</span>
        </button>

        {/* Room name + metadata */}
        <div className="flex-1 min-w-0 text-center">
          <h2
            className="font-display font-bold text-base text-foreground truncate leading-tight"
            title={room.name}
          >
            {room.name}
          </h2>
          <p className="text-[10px] text-muted-foreground/70 leading-none mt-0.5 truncate">
            {Number(room.teamCount ?? participants.length)} Teams
            {" • "}
            {room.leagueFormat
              ? room.leagueFormat.charAt(0).toUpperCase() +
                room.leagueFormat.slice(1)
              : room.rosterSettings && Number(room.rosterSettings.superflex) > 0
                ? "Superflex"
                : "Redraft"}
            {" • $"}
            {Number(room.startingBudget)} Budget
          </p>
        </div>

        {/* Right info: participant count + my budget */}
        <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground font-mono">
          <span
            className="hidden sm:inline bg-muted/50 rounded px-1.5 py-0.5"
            title="Participants"
          >
            {participants.length}/{Number(room.settings.maxParticipants ?? 12)}
          </span>
          {myBudget != null && (
            <span
              className="bg-primary/10 text-primary rounded px-1.5 py-0.5 font-semibold"
              title="Your available budget"
            >
              ${myBudget.toString()}
            </span>
          )}
        </div>
      </div>

      {/* ── Offline banner ── */}
      {isOffline && (
        <div
          className="shrink-0 px-4 py-2 bg-destructive/10 border-b border-destructive/30 text-center"
          data-ocid="room-offline-banner"
        >
          <p className="text-xs text-destructive font-medium">
            Connection lost — reconnecting…
          </p>
        </div>
      )}

      {/* ── Tab content — scrollable, clears room bottom nav ── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin pb-20 animate-in fade-in duration-150">
        {/* NominationTimerBanner renders once above all tab content — never remounts on tab switch */}
        {effectiveTab !== "host-controls" && (
          <NominationTimerBanner
            roomView={roomView}
            actor={actor}
            roomId={roomId}
            queryClient={queryClient}
            nominationId={roomView.activeNominations[0]?.id ?? null}
          />
        )}

        {/* Spectator banner */}
        {isSpectator && (
          <div
            className="shrink-0 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-center"
            data-ocid="spectator-banner"
          >
            <p className="text-xs text-amber-400 font-medium">
              👁 Spectating — read-only mode
            </p>
          </div>
        )}

        {spectatorEffectiveTab === "auction" && (
          <div className="pt-4 px-4 sm:pt-6 sm:px-6 max-w-5xl mx-auto pb-44">
            <AuctionDashboard
              roomView={roomView}
              roomId={room.id}
              onNavigateToNominate={() => setActiveTab("nominate")}
              isSpectator={isSpectator}
              isAdmin={isAdmin}
              adpDataset={adpDataset}
              playerByeWeeks={playerByeWeeks}
            />
          </div>
        )}

        {effectiveTab === "nominate" && (
          <div
            className="flex flex-col"
            style={{ height: "calc(100dvh - 7.5rem)" }}
            data-ocid="nominate-tab-panel"
          >
            <NominateTab
              roomView={roomView}
              roomId={room.id}
              myPrincipal={principal}
              nominatedPlayerIds={nominatedPlayerIds}
              playerFilter={room.playerFilter}
              onNavigateToAuction={() => setActiveTab("auction")}
            />
          </div>
        )}

        {spectatorEffectiveTab === "draft-board" && (
          <div data-ocid="draft-board-tab-panel">
            <DraftBoardTab
              roomView={roomView}
              participants={participants}
              activeNominations={roomView.activeNominations}
              myPrincipal={principal}
              adminId={room.admin}
              roomId={room.id}
              isAdmin={isAdmin}
            />
          </div>
        )}

        {effectiveTab === "chat" && (
          <div
            className="flex-1 min-h-0 h-full pb-16"
            style={{ minHeight: "calc(100dvh - 14rem)" }}
          >
            {/* Nested Chat | News toggle */}
            <div className="flex items-center justify-center gap-1 px-4 pt-3 pb-2">
              <button
                type="button"
                onClick={() => setChatView("chat")}
                data-ocid="chat-view-chat-tab"
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  chatView === "chat"
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "text-muted-foreground hover:text-foreground border border-transparent hover:bg-muted/50"
                }`}
              >
                Chat
              </button>
              <button
                type="button"
                onClick={() => setChatView("news")}
                data-ocid="chat-view-news-tab"
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  chatView === "news"
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "text-muted-foreground hover:text-foreground border border-transparent hover:bg-muted/50"
                }`}
              >
                News
              </button>
            </div>

            {chatView === "chat" ? (
              <div className="h-full">
                <ChatPanel
                  roomId={room.id}
                  participants={roomView.participants}
                  currentUserDisplayName={myDisplayName}
                />
              </div>
            ) : (
              <div className="h-full px-4 pb-4">
                <NewsTab />
              </div>
            )}
          </div>
        )}

        {spectatorEffectiveTab === "host-controls" && isAdmin && (
          <div
            className="p-4 sm:p-6 max-w-5xl mx-auto"
            data-ocid="host-controls-tab-panel"
          >
            <div className="bg-card border border-border/60 rounded-xl p-5 space-y-2">
              <div className="flex items-center gap-2 mb-4">
                <Settings className="w-4 h-4 text-primary" />
                <h3 className="font-display font-semibold text-base text-foreground">
                  Host Controls
                </h3>
              </div>
              <HostControls
                roomId={room.id}
                state={room.state}
                settings={room.settings}
                participants={participants}
                onRefresh={handleRefresh}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Room bottom navigation ── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 h-16 bg-background/40 backdrop-blur-xl backdrop-saturate-150 border-t border-white/10 flex items-stretch"
        data-ocid="room-bottom-nav"
        aria-label="Room navigation"
      >
        {tabs.map(({ id, label, icon, ocid, badge, mentionAlert }) => {
          const active = effectiveTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleTabClick(id)}
              data-ocid={ocid}
              aria-label={label}
              aria-selected={active}
              role="tab"
              className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span
                className={`flex flex-col items-center gap-0.5 rounded-lg px-2 py-1 transition-colors ${
                  active ? "bg-primary/10" : ""
                }`}
              >
                {active && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-primary transition-all duration-200" />
                )}
                <span className="relative">
                  {icon}
                  {badge != null && badge > 0 && (
                    <span
                      className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground flex items-center justify-center px-0.5 leading-none"
                      aria-label={`${badge} unread messages`}
                      data-ocid="chat-unread-badge"
                    >
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                  {mentionAlert && badge != null && badge > 0 && (
                    <span
                      className="absolute -top-2.5 -right-1 text-[8px] font-bold text-primary"
                      aria-label="You were mentioned"
                      data-ocid="chat-mention-indicator"
                    >
                      @
                    </span>
                  )}
                  {badge === -1 && (
                    <span
                      className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-destructive"
                      aria-label="Your turn to nominate"
                      data-ocid="nominate-turn-badge"
                    />
                  )}
                </span>
                <span className="text-[10px] font-medium leading-none">
                  {label}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      {/* ── Leave confirmation dialog ── */}
      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent
          className="bg-card border-border"
          data-ocid="leave-auction-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-foreground">
              Leave auction?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              You can rejoin anytime. Your bids and nominations will remain
              active while you&apos;re away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="border-border text-muted-foreground"
              data-ocid="leave-dialog-stay-btn"
            >
              Stay
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => navigate({ to: "/" })}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              data-ocid="leave-dialog-leave-btn"
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = useParams({ from: "/room/$roomId" });
  return <RoomPageInner roomId={roomId} />;
}
