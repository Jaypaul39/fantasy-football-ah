import { useEffect, useRef, useState } from "react";
import type { RoomId, WeeklyPlayerStats } from "../backend.d.ts";
import { useBackend } from "./useBackend";

// ── Sleeper import types ───────────────────────────────────────────────────
interface SleeperPlayer {
  player_id: string;
  full_name?: string;
  position?: string;
  team?: string;
  years_exp?: number | null;
  active?: boolean;
  status?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// Module-scoped in-session in-flight guard: a Set of "season:week" keys
// currently being synced. It lives at module scope (not in a useRef) so it
// survives a component remount within the same app session — a remount while a
// sync is still in-flight must not start a second concurrent fetch for the
// same (season, week). It is shared across every Best Ball score view instance
// so switching between My Team and Standings never double-fetches. The
// backend's atomic guard remains the real correctness guarantee; this is purely
// an optimization to avoid hammering Sleeper.
const inFlightSyncKeys = new Set<string>();

/**
 * Calm ambient confidence signal for the auto-sync flow, derived entirely from
 * the existing syncWeeklyStats #ok n count and the Sleeper fetch outcome:
 * - 'syncing'     — a fetch/submit is currently in progress
 * - 'updated'     — new data was stored (#ok n with n > 0); lastSuccessfulSync set
 * - 'up-to-date'  — nothing new to store (#ok 0 cooldown no-op or empty batch)
 * - 'error'       — a Sleeper fetch failed or syncWeeklyStats returned #err
 */
export type SyncStatus = "syncing" | "updated" | "up-to-date" | "error";

export interface SyncStatusInfo {
  status: SyncStatus;
  lastSuccessfulSync: Date | null;
}

// Per-week outcome of the shared fetch+parse+submit flow, aggregated by
// runAutoSync into the single hook-level SyncStatus.
type SyncOutcome = "updated" | "up-to-date" | "error";

/**
 * Ports the Phase 4 automatic sync-trigger pattern from AdminPanel.tsx into the
 * Best Ball score views (My Team / Standings) so any participant actively
 * viewing them gets fresh scores.
 *
 * The mechanism is reused as-is — fire on load, on a recurring interval, and on
 * visibilitychange catch-up — guarded by a lastAutoSyncRef rate-limit and an
 * inFlightSyncKeys dedupe. It calls getFlaggedWeeks() then, for each flagged
 * week matching the current room's season, runs the shared fetch+parse+submit
 * flow that ends in syncWeeklyStats(roomId, season, week, batch). The backend
 * authorizes participants of the room and applies its 75s cooldown no-op, so
 * the frontend only needs to make the call.
 *
 * `enabled` scopes the trigger to active viewing: the caller passes true only
 * while the score content is mounted/active, so the sync never runs app-wide.
 */
export function useBestBallAutoSync(
  roomId: RoomId | null | undefined,
  season: bigint | null | undefined,
  enabled: boolean,
) {
  const { actor } = useBackend();
  const lastAutoSyncRef = useRef(0);
  const playerListRef = useRef<Record<string, SleeperPlayer> | null>(null);
  const [status, setStatus] = useState<SyncStatus>("up-to-date");
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<Date | null>(
    null,
  );

  // Shared fetch+parse+submit flow (ported from AdminPanel.runWeeklyStatsSync):
  // fetches Sleeper's weekly stats map directly in the browser, filters out
  // team-defense keys and K/DST players, maps raw categories into
  // WeeklyPlayerStats, then calls actor.syncWeeklyStats with the roomId.
  const runWeeklyStatsSync = async (
    seasonNum: number,
    weekNum: number,
  ): Promise<SyncOutcome | null> => {
    if (!actor || !roomId || season == null) return null;
    const key = `${seasonNum}:${weekNum}`;
    // Skip if this (season, week) is already in-flight in this session.
    if (inFlightSyncKeys.has(key)) return null;
    inFlightSyncKeys.add(key);
    // A fetch/submit is now in progress for this week.
    setStatus("syncing");

    try {
      // Fetch the weekly stats map: player-ID keys → raw stat objects.
      const statsResponse = await fetch(
        `https://api.sleeper.app/v1/stats/nfl/regular/${seasonNum}/${weekNum}`,
      );
      if (!statsResponse.ok) return "error";
      const statsRaw: Record<
        string,
        Record<string, number>
      > = await statsResponse.json();

      // The stats response does not carry position. Cross-reference the player
      // list (the same one the player import fetches) to exclude K/DST. Cache
      // it so a second sync reuses it.
      if (!playerListRef.current) {
        const playersResponse = await fetch(
          "https://api.sleeper.app/v1/players/nfl",
        );
        if (!playersResponse.ok) return "error";
        playerListRef.current = (await playersResponse.json()) as Record<
          string,
          SleeperPlayer
        >;
      }
      const players = playerListRef.current;

      const batch: WeeklyPlayerStats[] = [];
      for (const [playerId, stats] of Object.entries(statsRaw)) {
        // Skip any key that is not purely numeric (team defense entries like
        // 'TEAM_BUF' or 'BUF').
        if (!/^\d+$/.test(playerId)) continue;
        // Skip K and DST players using the player metadata.
        const pos = players[playerId]?.position ?? "";
        if (pos === "K" || pos === "DST") continue;
        // Map raw Sleeper categories → WeeklyPlayerStats, defaulting to 0.
        batch.push({
          playerId,
          season: BigInt(seasonNum),
          week: BigInt(weekNum),
          passYds: BigInt(stats.pass_yd ?? 0),
          passTds: BigInt(stats.pass_td ?? 0),
          ints: BigInt(stats.pass_int ?? 0),
          rushYds: BigInt(stats.rush_yd ?? 0),
          rushTds: BigInt(stats.rush_td ?? 0),
          receptions: BigInt(stats.rec ?? 0),
          recYds: BigInt(stats.rec_yd ?? 0),
          recTds: BigInt(stats.rec_td ?? 0),
          fumblesLost: BigInt(stats.fum_lost ?? 0),
          twoPtConversions: BigInt(stats.two_pt_conversions ?? 0),
        });
      }

      // Nothing new to store (e.g. no eligible players) → up to date.
      if (batch.length === 0) return "up-to-date";

      const res = await actor.syncWeeklyStats(
        roomId,
        BigInt(seasonNum),
        BigInt(weekNum),
        batch,
      );
      if (res.__kind__ === "err") {
        // The backend rejects finalized weeks and applies a 75s cooldown no-op
        // for live/partial weeks; a #err is surfaced as an error state.
        return "error";
      }
      // #ok n: n is the count of entries stored. n > 0 means new data was
      // stored; n === 0 is a cooldown no-op / nothing-new-to-store.
      return res.ok > 0n ? "updated" : "up-to-date";
    } catch {
      // A failed Sleeper fetch or submit resolves to an error state.
      return "error";
    } finally {
      inFlightSyncKeys.delete(key);
    }
  };

  // Automatic sync on view load: fetch the currently-flagged (season, week)
  // pairs for the current room's season and run the shared flow for each. This
  // is silent/automatic and re-runs at most once every ~5 minutes
  // (minimum-time-since-last-sync interval) while the view stays open — no
  // uncontrolled polling or refetch loop. The in-flight guard prevents
  // duplicate concurrent fetches for the same (season, week) from a re-render
  // or remount.
  const runAutoSync = async () => {
    if (!actor || !roomId || season == null) return;
    const now = Date.now();
    if (now - lastAutoSyncRef.current < AUTO_SYNC_INTERVAL_MS) return;
    lastAutoSyncRef.current = now;
    let hasError = false;
    let hasUpdated = false;
    try {
      const flagged = await actor.getFlaggedWeeks();
      for (const record of flagged) {
        // Only sync weeks for the current room's season — a participant viewing
        // this room's scores should not trigger syncs for other seasons.
        if (record.season !== season) continue;
        const seasonNum = Number(record.season);
        const weekNum = Number(record.week);
        if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
        if (!Number.isInteger(weekNum) || weekNum < 1 || weekNum > 18) continue;
        const outcome = await runWeeklyStatsSync(seasonNum, weekNum);
        if (outcome === "error") hasError = true;
        else if (outcome === "updated") hasUpdated = true;
      }
    } catch {
      // A failed getFlaggedWeeks call means the sync attempt errored.
      hasError = true;
    }
    // Aggregate the pass into a single calm status: any error wins, then any
    // successful store, otherwise up-to-date.
    if (hasError) {
      setStatus("error");
    } else if (hasUpdated) {
      setStatus("updated");
      setLastSuccessfulSync(new Date());
    } else {
      setStatus("up-to-date");
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runAutoSync intentionally omitted
  useEffect(() => {
    if (!actor || !roomId || season == null || !enabled) return;
    void runAutoSync();
    const interval = window.setInterval(() => {
      void runAutoSync();
    }, AUTO_SYNC_INTERVAL_MS);
    // Browsers throttle background-tab setInterval timers, so the 5-minute
    // sync can fire late when the tab is backgrounded or the screen is locked.
    // When the tab regains visibility, run the same overdue check immediately
    // instead of waiting for the next (possibly clamped) interval tick.
    // runAutoSync's own lastAutoSyncRef rate-limit guard still enforces the
    // 5-minute minimum, so a visible tab never syncs more often than that.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runAutoSync();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, roomId, season, enabled]);

  return { status, lastSuccessfulSync };
}
