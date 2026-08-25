import { useQuery } from "@tanstack/react-query";
import { type NewsItem, parseRss } from "../lib/rss-parser";
import { useBackend } from "./useBackend";

// Sane client-side default (15 min) used until the backend interval is known,
// and as a floor so the frontend never refreshes more aggressively than the
// backend's configured cache — the backend cache is the source of truth.
const DEFAULT_STALE_MS = 15 * 60 * 1000;

export function useNflNews() {
  const { actor } = useBackend();

  // Pull the backend-configured refresh interval so the frontend staleTime can
  // never drift out of sync with the backend cache. We keep the default as a
  // floor and never go below it, since the backend cache is the actual source
  // of truth regardless of what the frontend requests.
  const { data: refreshIntervalSecs } = useQuery<bigint>({
    queryKey: ["rss-refresh-interval-secs"],
    queryFn: async () => {
      if (!actor) return BigInt(DEFAULT_STALE_MS / 1000);
      return actor.getRssRefreshIntervalSecs();
    },
    enabled: !!actor,
    staleTime: DEFAULT_STALE_MS,
  });

  const staleTime = (() => {
    const backendMs = refreshIntervalSecs
      ? Number(refreshIntervalSecs) * 1000
      : DEFAULT_STALE_MS;
    // Never go below the default — the backend cache is the source of truth,
    // so refreshing more aggressively than the default would only add round
    // trips without yielding fresher data.
    return Math.max(backendMs, DEFAULT_STALE_MS);
  })();

  const {
    data: newsItems,
    isLoading,
    error,
    refetch,
  } = useQuery<NewsItem[]>({
    queryKey: ["nfl-news"],
    queryFn: async () => {
      if (!actor) return [];
      const xml = await actor.fetchRssFeeds();
      return parseRss(xml);
    },
    enabled: !!actor,
    staleTime,
  });

  return { newsItems: newsItems ?? [], isLoading, error, refetch };
}
