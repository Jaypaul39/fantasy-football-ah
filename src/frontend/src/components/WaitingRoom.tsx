import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Principal } from "@icp-sdk/core/principal";
import { CheckCircle2, Circle, Clock, DollarSign, Users } from "lucide-react";
import { useState } from "react";
import { useSetParticipantPaid } from "../hooks/useRoomPolling";
import { defaultRosterSettings, getTotalBudget } from "../types";
import type { ParticipantView, RoomId, RoomView } from "../types";
import { HostControls } from "./HostControls";

interface WaitingRoomProps {
  roomView: RoomView;
  myPrincipal: Principal | null;
  isHost: boolean;
  /** Whether the host has clicked Start and we're in the countdown/starting phase */
  isStarting: boolean;
  /** Current countdown number (3-0) shown during pre-auction countdown */
  countdown: number | null;
  onReadyToggle: () => void;
  onStartAuction: () => void;
  roomId: RoomId;
}

export function WaitingRoom({
  roomView,
  myPrincipal,
  isHost,
  isStarting,
  countdown,
  onReadyToggle,
  onStartAuction,
  roomId,
}: WaitingRoomProps) {
  const { room, participants } = roomView;
  const [showSettings, setShowSettings] = useState(false);

  const myPrincipalText = myPrincipal?.toText() ?? null;

  const isReady = (p: ParticipantView) =>
    room.readyParticipants.some((rp) => rp.toText() === p.userId.toText());

  // Paid status is informational only — does not affect starting the auction.
  const isPaid = (p: ParticipantView) =>
    room.paidParticipants.some((pp) => pp.toText() === p.userId.toText());

  const setParticipantPaid = useSetParticipantPaid(roomId);

  const iAmReady =
    myPrincipalText != null &&
    room.readyParticipants.some((rp) => rp.toText() === myPrincipalText);

  const readyCount = room.readyParticipants.length;

  // Prevent start button if already starting or already transitioned
  const canStart = isHost && !isStarting;

  return (
    <div
      className="relative flex flex-col min-h-0 h-full"
      data-ocid="waiting-room"
    >
      {/* Pre-auction countdown overlay */}
      {isStarting && countdown !== null && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm"
          aria-live="assertive"
          data-ocid="waiting-countdown-overlay"
        >
          <div className="flex flex-col items-center gap-6">
            <span className="text-8xl font-display font-black text-primary tabular-nums animate-pulse select-none">
              {countdown}
            </span>
            <p className="text-lg font-semibold text-foreground/80">
              Auction starting…
            </p>
          </div>
        </div>
      )}

      {/* Room status bar */}
      <div className="shrink-0 px-4 py-3 bg-muted/40 border-b border-border/60 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="w-4 h-4 shrink-0" />
          <span>
            <span className="font-semibold text-foreground">{readyCount}</span>
            <span className="text-muted-foreground">
              /{participants.length} ready
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>Waiting for host to start</span>
        </div>
      </div>

      {/* Roster requirements */}
      {(() => {
        if (!room.rosterSettings) return null;
        const rs = room.rosterSettings;
        const parts: string[] = [];
        parts.push(`${rs.qb.toString()} QB`);
        parts.push(`${rs.rb.toString()} RB`);
        parts.push(`${rs.wr.toString()} WR`);
        parts.push(`${rs.te.toString()} TE`);
        parts.push(`${rs.flex.toString()} FLEX`);
        if (rs.superflex > BigInt(0)) {
          parts.push(`${rs.superflex.toString()} SUPERFLEX`);
        }
        parts.push(`${rs.bench.toString()} Bench`);
        return (
          <div className="shrink-0 px-4 py-2 border-b border-border/40">
            <p className="text-xs text-muted-foreground font-medium">
              Roster: {parts.join(" \u2022 ")}
            </p>
          </div>
        );
      })()}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
        {/* My ready toggle — now appears FIRST above the participant list */}
        {myPrincipalText != null && (
          <div
            className="bg-card border border-border/60 rounded-xl p-4 flex items-center justify-between gap-4"
            data-ocid="waiting-room-ready-section"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                {iAmReady ? "You are ready" : "Are you ready?"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {iAmReady
                  ? "Toggle to mark yourself as not ready."
                  : "Let everyone know you're ready to start."}
              </p>
            </div>
            <Button
              type="button"
              onClick={onReadyToggle}
              disabled={isStarting}
              variant={iAmReady ? "outline" : "default"}
              className={
                iAmReady
                  ? "shrink-0 border-destructive/60 text-destructive hover:bg-destructive/10"
                  : "shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white border-0"
              }
              data-ocid="waiting-room-ready-toggle"
            >
              {iAmReady ? "Not Ready" : "Ready Up"}
            </Button>
          </div>
        )}

        {/* Participant list — now appears BELOW the ready toggle */}
        <div
          className="bg-card border border-border/60 rounded-xl overflow-hidden"
          data-ocid="waiting-room-participants"
        >
          <div className="px-4 py-3 border-b border-border/40 flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              Participants
            </h3>
          </div>

          {participants.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-10 gap-2"
              data-ocid="waiting-room-participants.empty_state"
            >
              <Users className="w-7 h-7 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                No participants yet
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/30">
              {participants.map((p, i) => {
                const ready = isReady(p);
                const paid = isPaid(p);
                const isMe =
                  myPrincipalText != null &&
                  p.userId.toText() === myPrincipalText;
                const totalBudget = getTotalBudget(p.budgetView);

                return (
                  <li
                    key={p.userId.toText()}
                    className={`px-4 py-3 transition-colors ${
                      isMe ? "bg-primary/5" : ""
                    }`}
                    data-ocid={`waiting-room-participants.item.${i + 1}`}
                  >
                    {/* Row: ready icon + name + starting budget + ready badge + paid control */}
                    <div className="flex items-center gap-3">
                      {ready ? (
                        <CheckCircle2
                          className="w-5 h-5 text-emerald-400 shrink-0"
                          aria-label="Ready"
                        />
                      ) : (
                        <Circle
                          className="w-5 h-5 text-muted-foreground/40 shrink-0"
                          aria-label="Not ready"
                        />
                      )}

                      <span
                        className={`flex-1 min-w-0 truncate text-sm font-medium ${
                          isMe ? "text-primary" : "text-foreground"
                        }`}
                      >
                        {p.displayName}
                        {isMe && (
                          <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                            (you)
                          </span>
                        )}
                      </span>

                      {/* Starting budget */}
                      <span
                        className="text-xs font-mono font-semibold text-green-400 shrink-0"
                        aria-label={`Starting budget: ${totalBudget.toString()}`}
                      >
                        ${totalBudget.toString()}
                      </span>

                      {/* Ready badge */}
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wide shrink-0 ${
                          ready
                            ? "text-emerald-400"
                            : "text-muted-foreground/50"
                        }`}
                      >
                        {ready ? "Ready" : "Waiting"}
                      </span>

                      {/* Paid toggle (host) / badge (non-host) — visually separate
                          from the ready indicator above. Uses DollarSign to stay
                          distinct from the ready CheckCircle2/Circle. */}
                      {isHost ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={setParticipantPaid.isPending}
                          onClick={() =>
                            setParticipantPaid.mutate({
                              targetUserId: p.userId,
                              paid: !paid,
                            })
                          }
                          className={`shrink-0 h-7 px-2 gap-1 text-[11px] font-semibold border-0 ${
                            paid
                              ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                              : "bg-muted/60 hover:bg-muted text-muted-foreground"
                          }`}
                          aria-label={
                            paid
                              ? `${p.displayName} paid — click to mark unpaid`
                              : `${p.displayName} unpaid — click to mark paid`
                          }
                          data-ocid={`waiting-room-participants.paid-toggle.${i + 1}`}
                        >
                          <DollarSign className="w-3.5 h-3.5" />
                          {paid ? "Paid" : "Unpaid"}
                        </Button>
                      ) : (
                        <span
                          className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold ${
                            paid
                              ? "text-emerald-500"
                              : "text-muted-foreground/50"
                          }`}
                          aria-label={
                            paid
                              ? `${p.displayName} has paid`
                              : `${p.displayName} has not paid`
                          }
                          data-ocid={`waiting-room-participants.paid-badge.${i + 1}`}
                        >
                          <DollarSign className="w-3.5 h-3.5" />
                          {paid ? "Paid" : "Unpaid"}
                        </span>
                      )}
                    </div>

                    {/* Paid mutation error per row — surfaces backend/permission failures */}
                    {isHost &&
                      setParticipantPaid.isError &&
                      setParticipantPaid.variables?.targetUserId.toText() ===
                        p.userId.toText() && (
                        <p
                          className="mt-1.5 text-[11px] text-destructive"
                          data-ocid={`waiting-room-participants.paid-error.${i + 1}`}
                        >
                          {setParticipantPaid.error?.message ??
                            "Could not update paid status"}
                        </p>
                      )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Host start button */}
        {isHost && (
          <div
            className="bg-card border border-primary/20 rounded-xl p-4 space-y-3"
            data-ocid="waiting-room-host-section"
          >
            <div>
              <p className="text-sm font-semibold text-foreground">
                Host Controls
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Start the auction when everyone is ready. You can start at any
                time.
              </p>
            </div>

            {/* Collapsible Room Settings */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowSettings((s) => !s)}
              className="w-full text-muted-foreground border-border/60 hover:text-foreground"
              data-ocid="waiting-room-settings-toggle"
            >
              ⚙ Room Settings {showSettings ? "▲" : "▼"}
            </Button>
            {showSettings && (
              <div className="bg-muted/20 border border-border rounded-lg p-4">
                <HostControls
                  roomId={roomId}
                  state={room.state}
                  settings={room.settings}
                  participants={participants}
                />
              </div>
            )}

            <Button
              type="button"
              onClick={onStartAuction}
              disabled={!canStart}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
              data-ocid="waiting-room-start-btn"
            >
              {isStarting ? "Starting…" : "Start Auction"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Skeleton shown while the waiting room is loading */
export function WaitingRoomSkeleton() {
  return (
    <div className="p-4 space-y-4">
      <Skeleton className="h-10 w-full" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}
