import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BidHistoryEventType } from "../backend";
import type { ParticipantView } from "../backend";
import type { BidHistoryEvent } from "../backend.d.ts";
import { useNewsDisplayPreference } from "../hooks/useNewsDisplayPreference";
import { useNflNews } from "../hooks/useNflNews";
import { useNominationHistory } from "../hooks/useRoomPolling";
import { useValueDisplayPreference } from "../hooks/useValueDisplayPreference";
import type { NewsItem } from "../lib/rss-parser";
import { relativeTime } from "../lib/time-utils";
import type { AuctionState, NominationView, ProxyBid, RoomId } from "../types";
import { NominationState, OVERCOMMIT_SAFEGUARD_MESSAGE } from "../types";
import { AvatarThumb } from "./AvatarThumb";
import { BidPanel } from "./BidPanel";
import { CountdownTimer } from "./CountdownTimer";

function formatTimestamp(ts: bigint): string {
  // Backend timestamps are in nanoseconds — convert to ms for Date
  const ms = Number(ts / BigInt(1_000_000));
  const date = new Date(ms);
  const now = Date.now();
  const diffS = Math.floor((now - date.getTime()) / 1000);
  if (diffS < 5) return "just now";
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  return `${Math.floor(diffM / 60)}h ago`;
}

function eventLabel(event: BidHistoryEvent): string {
  switch (event.eventType) {
    case BidHistoryEventType.nominationCreated:
      return `${event.displayName} nominated ${event.playerName} for $${event.amount.toString()}`;
    case BidHistoryEventType.leaderChanged:
      return `${event.displayName} is now leading at $${event.amount.toString()}`;
    case BidHistoryEventType.nominationEnded:
      return `${event.displayName} won ${event.playerName} for $${event.amount.toString()}`;
  }
}

function eventColor(eventType: BidHistoryEventType): string {
  switch (eventType) {
    case BidHistoryEventType.nominationCreated:
      return "text-primary/80";
    case BidHistoryEventType.leaderChanged:
      return "text-secondary/90";
    case BidHistoryEventType.nominationEnded:
      return "text-amber-400/90";
  }
}

