import { useQuery } from "@tanstack/react-query";
import type { PlayoffBracketResult, RoomId } from "../backend.d.ts";
import { useBackend } from "./useBackend";

/**
 * Fetches the read-only playoff bracket for a Head-to-Head room.
 *
 * The backend derives the fixed-slot bracket on demand (never stored) and
 * resolves each game's home/away slots and status, distinguishing
 * `pendingOnSync` (awaiting the weekly stats sync) from `pendingOnDependency`
 * (waiting on an earlier game's winner). The champion is computed on demand
 * and returned once the final game resolves, or `inProgress` otherwise.
 */
export function useGetPlayoffBracket(roomId: RoomId | null | undefined): {
  bracket: PlayoffBracketResult | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading, error } = useQuery<
    PlayoffBracketResult | null,
    Error
  >({
    queryKey: ["playoff-bracket", roomId],
    queryFn: async () => {
      if (!actor || !roomId) return null;
      const result = await actor.getPlayoffBracket(roomId);
      if (result.__kind__ === "ok") return result.ok;
      return null;
    },
    enabled: !!actor && !isFetching && !!roomId,
    staleTime: 60_000,
  });

  return { bracket: data ?? null, isLoading, error: error ?? null };
}
