import { useCallback, useState } from "react";

const STORAGE_KEY_PREFIX = "ffah_watchlist_";

export function useWatchlist(roomId: string) {
  const STORAGE_KEY = `${STORAGE_KEY_PREFIX}${roomId}`;

  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    } catch {
      return [];
    }
  });

  const toggle = useCallback(
    (playerId: string) => {
      setWatchlist((prev) => {
        const next = prev.includes(playerId)
          ? prev.filter((id) => id !== playerId)
          : [...prev, playerId];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    [STORAGE_KEY],
  );

  const isWatched = useCallback(
    (playerId: string) => watchlist.includes(playerId),
    [watchlist],
  );

  const clear = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setWatchlist([]);
  }, [STORAGE_KEY]);

  return { watchlist, toggle, isWatched, clear };
}
