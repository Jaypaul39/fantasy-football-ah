import { cn } from "@/lib/utils";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AuctionState } from "../types";
import type { RoomView } from "../types";

interface NominationTimerBannerProps {
  roomView: RoomView;
  actor: { sweepNominations: (roomId: string) => Promise<unknown> } | null;
  roomId: string;
  queryClient: QueryClient;
  nominationId: bigint | null | undefined;
}

/**
 * Backend-driven nomination timer banner.
 * Ticks down locally every second but re-anchors to the backend value
 * on every poll. Resets (restarts) if server value jumps UP.
 * Renders when auction state is Active or Paused.
 *
 * Frontend-only pause: when activeNominations.length >= maxActivePicks,
 * the countdown is paused and "Waiting for slot..." is displayed.
 * Resumes from stored remaining time when a slot opens.
 * This is COMPLETELY SEPARATE from any pre-auction countdown.
 */
export function NominationTimerBanner({
  roomView,
  actor,
  roomId,
  queryClient,
  nominationId,
}: NominationTimerBannerProps) {
  const { room } = roomView;

  // Show banner when auction is Active or Paused
  if (
    room.state !== AuctionState.Active &&
    room.state !== AuctionState.Paused
  ) {
    return null;
  }

  const isPaused = room.state === AuctionState.Paused;

  const nominatorName =
    roomView.currentNominatorName ??
    (roomView.currentNominatorId
      ? `${roomView.currentNominatorId.toText().slice(0, 10)}…`
      : "—");

  const activeCount = roomView.activeNominations.length;
  const maxActivePicks = Number(room.settings.maxActivePicks ?? 1);

  return (
    <BannerInner
      nominatorName={nominatorName}
      nominationTimerSecsRemaining={roomView.nominationTimerSecsRemaining}
      activeNominationCount={activeCount}
      maxActivePicks={maxActivePicks}
      isPaused={isPaused}
      actor={actor}
      roomId={roomId}
      queryClient={queryClient}
      nominationId={nominationId}
    />
  );
}

interface BannerInnerProps {
  nominatorName: string;
  nominationTimerSecsRemaining: bigint;
  activeNominationCount: number;
  maxActivePicks: number;
  isPaused: boolean;
  actor: { sweepNominations: (roomId: string) => Promise<unknown> } | null;
  roomId: string;
  queryClient: QueryClient;
  nominationId: bigint | null | undefined;
}

