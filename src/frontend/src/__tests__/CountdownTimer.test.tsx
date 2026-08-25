import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports AuctionState) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import { AuctionState } from "../backend";
import { CountdownTimer } from "../components/CountdownTimer";

describe("CountdownTimer onExpire", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("fires onExpire once when the local countdown reaches zero", () => {
    const onExpire = vi.fn();
    render(
      <CountdownTimer
        timerSecsRemaining={2n}
        isActive
        auctionState={AuctionState.Active}
        onExpire={onExpire}
      />,
    );

    // Two ticks bring the displayed value from 2 → 0.
    vi.advanceTimersByTime(2000);
    expect(onExpire).toHaveBeenCalledTimes(1);

    // Further ticks must not re-fire on the same expiry.
    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("does not fire onExpire while the auction is paused", () => {
    const onExpire = vi.fn();
    render(
      <CountdownTimer
        timerSecsRemaining={1n}
        isActive
        auctionState={AuctionState.Paused}
        onExpire={onExpire}
      />,
    );

    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("does not fire onExpire when the timer is not active", () => {
    const onExpire = vi.fn();
    render(
      <CountdownTimer
        timerSecsRemaining={1n}
        isActive={false}
        auctionState={AuctionState.Active}
        onExpire={onExpire}
      />,
    );

    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("renders the formatted countdown for the server value", () => {
    render(
      <CountdownTimer
        timerSecsRemaining={65n}
        isActive
        auctionState={AuctionState.Active}
      />,
    );
    expect(screen.getByText("01:05")).toBeInTheDocument();
  });
});
