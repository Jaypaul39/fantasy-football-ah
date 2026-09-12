import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BestBallConfig,
  RoomId,
  UserId,
  WeeklyLineupView,
} from "../backend.d.ts";
import { useBackend } from "./useBackend";

/**
 * Fetches a participant's optimal weekly lineup for a single week.
 *
 * Cached per (room, participant, week) triple via the TanStack Query key so
 * repeated lookups of the same week never re-hit the backend. A week is
 * "synced" when the returned lineup's starters array has length > 0 — even if
 * individual slots have a null playerId. An unsynced week returns a lineup
 * with an empty starters array.
 */
export function useGetWeeklyLineup(
  roomId: RoomId | null | undefined,
  participantId: UserId | null | undefined,
  week: bigint | null | undefined,
): {
  lineup: WeeklyLineupView | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading, error } = useQuery<WeeklyLineupView | null, Error>({
    queryKey: [
      "weeklyLineup",
      roomId,
      participantId?.toText(),
      week?.toString(),
    ],
    queryFn: async () => {
      if (!actor || !roomId || !participantId || week == null) return null;
      const result = await actor.getWeeklyLineup(roomId, participantId, week);
      if (result.__kind__ === "ok") return result.ok;
      return null;
    },
    enabled:
      !!actor && !isFetching && !!roomId && !!participantId && week != null,
    staleTime: 60_000,
  });

  return { lineup: data ?? null, isLoading, error: error ?? null };
}

/**
 * Pure, testable current-week detector.
 *
 * Scans from `endWeek` DOWN to `startWeek` and returns the latest week for
 * which `isWeekSynced` returns true. A week is "synced" when its lineup's
 * starters array has length > 0 — never by inspecting individual playerId
 * values. If no week qualifies, returns `startWeek` (shown in its unsynced
 * state).
 */
export async function findCurrentWeek(
  config: BestBallConfig,
  isWeekSynced: (week: bigint) => boolean | Promise<boolean>,
): Promise<bigint> {
  // The endWeek field was removed from BestBallConfig, so scan from startWeek
  // upward and return the latest synced week. The scan is bounded by the NFL
  // regular-season length to avoid an unbounded loop.
  const start = Number(config.startWeek);
  const MAX_WEEK = 22;
  let current = start;
  for (let week = start; week <= MAX_WEEK; week++) {
    if (await isWeekSynced(BigInt(week))) {
      current = week;
    }
  }
  return BigInt(current);
}

/**
 * Determines the current week for a participant in a Best Ball room.
 *
 * Runs once per view load (no polling loop). Scans from endWeek down to
 * startWeek, checking each week's lineup via getWeeklyLineup. Each week's
 * result is written into the per-(room, participant, week) query cache so the
 * later useGetWeeklyLineup render fetch is a cache hit — no duplicate request.
 */
export function useCurrentWeek(
  roomId: RoomId | null | undefined,
  participantId: UserId | null | undefined,
  config: BestBallConfig | null | undefined,
): {
  currentWeek: bigint | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<bigint | null, Error>({
    queryKey: [
      "currentWeek",
      roomId,
      participantId?.toText(),
      config?.startWeek?.toString(),
    ],
    queryFn: async () => {
      if (!actor || !roomId || !participantId || !config) return null;
      return findCurrentWeek(config, async (week) => {
        const result = await actor.getWeeklyLineup(roomId, participantId, week);
        if (result.__kind__ !== "ok") return false;
        queryClient.setQueryData(
          ["weeklyLineup", roomId, participantId.toText(), week.toString()],
          result.ok,
        );
        return result.ok.starters.length > 0;
      });
    },
    enabled: !!actor && !isFetching && !!roomId && !!participantId && !!config,
    staleTime: 60_000,
  });

  return { currentWeek: data ?? null, isLoading, error: error ?? null };
}