function BannerInner({
  nominatorName,
  nominationTimerSecsRemaining,
  activeNominationCount,
  maxActivePicks,
  isPaused,
  actor,
  roomId,
  queryClient,
  nominationId,
}: BannerInnerProps) {
  const serverSecs = Number(nominationTimerSecsRemaining);
  const [displayed, setDisplayed] = useState(serverSecs);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevServerSecsRef = useRef(serverSecs);
  const displayedRef = useRef(serverSecs);
  const hasTriggeredSweepRef = useRef(false);
  // Keep refs to latest actor/roomId/queryClient so the stable setInterval closure
  // always uses the current values without triggering a remount.
  const actorRef = useRef(actor);
  const roomIdRef = useRef(roomId);
  const queryClientRef = useRef(queryClient);
  const isPausedRef = useRef(isPaused);
  actorRef.current = actor;
  roomIdRef.current = roomId;
  queryClientRef.current = queryClient;
  isPausedRef.current = isPaused;

  // Frontend-only pause state: stores the remaining seconds when paused.
  // Must be React state so it persists across re-renders and roomView updates.
  const [pausedRemaining, setPausedRemaining] = useState<number | null>(null);

  const isFull = activeNominationCount >= maxActivePicks;
  // Reset sweep guard whenever the nomination changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: nominationId is the only relevant dep; ref mutation doesn't need stale closure tracking
  useEffect(() => {
    hasTriggeredSweepRef.current = false;
  }, [nominationId]);

  // Sync to backend value and restart interval if server jumped up
  useEffect(() => {
    const prev = prevServerSecsRef.current;
    prevServerSecsRef.current = serverSecs;

    if (serverSecs === prev) return;

    displayedRef.current = serverSecs;
    setDisplayed(serverSecs);

    // Server jumped UP → new nomination started or rotated, restart interval
    if (serverSecs > prev + 2) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        if (isPausedRef.current) return;
        displayedRef.current = Math.max(0, displayedRef.current - 1);
        setDisplayed(displayedRef.current);
      }, 1000);
    }
  }, [serverSecs]);

  // Start local countdown on mount
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      // Do not tick while the auction is paused by the host
      if (isPausedRef.current) return;

      displayedRef.current = Math.max(0, displayedRef.current - 1);
      setDisplayed(displayedRef.current);

      // When timer hits zero, fire sweep exactly once per nomination
      if (displayedRef.current === 0 && !hasTriggeredSweepRef.current) {
        hasTriggeredSweepRef.current = true;
        if (actorRef.current && roomIdRef.current) {
          actorRef.current.sweepNominations(roomIdRef.current).catch(() => {});
        }
        queryClientRef.current.invalidateQueries({
          queryKey: ["room", roomIdRef.current],
        });
      }
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Frontend-only pause/resume logic.
  // Runs whenever isFull or pausedRemaining changes.
  // COMPLETELY SEPARATE from any pre-auction countdown.
  useEffect(() => {
    if (isFull) {
      // Pause: stop the interval and store current remaining time if not already stored
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (pausedRemaining === null) {
        // Capture current remaining time into React state
        setPausedRemaining(displayedRef.current);
      }
    } else {
      // Resume: if we have a stored paused value, resume from it
      if (pausedRemaining !== null) {
        displayedRef.current = pausedRemaining;
        setDisplayed(pausedRemaining);
        setPausedRemaining(null); // clear stored value once resumed
      }
      // Restart the interval if it's not running
      if (!intervalRef.current) {
        intervalRef.current = setInterval(() => {
          if (isPausedRef.current) return;
          displayedRef.current = Math.max(0, displayedRef.current - 1);
          setDisplayed(displayedRef.current);
        }, 1000);
      }
    }
  }, [isFull, pausedRemaining]);

  // When auction is paused by the host, show server-provided frozen time directly
  const frozenSecs = Number(nominationTimerSecsRemaining);
  const frozenH = Math.floor(frozenSecs / 3600);
  const frozenM = Math.floor((frozenSecs % 3600) / 60);
  const frozenS = frozenSecs % 60;
  const frozenFormatted =
    frozenH > 0
      ? `${String(frozenH).padStart(2, "0")}:${String(frozenM).padStart(2, "0")}:${String(frozenS).padStart(2, "0")}`
      : `${String(frozenM).padStart(2, "0")}:${String(frozenS).padStart(2, "0")}`;

  const h = Math.floor(displayed / 3600);
  const m = Math.floor((displayed % 3600) / 60);
  const s = displayed % 60;
  const formatted =
    h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

  const isUrgent = !isFull && !isPaused && displayed < 10;
  const isAmber = !isFull && !isPaused && displayed >= 10 && displayed <= 30;

  // Paused state: show frozen server time with ⏸ label
  if (isPaused) {
    return (
      <div
        className="nomination-timer-banner rounded-xl mb-2"
        data-ocid="nomination-timer-banner"
        aria-live="polite"
        aria-label={`${nominatorName} nominating. Auction paused. Time frozen: ${frozenFormatted}`}
      >
        {/* Left: nominator name */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-amber-400" />
          <span className="nomination-timer-text truncate font-semibold text-sm">
            {nominatorName} nominating
          </span>
        </div>

        {/* Right: frozen timer with Paused label */}
        <span
          className="nomination-timer-countdown shrink-0 ml-auto tabular-nums select-none text-right flex items-center gap-1.5 text-amber-400 text-sm font-semibold"
          data-ocid="nomination-timer-countdown"
        >
          <span className="text-amber-400 font-bold text-xl tabular-nums">
            {frozenFormatted}
          </span>
          <span className="text-amber-400 font-semibold">⏸ Paused</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="nomination-timer-banner rounded-xl mb-2"
      data-ocid="nomination-timer-banner"
      aria-live="polite"
      aria-label={
        isFull
          ? `${nominatorName} nominating. Waiting for slot.`
          : `${nominatorName} nominating. Time remaining: ${formatted}`
      }
    >
      {/* Left: nominator name — truncates when long */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={cn(
            "inline-block w-2 h-2 rounded-full shrink-0",
            isFull ? "bg-amber-400 animate-pulse" : "bg-primary animate-pulse",
          )}
        />
        <span className="nomination-timer-text truncate font-semibold text-sm">
          {nominatorName} nominating
        </span>
      </div>

      {/* Right: countdown or waiting — never truncates */}
      <span
        className={cn(
          "nomination-timer-countdown shrink-0 ml-auto tabular-nums select-none text-right",
          isFull && "text-amber-400 text-sm font-semibold",
          !isFull && isUrgent && "timer-urgent text-2xl font-bold",
          !isFull && isAmber && "text-amber-400 text-xl font-bold",
          !isFull &&
            !isUrgent &&
            !isAmber &&
            "text-primary text-glow-cyan text-xl font-bold",
        )}
        data-ocid="nomination-timer-countdown"
      >
        {isFull ? "Waiting…" : formatted}
      </span>
    </div>
  );
}
