import type { Principal } from "@icp-sdk/core/principal";
import { useQuery } from "@tanstack/react-query";
import type { BestBallConfig, Room } from "../backend.d.ts";
import { useBackend } from "../hooks/useBackend";
import {
  type SyncStatus,
  useBestBallAutoSync,
} from "../hooks/useBestBallAutoSync";
import { useGetH2HStandings } from "../hooks/useGetH2HStandings";
import { useGetStandings } from "../hooks/useGetStandings";
import { useCurrentWeek } from "../hooks/useGetWeeklyLineup";
import { CompetitionMode } from "../types";

interface StandingsTabProps {
  roomId: string;
  participantId: Principal | null;
  /** The room's season, passed from the room being viewed. */
  season?: bigint;
}

/**
 * League-wide standings table for #BestBall rooms.
 *
 * Branches on the room's immutable competitionMode without duplicating the
 * component:
 *  - #Cumulative rooms keep the existing behavior exactly: one row per entry
 *    in the getStandings result, in the order the backend returned (desc by
 *    totalPoints, then asc participantId). Rank is the entry's index + 1 —
 *    never recomputed client-side and never shared on ties.
 *  - #HeadToHead rooms render Rank / Team / W / L / T / PF from
 *    getH2HStandings, which the backend already orders by wins desc then
 *    pointsFor desc. Rank is again the entry's index + 1.
 *
 * The "Standings through Week X" label sources X from the shared useCurrentWeek
 * hook; no per-week fetching or completeness claims are made here.
 */
export function StandingsTab({
  roomId,
  participantId,
  season: seasonProp,
}: StandingsTabProps) {
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

  const { data: room } = useQuery<Room | null>({
    queryKey: ["room-standings", roomId],
    queryFn: async () => {
      if (!actor) return null;
      const result = await actor.getRoomState(roomId);
      if (result.__kind__ === "ok") return result.ok.room;
      return null;
    },
    enabled: !!actor && !isFetching && !!roomId,
    staleTime: 60_000,
  });

  const isH2H = room?.competitionMode === CompetitionMode.HeadToHead;

  // Automatic sync trigger (ported from AdminPanel's Phase 4 pattern): fires on
  // load, on a recurring interval, and on visibilitychange catch-up so the
  // participant viewing this score view gets fresh scores. Scoped to active
  // viewing — this component is only mounted while the Standings tab is active.
  const season = seasonProp ?? room?.season ?? null;
  const { status, lastSuccessfulSync } = useBestBallAutoSync(
    roomId,
    season,
    true,
  );

  const { currentWeek } = useCurrentWeek(roomId, participantId, config);
  const { standings, isLoading } = useGetStandings(roomId);
  const h2h = useGetH2HStandings(roomId);

  return (
    <div className="space-y-4" data-ocid="standings-view">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-foreground">
          Standings
        </h2>
        <div className="flex items-center gap-3">
          {currentWeek != null && (
            <span
              className="font-mono text-xs text-muted-foreground"
              data-ocid="standings-through-week"
            >
              Standings through Week {Number(currentWeek)}
            </span>
          )}
          <SyncStatusIndicator status={status} lastSync={lastSuccessfulSync} />
        </div>
      </div>

      {isH2H ? (
        <H2HStandingsTable
          standings={h2h.standings}
          isLoading={h2h.isLoading}
        />
      ) : (
        <CumulativeStandingsTable standings={standings} isLoading={isLoading} />
      )}
    </div>
  );
}

interface SyncStatusIndicatorProps {
  status: SyncStatus;
  lastSync: Date | null;
}

/**
 * Calm, ambient confidence signal for the auto-sync flow. It is intentionally
 * subtle — a small pill that never flashes or cycles through 'Syncing…' on
 * routine no-op interval ticks. Each state has distinct copy and a muted
 * visual treatment:
 *  - 'up-to-date'  → neutral "Stats up to date"
 *  - 'updated'     → "Stats updated" plus the last-sync time
 *  - 'error'       → a distinct error message
 *  - 'syncing'     → a subtle, non-animated "Syncing…" indication
 */
