import type { Principal } from "@icp-sdk/core/principal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserProfile } from "../types";
import { useBackend } from "./useBackend";

/**
 * Fetches the current user's profile (displayName).
 * Refetches every 5 seconds to pick up changes made on other sessions.
 */
/**
 * Fetches the current user's profile (displayName).
 * Refetches every 5 seconds to pick up changes made on other sessions.
 */
export function useProfile(): {
  profile: UserProfile | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading, error } = useQuery<UserProfile | null, Error>({
    queryKey: ["profile"],
    queryFn: async () => {
      if (!actor) return null;
      return actor.getProfile();
    },
    enabled: !!actor && !isFetching,
    refetchInterval: 5000,
    staleTime: 0,
  });

  return {
    profile: data ?? null,
    isLoading,
    error: error ?? null,
  };
}

/**
 * Query: fetch a display name for any user by principal.
 */
export function useDisplayName(userId: Principal | null): {
  displayName: string | null;
  isLoading: boolean;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading } = useQuery<string | null, Error>({
    queryKey: ["displayName", userId?.toText()],
    queryFn: async () => {
      if (!actor || !userId) return null;
      return actor.getDisplayName(userId);
    },
    enabled: !!actor && !isFetching && !!userId,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return {
    displayName: data ?? null,
    isLoading,
  };
}

/**
 * Mutation: update the user's display name.
 * Invalidates the profile query on success.
 */
/**
 * Mutation: update the user's display name.
 * Invalidates the profile query on success.
 */
export function useSetDisplayName() {
  const { actor } = useBackend();
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (name: string) => {
      if (!actor) throw new Error("Not connected");
      const result = await actor.setDisplayName(name);
      if (result.__kind__ === "err") throw new Error(result.err);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
  });
}

/**
 * Mutation: update the user's avatar URL (DiceBear style ID).
 * Invalidates the profile query and room queries on success.
 */
export function useSetAvatarUrl() {
  const { actor } = useBackend();
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (url: string) => {
      if (!actor) throw new Error("Not connected");
      const result = await actor.setAvatarUrl(url);
      if (result.__kind__ === "err") throw new Error(result.err);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["roomView"] });
    },
  });
}
