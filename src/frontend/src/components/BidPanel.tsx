import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertCircle, CheckCircle, Loader2, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAudio } from "../hooks/useAudio";
import { useBackend } from "../hooks/useBackend";
import {
  requestNotificationPermission,
  storeOneSignalPlayerId,
} from "../lib/onesignal";
import {
  AuctionState,
  NominationState,
  OVERCOMMIT_SAFEGUARD_MESSAGE,
} from "../types";
import type { NominationView, ProxyBid, RoomId } from "../types";

interface BidPanelProps {
  nomination: NominationView;
  roomId: RoomId;
  auctionState: AuctionState;
  /**
   * The logged-in user's available budget, sourced from their private budget view.
   * Pre-computed by AuctionDashboard from budgetView.private.availableBudget.
   * No frontend calculations here.
   */
  availableBudget: bigint;
  myProxyBids: ProxyBid[];
  minBidIncrement: bigint;
  /** Current user's principal as text — used to determine if they are the bid leader. */
  currentUserPrincipal?: string | null;
  /** Roster cap enforcement */
  userWonCount?: number;
  maxRosterSize?: number | null;
  /**
   * Reserve-adjusted max bid — the effective ceiling on what the current user
   * can commit to a single nomination without losing the ability to fill the
   * rest of their roster. Pre-computed by NominationCard via
   * getReserveCeiling(availableBudget, maxRosterSize, wonPlayersCount).
   * When unset, falls back to availableBudget.
   */
  reserveCeiling?: bigint;
  /**
   * True when bidding on this nomination is blocked because the user is
   * already leading another active nomination and winning this one too would
   * exceed their roster cap. Disables the submit button and surfaces
   * OVERCOMMIT_SAFEGUARD_MESSAGE inline.
   */
  overcommitBlocked?: boolean;
}

