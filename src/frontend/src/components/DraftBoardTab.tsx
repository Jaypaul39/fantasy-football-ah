import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Download, LayoutList, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import {
  AuctionState,
  type NominationView,
  type ParticipantView,
  type RoomView,
  type RosterSettings,
  type UserId,
  type WonPlayer,
  getAvailableBudget,
  getPrivateBudget,
  getPublicBudget,
} from "../types";
import NominationOrderTab from "./NominationOrderTab";
import WonPlayersList from "./WonPlayersList";

interface SlottedRoster {
  counts: Record<string, number>;
  filled: Record<string, (WonPlayer | null)[]>;
}

export function assignSlotsToPlayers(
  wonPlayers: WonPlayer[],
  rosterSettings: RosterSettings,
): SlottedRoster {
  const counts = {
    QB: Number(rosterSettings.qb),
    RB: Number(rosterSettings.rb),
    WR: Number(rosterSettings.wr),
    TE: Number(rosterSettings.te),
    FLEX: Number(rosterSettings.flex),
    SUPERFLEX: Number(rosterSettings.superflex),
    BN: Number(rosterSettings.bench),
  };

  const filled: Record<string, (WonPlayer | null)[]> = {};
  for (const [slot, count] of Object.entries(counts)) {
    filled[slot] = Array(count).fill(null);
  }

  for (const player of wonPlayers) {
    const pos = player.position.toUpperCase();

    const naturalSlot = filled[pos];
    if (naturalSlot) {
      const emptyIdx = naturalSlot.findIndex((s) => s === null);
      if (emptyIdx !== -1) {
        naturalSlot[emptyIdx] = player;
        continue;
      }
    }

    const flexEligible = rosterSettings.flexPositions.map((p) =>
      p.toUpperCase(),
    );
    if (flexEligible.includes(pos) && filled.FLEX) {
      const emptyIdx = filled.FLEX.findIndex((s) => s === null);
      if (emptyIdx !== -1) {
        filled.FLEX[emptyIdx] = player;
        continue;
      }
    }

    const sfEligible = rosterSettings.superflexPositions.map((p) =>
      p.toUpperCase(),
    );
    if (sfEligible.includes(pos) && filled.SUPERFLEX) {
      const emptyIdx = filled.SUPERFLEX.findIndex((s) => s === null);
      if (emptyIdx !== -1) {
        filled.SUPERFLEX[emptyIdx] = player;
        continue;
      }
    }

    if (filled.BN) {
      const emptyIdx = filled.BN.findIndex((s) => s === null);
      if (emptyIdx !== -1) {
        filled.BN[emptyIdx] = player;
      }
    }
  }

  return { counts, filled };
}

const SLOT_LABELS: Record<string, string> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  FLEX: "FLX",
  SUPERFLEX: "SFX",
  BN: "BN",
};

const SLOT_STYLES: Record<string, { bg: string; text: string }> = {
  QB: { bg: "bg-red-500/20", text: "text-red-400" },
  RB: { bg: "bg-green-500/20", text: "text-green-400" },
  WR: { bg: "bg-blue-400/20", text: "text-blue-400" },
  TE: { bg: "bg-orange-500/20", text: "text-orange-400" },
  FLEX: { bg: "bg-cyan-500/20", text: "text-cyan-400" },
  SUPERFLEX: { bg: "bg-purple-500/20", text: "text-purple-400" },
  BN: { bg: "bg-muted/30", text: "text-muted-foreground" },
};

