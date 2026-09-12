import type { Principal } from "@icp-sdk/core/principal";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  BestBallConfig,
  LineupSlot,
  RoomView,
  RosterSettings,
} from "../backend.d.ts";
import { useBackend } from "../hooks/useBackend";
import {
  type SyncStatus,
  useBestBallAutoSync,
} from "../hooks/useBestBallAutoSync";
import { useGetH2HStandings } from "../hooks/useGetH2HStandings";
import { useGetStandings } from "../hooks/useGetStandings";
import {
  useCurrentWeek,
  useGetWeeklyLineup,
} from "../hooks/useGetWeeklyLineup";
import { useGetWeeklyStandings } from "../hooks/useGetWeeklyStandings";
import type { H2HMatchup, MatchupResult } from "../types";
import { CompetitionMode } from "../types";

interface MyBestBallTeamTabProps {
  roomId: string;
  participantId: Principal | null;
  /** playerId -> display name, built from the participant's won players. */
  playerNames: Record<string, string>;
  rosterSettings?: RosterSettings;
  /** The room's season, passed from the room being viewed. */
  season?: bigint;
}

const SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX"];

// The final week of the season. The endWeek field was removed from
// BestBallConfig, so week navigation is bounded by this fixed constant.
const FINAL_WEEK = 17;

function positionClass(position: string): string {
  switch (position) {
    case "QB":
      return "pos-qb";
    case "RB":
      return "pos-rb";
    case "WR":
      return "pos-wr";
    case "TE":
      return "pos-te";
    default:
      return "pos-flex";
  }
}

function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

/** Builds the configured slot list (all empty) from roster settings. */
function buildEmptySlots(settings: RosterSettings): LineupSlot[] {
  const slots: LineupSlot[] = [];
  const push = (slot: string, count: bigint) => {
    for (let i = 0; i < Number(count); i++) {
      slots.push({ slot, position: slot, playerId: undefined, points: 0 });
    }
  };
  push("QB", settings.qb);
  push("RB", settings.rb);
  push("WR", settings.wr);
  push("TE", settings.te);
  push("FLEX", settings.flex);
  push("SUPERFLEX", settings.superflex);
  return slots;
}

/** Formats a sync timestamp as a short, calm "HH:MM" local time. */
function formatSyncTime(date: Date | null): string | null {
  if (!date) return null;
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Calm, ambient sync-status indicator. It is a quiet confidence signal, not a
 * live ticker: each state has distinct copy and a subtle visual treatment, and
 * it never flashes or cycles through "Syncing…" on routine no-op interval
 * ticks (the hook only reports 'syncing' while a fetch/submit is actually in
 * flight).
 */
function SyncStatusIndicator({
  status,
  lastSuccessfulSync,
}: {
  status: SyncStatus;
  lastSuccessfulSync: Date | null;
}) {
  if (status === "syncing") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-widest uppercase text-muted-foreground"
        data-ocid="sync-status-syncing"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-slow"
          aria-hidden="true"
        />
        Syncing
      </span>
    );
  }

  if (status === "updated") {
    const time = formatSyncTime(lastSuccessfulSync);
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-widest uppercase text-secondary"
        data-ocid="sync-status-updated"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-secondary"
          aria-hidden="true"
        />
        Stats updated{time ? ` · ${time}` : ""}
      </span>
    );
  }

  if (status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-widest uppercase text-destructive/90"
        data-ocid="sync-status-error"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-destructive"
          aria-hidden="true"
        />
        Stats unavailable
      </span>
    );
  }

  // up-to-date — the calm, neutral resting state.
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-widest uppercase text-muted-foreground"
      data-ocid="sync-status-up-to-date"
    >
      <span
        className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50"
        aria-hidden="true"
      />
      Stats up to date
    </span>
  );
}

// ── Head-to-Head schedule derivation ────────────────────────────────────────
// These helpers mirror the backend's pure derivation in lib/h2h.mo exactly.
// The H2H regular-season schedule is derived on demand from immutable inputs
// (frozen participants, startWeek, competitionMode/playoffTeams, FINAL_WEEK) —
// never stored. Replicating the circle method here lets the team tab resolve
// the weekly opponent without any new backend state.

/** Number of playoff rounds for a playoff-team count (0, 2 for 4, else 3). */
function playoffRounds(playoffTeams: number): number {
  if (playoffTeams === 0) return 0;
  if (playoffTeams === 4) return 2;
  return 3;
}