function matchNewsToPlayer(
  newsItems: NewsItem[],
  playerName: string,
): NewsItem[] {
  const parts = playerName.trim().split(/\s+/);
  const firstName = parts[0]?.toLowerCase() ?? "";
  const lastName = parts.slice(1).join(" ").toLowerCase() ?? "";
  const fullName = playerName.toLowerCase();

  const scored = newsItems.map((item) => {
    const text = `${item.headline} ${item.description}`.toLowerCase();

    // Priority 1 — full name match
    if (text.includes(fullName)) return { item, score: 3 };

    // Priority 2 — first + last name match (both must be present)
    if (
      firstName &&
      lastName &&
      text.includes(firstName) &&
      text.includes(lastName)
    ) {
      return { item, score: 2 };
    }

    // Priority 3 — last name only (length >= 6 to avoid false matches)
    if (lastName.length >= 6 && text.includes(lastName)) {
      return { item, score: 1 };
    }

    return { item, score: 0 };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}

interface PlayerNewsSectionProps {
  playerName: string;
}

function PlayerNewsSection({ playerName }: PlayerNewsSectionProps) {
  const { newsItems, isLoading } = useNflNews();
  // Local-only expanded state — no persistence, no backend changes.
  // Default expanded per requirement.
  const [isExpanded, setIsExpanded] = useState(true);

  const matched = useMemo(
    () => matchNewsToPlayer(newsItems, playerName).slice(0, 3),
    [newsItems, playerName],
  );

  const newsCount = matched.length;
  const toggleLabel = `${isExpanded ? "▼" : "▶"} Recent News (${newsCount})`;

  // Loading state: keep header collapsible but show skeletons when expanded.
  if (isLoading) {
    return (
      <div data-ocid="player-news-loading">
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          className="w-full flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider font-semibold hover:text-foreground transition-colors py-0.5"
          data-ocid="player-news-toggle"
          aria-expanded={isExpanded}
        >
          <span>{toggleLabel}</span>
        </button>
        {isExpanded && (
          <div className="space-y-2 mt-1.5 overflow-hidden">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-10 bg-white/5 rounded-lg animate-pulse"
                data-ocid={`player-news-skeleton.item.${i}`}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Empty state: keep header collapsible; show "no news" message when expanded.
  if (matched.length === 0) {
    return (
      <div data-ocid="player-news-empty_state">
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          className="w-full flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider font-semibold hover:text-foreground transition-colors py-0.5"
          data-ocid="player-news-toggle"
          aria-expanded={isExpanded}
        >
          <span>{toggleLabel}</span>
        </button>
        {isExpanded && (
          <p className="text-xs text-muted-foreground/60 mt-1.5">
            No news found for {playerName}.
          </p>
        )}
      </div>
    );
  }

  return (
    <div data-ocid="player-news-section">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider font-semibold hover:text-foreground transition-colors py-0.5"
        data-ocid="player-news-toggle"
        aria-expanded={isExpanded}
      >
        <span>{toggleLabel}</span>
      </button>
      {/* Smooth expand/collapse via grid-rows transition (animates height
          without measuring scrollHeight, no layout thrash). */}
      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          isExpanded
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 mt-1.5">
            {matched.map((item, index) => (
              <a
                key={item.link}
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/15 rounded-lg p-2.5 transition-colors group"
                data-ocid={`player-news.item.${index + 1}`}
              >
                <p className="text-xs font-medium text-foreground group-hover:text-primary transition-colors line-clamp-2 leading-snug">
                  {item.headline}
                </p>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] text-muted-foreground/70">
                    {item.source}
                  </span>
                  <span className="text-[10px] text-muted-foreground/40">
                    •
                  </span>
                  <span className="text-[10px] text-muted-foreground/50">
                    {relativeTime(item.timestamp)}
                  </span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
function positionClass(pos: string): string {
  switch (pos) {
    case "QB":
      return "bg-red-500/20 text-red-400 border-red-500/30";
    case "RB":
      return "bg-green-500/20 text-green-400 border-green-500/30";
    case "WR":
      return "bg-blue-400/20 text-blue-400 border-blue-500/30";
    case "TE":
      return "bg-orange-500/20 text-orange-400 border-orange-500/30";
    case "K":
      return "bg-purple-500/20 text-purple-400 border-purple-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

interface PlayerAvatarProps {
  url?: string;
  name: string;
  position: string;
}

function PlayerAvatar({ url, name, position }: PlayerAvatarProps) {
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("");

  const fallbackClass = cn(
    "w-16 h-16 rounded-lg flex items-center justify-center border font-display font-bold text-lg shrink-0",
    positionClass(position),
  );

  if (url) {
    return (
      <>
        <img
          src={url}
          alt={name}
          className="w-16 h-16 rounded-lg object-cover object-top border border-border shrink-0"
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = "none";
            const fallback = el.nextElementSibling as HTMLElement | null;
            if (fallback) fallback.style.display = "flex";
          }}
        />
        <div style={{ display: "none" }} className={fallbackClass}>
          {initials}
        </div>
      </>
    );
  }

  return <div className={fallbackClass}>{initials}</div>;
}

interface NominationCardProps {
  nomination: NominationView;
  roomId: RoomId;
  auctionState: AuctionState;
  currentUserPrincipal: string | null;
  isParticipant: boolean;
  /**
   * The logged-in user's available budget, sourced from their private budget view.
   * Pre-computed by AuctionDashboard from budgetView.private.availableBudget.
   * No frontend calculations in this component.
   */
  availableBudget: bigint;
  myProxyBids: ProxyBid[];
  minBidIncrement: bigint;
  nominatorName: string;
  /** Player image URL — from nomination.imageUrl (backend) or Sleeper CDN */
  imageUrl?: string;
  /** @deprecated — use imageUrl instead */
  headshotUrl?: string;
  /** @deprecated — history is now fetched internally via useNominationHistory */
  bidHistoryEntries?: unknown[];
  /** Roster cap enforcement */
  userWonCount?: number;
  maxRosterSize?: number | null;
  /**
   * Reserve-adjusted max bid — the effective ceiling on what the current user
   * can commit to a single nomination without losing the ability to fill the
   * rest of their roster. Pre-computed by AuctionDashboard via
   * getReserveCeiling(availableBudget, maxRosterSize, wonPlayersCount) and
   * passed down, mirroring the availableBudget flow. When maxRosterSize is
   * unset this equals availableBudget.
   */
  reserveCeiling?: bigint;
  /**
   * Count of active nominations the current user is currently leading. Used to
   * surface the OVERCOMMIT_SAFEGUARD_MESSAGE when bidding on a *different*
   * nomination would push the user's projected roster over the cap.
   */
  leadingActiveNominations?: number;
  /** Full bid timer duration in seconds — used to calculate urgency glow percentage */
  bidTimerSecs: number;
  /** Estimated auction value (dollars) — only shown when room.rosterSettings is configured */
  estimatedValue?: number;
  /** Full participant list so the card can look up bid-leader avatar */
  participants?: ParticipantView[];
  /**
   * Optional map of playerId → bye week number, used to surface an informational
   * warning when drafting the nominated player would cluster multiple roster
   * players on the same bye week. Purely advisory — never affects auction logic.
   */
  playerByeWeeks?: Map<string, number>;
}

export const NominationCard = memo(function NominationCard({
  nomination,
  roomId,
  auctionState,
  currentUserPrincipal,
  isParticipant,
  availableBudget,
  myProxyBids,
  minBidIncrement,
  nominatorName,
  imageUrl,
  headshotUrl,
  userWonCount,
  maxRosterSize,
  reserveCeiling,
  leadingActiveNominations,
  bidTimerSecs,
  estimatedValue,
  participants,
  playerByeWeeks,
}: NominationCardProps) {
  const queryClient = useQueryClient();
  const { showEstimatedValues } = useValueDisplayPreference();
  const { showNewsOnCards } = useNewsDisplayPreference();

  // leader lookup for avatar
  const leaderParticipant = useMemo(() => {
    if (!nomination.bidLeader) return undefined;
    const leaderText = nomination.bidLeader.toText();
    return participants?.find((p) => p.userId.toText() === leaderText);
  }, [nomination.bidLeader, participants]);

  const isActive = nomination.state === NominationState.Active;
  const isClosed =
    nomination.state === NominationState.Closed ||
    nomination.state === NominationState.Expired;

  const isLeader =
    currentUserPrincipal != null &&
    nomination.bidLeader != null &&
    nomination.bidLeader.toText() === currentUserPrincipal;

  // ── Over-commitment safeguard ──────────────────────────────────────────────
  // The user is blocked from bidding on THIS nomination when:
  //  - a roster cap is set, AND
  //  - the user is NOT currently leading this nomination (so winning it would
  //    add a new player to their roster), AND
  //  - the user is already leading at least one other active nomination, AND
  //  - winning this nomination too would push their projected roster over the
  //    cap (won + other active leads + this win > cap).
  // When blocked, surface OVERCOMMIT_SAFEGUARD_MESSAGE on the card and pass
  // the blocked flag down to BidPanel so it can disable bidding and show the
  // same message inline.
  const myWonCount = userWonCount ?? 0;
  const overcommitBlocked =
    maxRosterSize != null &&
    !isLeader &&
    (leadingActiveNominations ?? 0) > 0 &&
    myWonCount + (leadingActiveNominations ?? 0) + 1 > maxRosterSize;

  // ── Bid status badge ─────────────────────────────────────────────────────
  const bidStatus = useMemo<"winning" | "outbid" | null>(() => {
    if (!currentUserPrincipal) return null;

    const isWinning =
      nomination.bidLeader != null &&
      nomination.bidLeader.toText() === currentUserPrincipal;

    if (isWinning) return "winning";

    const hasProxyBid = myProxyBids.some(
      (pb) => pb.nominationId.toString() === nomination.id.toString(),
    );

    if (hasProxyBid) return "outbid";

    return null;
  }, [nomination.bidLeader, nomination.id, myProxyBids, currentUserPrincipal]);

  // ── Bye week warning ──────────────────────────────────────────────────────
  // Informational only: surfaces when drafting this player would give the
  // current user 3+ roster players sharing the same bye week. Never affects
  // bidding, proxy bids, or any auction logic.
  const byeWeekWarning = useMemo<{
    count: number;
    byeWeek: number;
  } | null>(() => {
    if (!playerByeWeeks || playerByeWeeks.size === 0) return null;

    const nominatedByeWeek = playerByeWeeks.get(nomination.playerId);
    if (nominatedByeWeek == null) return null;

    if (!currentUserPrincipal || !participants) return null;

    const meParticipant = participants.find(
      (p) => p.userId.toText() === currentUserPrincipal,
    );
    if (!meParticipant) return null;

    let sharedCount = 0;
    for (const wonPlayer of meParticipant.wonPlayers) {
      const bye = playerByeWeeks.get(wonPlayer.playerId);
      if (bye != null && bye === nominatedByeWeek) {
        sharedCount += 1;
      }
    }

    // +1 for the nominated player itself
    const total = sharedCount + 1;

    if (total >= 3) {
      return { count: total, byeWeek: nominatedByeWeek };
    }
    return null;
  }, [nomination.playerId, participants, playerByeWeeks, currentUserPrincipal]);

  // Leader display: always from server state only
  const leaderDisplay =
    nomination.bidLeaderName ??
    (nomination.bidLeader
      ? `${nomination.bidLeader.toText().slice(0, 10)}…`
      : null);

  // Awarded winner display (for closed nominations)
  const awardedTo = isClosed ? leaderDisplay : null;

  // BidPanel is ALWAYS shown for active participants while nomination is active.
  const showBidPanel = isParticipant && isActive;

  const [bidHistoryOpen, setBidHistoryOpen] = useState(false);

  // ── DIAGNOSTIC LOGGING ── (removed)
  // ── END DIAGNOSTIC LOGGING ──

  // Fetch bid history events from backend — event-based, not polling-diff
  const { events } = useNominationHistory(nomination.id, roomId);

  // Sort descending: newest first
  const sortedEvents = [...events].sort((a, b) =>
    b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0,
  );

  // Auto-bid beat toast — fires ONCE per auto-bid leaderChanged event where current user was outbid
  const lastSeenAutoBidTimestampRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (!currentUserPrincipal) return;

    // isAutoBid is a new backend field — cast to access it safely
    type EventWithAutoBid = BidHistoryEvent & { isAutoBid?: boolean };

    // Find the most recent leaderChanged event where auto-bid fired
    // and the new leader is someone other than the current user
    const autoBidEvents = (sortedEvents as EventWithAutoBid[]).filter(
      (e) =>
        e.eventType === BidHistoryEventType.leaderChanged &&
        e.isAutoBid === true &&
        e.userId.toText() !== currentUserPrincipal,
    );

    if (autoBidEvents.length === 0) return;

    const latest = autoBidEvents[0]; // newest first

    // Only fire if current user HAS a proxy bid on this nomination
    // (they were in the running before being outbid)
    const hasMyProxyBid = myProxyBids.some(
      (pb) => pb.nominationId.toString() === nomination.id.toString(),
    );

    if (
      hasMyProxyBid &&
      latest.timestamp !== lastSeenAutoBidTimestampRef.current
    ) {
      lastSeenAutoBidTimestampRef.current = latest.timestamp;
      toast("Your max bid was beaten by another bidder\u2019s auto-bid", {
        description: "Consider raising your max bid to stay in the lead.",
        duration: 6000,
      });
    }
  }, [sortedEvents, currentUserPrincipal, myProxyBids, nomination.id]);

  // Animated bid count-up: animates from previous value to new value over 200ms
  const [animatedBid, setAnimatedBid] = useState<number>(
    Number(nomination.currentBid),
  );
  const prevBidForAnimRef = useRef<number>(Number(nomination.currentBid));
  const animFrameRef = useRef<number | null>(null);
  const isFirstRenderRef = useRef(true);

  useEffect(() => {
    const newBid = Number(nomination.currentBid);

    // Do not animate on first render — show value immediately
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      prevBidForAnimRef.current = newBid;
      setAnimatedBid(newBid);
      return;
    }

    const prevBid = prevBidForAnimRef.current;

    // Only animate upward; if same or decreased, set immediately
    if (newBid <= prevBid) {
      prevBidForAnimRef.current = newBid;
      setAnimatedBid(newBid);
      return;
    }

    prevBidForAnimRef.current = newBid;

    // Cancel any in-progress animation
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
    }

    const startTime = performance.now();
    const duration = 200;
    const startValue = prevBid;
    const endValue = newBid;

    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Linear easing
      const current = Math.round(
        startValue + (endValue - startValue) * progress,
      );
      setAnimatedBid(current);
      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(tick);
      } else {
        animFrameRef.current = null;
      }
    }

    animFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [nomination.currentBid]);

  // Pulse flash when bid changes (legacy visual cue — kept for brief highlight)
  const [isBidPulsing, setIsBidPulsing] = useState(false);
  const prevBidRef = useRef(nomination.currentBid);
  useEffect(() => {
    if (nomination.currentBid !== prevBidRef.current) {
      prevBidRef.current = nomination.currentBid;
      setIsBidPulsing(true);
      const t = setTimeout(() => setIsBidPulsing(false), 800);
      return () => clearTimeout(t);
    }
  }, [nomination.currentBid]);

  // Urgency glow: track locally-ticking seconds from CountdownTimer via onTick
  const [displayedSecs, setDisplayedSecs] = useState(
    Number(nomination.timerSecsRemaining),
  );
  // Sync to server authoritative value on each poll (handles extensions, pause/resume)
  useEffect(() => {
    setDisplayedSecs(Number(nomination.timerSecsRemaining));
  }, [nomination.timerSecsRemaining]);

  const timerPct =
    bidTimerSecs > 0 ? (displayedSecs / bidTimerSecs) * 100 : 100;

  // FIX 5 — Urgent timer: < 10 seconds remaining
  const timerSecs =
    typeof nomination.timerSecsRemaining === "bigint"
      ? Number(nomination.timerSecsRemaining)
      : (nomination.timerSecsRemaining as number);
  const isUrgent = isActive && timerSecs > 0 && timerSecs < 10;

  return (
    <div
      className={cn(
        "bg-white/5 backdrop-blur-sm rounded-xl border border-white/10 p-4 space-y-3 transition-smooth relative overflow-hidden animate-fade-in",
        isLeader && "border-accent/60 shadow-[0_0_20px_rgba(236,72,153,0.15)]",
        !isLeader && isActive && !isUrgent && "border-primary/50",
        isClosed && "border-border/40 opacity-65",
        // Urgent red border glow when timer < 10s
        isUrgent && "border-red-500 shadow-red-500/50 shadow-md",
        // Urgency glow tied to timer percentage (cyan, scales as timer runs down)
        isActive && !isUrgent && timerPct > 70 && "glow-urgency-low",
        isActive &&
          !isUrgent &&
          timerPct <= 70 &&
          timerPct > 40 &&
          "glow-urgency-medium",
        isActive &&
          !isUrgent &&
          timerPct <= 40 &&
          timerPct > 15 &&
          "glow-urgency-high",
      )}
      data-ocid="nomination-card"
    >
      {/* Timer — top right */}
      <div className="absolute top-3 right-3">
        {/* FIX 5 — apply pulse-neon to timer element when urgent */}
        <div className={cn(isUrgent && "pulse-neon")}>
          <CountdownTimer
            timerSecsRemaining={nomination.timerSecsRemaining}
            isActive={isActive}
            auctionState={auctionState}
            onTick={setDisplayedSecs}
            onExpire={() =>
              queryClient.invalidateQueries({ queryKey: ["room", roomId] })
            }
          />
        </div>
      </div>

      {/* Player info row */}
      <div className="flex items-start gap-3 pr-20">
        <PlayerAvatar
          url={imageUrl || headshotUrl}
          name={nomination.playerName}
          position={nomination.position}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-foreground text-base leading-tight truncate">
              {nomination.playerName}
            </h3>
            {/* Bid status badge — updates on every poll */}
            {bidStatus === "winning" && (
              <span
                className="bg-green-500/20 text-green-400 border border-green-500/40 text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                data-ocid="nomination-status-winning"
              >
                Winning
              </span>
            )}
            {(() => {
              const currentBidNum = Number(nomination.currentBid);
              const userMaxBid = myProxyBids
                .filter(
                  (pb) =>
                    pb.nominationId.toString() === nomination.id.toString(),
                )
                .reduce((max, pb) => {
                  const bid = Number(pb.maxBid);
                  return bid > max ? bid : max;
                }, 0);
              const showOutbid =
                bidStatus === "outbid" &&
                userMaxBid > 0 &&
                currentBidNum <= userMaxBid * 1.5;
              return (
                showOutbid && (
                  <span
                    className="bg-amber-500/15 text-amber-400 border border-amber-500/40 text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                    data-ocid="nomination-status-outbid"
                  >
                    Outbid
                  </span>
                )
              );
            })()}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge
              className={cn(
                "text-[10px] px-1.5 py-0 border font-semibold shrink-0",
                positionClass(nomination.position),
              )}
            >
              {nomination.position}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {nomination.team}
              {(() => {
                const bye = playerByeWeeks?.get(nomination.playerId);
                return bye != null ? ` · Bye ${bye}` : "";
              })()}
            </span>
          </div>
          {showEstimatedValues &&
            estimatedValue != null &&
            (() => {
              const currentBidNum = Number(nomination.currentBid);
              const adpVal = (nomination as NominationView & { adp?: number })
                .adp;
              const adpPart = adpVal != null ? `ADP: ${adpVal} · ` : "";
              if (currentBidNum < estimatedValue * 0.85) {
                return (
                  <p className="text-xs text-emerald-400 mt-0.5 truncate">
                    {adpPart}Est. ${estimatedValue} · Good Value
                  </p>
                );
              }
              if (currentBidNum > estimatedValue * 1.15) {
                return (
                  <p className="text-xs text-amber-400 mt-0.5 truncate">
                    {adpPart}Est. ${estimatedValue} · Above Value
                  </p>
                );
              }
              return (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {adpPart}Est. ${estimatedValue}
                </p>
              );
            })()}
          <p className="text-xs text-muted-foreground/60 mt-1 truncate">
            Nominated by {nominatorName}
          </p>
        </div>
      </div>

      {/* Bye week warning — informational only, never affects bidding */}
      {byeWeekWarning && (
        <div
          className="bg-amber-500/15 border border-amber-500/40 text-amber-400 rounded-lg p-2.5 space-y-0.5"
          data-ocid="nomination-bye-week-warning"
          role="note"
        >
          <p className="text-xs font-semibold flex items-center gap-1.5">
            <span aria-hidden="true">⚠</span> Bye Week Warning
          </p>
          <p className="text-xs text-amber-400/90">
            Drafting this player would give you {byeWeekWarning.count} players
            on Week {byeWeekWarning.byeWeek} bye.
          </p>
        </div>
      )}

      {/* Recent News */}
      {showNewsOnCards && (
        <PlayerNewsSection playerName={nomination.playerName} />
      )}

      {/* Bid display */}
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
            Current Bid
          </p>
          <span
            className={cn(
              "font-mono font-bold text-2xl",
              isLeader ? "text-accent text-glow-magenta" : "text-primary",
              isBidPulsing && "animate-pulse",
            )}
          >
            ${animatedBid}
          </span>
        </div>

        <div className="text-right">
          {isClosed && awardedTo ? (
            <Badge className="bg-secondary/20 text-secondary border border-secondary/30 text-xs font-semibold">
              🏆 {awardedTo}
            </Badge>
          ) : isLeader ? (
            <Badge className="bg-accent/20 text-accent border border-accent/40 text-xs font-semibold animate-pulse">
              ✦ You&rsquo;re Leading
            </Badge>
          ) : leaderDisplay ? (
            <div className="flex items-center gap-1.5">
              <AvatarThumb
                size={36}
                displayName={leaderDisplay}
                seed={nomination.bidLeader?.toText() ?? ""}
                avatarUrl={leaderParticipant?.avatarUrl ?? null}
              />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                  Leader
                </p>
                <p className="text-sm font-semibold text-foreground/80 font-mono truncate max-w-[120px]">
                  {leaderDisplay}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Over-commitment safeguard banner — shown when bidding on this
          nomination would push the user's projected roster over the cap.
          Mirrors the inline message rendered by BidPanel. */}
      {showBidPanel && overcommitBlocked && (
        <div
          className="bg-amber-500/15 border border-amber-500/40 text-amber-400 rounded-lg p-2.5"
          data-ocid="nomination-overcommit-safeguard"
          role="alert"
        >
          <p className="text-xs font-medium leading-snug">
            <span aria-hidden="true">⚠ </span>
            {OVERCOMMIT_SAFEGUARD_MESSAGE}
          </p>
        </div>
      )}

      {/* Bid panel — always mounted while nomination is active and user is a participant */}
      {showBidPanel && (
        <div className="border-t border-border/50 pt-3">
          <BidPanel
            nomination={nomination}
            roomId={roomId}
            auctionState={auctionState}
            availableBudget={availableBudget}
            myProxyBids={myProxyBids}
            minBidIncrement={minBidIncrement}
            currentUserPrincipal={currentUserPrincipal}
            userWonCount={userWonCount}
            maxRosterSize={maxRosterSize}
            reserveCeiling={reserveCeiling}
            overcommitBlocked={overcommitBlocked}
          />
        </div>
      )}

      {/* Collapsible bid history — event-based from backend */}
      <div className="border-t border-border/30 pt-2">
        <button
          type="button"
          onClick={() => setBidHistoryOpen((v) => !v)}
          className="w-full flex items-center justify-between text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors py-0.5"
          data-ocid="nomination-bid-history-toggle"
          aria-expanded={bidHistoryOpen}
        >
          <span className="uppercase tracking-wider font-mono">
            Bid History
            {sortedEvents.length > 0 && (
              <span className="ml-1.5 text-primary/70">
                ({sortedEvents.length})
              </span>
            )}
          </span>
          {bidHistoryOpen ? (
            <ChevronUp className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
          )}
        </button>

        {bidHistoryOpen && (
          <div
            className="mt-2 rounded-lg border border-border/60 overflow-hidden"
            data-ocid="nomination-bid-history-panel"
          >
            {sortedEvents.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-3">
                No events yet
              </p>
            ) : (
              <div className="max-h-48 overflow-y-auto scrollbar-thin px-3 py-2">
                <div className="relative pl-6 space-y-2">
                  {/* Vertical timeline line */}
                  <div className="w-px bg-border/40 absolute left-3 top-0 bottom-0" />
                  {sortedEvents.map((evt, i) => {
                    // Detect outbid: previous leader was current user, this event shows someone else taking lead
                    const prevLeader =
                      i < sortedEvents.length - 1
                        ? sortedEvents[i + 1].userId.toText()
                        : null;
                    const isOutbidEntry =
                      evt.eventType === BidHistoryEventType.leaderChanged &&
                      currentUserPrincipal != null &&
                      prevLeader === currentUserPrincipal &&
                      evt.userId.toText() !== currentUserPrincipal;

                    return (
                      <div
                        key={`${evt.timestamp.toString()}-${i}`}
                        className="flex items-start gap-2 text-xs"
                        data-ocid="nomination-bid-history-row"
                      >
                        {/* Timeline dot — brightest for most recent (index 0) */}
                        <span
                          className={cn(
                            "w-2 h-2 rounded-full flex-shrink-0 relative z-10 mt-1",
                            i === 0 ? "bg-primary/80" : "bg-primary/60",
                          )}
                        />
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span
                            className={cn(
                              "font-medium",
                              isOutbidEntry
                                ? "text-amber-400"
                                : eventColor(evt.eventType),
                            )}
                          >
                            {eventLabel(evt)}
                          </span>
                          <span className="text-muted-foreground tabular-nums text-[10px]">
                            {formatTimestamp(evt.timestamp)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