export function BidPanel({
  nomination,
  roomId,
  auctionState,
  availableBudget,
  myProxyBids,
  minBidIncrement,
  currentUserPrincipal,
  userWonCount,
  maxRosterSize,
  reserveCeiling,
  overcommitBlocked,
}: BidPanelProps) {
  const { actor } = useBackend();
  const { playNewBid, playLeading } = useAudio();
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successFlash, setSuccessFlash] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  // True when the current user is the bid leader on this nomination
  const isCurrentLeader =
    currentUserPrincipal != null &&
    nomination.bidLeader != null &&
    nomination.bidLeader.toText() === currentUserPrincipal;

  // Optimistic proxy display only — cleared as soon as server confirms.
  const [optimisticProxy, setOptimisticProxy] = useState<bigint | null>(null);

  // Track nomination id to reset optimistic state when nomination changes
  const prevNomIdRef = useRef(nomination.id);
  useEffect(() => {
    if (nomination.id !== prevNomIdRef.current) {
      prevNomIdRef.current = nomination.id;
      setOptimisticProxy(null);
      setValidationError(null);
      setBackendError(null);
      setAmount("");
    }
  }, [nomination.id]);

  // Revert optimistic proxy display once server truth catches up
  const serverProxy = myProxyBids.find((p) => p.nominationId === nomination.id);
  const prevServerProxyRef = useRef(serverProxy?.maxBid);
  useEffect(() => {
    if (
      optimisticProxy !== null &&
      serverProxy?.maxBid !== prevServerProxyRef.current
    ) {
      setOptimisticProxy(null);
    }
    prevServerProxyRef.current = serverProxy?.maxBid;
  }, [serverProxy?.maxBid, optimisticProxy]);

  // Proxy already placed for this nomination — use optimistic if set
  const displayProxy =
    optimisticProxy !== null
      ? { nominationId: nomination.id, maxBid: optimisticProxy }
      : serverProxy;

  // Minimum the proxy max must be: current visible bid + 1 increment
  const minProxyBid = nomination.currentBid + minBidIncrement;

  const isAuctionPaused = auctionState === AuctionState.Paused;
  const isNomClosed = nomination.state !== NominationState.Active;
  // Effective max bid: reserve-adjusted ceiling when a roster cap is set,
  // otherwise the full available budget. Used everywhere a bid is clamped or
  // validated against the user's budget.
  const effectiveMaxBid = reserveCeiling ?? availableBudget;
  const isBudgetExhausted = effectiveMaxBid <= BigInt(0);
  const isRosterFull =
    maxRosterSize != null &&
    userWonCount != null &&
    userWonCount >= maxRosterSize;
  // Only the submit button is disabled during submission — inputs stay live
  // Allow submit when exhausted but reducing an existing proxy (no additional budget needed)
  const isSubmitDisabled =
    isAuctionPaused ||
    isNomClosed ||
    (isBudgetExhausted && serverProxy == null) ||
    submitting ||
    isRosterFull ||
    (overcommitBlocked ?? false);

  // FIX 1 (BidPanel) — track previous bid leader to detect outbid event
  const prevBidLeaderRef = useRef<string | null>(
    nomination.bidLeader?.toText() ?? null,
  );
  useEffect(() => {
    const currentLeader = nomination.bidLeader?.toText() ?? null;
    const prevLeader = prevBidLeaderRef.current;

    // Detect outbid: previous leader was current user, new leader is someone else
    if (
      currentUserPrincipal != null &&
      prevLeader === currentUserPrincipal &&
      currentLeader !== currentUserPrincipal &&
      currentLeader !== null
    ) {
      playNewBid();
    }

    prevBidLeaderRef.current = currentLeader;
  }, [nomination.bidLeader, currentUserPrincipal, playNewBid]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAmount(e.target.value);
    if (validationError) setValidationError(null);
    if (backendError) setBackendError(null);
  };

  const handleBlur = () => {
    if (!amount) {
      setValidationError(null);
      return;
    }
    let parsed: bigint;
    try {
      parsed = BigInt(amount);
    } catch {
      setValidationError("Enter a valid whole number.");
      return;
    }

    if (isCurrentLeader) {
      // Leader can lower their max bid — backend accepts maxBid >= currentBid
      if (parsed < nomination.currentBid) {
        setValidationError(
          `Must be at least the current bid ($${nomination.currentBid.toString()})`,
        );
      } else if (parsed > effectiveMaxBid) {
        setValidationError(
          `Exceeds available budget ($${effectiveMaxBid.toString()})`,
        );
      } else {
        setValidationError(null);
      }
    } else {
      if (parsed < minProxyBid) {
        setValidationError(`Must be at least $${minProxyBid.toString()}`);
      } else if (parsed > effectiveMaxBid) {
        setValidationError(
          `Exceeds available budget ($${effectiveMaxBid.toString()})`,
        );
      } else {
        setValidationError(null);
      }
    }
  };

  const handleSubmit = async () => {
    if (!actor) return;
    if (!amount) {
      setValidationError("Enter your max bid.");
      return;
    }

    let parsed: bigint;
    try {
      parsed = BigInt(amount);
    } catch {
      setValidationError("Enter a valid whole number.");
      return;
    }

    if (isCurrentLeader) {
      // Leader can lower their proxy — backend accepts maxBid >= currentBid
      if (parsed < nomination.currentBid) {
        setValidationError(
          `Must be at least the current bid ($${nomination.currentBid.toString()})`,
        );
        return;
      }
    } else {
      if (parsed < minProxyBid) {
        setValidationError(`Must be at least $${minProxyBid.toString()}`);
        return;
      }
    }
    const existingMax = serverProxy?.maxBid ?? BigInt(0);
    const additionalRequired =
      parsed > existingMax ? parsed - existingMax : BigInt(0);

    if (parsed > effectiveMaxBid) {
      setValidationError(
        `Exceeds available budget ($${effectiveMaxBid.toString()})`,
      );
      return;
    }

    if (additionalRequired > availableBudget) {
      setValidationError(
        `Insufficient available budget (${availableBudget.toString()})`,
      );
      return;
    }

    setValidationError(null);
    setBackendError(null);

    // Optimistic proxy display — shows "Your Max: $X" immediately.
    setOptimisticProxy(parsed);

    setSubmitting(true);
    try {
      const result = await actor.placeProxyBid(nomination.id, roomId, parsed);
      if ("ok" in result) {
        // FIX 1 (BidPanel) — play sounds after successful bid
        playNewBid();

        // Check if current user is now the leader (re-check after bid)
        // nomination.bidLeader may not be updated yet from server, but we can
        // optimistically check if our bid would make us leader
        const nowLeader =
          currentUserPrincipal != null &&
          (nomination.bidLeader == null ||
            nomination.bidLeader.toText() !== currentUserPrincipal);
        if (nowLeader) {
          playLeading();
        }

        setSuccessFlash(true);
        setIsSuccess(true);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => {
          setIsSuccess(false);
        }, 500);
        setAmount("");
        setTimeout(() => setSuccessFlash(false), 2000);
        // Haptic feedback on supported devices (safe no-op on iOS/desktop)
        navigator.vibrate?.(50);
        // Request notification permission after first successful bid
        void requestNotificationPermission();
        setTimeout(async () => {
          try {
            if (actor) {
              await storeOneSignalPlayerId(actor);
            }
          } catch {
            // silent
          }
        }, 2000);
        // Leave optimisticProxy — it will auto-clear when server proxy updates
      } else {
        // Backend rejected — revert optimistic proxy
        setOptimisticProxy(null);
        const errMsg =
          "err" in result
            ? String(result.err)
            : "Bid rejected — please try again.";
        if (errMsg.toLowerCase().includes("roster is full")) {
          toast.error("Your roster is full");
        } else {
          setBackendError(errMsg);
        }
      }
    } catch {
      // Network / call error — revert
      setOptimisticProxy(null);
      setBackendError("Failed to place bid — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2.5" data-ocid="bid-panel">
      {/* Roster full — replaces entire bid UI */}
      {isRosterFull ? (
        <p
          className="text-xs text-destructive/80 font-semibold"
          data-ocid="bid-roster-full"
        >
          Your roster is full — cannot place more bids.
        </p>
      ) : (
        <>
          {/* Status badges: Current Bid + Your Max */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="bid-status-badge" data-ocid="bid-current-badge">
              Bid: ${nomination.currentBid.toString()}
            </span>
            {displayProxy && displayProxy.maxBid > nomination.currentBid && (
              <span
                className={cn(
                  "bid-status-badge",
                  "bg-accent/10 text-accent border border-accent/30",
                  optimisticProxy !== null && "opacity-80 italic",
                )}
                data-ocid="bid-proxy-badge"
              >
                Your Max: ${displayProxy.maxBid.toString()}
                {optimisticProxy !== null && (
                  <Loader2 className="w-3 h-3 animate-spin inline ml-1" />
                )}
              </span>
            )}
          </div>

          {/* Available budget row */}
          <div className="flex items-center gap-1.5 text-xs">
            <Wallet className="w-3 h-3 text-muted-foreground" />
            <span className="text-muted-foreground font-medium text-foreground/80">
              Available:
            </span>
            <span
              className={cn(
                "font-mono font-semibold",
                isBudgetExhausted
                  ? "text-destructive"
                  : effectiveMaxBid > BigInt(50)
                    ? "text-secondary"
                    : effectiveMaxBid > BigInt(10)
                      ? "text-amber-400"
                      : "text-destructive",
              )}
              data-ocid="bid-available-budget"
            >
              ${effectiveMaxBid.toString()}
            </span>
          </div>

          {/* Budget exhausted — no existing proxy: hide input entirely */}
          {isBudgetExhausted && serverProxy == null ? (
            <p
              className="text-xs text-destructive/80 font-semibold"
              data-ocid="bid-budget-exhausted"
            >
              Budget exhausted — cannot place bids.
            </p>
          ) : (
            <>
              {/* Quick-bid increment buttons — hidden when exhausted with existing proxy */}
              {!(isBudgetExhausted && serverProxy != null) && (
                <div
                  className="flex gap-1.5 mb-1"
                  data-ocid="bid-quick-buttons"
                >
                  {([1, 5, 10] as const).map((inc) => (
                    <button
                      key={inc}
                      type="button"
                      onClick={() => {
                        // Determine base: current input > currentBid > minProxyBid (never placeholder)
                        let base: bigint;
                        try {
                          if (
                            amount &&
                            amount.trim() !== "" &&
                            !Number.isNaN(Number(amount))
                          ) {
                            base = BigInt(amount);
                          } else if (nomination.currentBid != null) {
                            base = nomination.currentBid;
                          } else {
                            base = minProxyBid;
                          }
                        } catch {
                          base =
                            nomination.currentBid != null
                              ? nomination.currentBid
                              : minProxyBid;
                        }
                        let next = base + BigInt(inc);
                        // Clamp up to minimum allowed bid
                        if (next < minProxyBid) next = minProxyBid;
                        // Clamp down to effectiveMaxBid (bigint comparison)
                        if (next > effectiveMaxBid) next = effectiveMaxBid;
                        setAmount(next.toString());
                        if (validationError) setValidationError(null);
                        if (backendError) setBackendError(null);
                      }}
                      disabled={
                        isAuctionPaused || isNomClosed || isBudgetExhausted
                      }
                      className="flex-1 text-xs font-semibold py-1 rounded-md border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      data-ocid={`bid-quick-btn-${inc}`}
                      aria-label={`Add ${inc} to bid`}
                    >
                      +${inc}
                    </button>
                  ))}
                </div>
              )}
              {/* Max bid input */}
              <div className="flex gap-2 items-start">
                <div className="relative flex-1">
                  <label
                    htmlFor={`bid-input-${nomination.id}`}
                    className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1"
                  >
                    {isBudgetExhausted && serverProxy != null
                      ? "Reduce Max Bid ($)"
                      : "Your Max Bid ($)"}
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm font-mono pointer-events-none">
                      $
                    </span>
                    <input
                      id={`bid-input-${nomination.id}`}
                      type="number"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      min={minProxyBid.toString()}
                      max={
                        isBudgetExhausted && serverProxy != null
                          ? serverProxy.maxBid.toString()
                          : effectiveMaxBid.toString()
                      }
                      value={amount}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSubmit();
                      }}
                      placeholder={
                        isCurrentLeader
                          ? nomination.currentBid.toString()
                          : minProxyBid.toString()
                      }
                      // Input stays enabled during submission — only submit button is locked
                      disabled={isAuctionPaused || isNomClosed}
                      className={cn(
                        "bid-panel-input w-full pl-7",
                        (validationError || backendError) &&
                          "border-destructive focus:border-destructive",
                      )}
                      data-ocid="bid-amount-input"
                      aria-label="Your max bid amount"
                      aria-describedby={
                        validationError || backendError
                          ? `bid-error-${nomination.id}`
                          : undefined
                      }
                      aria-invalid={
                        validationError || backendError ? "true" : "false"
                      }
                    />
                  </div>

                  {/* Helper text when budget is exhausted but proxy exists */}
                  {isBudgetExhausted && serverProxy != null && (
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      Budget exhausted — you can only reduce your current max
                    </p>
                  )}

                  {/* Validation error (client-side) */}
                  {validationError && (
                    <p
                      id={`bid-error-${nomination.id}`}
                      className="flex items-center gap-1 text-xs text-destructive mt-1"
                      role="alert"
                      data-ocid="bid-validation-error"
                    >
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      {validationError}
                    </p>
                  )}

                  {/* Backend error (server rejection or network failure) */}
                  {backendError && !validationError && (
                    <p
                      id={`bid-error-${nomination.id}`}
                      className="flex items-center gap-1 text-xs text-destructive mt-1 font-medium"
                      role="alert"
                      data-ocid="bid-backend-error"
                    >
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      {backendError}
                    </p>
                  )}
                </div>

                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isSubmitDisabled}
                  className={cn(
                    "font-semibold shrink-0 mt-5 transition-all duration-150 active:scale-95",
                    isSuccess
                      ? "bg-emerald-600 text-white border border-emerald-500"
                      : successFlash
                        ? "bg-secondary/20 text-secondary border border-secondary/40"
                        : "bg-primary/20 hover:bg-primary/30 text-primary border border-primary/40 glow-cyan",
                  )}
                  data-ocid="bid-submit-btn"
                  aria-label={displayProxy ? "Update Max Bid" : "Place Max Bid"}
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : successFlash ? (
                    <>
                      <CheckCircle className="w-4 h-4 mr-1" />
                      <span className="text-xs">Bid placed!</span>
                    </>
                  ) : displayProxy ? (
                    "Update Max"
                  ) : (
                    "Place Bid"
                  )}
                </Button>
              </div>

              {/* Budget intelligence warning */}
              {(() => {
                if (maxRosterSize == null) return null;
                const parsedAmount = amount ? Number(amount) : 0;
                const avail = Number(availableBudget);
                const roster = Number(maxRosterSize);
                const won = Number(userWonCount ?? 0);
                const reserveRequired = Math.max(0, roster - won - 1);
                const showWarning =
                  reserveRequired > 0 &&
                  parsedAmount > 0 &&
                  avail - parsedAmount < reserveRequired;
                return showWarning ? (
                  <p
                    className="text-xs text-amber-400/90 font-medium"
                    data-ocid="bid-budget-warning"
                  >
                    ⚠ This bid may leave you short for remaining roster spots
                  </p>
                ) : null;
              })()}

              {/* Over-commitment safeguard — disables bidding when winning this
                  nomination would push the user's projected roster over the cap. */}
              {overcommitBlocked && (
                <p
                  className="flex items-start gap-1.5 text-xs text-amber-400 font-medium"
                  role="alert"
                  data-ocid="bid-overcommit-safeguard"
                >
                  <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{OVERCOMMIT_SAFEGUARD_MESSAGE}</span>
                </p>
              )}

              {/* Proxy hint */}
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                Your max stays private. Visible bid starts at{" "}
                <span className="font-mono text-primary/80">$1</span> and only
                increases when outbid.
              </p>
            </>
          )}

          {/* Paused / closed state messages */}
          {isAuctionPaused && (
            <p className="text-xs text-muted-foreground/70">
              Auction is paused.
            </p>
          )}
          {isNomClosed && !isAuctionPaused && (
            <p className="text-xs text-muted-foreground/70">
              Bidding has closed for this nomination.
            </p>
          )}
        </>
      )}
    </div>
  );
}