/** Number of regular-season rounds for a participant count. */
function numberOfRounds(count: number): number {
  if (count <= 1) return 0;
  return count % 2 === 0 ? count - 1 : count;
}

/** The last regular-season week: FINAL_WEEK - playoffRounds. */
function regularSeasonEnd(playoffTeams: number): number {
  return FINAL_WEEK - playoffRounds(playoffTeams);
}

/**
 * Derives the opponent for `myId` in `week` using the same round-robin circle
 * method the backend uses. Returns null when the week is outside the regular
 * season or the participant has no opponent (bye / too few teams).
 */
function deriveOpponent(
  participants: Principal[],
  myId: Principal,
  startWeek: number,
  playoffTeams: number,
  week: number,
): Principal | null {
  const ordered = [...participants].sort((a, b) => {
    const c = a.compareTo(b);
    return c === "lt" ? -1 : c === "gt" ? 1 : 0;
  });
  const n = ordered.length;
  const rounds = numberOfRounds(n);
  const end = regularSeasonEnd(playoffTeams);
  if (rounds === 0 || week < startWeek || week > end) return null;

  const m = n % 2 === 0 ? n : n + 1;
  // Initial circle: real participants followed by a bye sentinel when odd.
  const arr: (Principal | null)[] = [...ordered];
  if (m > n) arr.push(null);

  // Rotate positions 1..m-1 by one, `roundIdx` times (position 0 stays fixed).
  const roundIdx = (week - startWeek) % rounds;
  for (let r = 0; r < roundIdx; r++) {
    const last = arr[m - 1];
    for (let j = m - 1; j > 1; j--) {
      arr[j] = arr[j - 1];
    }
    arr[1] = last;
  }

  // Pair position i with position (m-1-i); find the pair containing myId.
  for (let i = 0; i < m / 2; i++) {
    const a = arr[i];
    const b = arr[m - 1 - i];
    if (a == null || b == null) continue;
    if (a.toText() === myId.toText()) return b;
    if (b.toText() === myId.toText()) return a;
  }
  return null;
}

/**
 * "My Best Ball Team" dashboard for #BestBall rooms.
 *
 * Shows only the authenticated participant's own data. For #Cumulative rooms
 * it keeps the existing best-ball behavior: the selected week's optimal lineup
 * and the participant's rank for that week read directly from
 * getWeeklyStandings, plus the cumulative season snapshot from getStandings.
 * For #HeadToHead rooms it branches to show the weekly matchup (opponent, both
 * scores, W/L/T outcome) derived from the backend's round-robin pairing table,
 * and the season W-L-T record and pointsFor from getH2HStandings. No other
 * participant's lineup or data is rendered beyond the H2H opponent, and no
 * client-side scoring or lineup-optimization is performed.
 */
