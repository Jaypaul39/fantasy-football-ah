import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  AdpEntry,
  ADPDataset as BackendADPDataset,
  PlayerFilter,
} from "../backend.d.ts";
import { useBackend } from "../hooks/useBackend";
import { useValueDisplayPreference } from "../hooks/useValueDisplayPreference";
import type { ADPDataset, EnrichedPlayer } from "../lib/adp-types";
import {
  enrichPlayersWithADP,
  getDraftablePlayers,
  getPlayersSortedByADP,
} from "../lib/adp-utils";
import { calculateEstimatedValues } from "../lib/auction-value";
import type { Player, RoomId, RoomView, UserId } from "../types";
import type { PositionFilter } from "../types";

interface PlayerSearchProps {
  roomId: RoomId;
  nominatedPlayerIds: Set<string>;
  /** Room's player pool filter — used to restrict visible position tabs */
  playerFilter?: PlayerFilter;
  onClose?: () => void;
  /** Watchlist integration props */
  isWatched?: (playerId: string) => boolean;
  onWatchlistToggle?: (playerId: string) => void;
  isMyTurn?: boolean;
  /** Roster cap enforcement */
  userWonCount?: number;
  maxRosterSize?: number | null;
  /** Room view — used to determine which ADP dataset to use */
  roomView?: RoomView | null;
  /** Optional max bid to place immediately after a successful nomination */
  optionalMaxBid?: number | null;
  /** Signed-in user's principal — gates the skip-nomination-turn toggle */
  myPrincipal?: UserId | null;
}

const ALL_POSITIONS: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "K"];

/** Map position string → Tailwind classes for badge */
function positionClass(pos: string): string {
  switch (pos) {
    case "QB":
      return "pos-qb border";
    case "RB":
      return "pos-rb border";
    case "WR":
      return "pos-wr border";
    case "TE":
      return "pos-te border";
    case "K":
      return "bg-purple-500/20 text-purple-400 border-purple-500/30 border";
    default:
      return "bg-muted text-muted-foreground border-border border";
  }
}

/**
 * Maps a backend ADPDataset (with bigint timestamps and AdpEntry[]) to the
 * frontend ADPDataset format consumed by adp-utils enrichment functions.
 */
function mapBackendDataset(dataset: BackendADPDataset): ADPDataset {
  return {
    entries: dataset.entries.map((e: AdpEntry) => ({
      name: e.name,
      adp: e.adp,
      position: e.position,
      team: e.team,
    })),
    importedAt: Number(dataset.importedAt),
  };
}

