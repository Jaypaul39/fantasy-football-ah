import { useQuery } from "@tanstack/react-query";
import type { RoomId, StandingsEntry } from "../backend.d.ts";
import { useBackend } from "./useBackend";

/**
 * Fetches the league standings for a room.
 *
 * The backend returns the list deterministically ordered desc by totalPoints
 * then asc participantId, so a participant's rank is simply their index in
 * this list — never recomputed client-side. Every number shown comes directly
 * from getStandings.
 */
export function useGetStandings(roomId: RoomId | null | undefined): {
  standings: StandingsEntry[];
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading, error } = useQuery<StandingsEntry[], Error>({
    queryKey: ["standings", roomId],
    queryFn: async () => {
      if (!actor || !roomId) return [];
      const result = await actor.getStandings(roomId);
      if (result.__kind__ === "ok") return result.ok;
      return [];
    },
    enabled: !!actor && !isFetching && !!roomId,
    staleTime: 60_000,
  });

  return { standings: data ?? [], isLoading, error: error ?? null };
}
