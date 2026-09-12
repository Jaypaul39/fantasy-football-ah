import { useQuery } from "@tanstack/react-query";
import type { H2HStandingEntry, RoomId } from "../backend.d.ts";
import { useBackend } from "./useBackend";

/**
 * Fetches the head-to-head (H2H) standings for a room.
 *
 * The backend returns the list deterministically ordered by the H2H tiebreak
 * rules (wins desc, then pointsFor desc, then participantId asc), so a
 * participant's rank is simply their index in this list — never recomputed
 * client-side. Every number shown comes directly from getH2HStandings.
 */
export function useGetH2HStandings(roomId: RoomId | null | undefined): {
  standings: H2HStandingEntry[];
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading, error } = useQuery<H2HStandingEntry[], Error>({
    queryKey: ["h2h-standings", roomId],
    queryFn: async () => {
      if (!actor || !roomId) return [];
      const result = await actor.getH2HStandings(roomId);
      if (result.__kind__ === "ok") return result.ok;
      return [];
    },
    enabled: !!actor && !isFetching && !!roomId,
    staleTime: 60_000,
  });

  return { standings: data ?? [], isLoading, error: error ?? null };
}