export function PlayerSearch({
  roomId,
  nominatedPlayerIds,
  playerFilter,
  onClose,
  isWatched,
  onWatchlistToggle,
  isMyTurn,
  userWonCount,
  maxRosterSize,
  roomView,
  optionalMaxBid,
  myPrincipal,
}: PlayerSearchProps) {
  const { actor } = useBackend();
  const queryClient = useQueryClient();
  const { showEstimatedValues } = useValueDisplayPreference();
  const [query, setQuery] = useState("");
  const [posFilter, setPosFilter] = useState<PositionFilter>("ALL");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [nominatingId, setNominatingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [skipPending, setSkipPending] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);

  // Current user's participant record — used for the skip-nomination-turn toggle.
  const meParticipant = useMemo(
    () =>
      roomView?.participants.find(
        (p) =>
          myPrincipal != null && p.userId.toText() === myPrincipal.toText(),
      ),
    [roomView?.participants, myPrincipal],
  );
  const isMe = meParticipant != null;
  const mySkipNominationTurn = meParticipant?.skipNominationTurn ?? false;

  // ── Skip my nomination turns toggle ────────────────────────────────────────
  // Standing toggle: when on, the user's nomination turns are skipped.
  // Mirrors the pattern from NominationOrderTab: call actor method, check
  // result.__kind__ === "err", then invalidate the room query.
  const handleSkipToggle = useCallback(
    async (currentSkip: boolean) => {
      if (!actor || skipPending) return;
      setSkipPending(true);
      setSkipError(null);
      try {
        const result = await actor.setSkipNominationTurn(roomId, !currentSkip);
        if (result.__kind__ === "err") {
          setSkipError(result.err);
        } else {
          queryClient.invalidateQueries({ queryKey: ["room", roomId] });
        }
      } catch (e) {
        setSkipError(
          e instanceof Error ? e.message : "Failed to update skip setting",
        );
      } finally {
        setSkipPending(false);
      }
    },
    [actor, roomId, skipPending, queryClient],
  );

  // Derive available position tabs from the room's playerFilter.
  const availablePositions: PositionFilter[] = (() => {
    if (!playerFilter || playerFilter.positions.length === 0) {
      return ALL_POSITIONS;
    }
    const roomPositions = new Set(playerFilter.positions);
    const filtered = ALL_POSITIONS.filter(
      (p) => p === "ALL" || roomPositions.has(p),
    );
    return filtered.length > 1 ? filtered : ALL_POSITIONS;
  })();

  // Reset posFilter if the current selection is no longer available
  useEffect(() => {
    if (posFilter !== "ALL" && !availablePositions.includes(posFilter)) {
      setPosFilter("ALL");
    }
  }, [availablePositions, posFilter]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Derive which ADP dataset key to use — rookies if either room settings or player filter says so
  const datasetKey =
    roomView?.room?.settings?.adpDataset === "rookies" ||
    (roomView?.room?.playerFilter as { filterType?: string } | undefined)
      ?.filterType === "rookies"
      ? "rookies"
      : "all";

  // ── STEP 1: Fetch ADP dataset from backend ────────────────────────────────
  // This query runs once on mount (staleTime is long — dataset rarely changes).
  const { data: backendADPDataset, isLoading: adpLoading } =
    useQuery<BackendADPDataset | null>({
      queryKey: ["activeADPDataset", datasetKey, roomId ?? "unknown"],
      queryFn: async () => {
        if (!actor) return null;
        try {
          let result: BackendADPDataset | null = null;
          if (datasetKey === "rookies") {
            result = await actor.getADPDatasetByType("rookies");
            // Fallback to "all" if rookie dataset is missing
            if (result == null) {
              result = await actor.getActiveADPDataset();
            }
          } else {
            result = await actor.getActiveADPDataset();
          }
          return result ?? null;
        } catch (err) {
          console.warn("[ADP] Failed to fetch ADP dataset:", err);
          return null;
        }
      },
      enabled: !!actor,
      // Dataset rarely changes — cache for 5 minutes
      staleTime: 0,
    });

  // ── Estimated auction values ──────────────────────────────────────────────
  const estimatedValues = useMemo<Map<string, number> | null>(() => {
    const rs = roomView?.room?.rosterSettings;
    if (!rs || !backendADPDataset || backendADPDataset.entries.length === 0)
      return null;
    const players = backendADPDataset.entries
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
    backendADPDataset,
    roomView?.room?.rosterSettings,
    roomView?.room?.settings,
    roomView?.room?.startingBudget,
  ]);

  // ── STEP 2: Validate + map the backend dataset ────────────────────────────
  // adpDataset is null when missing/empty — never fallback to 999.
  const adpDataset = useMemo<ADPDataset | null>(() => {
    // Still loading — hold off
    if (adpLoading) return undefined as unknown as null;

    if (backendADPDataset == null) {
      console.warn(
        "[ADP] No active ADP dataset available — ADP will be null for all players",
      );
      return null;
    }
    if (backendADPDataset.entries.length === 0) {
      console.warn(
        "[ADP] Active ADP dataset is empty — ADP will be null for all players",
      );
      return null;
    }
    return mapBackendDataset(backendADPDataset);
  }, [backendADPDataset, adpLoading]);

  // ── Fetch raw players from backend ───────────────────────────────────────
  const { data: rawPlayers, isLoading: playersLoading } = useQuery<Player[]>({
    queryKey: ["playersByRoom", roomId, debouncedQuery, posFilter],
    queryFn: async () => {
      if (!actor) return [];
      const posArg = posFilter === "ALL" ? "" : posFilter;
      try {
        return await actor.getPlayersByRoom(roomId, debouncedQuery, posArg);
      } catch {
        const pos = posFilter === "ALL" ? null : posFilter;
        return actor.getPlayers(debouncedQuery, pos ?? null);
      }
    },
    enabled: !!actor,
    staleTime: 10_000,
  });

  // ── STEP 3 + 4: Enrich then sort — BLOCKING render gate ──────────────────
  // enrichedPlayers is only produced after BOTH rawPlayers AND adpDataset are ready.
  // During either fetch, isLoading will be true and no player list is shown.
  const isLoading = adpLoading || playersLoading;

  const enrichedPlayers = useMemo(() => {
    // Block render until both datasets are available
    if (adpLoading || !rawPlayers) return null;

    // STEP 3: Filter to draftable players, then enrich with ADP
    const draftable = getDraftablePlayers(rawPlayers);
    // adpDataset may be null (validated above) — enrichPlayersWithADP handles null gracefully (sets adp: null)
    const enriched = enrichPlayersWithADP(draftable, adpDataset);

    // STEP 4: Sort enriched array — null ADP always at bottom
    return getPlayersSortedByADP(enriched);
  }, [rawPlayers, adpDataset, adpLoading]);

  // Apply search/position filter on the already-enriched+sorted array.
  // Sorting is NOT re-run here — the enriched array is already sorted above.
  // Filtering the sorted array preserves relative ADP order within the filtered result.
  const displayPlayers = useMemo(() => {
    if (!enrichedPlayers) return null;
    return enrichedPlayers.filter((p) => {
      // Filter out already-nominated players
      if (nominatedPlayerIds.has(p.id)) return false;
      return true;
    });
  }, [enrichedPlayers, nominatedPlayerIds]);

  const isRosterFull =
    maxRosterSize != null &&
    userWonCount != null &&
    userWonCount >= maxRosterSize;

  const handleNominate = useCallback(
    async (player: EnrichedPlayer) => {
      if (!actor) return;
      setNominatingId(player.id);
      try {
        const result = await actor.nominatePlayer(roomId, player.id);
        if (result.__kind__ === "ok") {
          // If an optional max bid was provided, place a proxy bid immediately after nomination
          if (optionalMaxBid != null && optionalMaxBid > 0) {
            try {
              await actor.placeProxyBid(
                result.ok,
                roomId,
                BigInt(optionalMaxBid),
              );
            } catch {
              // Non-fatal — nomination succeeded, proxy bid failure is logged only
              toast.warning(
                `${player.name} nominated! Max bid could not be set.`,
              );
            }
          }
          toast.success(`${player.name} nominated!`);
          onClose?.();
        } else {
          if (result.err.toLowerCase().includes("roster is full")) {
            toast.error("Your roster is full");
          } else {
            toast.error(result.err);
          }
        }
      } catch {
        toast.error("Failed to nominate player.");
      } finally {
        setNominatingId(null);
      }
    },
    [actor, roomId, onClose, optionalMaxBid],
  );

  return (
    <div
      className="flex flex-col h-full bg-card border border-border rounded-lg overflow-hidden"
      data-ocid="player-search"
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search players…"
          className="border-0 bg-transparent p-0 h-auto text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          data-ocid="player-search.search_input"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close player search"
            data-ocid="player-search.close_button"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Position filter + skip-nomination-turn toggle (current user only) */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border overflow-x-auto scrollbar-thin shrink-0">
        <div className="flex gap-1.5 shrink-0">
          {availablePositions.map((pos) => (
            <button
              key={pos}
              type="button"
              onClick={() => setPosFilter(pos)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 transition-smooth",
                posFilter === pos
                  ? "bg-primary/20 text-primary border border-primary/40"
                  : "bg-muted/40 text-muted-foreground border border-transparent hover:border-border",
              )}
              data-ocid={`pos-filter-${pos.toLowerCase()}`}
            >
              {pos}
            </button>
          ))}
        </div>

        {isMe && (
          <label
            className={cn(
              "flex items-center gap-1.5 ml-auto pl-2 shrink-0 cursor-pointer select-none",
              skipPending && "opacity-60 cursor-not-allowed",
            )}
            data-ocid="player-search.skip-nomination-toggle"
          >
            <span className="relative inline-flex items-center justify-center">
              <input
                type="checkbox"
                checked={mySkipNominationTurn}
                disabled={skipPending}
                onChange={() => handleSkipToggle(mySkipNominationTurn)}
                aria-label="Skip my nomination turns"
                className="peer appearance-none w-4 h-4 rounded border border-border bg-muted/40 checked:bg-amber-500 checked:border-amber-500 transition-colors cursor-pointer disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0"
                data-ocid="player-search.skip-nomination-checkbox"
              />
              {skipPending ? (
                <Loader2 className="w-3 h-3 absolute animate-spin text-muted-foreground pointer-events-none" />
              ) : (
                mySkipNominationTurn && (
                  <svg
                    viewBox="0 0 12 12"
                    className="w-3 h-3 absolute text-white pointer-events-none"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 6.5l2.5 2.5 4.5-5" />
                  </svg>
                )
              )}
            </span>
            <span
              className="text-[11px] font-medium text-muted-foreground whitespace-nowrap"
              title="Skip my nomination turns"
            >
              Skip Turn
            </span>
          </label>
        )}
      </div>

      {/* Skip error — shown only for the current user when the toggle fails */}
      {isMe && skipError && (
        <p
          className="px-3 py-1 text-[10px] text-destructive font-medium border-b border-border/50"
          data-ocid="player-search.skip-nomination-error"
          role="alert"
        >
          {skipError}
        </p>
      )}

      {/* Results — only render after enrichment is complete */}
      <div className="flex-1 overflow-y-auto scrollbar-thin pb-16">
        {isLoading || displayPlayers === null ? (
          // Loading state shown while ADP dataset OR players are still fetching,
          // or while enrichment hasn't completed yet.
          <div
            className="p-3 space-y-2"
            data-ocid="player-search.loading_state"
          >
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : displayPlayers.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-12 gap-2 text-center px-4"
            data-ocid="player-search.empty_state"
          >
            <Search className="w-8 h-8 text-muted-foreground/30" />
            <p className="text-sm font-semibold text-muted-foreground">
              No players found
            </p>
            <p className="text-xs text-muted-foreground/60">
              {query
                ? `No results for "${query}"`
                : posFilter !== "ALL"
                  ? `No eligible ${posFilter} players`
                  : "No players available for nomination"}
            </p>
            {(query || posFilter !== "ALL") && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setPosFilter("ALL");
                }}
                className="text-xs text-primary underline underline-offset-2 mt-1"
                data-ocid="player-search.clear_filters"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {displayPlayers.map((player) => {
              const watched = isWatched?.(player.id) ?? false;
              const isNominated = nominatedPlayerIds.has(player.id);
              return (
                <li
                  key={player.id}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5 hover:bg-muted/20 transition-colors",
                    isNominated && "opacity-40",
                  )}
                  data-ocid="player-result-row"
                >
                  {/* Star toggle */}
                  <button
                    type="button"
                    onClick={() => onWatchlistToggle?.(player.id)}
                    className="shrink-0 w-6 h-6 flex items-center justify-center transition-colors"
                    aria-label={
                      watched ? "Remove from watchlist" : "Add to watchlist"
                    }
                    data-ocid="player-search.watchlist_toggle"
                  >
                    {watched ? (
                      <span className="text-primary text-base leading-none">
                        ★
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-base leading-none hover:text-primary/60">
                        ☆
                      </span>
                    )}
                  </button>

                  {/* Headshot / initials */}
                  <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 flex items-center justify-center bg-muted text-xs font-bold font-display">
                    {player.headshotUrl ? (
                      <img
                        src={player.headshotUrl}
                        alt={player.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className={cn(positionClass(player.position))}>
                        {player.position}
                      </span>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="font-display font-semibold text-sm text-foreground truncate">
                      {player.name}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge
                        className={cn(
                          "text-[10px] px-1.5 py-0 font-semibold",
                          positionClass(player.position),
                        )}
                      >
                        {player.position}
                      </Badge>
                      <span className="text-xs text-muted-foreground truncate">
                        {player.team}
                      </span>
                      <span className="text-xs text-muted-foreground/60 font-mono ml-auto flex items-center gap-1.5">
                        {player.adp != null ? `ADP ${player.adp}` : "ADP —"}
                        {showEstimatedValues &&
                          player.adp != null &&
                          estimatedValues?.get(
                            player.name.trim().toLowerCase(),
                          ) != null && (
                            <span className="text-muted-foreground">
                              ~$
                              {estimatedValues.get(
                                player.name.trim().toLowerCase(),
                              )}
                            </span>
                          )}
                      </span>
                    </div>
                  </div>

                  {/* Action */}
                  {isNominated ? (
                    <Badge className="bg-muted/60 text-muted-foreground border border-border text-xs shrink-0">
                      Nominated
                    </Badge>
                  ) : isRosterFull ? (
                    <Badge className="bg-destructive/10 text-destructive border border-destructive/30 text-xs shrink-0">
                      Roster full
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleNominate(player)}
                      disabled={nominatingId !== null || !isMyTurn}
                      className="bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-xs shrink-0 transition-smooth disabled:opacity-40"
                      data-ocid="nominate-btn"
                    >
                      {nominatingId === player.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        "Nominate"
                      )}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
