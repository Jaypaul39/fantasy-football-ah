import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuctionState } from "../types";

interface CountdownTimerProps {
  timerSecsRemaining: bigint;
  isActive: boolean;
  auctionState?: AuctionState;
  onTick?: (displayedSecs: number) => void;
  /**
   * Fired ONCE when the locally displayed countdown reaches zero. Used to
   * prompt a room-state refresh so expired nominations / turn advancement /
   * auction completion synchronize without waiting for the next poll.
   */
  onExpire?: () => void;
}

/**
 * Server-driven countdown timer.
 *
 * - Ticks down locally every second via a setInterval.
 * - Re-anchors to the backend value on every prop change (poll).
 * - If the server value jumps UP by more than 2s (new bid leader → timer reset),
 *   the local interval restarts from the new value.
 * - Color coding: cyan (normal), amber (10–30s), red pulsing (< 10s critical).
 * - No hardcoded fallback seconds anywhere.
 */
export function CountdownTimer({
  timerSecsRemaining,
  isActive,
  auctionState,
  onTick,
  onExpire,
}: CountdownTimerProps) {
  const serverSecs = Number(timerSecsRemaining);
  const [displayed, setDisplayed] = useState(serverSecs);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevServerSecsRef = useRef(serverSecs);
  // Mutable ref so interval callback always reads the latest value without
  // triggering extra renders.
  const displayedRef = useRef(serverSecs);
  // Guard so onExpire fires only once per expiry, not on every render/tick.
  const expiredRef = useRef(false);

  // Keep a ref to the latest auctionState so the interval closure always reads
  // the current value without requiring a restart on every state change.
  const auctionStateRef = useRef(auctionState);
  auctionStateRef.current = auctionState;
  // Keep a ref to onTick so interval closure always calls the latest callback
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  // Keep a ref to onExpire so interval closure always calls the latest callback
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // Shared local tick: decrement the displayed value and fire onExpire ONCE
  // when it reaches zero (guarded by expiredRef so it never re-fires on the
  // same expiry, even across re-renders or interval restarts). Wrapped in
  // useCallback with stable refs so the interval effects below can list it as
  // a dependency without restarting the interval on every render.
  const tick = useCallback(() => {
    if (auctionStateRef.current === AuctionState.Paused) return;
    displayedRef.current = Math.max(0, displayedRef.current - 1);
    setDisplayed(displayedRef.current);
    onTickRef.current?.(displayedRef.current);
    if (displayedRef.current === 0 && !expiredRef.current) {
      expiredRef.current = true;
      onExpireRef.current?.();
    }
  }, []);

  // Sync displayed value whenever the server sends a new timerSecsRemaining.
  useEffect(() => {
    const prev = prevServerSecsRef.current;
    prevServerSecsRef.current = serverSecs;

    if (serverSecs === prev) return;

    displayedRef.current = serverSecs;
    setDisplayed(serverSecs);

    // Server jumped UP → new bid leader reset the clock; restart local interval.
    if (isActive && serverSecs > prev + 2) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(tick, 1000);
    }
  }, [serverSecs, isActive, tick]);

  // Manage the countdown interval whenever isActive changes.
  useEffect(() => {
    if (!isActive) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(tick, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive, tick]);

  const h = Math.floor(displayed / 3600);
  const m = Math.floor((displayed % 3600) / 60);
  const s = displayed % 60;
  const formatted =
    h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

  const isUrgent = isActive && displayed < 10;
  const isAmber = isActive && displayed >= 10 && displayed <= 30;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 font-mono text-lg font-bold select-none",
        isUrgent && "timer-urgent",
        isAmber && "text-amber-400",
        !isUrgent && !isAmber && isActive && "text-cyan-400",
        !isActive && "text-muted-foreground opacity-50",
      )}
      data-ocid="countdown-timer"
      aria-label={`Timer: ${formatted}`}
      aria-live="polite"
    >
      {isUrgent && (
        <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      )}
      <span className={cn("tabular-nums", isUrgent && "text-2xl")}>
        {formatted}
      </span>
    </div>
  );
}
