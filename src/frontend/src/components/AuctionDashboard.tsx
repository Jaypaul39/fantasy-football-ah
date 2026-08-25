import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import confetti from "canvas-confetti";
import { Clock, PauseCircle, Trophy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAudio } from "../hooks/useAudio";
import { useAuth } from "../hooks/useAuth";
import type { ADPDataset } from "../lib/adp-types";
import { calculateEstimatedValues } from "../lib/auction-value";
import {
  AuctionState,
  NominationState,
  OVERCOMMIT_SAFEGUARD_MESSAGE,
  getAvailableBudget,
  getPrivateBudget,
  getReserveCeiling,
  getSpentBudget,
  getTotalBudget,
  isPrivateBudget,
} from "../types";
import type {
  NominationView,
  ParticipantView,
  RoomId,
  RoomView,
} from "../types";
import { NominationCard } from "./NominationCard";

interface AuctionDashboardProps {
  roomView: RoomView;
  roomId: RoomId;
  onNavigateToNominate?: () => void;
  isSpectator?: boolean;
  isAdmin?: boolean;
  /** ADP dataset — used to compute estimated auction values when rosterSettings are configured */
  adpDataset?: ADPDataset | null;
  /** Map of playerId -> byeWeek, fetched once per room. Used by NominationCard
   *  to surface a bye-week collision warning for the current user's roster. */
  playerByeWeeks?: Map<string, number>;
}

interface AwardNotification {
  id: string;
  playerName: string;
  winnerName: string;
  amount: bigint;
}

const MIN_BID_FALLBACK = BigInt(1);

