import { useQuery } from "@tanstack/react-query";
import type { RoomId, StandingsEntry } from "../backend.d.ts";
import { useBackend } from "./useBackend";

/**
 * Fetches the league standings for a single week of a Best Ball room.
 *
 * Cached per (room, week) pair via the TanStack Query key so repeated lookups
 * of the same week never re-hit the backend. The backend returns the list
 * deterministically ordered desc by totalPoints then asc participantId, so a
 * participant's rank for the week is simply their index in this list — never
 * recomputed client-side. A fully unsynced week returns a valid all-zero list
 * (not an error).
 */
export function useGetWeeklyStandings(
  roomId: RoomId | null | undefined,
  week: bigint | null | undefined,
): {
  standings: StandingsEntry[];
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading, error } = useQuery<StandingsEntry[], Error>({
    queryKey: ["weeklyStandings", roomId, week?.toString()],
    queryFn: async () => {
      if (!actor || !roomId || week == null) return [];
      const result = await actor.getWeeklyStandings(roomId, week);
      if (result.__kind__ === "ok") return result.ok;
      return [];
    },
    enabled: !!actor && !isFetching && !!roomId && week != null,
    staleTime: 60_000,
  });

  return { standings: data ?? [], isLoading, error: error ?? null };
}
