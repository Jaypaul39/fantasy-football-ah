import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ADPDataset as BackendADPDataset } from "../backend.d.ts";
import type { PlayerFilter } from "../backend.d.ts";
import { useBackend } from "../hooks/useBackend";
import { useValueDisplayPreference } from "../hooks/useValueDisplayPreference";
import { useWatchlist } from "../hooks/useWatchlist";
import { calculateEstimatedValues } from "../lib/auction-value";
import {
  requestNotificationPermission,
  storeOneSignalPlayerId,
} from "../lib/onesignal";
import type { RoomId, RoomView, UserId } from "../types";
import { PlayerSearch } from "./PlayerSearch";

interface NominateTabProps {
  roomView: RoomView;
  roomId: RoomId;
  myPrincipal: UserId | null;
  nominatedPlayerIds: Set<string>;
  playerFilter?: PlayerFilter;
  /** Called after a successful nomination to redirect to the Auction tab */
  onNavigateToAuction?: () => void;
}

export default function NominateTab({
  roomView,
  roomId,
  myPrincipal,
  nominatedPlayerIds,
  playerFilter,
  onNavigateToAuction,
}: NominateTabProps) {
  const { actor } = useBackend();
  const { currentNominatorId, currentNominatorName } = roomView;

  const isMyTurn =
    myPrincipal != null &&
    currentNominatorId != null &&
    myPrincipal.toText() === currentNominatorId.toText();

  const showBanner = currentNominatorId != null;

  const { watchlist, toggle, isWatched } = useWatchlist(roomId);
  const { showEstimatedValues } = useValueDisplayPreference();

  const [watchlistExpanded, setWatchlistExpanded] = useState(true);

  // ── ADP dataset fetch for estimated values ────────────────────────────────
  const datasetKeyForEstimates =
    roomView?.room?.settings?.adpDataset === "rookies" ||
    (roomView?.room?.playerFilter as { filterType?: string } | undefined)
      ?.filterType === "rookies"
      ? "rookies"
      : "all";

  const { data: adpDatasetForEstimates } = useQuery<BackendADPDataset | null>({
    queryKey: ["activeADPDataset", datasetKeyForEstimates, roomId ?? "unknown"],
    queryFn: async () => {
      if (!actor) return null;
      try {
        if (datasetKeyForEstimates === "rookies") {
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
  });

  const estimatedValues = useMemo<Map<string, number> | null>(() => {
    const rs = roomView?.room?.rosterSettings;
    if (
      !rs ||
      !adpDatasetForEstimates ||
      adpDatasetForEstimates.entries.length === 0
    )
      return null;
    const players = adpDatasetForEstimates.entries
      .filter((e) => e.adp != null && e.position)
      .map((e) => ({ name: e.name, position: e.position ?? "", adp: e.adp }));
    if (players.length === 0) return null;
    const rsMapped = {
      qb: Number(rs.qb),
      rb: Number(rs.rb),
      wr: Number(rs.wr),
      te: Number(rs.te),
      flex: Number(rs.flex),
      superflex: Number(rs.superflex),
      bench: Number(rs.bench),
      flexPositions: rs.flexPositions,
      superflexPositions: rs.superflexPositions,
    };
    const numTeams = Number(roomView?.room?.settings?.maxParticipants ?? 10);
    const totalBudget =
      roomView?.room?.startingBudget != null
        ? Number(roomView.room.startingBudget)
        : 200;
    return calculateEstimatedValues(
      players,
      rsMapped,
      numTeams,
      totalBudget,
      [],
    );
  }, [
    adpDatasetForEstimates,
    roomView?.room?.rosterSettings,
    roomView?.room?.settings,
    roomView?.room?.startingBudget,
  ]);

  // ── Optional max bid for nomination ──────────────────────────────────────
  const [maxBidInput, setMaxBidInput] = useState("");
  const optionalMaxBid = maxBidInput.trim() !== "" ? Number(maxBidInput) : null;

  // Clear max bid input after a successful nomination
  const handleAfterNominate = () => {
    setMaxBidInput("");
    // Request notification permission after first successful nomination
    void requestNotificationPermission();
    setTimeout(async () => {
      try {
        if (actor) {
          await storeOneSignalPlayerId(actor);
        }
      } catch {
        // silent
      }
    }, 2000);
    onNavigateToAuction?.();
  };

  // ── Backend-driven queue state with optimistic UI ─────────────────────────
  const [optimisticQueuedId, setOptimisticQueuedId] = useState<string | null>(
    null,
  );

  // Effective queuedId: optimistic takes precedence while in-flight, then server truth
  const queuedId = optimisticQueuedId ?? roomView.queuedPlayerId ?? null;

  // When server state changes, clear optimistic to let server be source of truth
  const serverQueuedPlayerId = roomView.queuedPlayerId ?? null;
  const prevServerQueuedRef = useRef(serverQueuedPlayerId);
  if (prevServerQueuedRef.current !== serverQueuedPlayerId) {
    prevServerQueuedRef.current = serverQueuedPlayerId;
    setOptimisticQueuedId(null);
  }

  // Queue-cleared detection toast
  const prevQueuedId = useRef<string | null>(null);
  useEffect(() => {
    const current = serverQueuedPlayerId;
    if (prevQueuedId.current && !current) {
      toast("Your queued player was unavailable — turn was skipped");
    }
    prevQueuedId.current = current;
  }, [serverQueuedPlayerId]);

  const setQueued = (playerId: string | null) => {
    if (playerId) {
      setOptimisticQueuedId(playerId);
      if (actor) {
        actor
          .setNominationQueue(roomId, playerId)
          .catch(() => setOptimisticQueuedId(null));
      }
    } else {
      setOptimisticQueuedId(null);
      if (actor) {
        actor.clearNominationQueue(roomId).catch(() => {});
      }
    }
  };

  // ── Watchlist player name map ─────────────────────────────────────────────
  const [playerNameMap, setPlayerNameMap] = useState<
    Map<
      string,
      { name: string; position: string; team: string; adp: number | null }
    >
  >(new Map());

  // Fetch player names when watchlist is non-empty (lightweight, cached by React Query via actor)
  useEffect(() => {
    if (!actor || watchlist.length === 0) return;

    // Determine which ADP dataset to use — same logic as PlayerSearch.tsx
    const datasetKey =
      roomView?.room?.settings?.adpDataset === "rookies" ||
      (roomView?.room?.playerFilter as { filterType?: string } | undefined)
        ?.filterType === "rookies"
        ? "rookies"
        : "all";

    Promise.all([
      actor.getPlayers("", null),
      datasetKey === "rookies"
        ? actor
            .getADPDatasetByType("rookies")
            .then((res) => (res != null ? res : actor.getActiveADPDataset()))
        : actor.getActiveADPDataset(),
    ])
      .then(([players, adpDataset]) => {
        // Build a normalized name → adp lookup map from the ADP dataset
        const adpByName = new Map<string, number>();
        if (adpDataset != null && adpDataset.entries.length > 0) {
          for (const entry of adpDataset.entries) {
            adpByName.set(entry.name.trim().toLowerCase(), entry.adp);
          }
        }

        const map = new Map<
          string,
          { name: string; position: string; team: string; adp: number | null }
        >();
        for (const p of players) {
          const normalizedName = p.name.trim().toLowerCase();
          const adpValue = adpByName.get(normalizedName) ?? null;
          map.set(p.id, {
            name: p.name,
            position: p.position,
            team: p.team,
            adp: adpValue,
          });
        }
        setPlayerNameMap(map);
      })
      .catch(() => {
        // silently ignore — names fall back to IDs
      });
  }, [actor, watchlist.length, roomView]);

  const watchlistPlayers = useMemo(
    () =>
      watchlist.map((id) => {
        const info = playerNameMap.get(id);
        return {
          id,
          ...(info ?? {
            name: id,
            position: "",
            team: "",
            adp: null as number | null,
          }),
        };
      }),
    [watchlist, playerNameMap],
  );

  const queuedPlayerName = useMemo(() => {
    if (!queuedId) return null;
    return playerNameMap.get(queuedId)?.name ?? queuedId;
  }, [queuedId, playerNameMap]);

  // Roster cap — handles all runtime shapes: bigint (auto-converted), bigint[] (raw Candid), null, undefined
  const raw = (roomView?.room?.settings as any)?.maxRosterSize;
  const max =
    raw == null ? null : Array.isArray(raw) ? Number(raw[0]) : Number(raw);

  const meParticipant = roomView.participants.find(
    (p) => myPrincipal != null && p.userId.toText() === myPrincipal.toText(),
  );
  const myWonCount = meParticipant?.wonPlayers.length ?? 0;

  return (
    <div className="flex flex-col h-full gap-3 p-4 sm:p-6 max-w-5xl mx-auto w-full">
      {/* Nomination turn indicator banner */}
      {showBanner && (
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-4 py-2.5 text-sm font-medium border transition-colors shrink-0",
            isMyTurn
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-muted/50 border-border text-muted-foreground",
          )}
          data-ocid="nominate-turn-banner"
        >
          {isMyTurn ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 text-muted-foreground/60" />
          )}
          <span>
            {isMyTurn ? (
              <span className="font-semibold text-emerald-300">
                You are up to nominate!
              </span>
            ) : (
              <>
                Waiting for{" "}
                <span className="font-semibold text-foreground">
                  {currentNominatorName ?? "…"}
                </span>{" "}
                to nominate
              </>
            )}
          </span>
        </div>
      )}

      {/* Queue indicator banner — visible when queued and not my turn */}
      {queuedId && !isMyTurn && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/60 shrink-0"
          data-ocid="nominate-queue-banner"
        >
          <span className="text-primary text-sm">⚡</span>
          <span className="text-sm text-muted-foreground flex-1">
            <>
              Auto-nominating:{" "}
              <span className="font-semibold text-foreground">
                {queuedPlayerName}
              </span>{" "}
              when your turn starts
            </>
          </span>
          <button
            type="button"
            onClick={() => setQueued(null)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear auto-nominate queue"
            data-ocid="nominate-queue-clear"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ⭐ My Watchlist — only visible when watchlist has items */}
      {watchlistPlayers.length > 0 && (
        <div
          className="shrink-0 rounded-lg border border-border bg-card/60"
          data-ocid="nominate-watchlist"
        >
          <button
            type="button"
            onClick={() => setWatchlistExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/20 transition-colors rounded-lg"
            data-ocid="nominate-watchlist-toggle"
          >
            <span>⭐ My Watchlist</span>
            {watchlistExpanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </button>

          {watchlistExpanded && (
            <div className="overflow-x-auto scrollbar-thin px-3 pb-3">
              <div className="flex gap-2 min-w-0">
                {watchlistPlayers.map((player) => {
                  const isTaken = nominatedPlayerIds.has(player.id);
                  const isQueued = queuedId === player.id;
                  return (
                    <WatchlistCard
                      key={player.id}
                      player={player}
                      isTaken={isTaken}
                      isQueued={isQueued}
                      isMyTurn={isMyTurn}
                      estimatedValue={
                        showEstimatedValues
                          ? estimatedValues?.get(
                              player.name.trim().toLowerCase(),
                            )
                          : undefined
                      }
                      onQueue={() => setQueued(player.id)}
                      onCancelQueue={() => setQueued(null)}
                      onRemove={() => toggle(player.id)}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Roster full banner */}
      {max != null && myWonCount >= max && (
        <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm font-semibold text-center shrink-0">
          Your roster is full — you cannot nominate any more players
        </div>
      )}

      <div className="flex-1 min-h-0" data-ocid="nominate-tab-player-list">
        {/* Optional max bid input — only shown when it's the user's turn */}
        {isMyTurn && (
          <div className="px-3 pt-2 pb-1 border-b border-border/50">
            <label
              htmlFor="nominate-max-bid"
              className="block text-xs text-muted-foreground mb-1"
            >
              Max Bid (optional)
            </label>
            <input
              id="nominate-max-bid"
              type="number"
              min={1}
              value={maxBidInput}
              onChange={(e) => setMaxBidInput(e.target.value)}
              placeholder="e.g. 50"
              className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              data-ocid="nominate-max-bid-input"
            />
            <p className="text-[11px] text-muted-foreground/60 mt-1">
              Leave blank to start at $1 with no proxy bid
            </p>
          </div>
        )}
        <PlayerSearch
          roomId={roomId}
          myPrincipal={myPrincipal}
          nominatedPlayerIds={nominatedPlayerIds}
          playerFilter={playerFilter}
          onClose={handleAfterNominate}
          isWatched={isWatched}
          onWatchlistToggle={toggle}
          isMyTurn={isMyTurn}
          userWonCount={myWonCount}
          maxRosterSize={max}
          optionalMaxBid={optionalMaxBid}
          roomView={roomView}
        />
      </div>
    </div>
  );
}

// ── WatchlistCard ─────────────────────────────────────────────────────────────
// Extracted as a separate component to avoid nesting interactive elements.

interface WatchlistCardProps {
  player: {
    id: string;
    name: string;
    position: string;
    team: string;
    adp: number | null;
  };
  isTaken: boolean;
  isQueued: boolean;
  isMyTurn: boolean;
  estimatedValue?: number;
  onQueue: () => void;
  onCancelQueue: () => void;
  onRemove: () => void;
}

function WatchlistCard({
  player,
  isTaken,
  isQueued,
  isMyTurn,
  estimatedValue,
  onQueue,
  onCancelQueue,
  onRemove,
}: WatchlistCardProps) {
  // Determine action button state (mutually exclusive, checked in order):
  // 1. Taken → disabled "Taken" label
  // 2. Queued → "⚡ Queued" + ✕ cancel
  // 3. Not my turn → "Nominate Next" button
  // 4. My turn → no action (nominate directly from the list)
  const renderAction = () => {
    if (isTaken) {
      return (
        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide px-2 py-1 rounded bg-muted/30">
          Taken
        </span>
      );
    }
    if (isQueued) {
      return (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-primary font-semibold flex items-center gap-0.5">
            ⚡ Queued
          </span>
          <button
            type="button"
            onClick={onCancelQueue}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Cancel auto-nominate"
            data-ocid="watchlist-card-cancel-queue"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      );
    }
    if (!isMyTurn) {
      return (
        <button
          type="button"
          onClick={onQueue}
          className="text-[10px] text-muted-foreground hover:text-primary transition-colors font-semibold border border-border/60 hover:border-primary/40 rounded px-2 py-0.5 bg-muted/20 hover:bg-primary/5"
          aria-label="Queue for auto-nominate"
          data-ocid="watchlist-card-queue"
        >
          Nominate Next
        </button>
      );
    }
    // isMyTurn && not taken && not queued → no action shown
    return null;
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border min-w-[116px] shrink-0 transition-colors",
        isTaken
          ? "opacity-40 border-border bg-muted/20"
          : "border-border/60 bg-muted/10",
        isQueued && !isTaken && "border-primary/40 bg-primary/5",
      )}
      data-ocid="watchlist-card"
    >
      {/* Top row: star + name */}
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={onRemove}
          className="text-sm leading-none text-primary transition-colors hover:text-primary/70 shrink-0 mt-0.5"
          aria-label="Remove from watchlist"
          data-ocid="watchlist-card-star"
        >
          ★
        </button>
        <p className="text-xs font-semibold text-foreground truncate max-w-[80px] leading-tight">
          {player.name}
        </p>
      </div>

      {/* Position • Team */}
      <div className="flex items-center gap-1 pl-5">
        {player.position && (
          <span className="text-[10px] font-bold text-muted-foreground uppercase">
            {player.position}
          </span>
        )}
        {player.position && player.team && (
          <span className="text-[10px] text-muted-foreground/50">•</span>
        )}
        {player.team && (
          <span className="text-[10px] text-muted-foreground/60 truncate">
            {player.team}
          </span>
        )}
      </div>

      {/* ADP line — shown inside WatchlistCard, but estimatedValues is passed as a prop */}
      <p className="text-xs text-muted-foreground pl-5">
        {player.adp != null
          ? estimatedValue != null
            ? `ADP ${player.adp} · ~${estimatedValue}`
            : `ADP ${player.adp}`
          : estimatedValue != null
            ? `~${estimatedValue}`
            : "ADP —"}
      </p>

      {/* Action button */}
      <div className="pl-5 mt-0.5">{renderAction()}</div>
    </div>
  );
}