export function AuctionDashboard({
  roomView,
  roomId,
  onNavigateToNominate,
  isSpectator = false,
  isAdmin = false,
  adpDataset,
  playerByeWeeks,
}: AuctionDashboardProps) {
  void isSpectator;
  void isAdmin;
  const { principal } = useAuth();
  const currentUserPrincipal = principal?.toText() ?? null;
  const { room, activeNominations, participants, myProxyBids } = roomView;
  const { playLeading, playExpired } = useAudio();

  // ── Estimated auction values ───────────────────────────────────────────────────
  const rosterSettings = room.rosterSettings;
  const numTeams = Number(room?.settings?.maxParticipants ?? 10);
  const totalBudget =
    room?.startingBudget != null ? Number(room.startingBudget) : 200;

  const estimatedValues = useMemo(() => {
    if (!rosterSettings || !adpDataset || adpDataset.entries.length === 0)
      return null;
    const players = adpDataset.entries
      .filter((e) => e.adp != null && e.position)
      .map((e) => ({
        name: e.name,
        position: e.position ?? "",
        adp: e.adp,
      }));
    if (players.length === 0) return null;
    const rs = {
      qb: Number(rosterSettings.qb),
      rb: Number(rosterSettings.rb),
      wr: Number(rosterSettings.wr),
      te: Number(rosterSettings.te),
      flex: Number(rosterSettings.flex),
      superflex: Number(rosterSettings.superflex),
      bench: Number(rosterSettings.bench),
      flexPositions: rosterSettings.flexPositions,
      superflexPositions: rosterSettings.superflexPositions,
    };
    const positions: string[] = [];
    return calculateEstimatedValues(
      players,
      rs,
      numTeams,
      totalBudget,
      positions,
    );
  }, [adpDataset, rosterSettings, numTeams, totalBudget]);

  const [awardNotifications, setAwardNotifications] = useState<
    AwardNotification[]
  >([]);
  // Track IDs of nominations that just appeared (to flash them in)
  const [newNomIds, setNewNomIds] = useState<Set<string>>(new Set());
  const prevNominationsRef = useRef<NominationView[]>([]);
  // Skeleton loaders only on first load — set to false after first data arrives
  const [initialLoading, setInitialLoading] = useState(true);
  const initialLoadDoneRef = useRef(false);

  // Refs for tracking previous values for audio / confetti
  const prevNominatorIdRef = useRef<string | null>(null);
  // Tracks notification IDs already processed (audio + confetti)
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());

  const minBidIncrement = room.settings.minBidIncrement ?? MIN_BID_FALLBACK;

  // Current user as participant
  const meParticipant = participants.find(
    (p) => currentUserPrincipal && p.userId.toText() === currentUserPrincipal,
  );
  const isParticipant = !!meParticipant;
  const myDisplayName = meParticipant?.displayName ?? null;

  // Extract available budget from the logged-in user's PRIVATE budget view.
  // The backend returns #private_ for the caller's own entry, so this is always accurate.
  // No frontend calculations — backend is the single source of truth.
  const myAvailableBudget: bigint = (() => {
    if (!meParticipant) return BigInt(0);
    const priv = getPrivateBudget(meParticipant.budgetView);
    if (priv) return priv.availableBudget;
    // Fallback: if somehow we only have a public view, use publicAvailableBudget
    return getAvailableBudget(meParticipant.budgetView);
  })();

  // Mark initial load complete after first activeNominations data arrives
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      setInitialLoading(false);
    }
  });

  // FIX 1a — Play sound when it becomes the current user's nomination turn
  useEffect(() => {
    const currentId = roomView.currentNominatorId?.toText() ?? null;
    const prevId = prevNominatorIdRef.current;

    // Only fire when it BECOMES the user's turn (transition, not every render)
    if (
      currentUserPrincipal != null &&
      currentId === currentUserPrincipal &&
      prevId !== currentUserPrincipal
    ) {
      playLeading();
    }

    prevNominatorIdRef.current = currentId;
  }, [roomView.currentNominatorId, currentUserPrincipal, playLeading]);

  // Detect new nominations (for entrance animation) and award notifications
  useEffect(() => {
    const prev = prevNominationsRef.current;
    const prevIds = new Set(prev.map((n) => n.id.toString()));

    // Detect brand-new nominations — mark them for entrance animation
    const incoming: string[] = [];
    for (const nom of activeNominations) {
      if (!prevIds.has(nom.id.toString())) {
        incoming.push(nom.id.toString());
      }
    }
    if (incoming.length > 0) {
      const ids = new Set(incoming);
      setNewNomIds(ids);
      // FIX 2 — cleanup after 600ms
      const t = setTimeout(() => setNewNomIds(new Set()), 600);
      prevNominationsRef.current = activeNominations;
      return () => clearTimeout(t);
    }

    // Detect nominations that just moved to Closed (no longer in activeNominations)
    const currentParticipants = participants;
    for (const prevNom of prev) {
      const isNowClosed = !activeNominations.find((n) => n.id === prevNom.id);
      if (
        isNowClosed &&
        prevNom.state === NominationState.Active &&
        prevNom.bidLeader
      ) {
        const leaderText = prevNom.bidLeader.toText();
        const winner = currentParticipants.find(
          (pt) => pt.userId.toText() === leaderText,
        );
        const winnerName =
          prevNom.bidLeaderName ??
          winner?.displayName ??
          `${leaderText.slice(0, 10)}…`;
        const notification: AwardNotification = {
          id: `${prevNom.id}-${Date.now()}`,
          playerName: prevNom.playerName,
          winnerName,
          amount: prevNom.currentBid,
        };
        setAwardNotifications((ns) => [...ns, notification]);
        setTimeout(() => {
          setAwardNotifications((ns) =>
            ns.filter((n) => n.id !== notification.id),
          );
        }, 5000);
      }
    }

    prevNominationsRef.current = activeNominations;
  }, [activeNominations, participants]);

  // FIX 1b + FIX 4 — Audio and confetti on award notifications
  useEffect(() => {
    for (const notification of awardNotifications) {
      if (seenNotificationIdsRef.current.has(notification.id)) continue;
      seenNotificationIdsRef.current.add(notification.id);

      const isMyWin =
        myDisplayName != null && notification.winnerName === myDisplayName;

      if (isMyWin) {
        // Current user won — large full-screen celebration burst
        playLeading();
        confetti({
          particleCount: 200,
          spread: 160,
          origin: { x: 0.5, y: 0.3 },
          zIndex: 9999,
        });
        setTimeout(() => {
          confetti({
            particleCount: 120,
            spread: 120,
            origin: { x: 0.35, y: 0.35 },
            zIndex: 9999,
          });
        }, 700);
        setTimeout(() => {
          confetti({
            particleCount: 80,
            spread: 100,
            origin: { x: 0.65, y: 0.4 },
            zIndex: 9999,
          });
        }, 1400);
      } else {
        // Someone else won — small ambient confetti + expired sound
        playExpired();
        confetti({
          particleCount: 40,
          spread: 60,
          origin: { x: 0.5, y: 0.5 },
          zIndex: 9999,
        });
      }
    }
  }, [awardNotifications, myDisplayName, playLeading, playExpired]);

  // Lookup nominator display name
  function getNominatorName(nom: NominationView): string {
    const p = participants.find(
      (pt) => pt.userId.toText() === nom.nominatedBy.toText(),
    );
    return p?.displayName ?? nom.nominatedBy.toText().slice(0, 10);
  }

  // Roster cap
  const maxRosterSize = (() => {
    const s = room.settings as unknown as { maxRosterSize?: bigint[] };
    if (s.maxRosterSize && s.maxRosterSize.length > 0) {
      return Number(s.maxRosterSize[0]);
    }
    return null;
  })();
  const myWonCount = meParticipant?.wonPlayers.length ?? 0;

  // ── Reserve ceiling ────────────────────────────────────────────────────────
  // The effective max bid is lower than availableBudget by the reserve amount
  // when a roster cap is set. Pre-computed here (where availableBudget is
  // computed) and passed down to NominationCard / BidPanel, mirroring the
  // existing availableBudget flow. maxRosterSize is number|null here; the
  // helper expects bigint|null, so convert at the call site.
  const maxRosterSizeBigInt =
    maxRosterSize != null ? BigInt(maxRosterSize) : null;
  const myReserveCeiling = getReserveCeiling(
    myAvailableBudget,
    maxRosterSizeBigInt,
    myWonCount,
  );

  // ── Over-commitment safeguard ──────────────────────────────────────────────
  // Count of active nominations the current user is currently leading. When the
  // user is already leading an active nomination, bidding on (and winning)
  // another player would grow their projected roster. The safeguard blocks
  // bidding on a *different* nomination when winning it too would exceed the
  // cap. Passed down so each NominationCard / BidPanel can surface the
  // OVERCOMMIT_SAFEGUARD_MESSAGE for nominations the user is NOT currently
  // leading.
  const myLeadingActiveNominations = currentUserPrincipal
    ? activeNominations.filter(
        (n) =>
          n.state === NominationState.Active &&
          n.bidLeader != null &&
          n.bidLeader.toText() === currentUserPrincipal,
      ).length
    : 0;

  const canNominate =
    isParticipant &&
    myAvailableBudget > BigInt(0) &&
    room.state === AuctionState.Active &&
    activeNominations.filter((n) => n.state === NominationState.Active).length <
      Number(room.settings.maxActivePicks);

  // State-based empty content
  const renderEmptyState = () => {
    if (room.state === AuctionState.Waiting) {
      return (
        <div
          className="flex flex-col items-center justify-center py-16 gap-3"
          data-ocid="auction-waiting-state"
        >
          <Clock className="w-12 h-12 text-muted-foreground/30" />
          <p className="font-display font-semibold text-foreground/70 text-lg">
            Waiting for auction to start
          </p>
          <p className="text-sm text-muted-foreground">
            The host will start the auction shortly.
          </p>
        </div>
      );
    }
    if (room.state === AuctionState.Paused) {
      return (
        <div
          className="flex flex-col items-center justify-center py-16 gap-3"
          data-ocid="auction-paused-state"
        >
          <PauseCircle className="w-12 h-12 text-amber-400/60" />
          <p className="font-display font-semibold text-foreground/70 text-lg">
            Auction Paused
          </p>
          <p className="text-sm text-muted-foreground">
            Waiting for the host to resume.
          </p>
        </div>
      );
    }
    if (room.state === AuctionState.Completed) {
      return <CompletedView participants={participants} />;
    }
    return (
      <div
        className="flex flex-col items-center justify-center py-16 gap-3"
        data-ocid="auction-no-nominations"
      >
        <span className="text-4xl" role="img" aria-label="Football">
          🏈
        </span>
        <p className="text-muted-foreground text-sm">
          Waiting for next nomination…
        </p>
        {canNominate && (
          <Button
            type="button"
            onClick={() => onNavigateToNominate?.()}
            className="bg-primary/15 hover:bg-primary/25 text-primary border border-primary/40 mt-2 transition-smooth"
            data-ocid="nominate-first-btn"
          >
            Nominate a Player
          </Button>
        )}{" "}
      </div>
    );
  };

  // Render ordering only — expiring soonest first. All other logic uses activeNominations.
  const sortedNominations = [...activeNominations].sort((a, b) =>
    Number(a.timerSecsRemaining - b.timerSecsRemaining),
  );

  return (
    <div className="flex flex-col gap-4" data-ocid="auction-dashboard">
      {/* Main column: nominations */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Award notifications */}
        {awardNotifications.length > 0 && (
          <div className="flex flex-col gap-2" data-ocid="award-notifications">
            {awardNotifications.map((n) => (
              <AwardNotificationBadge key={n.id} notification={n} />
            ))}
          </div>
        )}

        {/* Header bar */}
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
            Active Nominations
            {sortedNominations.length > 0 && (
              <span className="ml-1.5 text-primary">
                ({sortedNominations.length})
              </span>
            )}
          </h3>
          {canNominate && (
            <Button
              type="button"
              size="sm"
              onClick={() => onNavigateToNominate?.()}
              className="bg-primary/15 hover:bg-primary/25 text-primary border border-primary/40 text-xs transition-smooth"
              data-ocid="nominate-player-btn"
            >
              + Nominate Player
            </Button>
          )}
        </div>

        {/* Nomination cards — skeleton on first load, then live list */}
        {initialLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-64 w-full rounded-xl" />
            ))}
          </div>
        ) : sortedNominations.length === 0 ? (
          renderEmptyState()
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedNominations.map((nom) => (
              <div
                key={nom.id.toString()}
                className={cn(
                  // FIX 2 — duration-300 (was duration-400)
                  newNomIds.has(nom.id.toString()) &&
                    "animate-in fade-in slide-in-from-bottom-3 duration-300",
                )}
              >
                <NominationCard
                  participants={participants}
                  nomination={nom}
                  roomId={roomId}
                  auctionState={room.state}
                  currentUserPrincipal={currentUserPrincipal}
                  isParticipant={isParticipant}
                  availableBudget={myAvailableBudget}
                  myProxyBids={myProxyBids}
                  minBidIncrement={minBidIncrement}
                  nominatorName={getNominatorName(nom)}
                  imageUrl={
                    (nom as NominationView & { imageUrl?: string }).imageUrl ??
                    (nom.playerId
                      ? `https://sleepercdn.com/content/nfl/players/${nom.playerId}.jpg`
                      : undefined)
                  }
                  userWonCount={myWonCount}
                  maxRosterSize={maxRosterSize}
                  reserveCeiling={myReserveCeiling}
                  leadingActiveNominations={myLeadingActiveNominations}
                  bidTimerSecs={Number(room.settings.bidTimerSecs)}
                  estimatedValue={estimatedValues?.get(
                    nom.playerName.trim().toLowerCase(),
                  )}
                  playerByeWeeks={playerByeWeeks}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Award notification toast
function AwardNotificationBadge({
  notification,
}: {
  notification: AwardNotification;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-lg",
        "bg-secondary/10 border border-secondary/30",
        "animate-in fade-in slide-in-from-top-2 duration-300",
      )}
      data-ocid="award-notification"
      role="alert"
      aria-live="assertive"
    >
      <Trophy className="w-4 h-4 text-secondary shrink-0" />
      <p className="text-sm font-medium text-foreground">
        <span className="font-bold text-secondary">
          {notification.playerName}
        </span>
        {" awarded to "}
        <span className="font-bold text-foreground">
          {notification.winnerName}
        </span>
        {" for "}
        <span className="font-mono font-bold text-primary">
          ${notification.amount.toString()}
        </span>
      </p>
    </div>
  );
}

// Completed auction summary
function CompletedView({
  participants,
}: {
  participants: ParticipantView[];
}) {
  const sorted = [...participants].sort(
    (a, b) => Number(b.wonPlayers.length) - Number(a.wonPlayers.length),
  );
  return (
    <div
      className="rounded-xl border border-secondary/30 bg-card p-5 space-y-4"
      data-ocid="auction-completed-view"
    >
      <div className="flex items-center gap-2">
        <Trophy className="w-5 h-5 text-secondary" />
        <h3 className="font-display font-bold text-foreground">
          Auction Complete!
        </h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {sorted.map((p) => {
          // Always use backend-provided values via helpers — no frontend calculations
          const spent = getSpentBudget(p.budgetView);
          const total = getTotalBudget(p.budgetView);
          const available = getAvailableBudget(p.budgetView);
          const isOwnPrivate = isPrivateBudget(p.budgetView);
          return (
            <div
              key={p.userId.toText()}
              className="bg-muted/30 rounded-lg p-3 border border-border space-y-1"
            >
              <p className="font-semibold text-sm text-foreground truncate">
                {p.displayName}
              </p>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{p.wonPlayers.length} players</span>
                <div className="flex gap-2 font-mono">
                  <span className="text-secondary">
                    ${spent.toString()} spent
                  </span>
                  <span className="text-muted-foreground/60">
                    ${available < BigInt(0) ? "0" : available.toString()} left
                  </span>
                </div>
              </div>
              {/* Show total only as context — no committed values exposed */}
              {isOwnPrivate && (
                <p className="text-[10px] text-muted-foreground/50 font-mono">
                  of ${total.toString()} total
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