function SyncStatusIndicator({ status, lastSync }: SyncStatusIndicatorProps) {
  if (status === "up-to-date") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-widest uppercase text-muted-foreground"
        data-ocid="standings-sync-status"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50"
          aria-hidden="true"
        />
        Stats up to date
      </span>
    );
  }

  if (status === "updated") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-widest uppercase text-secondary"
        data-ocid="standings-sync-status"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-secondary"
          aria-hidden="true"
        />
        Stats updated
        {lastSync != null && (
          <span className="normal-case text-muted-foreground">
            {lastSync.toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        )}
      </span>
    );
  }

  if (status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-widest uppercase text-destructive"
        data-ocid="standings-sync-status"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-destructive"
          aria-hidden="true"
        />
        Stats sync unavailable
      </span>
    );
  }

  // 'syncing' — a subtle, static indication. No animation, so it never draws
  // attention or flickers on routine ticks.
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-widest uppercase text-muted-foreground"
      data-ocid="standings-sync-status"
    >
      <span
        className="h-1.5 w-1.5 rounded-full bg-primary/60"
        aria-hidden="true"
      />
      Syncing…
    </span>
  );
}

interface CumulativeStandingsTableProps {
  standings: Array<{
    participantId: Principal;
    displayName: string;
    totalPoints: number;
  }>;
  isLoading: boolean;
}

function CumulativeStandingsTable({
  standings,
  isLoading,
}: CumulativeStandingsTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2" data-ocid="standings-loading">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="slot-card skeleton-shimmer h-14"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="bg-card border border-border rounded-xl overflow-hidden"
      data-ocid="standings-table"
    >
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b border-border/60">
            <th className="w-16 px-4 py-3 text-left font-mono text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Rank
            </th>
            <th className="px-4 py-3 text-left font-mono text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Team
            </th>
            <th className="w-24 px-4 py-3 text-right font-mono text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {standings.map((entry, i) => (
            <tr
              key={entry.participantId.toText()}
              className="border-b border-border/40 last:border-0"
              data-ocid={`standings-row-${i + 1}`}
            >
              <td className="px-4 py-3">
                <span
                  className={`rank-badge ${i === 0 ? "top" : ""}`}
                  data-ocid={`standings-rank-${i + 1}`}
                >
                  {i + 1}
                </span>
              </td>
              <td className="px-4 py-3">
                <span
                  className="block truncate font-display font-semibold text-foreground"
                  data-ocid={`standings-team-${i + 1}`}
                >
                  {entry.displayName}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <span
                  className="font-mono font-bold text-primary"
                  data-ocid={`standings-total-${i + 1}`}
                >
                  {entry.totalPoints.toFixed(2)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface H2HStandingsTableProps {
  standings: Array<{
    participant: Principal;
    displayName: string;
    wins: bigint;
    losses: bigint;
    ties: bigint;
    pointsFor: number;
  }>;
  isLoading: boolean;
}

function H2HStandingsTable({ standings, isLoading }: H2HStandingsTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2" data-ocid="h2h-standings-loading">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="slot-card skeleton-shimmer h-14"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="h2h-section-label" data-ocid="h2h-standings-label">
        Head-to-Head
      </p>
      <div
        className="bg-card border border-border rounded-xl overflow-hidden"
        data-ocid="h2h-standings-table"
      >
        <table className="standings-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Team</th>
              <th className="numeric">W</th>
              <th className="numeric">L</th>
              <th className="numeric">T</th>
              <th className="numeric">PF</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((entry, i) => (
              <tr
                key={entry.participant.toText()}
                data-ocid={`h2h-standings-row-${i + 1}`}
              >
                <td>
                  <span
                    className={`standings-rank ${i === 0 ? "top" : ""}`}
                    data-ocid={`h2h-standings-rank-${i + 1}`}
                  >
                    {i + 1}
                  </span>
                </td>
                <td>
                  <span
                    className="standings-team block truncate"
                    data-ocid={`h2h-standings-team-${i + 1}`}
                  >
                    {entry.displayName}
                  </span>
                </td>
                <td className="numeric">
                  <span
                    className="wl-record win"
                    data-ocid={`h2h-standings-wins-${i + 1}`}
                  >
                    {Number(entry.wins)}
                  </span>
                </td>
                <td className="numeric">
                  <span
                    className="wl-record loss"
                    data-ocid={`h2h-standings-losses-${i + 1}`}
                  >
                    {Number(entry.losses)}
                  </span>
                </td>
                <td className="numeric">
                  <span
                    className="wl-record tie"
                    data-ocid={`h2h-standings-ties-${i + 1}`}
                  >
                    {Number(entry.ties)}
                  </span>
                </td>
                <td className="numeric">
                  <span
                    className="pf-value"
                    data-ocid={`h2h-standings-pf-${i + 1}`}
                  >
                    {entry.pointsFor.toFixed(2)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