export function SlottedRosterView({
  wonPlayers,
  rosterSettings,
  maxRosterSize,
}: {
  wonPlayers: WonPlayer[];
  rosterSettings: RosterSettings;
  maxRosterSize: number;
}) {
  const { counts, filled } = assignSlotsToPlayers(wonPlayers, rosterSettings);
  const playerCount = wonPlayers.length;
  const isFull = playerCount >= maxRosterSize;

  const rosterRef = useRef<HTMLDivElement>(null);
  const [rosterOverflows, setRosterOverflows] = useState(false);

  useEffect(() => {
    const el = rosterRef.current;
    if (!el) return;
    setRosterOverflows(el.scrollHeight > el.clientHeight);
  }, []);

  const slotOrder = ["QB", "RB", "WR", "TE", "FLEX"];
  if (counts.SUPERFLEX > 0) slotOrder.push("SUPERFLEX");
  slotOrder.push("BN");

  return (
    <div className="space-y-1 relative">
      <p
        className={`text-xs font-medium mb-2 ${
          isFull ? "text-emerald-400" : "text-muted-foreground"
        }`}
      >
        {playerCount} / {maxRosterSize} players
      </p>
      <div ref={rosterRef} className="max-h-[320px] overflow-y-auto">
        {slotOrder.map((slotKey) => {
          const slots = filled[slotKey] ?? [];
          const style = SLOT_STYLES[slotKey] ?? SLOT_STYLES.BN;
          const label = SLOT_LABELS[slotKey] ?? slotKey;
          return slots.map((player, idx) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: stable slot indices
              key={`${slotKey}-slot-${idx}`}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${
                player
                  ? "bg-muted/20 border border-border/40"
                  : "bg-muted/10 border border-dashed border-border/30"
              }`}
            >
              <span
                className={`${style.bg} ${style.text} px-1.5 py-0.5 rounded text-[10px] font-mono font-bold w-8 text-center flex-shrink-0`}
              >
                {label}
              </span>
              {player ? (
                <>
                  <span className="font-semibold text-foreground truncate flex-1">
                    {player.playerName}
                  </span>
                  {player.byeWeek != null ? (
                    <span
                      className="text-[10px] text-muted-foreground/70 font-mono flex-shrink-0"
                      data-ocid="slotted-roster-bye-week"
                    >
                      Bye {player.byeWeek.toString()}
                    </span>
                  ) : null}
                  <span className="text-emerald-400 font-mono flex-shrink-0">
                    ${player.winningBid.toString()}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground/40 italic flex-1">
                  —
                </span>
              )}
            </div>
          ));
        })}
      </div>
      {rosterOverflows && (
        <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent pointer-events-none" />
      )}
    </div>
  );
}

interface DraftBoardTabProps {
  roomView?: RoomView;
  participants: ParticipantView[];
  activeNominations: NominationView[];
  myPrincipal: UserId | null;
  adminId: UserId;
  /** Room identifier — threaded through to NominationOrderTab for the skip toggle. */
  roomId: string;
  isAdmin?: boolean;
}

export default function DraftBoardTab({
  roomView,
  participants,
  activeNominations,
  myPrincipal,
  adminId,
  roomId,
  isAdmin = false,
}: DraftBoardTabProps) {
  const { principalText } = useAuth();

  const raw = (roomView?.room?.settings as any)?.maxRosterSize;
  const maxRosterSize =
    raw == null ? null : Array.isArray(raw) ? Number(raw[0]) : Number(raw);
  const hasRosterCap = maxRosterSize != null && !Number.isNaN(maxRosterSize);

  const currentParticipant = useMemo(
    () =>
      participants.find(
        (p) => p.userId.toText() === (principalText ?? myPrincipal?.toText()),
      ) ?? null,
    [participants, principalText, myPrincipal],
  );

  // Draft board budget: uses current winning bids instead of committed proxy max bids.
  // This only affects the budget numbers displayed on the Draft Board tab.
  const draftBoardBudgets = useMemo(() => {
    const map = new Map<string, bigint>();

    for (const participant of participants) {
      const participantPrincipal = participant.userId.toText();

      // Sum of currentBid on nominations where this participant is currently winning
      const winningBidsTotal = activeNominations.reduce((sum, nom) => {
        const isWinning =
          nom.bidLeader != null &&
          nom.bidLeader.toText() === participantPrincipal;
        return isWinning ? sum + nom.currentBid : sum;
      }, BigInt(0));

      const priv = getPrivateBudget(participant.budgetView);
      if (priv) {
        // Current user — has private budget view
        map.set(
          participantPrincipal,
          priv.totalBudget - priv.spentBudget - winningBidsTotal,
        );
      } else {
        const pub = getPublicBudget(participant.budgetView);
        if (pub) {
          // Other participants — use public budget view
          map.set(
            participantPrincipal,
            pub.totalBudget - pub.spentBudget - winningBidsTotal,
          );
        }
      }
    }

    return map;
  }, [participants, activeNominations]);

  const isCompleted = roomView?.room?.state === AuctionState.Completed;

  const handleExportCSV = () => {
    const rows: string[] = [];
    rows.push("Player Name,Winning Manager,Winning Bid,Position,NFL Team");

    for (const participant of participants) {
      for (const wp of participant.wonPlayers) {
        const playerName = wp.playerName ?? "";
        const position = wp.position ?? "";
        const team = wp.team ?? "";
        const winningBid = wp.winningBid?.toString() ?? "";
        const managerName = participant.displayName ?? "";
        rows.push(
          `"${playerName.replace(/"/g, '""')}","${managerName.replace(/"/g, '""')}",${winningBid},"${position}","${team}"`,
        );
      }
    }

    const csvContent = rows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${roomView?.room?.name ?? "draft"}-results.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const draftedPlayersCount = roomView?.completedNominations?.length ?? 0;

  const [showDraftDataModal, setShowDraftDataModal] = useState(false);

  // Draft Summary rows — resolved from completedNominations + participants.
  // Preserves completedNominations array order (oldest drafted first).
  const draftSummaryRows = useMemo(() => {
    if (!roomView) return [];
    return roomView.completedNominations.map((n) => {
      const owner =
        roomView.participants.find(
          (p) => p.userId.toText() === n.bidLeader?.toText(),
        )?.displayName ??
        n.bidLeaderName ??
        "Unknown";
      return {
        playerName: n.playerName,
        owner,
        winningBid: Number(n.currentBid),
      };
    });
  }, [roomView]);

  return (
    <div
      className="flex flex-col gap-6 p-4 sm:p-6 max-w-5xl mx-auto w-full"
      data-ocid="draft-board-tab"
    >
      {/* Draft Status card */}
      <button
        type="button"
        className="bg-card/60 border border-border/40 rounded-lg px-4 py-3 cursor-pointer hover:bg-card/90 transition-colors text-left w-full"
        data-ocid="draft-board-status-card"
        onClick={() => setShowDraftDataModal(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setShowDraftDataModal(true);
          }
        }}
      >
        <p className="text-muted-foreground text-sm">Draft Status</p>
        <p className="font-semibold text-foreground">
          {draftedPlayersCount} Players Drafted
        </p>
      </button>
      {/* Section 1 — Nomination Queue */}
      <section data-ocid="draft-board-nomination-queue">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <LayoutList className="w-4 h-4 text-primary" />
            <h2 className="font-display font-semibold text-sm text-foreground uppercase tracking-wide">
              Nomination Queue
            </h2>
          </div>
          {isCompleted && isAdmin && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleExportCSV}
              className="h-7 text-xs px-2 border-primary/40 text-primary hover:bg-primary/10 flex items-center gap-1"
              data-ocid="draft-board-export-csv-btn"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </Button>
          )}
        </div>
        <NominationOrderTab
          participants={participants}
          myPrincipal={myPrincipal}
          adminId={adminId}
          roomId={roomId}
          maxRosterSize={hasRosterCap ? maxRosterSize : null}
          rosterSettings={roomView?.room?.rosterSettings ?? null}
          budgetOverrides={draftBoardBudgets}
          highlightCurrentUser
        />
      </section>

      <Separator className="bg-border/50" />

      {/* Section 2 — My Roster */}
      <section data-ocid="draft-board-my-roster">
        <div className="flex items-center gap-2 mb-3">
          <User className="w-4 h-4 text-primary" />
          <h2 className="font-display font-semibold text-sm text-foreground uppercase tracking-wide">
            My Roster
          </h2>
        </div>
        <div className="bg-card border border-border/60 rounded-xl p-3">
          {roomView?.room?.rosterSettings && hasRosterCap && maxRosterSize ? (
            <SlottedRosterView
              wonPlayers={currentParticipant?.wonPlayers ?? []}
              rosterSettings={roomView.room.rosterSettings}
              maxRosterSize={maxRosterSize}
            />
          ) : (
            <WonPlayersList
              wonPlayers={currentParticipant?.wonPlayers ?? []}
              showAll={false}
              showNews={false}
            />
          )}
        </div>
      </section>

      {showDraftDataModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          role="presentation"
          onClick={() => setShowDraftDataModal(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowDraftDataModal(false);
          }}
          data-ocid="draft-data-modal"
        >
          <dialog
            open
            className="bg-card border border-border rounded-xl w-full max-w-lg flex flex-col max-h-[75dvh] p-0 m-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Draft Summary"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/60 flex-shrink-0">
              <h3 className="font-semibold text-foreground text-sm">
                Draft Summary
              </h3>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground p-1"
                onClick={() => setShowDraftDataModal(false)}
                aria-label="Close draft summary modal"
                data-ocid="draft-data-modal-close-button"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 overscroll-contain">
              {draftSummaryRows.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground py-8">
                  No players drafted yet.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b border-border/60">
                      <th className="text-left font-semibold text-muted-foreground text-xs uppercase tracking-wider px-4 py-2">
                        Player
                      </th>
                      <th className="text-left font-semibold text-muted-foreground text-xs uppercase tracking-wider px-4 py-2">
                        Team Owner
                      </th>
                      <th className="text-right font-semibold text-muted-foreground text-xs uppercase tracking-wider px-4 py-2">
                        Winning Bid
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftSummaryRows.map((row, index) => (
                      <tr
                        key={`${row.playerName}-${index}`}
                        className="border-b border-border/30 last:border-b-0"
                        data-ocid={`draft-summary.item.${index + 1}`}
                      >
                        <td className="px-4 py-2 font-bold text-foreground">
                          {row.playerName}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {row.owner}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-foreground">
                          ${row.winningBid}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-4 py-3 border-t border-border/60 flex-shrink-0">
              <p className="text-xs text-muted-foreground text-center">
                {draftSummaryRows.length} Players Drafted
              </p>
            </div>
          </dialog>
        </div>
      )}
    </div>
  );
}