export function MyBestBallTeamTab({
  roomId,
  participantId,
  playerNames,
  rosterSettings,
  season: seasonProp,
}: MyBestBallTeamTabProps) {
  const { actor, isFetching } = useBackend();

  const { data: config } = useQuery<BestBallConfig | null>({
    queryKey: ["bestBallConfig", roomId],
    queryFn: async () => {
      if (!actor) return null;
      return actor.getBestBallConfig(roomId);
    },
    enabled: !!actor && !isFetching && !!roomId,
    staleTime: 60_000,
  });

  // Room state supplies the immutable competitionMode and the frozen
  // participant list needed to derive the H2H schedule. Reuses the same query
  // key as useRoomPolling so the already-polled room view is shared.
  const { data: roomView } = useQuery<RoomView | null>({
    queryKey: ["room", roomId],
    queryFn: async () => {
      if (!actor) return null;
      const result = await actor.getRoomState(roomId);
      if (result.__kind__ === "ok") return result.ok;
      return null;
    },
    enabled: !!actor && !isFetching && !!roomId,
    staleTime: 60_000,
  });

  const competitionMode = roomView?.room.competitionMode ?? null;
  const isH2H = competitionMode === CompetitionMode.HeadToHead;
  const participants = roomView?.room.participants ?? [];
  const playoffTeams = Number(roomView?.room.playoffTeams ?? 0);

  // Automatic sync trigger (ported from AdminPanel's Phase 4 pattern): fires on
  // load, on a recurring interval, and on visibilitychange catch-up so the
  // participant viewing this score view gets fresh scores. Scoped to active
  // viewing — this component is only mounted while the My Team tab is active.
  const season = seasonProp ?? roomView?.room.season ?? null;
  const { status: syncStatus, lastSuccessfulSync } = useBestBallAutoSync(
    roomId,
    season,
    true,
  );

  const { currentWeek } = useCurrentWeek(roomId, participantId, config);

  // Week selector state. Defaults to the current week once it resolves; the
  // user may navigate to any week within startWeek..endWeek.
  const [selectedWeek, setSelectedWeek] = useState<bigint | null>(null);

  useEffect(() => {
    if (currentWeek != null && selectedWeek == null) {
      setSelectedWeek(currentWeek);
    }
  }, [currentWeek, selectedWeek]);

  const startWeek = config?.startWeek ?? null;
  const atStart =
    selectedWeek != null && startWeek != null && selectedWeek <= startWeek;
  // The endWeek field was removed from BestBallConfig; the next-week button is
  // bounded by the fixed FINAL_WEEK constant instead.
  const atEnd = selectedWeek != null && selectedWeek >= BigInt(FINAL_WEEK);

  const { lineup, isLoading: lineupLoading } = useGetWeeklyLineup(
    roomId,
    participantId,
    selectedWeek,
  );
  const { standings: weeklyStandings, isLoading: weeklyStandingsLoading } =
    useGetWeeklyStandings(roomId, selectedWeek);
  const { standings, isLoading: standingsLoading } = useGetStandings(roomId);
  const { standings: h2hStandings, isLoading: h2hStandingsLoading } =
    useGetH2HStandings(roomId);

  // A week is "unsynced" when its lineup's starters array is empty. A synced
  // week — even a zero-point one — always returns a full array of slot entries.
  const isUnsynced = !!lineup && lineup.starters.length === 0;

  // Slots to render: the selected week's starters when synced, otherwise the
  // configured slots shown in their empty/unsynced state.
  const slots = useMemo<LineupSlot[]>(() => {
    if (lineup && lineup.starters.length > 0) {
      return [...lineup.starters].sort(
        (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot),
      );
    }
    if (rosterSettings) return buildEmptySlots(rosterSettings);
    return [];
  }, [lineup, rosterSettings]);

  // Season snapshot: the authenticated participant's entry in the already
  // ordered getStandings list. Rank = index in that list; total read directly.
  const myStanding = useMemo(() => {
    if (!participantId) return null;
    return (
      standings.find(
        (s) => s.participantId.toText() === participantId.toText(),
      ) ?? null
    );
  }, [standings, participantId]);

  const rank = myStanding ? standings.indexOf(myStanding) + 1 : null;
  const seasonTotal = myStanding?.totalPoints ?? null;

  // Weekly rank: the viewer's entry in the selected week's ordered
  // getWeeklyStandings list, filtered to the viewer client-side. Only the
  // viewer's own entry is read — other participants' entries are never rendered.
  const weeklyMyStanding = useMemo(() => {
    if (!participantId) return null;
    return (
      weeklyStandings.find(
        (s) => s.participantId.toText() === participantId.toText(),
      ) ?? null
    );
  }, [weeklyStandings, participantId]);

  const weeklyRank = weeklyMyStanding
    ? weeklyStandings.indexOf(weeklyMyStanding) + 1
    : null;

  const weeklyTotal = lineup?.total ?? 0;
  const displayName = lineup?.displayName ?? "My Best Ball Team";

  // ── Head-to-Head weekly matchup ──────────────────────────────────────────
  // The opponent for the selected week is derived from the backend's pairing
  // table; both scores come from each team's optimal weekly lineup.
  const opponentId = useMemo<Principal | null>(() => {
    if (!isH2H || !participantId || !selectedWeek || startWeek == null) {
      return null;
    }
    return deriveOpponent(
      participants,
      participantId,
      Number(startWeek),
      playoffTeams,
      Number(selectedWeek),
    );
  }, [
    isH2H,
    participantId,
    selectedWeek,
    participants,
    startWeek,
    playoffTeams,
  ]);

  const { lineup: opponentLineup } = useGetWeeklyLineup(
    roomId,
    opponentId,
    selectedWeek,
  );

  const matchup = useMemo<H2HMatchup | null>(() => {
    if (!isH2H || !opponentId || !lineup || !opponentLineup || !selectedWeek) {
      return null;
    }
    // Unsynced weeks show no result.
    if (lineup.starters.length === 0 || opponentLineup.starters.length === 0) {
      return null;
    }
    const teamScore = lineup.total;
    const opponentScore = opponentLineup.total;
    let result: MatchupResult = "tie";
    if (teamScore > opponentScore) result = "win";
    else if (teamScore < opponentScore) result = "loss";
    return {
      week: Number(selectedWeek),
      opponentName: opponentLineup.displayName ?? "Opponent",
      teamScore,
      opponentScore,
      result,
    };
  }, [isH2H, opponentId, lineup, opponentLineup, selectedWeek]);

  // ── Head-to-Head season record ───────────────────────────────────────────
  const myH2H = useMemo(() => {
    if (!participantId) return null;
    return (
      h2hStandings.find(
        (s) => s.participant.toText() === participantId.toText(),
      ) ?? null
    );
  }, [h2hStandings, participantId]);

  const h2hWins = myH2H ? Number(myH2H.wins) : null;
  const h2hLosses = myH2H ? Number(myH2H.losses) : null;
  const h2hTies = myH2H ? Number(myH2H.ties) : null;
  const h2hPointsFor = myH2H?.pointsFor ?? null;

  const loading =
    lineupLoading ||
    weeklyStandingsLoading ||
    standingsLoading ||
    (isH2H && h2hStandingsLoading) ||
    !selectedWeek;

  return (
    <div className="space-y-4" data-ocid="best-ball-team-view">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-foreground">
          {displayName}
        </h2>
        <div className="flex items-center gap-3">
          <SyncStatusIndicator
            status={syncStatus}
            lastSuccessfulSync={lastSuccessfulSync}
          />
          {selectedWeek != null && (
            <span
              className="font-mono text-xs text-muted-foreground"
              data-ocid="bestball-current-week"
            >
              Week {Number(selectedWeek)}
            </span>
          )}
        </div>
      </div>

      {/* ── Week selector ── */}
      <div
        className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
        data-ocid="bestball-week-selector"
      >
        <button
          type="button"
          className="week-nav-button"
          onClick={() =>
            setSelectedWeek((w) => (w != null ? w - BigInt(1) : w))
          }
          disabled={atStart || selectedWeek == null}
          aria-label="Previous week"
          data-ocid="bestball-week-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-center">
          <p className="font-mono text-xs font-bold tracking-widest uppercase text-muted-foreground">
            Week
          </p>
          <p
            className="font-display text-lg font-bold text-foreground"
            data-ocid="bestball-week-label"
          >
            {selectedWeek != null ? Number(selectedWeek) : "—"}
          </p>
        </div>
        <button
          type="button"
          className="week-nav-button"
          onClick={() =>
            setSelectedWeek((w) => (w != null ? w + BigInt(1) : w))
          }
          disabled={atEnd || selectedWeek == null}
          aria-label="Next week"
          data-ocid="bestball-week-next"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* ── Selected Week's Lineup ── */}
        <div className="lg:col-span-3 space-y-3">
          {/* Head-to-Head weekly matchup */}
          {isH2H && (
            <div className="matchup-card" data-ocid="h2h-matchup">
              <h3 className="h2h-section-label mb-3">
                Week {selectedWeek != null ? Number(selectedWeek) : "—"} Matchup
              </h3>
              {matchup ? (
                <>
                  <div className="matchup-team">
                    <span className="matchup-team-name">{displayName}</span>
                    <span
                      className={`matchup-team-score ${matchup.result}`}
                      data-ocid="h2h-matchup-team-score"
                    >
                      {matchup.teamScore.toFixed(2)}
                    </span>
                  </div>
                  <div className="matchup-team">
                    <span className="matchup-team-name">
                      {matchup.opponentName}
                    </span>
                    <span
                      className={`matchup-team-score ${
                        matchup.result === "win"
                          ? "loss"
                          : matchup.result === "loss"
                            ? "win"
                            : "tie"
                      }`}
                      data-ocid="h2h-matchup-opponent-score"
                    >
                      {matchup.opponentScore.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <span
                      className={`matchup-result-badge ${matchup.result}`}
                      data-ocid="h2h-matchup-result"
                    >
                      {matchup.result === "win"
                        ? "Win"
                        : matchup.result === "loss"
                          ? "Loss"
                          : "Tie"}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No result for this week yet.
                </p>
              )}
            </div>
          )}

          <h3 className="font-mono text-xs font-bold tracking-widest uppercase text-muted-foreground">
            Week {selectedWeek != null ? Number(selectedWeek) : "—"} Lineup
          </h3>

          {loading ? (
            <div className="space-y-2" data-ocid="bestball-loading">
              {["qb", "rb", "wr", "te", "flex", "superflex", "bench"].map(
                (id) => (
                  <div
                    key={id}
                    className="slot-card skeleton-shimmer h-14"
                    aria-hidden="true"
                  />
                ),
              )}
            </div>
          ) : isUnsynced ? (
            <div className="unsynced-card" data-ocid="bestball-unsynced">
              <p className="font-display text-base font-bold text-foreground">
                Week {Number(selectedWeek)} hasn&apos;t synced yet
              </p>
              <p className="text-sm text-muted-foreground">
                Stats for this week haven&apos;t been processed. Check back once
                the week&apos;s games have been synced.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {slots.map((slot, i) => {
                const filled = !!slot.playerId;
                return (
                  <div
                    key={`${slot.slot}-${i}`}
                    className={`slot-card ${filled ? "filled" : "empty"}`}
                    data-ocid={`bestball-slot-${i + 1}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`slot-position ${positionClass(slot.position)}`}
                      >
                        {slot.slot}
                      </span>
                      {filled ? (
                        <span className="slot-player">
                          {playerNames[slot.playerId!] ?? slot.playerId}
                        </span>
                      ) : (
                        <span className="slot-empty-label">No player</span>
                      )}
                    </div>
                    <span className="slot-points">
                      {filled ? slot.points.toFixed(2) : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Bench ── */}
          {!loading && !isUnsynced && lineup && lineup.bench.length > 0 && (
            <div className="space-y-2 pt-2">
              <h3 className="font-mono text-xs font-bold tracking-widest uppercase text-muted-foreground">
                Bench
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {lineup.bench.map((b, i) => (
                  <div
                    key={`${b.playerId}-${i}`}
                    className="bench-row"
                    data-ocid={`bestball-bench-${i + 1}`}
                  >
                    <span className="bench-name">
                      {playerNames[b.playerId] ?? b.playerId}
                    </span>
                    <span className="bench-points">{b.points.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Weekly total ── */}
          {!loading && !isUnsynced && (
            <div className="total-banner" data-ocid="bestball-weekly-total">
              <span className="total-label">Weekly Total</span>
              <span className="total-value">{weeklyTotal.toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* ── Season Snapshot ── */}
        <div className="lg:col-span-1">
          {isH2H ? (
            <div className="snapshot-card" data-ocid="h2h-snapshot">
              <h3 className="h2h-section-label mb-4">Season Record</h3>
              <div className="space-y-5">
                <div>
                  <p className="snapshot-label">Record</p>
                  <p
                    className="wl-record text-lg font-bold"
                    data-ocid="h2h-record"
                  >
                    <span className="wl-record win">
                      {h2hWins != null ? h2hWins : "—"}
                    </span>
                    <span className="text-muted-foreground"> - </span>
                    <span className="wl-record loss">
                      {h2hLosses != null ? h2hLosses : "—"}
                    </span>
                    <span className="text-muted-foreground"> - </span>
                    <span className="wl-record tie">
                      {h2hTies != null ? h2hTies : "—"}
                    </span>
                  </p>
                </div>
                <div>
                  <p className="snapshot-label">Points For</p>
                  <p className="pf-value text-2xl" data-ocid="h2h-points-for">
                    {h2hPointsFor != null ? h2hPointsFor.toFixed(2) : "—"}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="snapshot-card" data-ocid="bestball-snapshot">
              <h3 className="font-mono text-xs font-bold tracking-widest uppercase text-muted-foreground mb-4">
                Season Snapshot
              </h3>
              <div className="space-y-5">
                <div>
                  <p className="snapshot-label">Best Ball Score</p>
                  <p
                    className="snapshot-stat"
                    data-ocid="bestball-season-total"
                  >
                    {seasonTotal != null ? seasonTotal.toFixed(2) : "—"}
                  </p>
                </div>
                <div>
                  <p className="snapshot-label">Rank</p>
                  <span
                    className={`rank-badge ${rank === 1 ? "top" : ""}`}
                    data-ocid="bestball-rank"
                  >
                    <Trophy className="h-3.5 w-3.5" />
                    {rank != null ? ordinal(rank) : "—"}
                  </span>
                </div>
                <div>
                  <p className="snapshot-label">
                    Week {selectedWeek != null ? Number(selectedWeek) : "—"}{" "}
                    Rank
                  </p>
                  <span
                    className={`rank-badge ${weeklyRank === 1 ? "top" : ""}`}
                    data-ocid="bestball-weekly-rank"
                  >
                    <Trophy className="h-3.5 w-3.5" />
                    {weeklyRank != null ? ordinal(weeklyRank) : "—"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
