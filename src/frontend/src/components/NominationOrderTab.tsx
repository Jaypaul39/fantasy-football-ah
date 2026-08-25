import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, ChevronRight, Crown, Trophy } from "lucide-react";
import { useState } from "react";
import type { ParticipantView, RosterSettings, UserId } from "../backend";
import { getAvailableBudget, getTotalBudget } from "../types";
import { AvatarThumb } from "./AvatarThumb";
import { SlottedRosterView } from "./DraftBoardTab";

interface NominationOrderTabProps {
  participants: ParticipantView[];
  myPrincipal: UserId | null;
  adminId: UserId;
  /** Room identifier — required for the per-user skip-nomination-turn toggle. */
  roomId: string;
  maxRosterSize?: number | null;
  /** Optional roster settings — when present, expanded rows render the slotted roster view. */
  rosterSettings?: RosterSettings | null;
  /** Optional per-principal budget overrides (draft board view only). */
  budgetOverrides?: Map<string, bigint>;
  /** When true, adds bg-primary/5 to the current user's row (used by DraftBoardTab). */
  highlightCurrentUser?: boolean;
}

export default function NominationOrderTab({
  participants,
  myPrincipal,
  adminId,
  maxRosterSize,
  rosterSettings,
  budgetOverrides,
  highlightCurrentUser = false,
}: NominationOrderTabProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Display participants in the exact order provided by the backend.
  // NO sorting of any kind — order is set by the host in Host Controls.
  const ordered = participants;

  function toggleRow(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  if (participants.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 gap-3 text-center"
        data-ocid="nomination-order-empty"
      >
        <Trophy className="w-10 h-10 text-muted-foreground/20" />
        <p className="text-sm font-medium text-muted-foreground">
          No participants yet
        </p>
      </div>
    );
  }

  return (
    <div
      className="bg-card border border-border rounded-xl overflow-hidden"
      data-ocid="nomination-order-tab"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-card">
        <h3 className="font-display font-semibold text-sm text-foreground">
          Nomination Order
        </h3>
        <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
          {participants.length} teams · host order
        </span>
      </div>

      <ScrollArea>
        <div className="divide-y divide-border/50">
          {ordered.map((p, index) => {
            const id = p.userId.toText();
            const isMe = myPrincipal != null && id === myPrincipal.toText();
            const isAdmin = id === adminId.toText();
            const isExpanded = expandedId === id;

            const available =
              budgetOverrides?.get(id) ?? getAvailableBudget(p.budgetView);
            const total = getTotalBudget(p.budgetView);
            const pct =
              total > 0n
                ? Math.max(0, Math.min(100, Number((available * 100n) / total)))
                : 0;

            return (
              <div key={id} data-ocid="nomination-order-row">
                <button
                  type="button"
                  onClick={() => toggleRow(id)}
                  className={`w-full flex items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/20 ${
                    isMe
                      ? highlightCurrentUser
                        ? "bg-primary/5"
                        : "bg-primary/5 border-l-2 border-l-primary"
                      : ""
                  }`}
                  aria-expanded={isExpanded}
                  data-ocid="nomination-order-participant-btn"
                >
                  {/* Rank */}
                  <span className="font-mono text-xs text-muted-foreground w-5 flex-shrink-0">
                    #{index + 1}
                  </span>

                  {/* Avatar */}
                  <AvatarThumb
                    displayName={p.displayName}
                    size={24}
                    seed={p.userId.toText()}
                    avatarUrl={p.avatarUrl ?? null}
                  />

                  {/* Name + budget */}
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`font-display font-semibold text-sm truncate ${
                          isMe ? "text-primary" : "text-foreground"
                        }`}
                      >
                        {p.displayName}
                      </span>
                      {isMe && (
                        <span className="text-[10px] text-primary/70 font-mono">
                          (you)
                        </span>
                      )}
                      {isAdmin && (
                        <Badge className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 px-1.5 py-0 text-[9px] font-mono">
                          <Crown className="w-2.5 h-2.5 mr-0.5" />
                          HOST
                        </Badge>
                      )}
                      {p.skipNominationTurn && (
                        <Badge
                          className="bg-amber-500/20 text-amber-400 border border-amber-500/40 px-1.5 py-0 text-[9px] font-mono"
                          data-ocid={`nomination-order-skip-badge.${index + 1}`}
                        >
                          Skipping
                        </Badge>
                      )}
                    </div>

                    {/* Budget bar — uses publicAvailableBudget for others, availableBudget for self */}
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${pct > 40 ? "bg-emerald-500" : pct > 10 ? "bg-amber-500" : "bg-red-500"} ${pct <= 10 ? "animate-pulse-slow" : ""}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span
                        className={`font-mono text-xs font-medium flex-shrink-0 ${pct > 40 ? "text-emerald-400" : pct > 10 ? "text-amber-400" : "text-red-400"}`}
                      >
                        ${available.toString()}
                      </span>
                    </div>
                  </div>

                  {/* Won count + expand icon */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {maxRosterSize != null ? (
                      <Badge
                        className={`border-0 font-mono text-[10px] ${
                          p.wonPlayers.length === maxRosterSize
                            ? "bg-emerald-500/15 text-emerald-400"
                            : p.wonPlayers.length === 0
                              ? "bg-muted/40 text-muted-foreground/40"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <span className="font-semibold text-foreground">
                          {p.wonPlayers.length}
                        </span>
                        <span className="font-normal text-muted-foreground">
                          /{maxRosterSize}
                        </span>{" "}
                        <span className="text-muted-foreground">players</span>
                      </Badge>
                    ) : (
                      <Badge className="bg-muted text-muted-foreground border-0 font-mono text-[10px]">
                        {p.wonPlayers.length} won
                      </Badge>
                    )}
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                </button>

                {/* Expandable won players */}
                <div
                  className={`overflow-hidden transition-all duration-200 ease-in-out ${
                    isExpanded
                      ? "max-h-[1000px] opacity-100"
                      : "max-h-0 opacity-0"
                  }`}
                >
                  <div className="bg-card/40 border-t border-border/40 border-l-4 border-l-primary/30">
                    {rosterSettings && maxRosterSize != null ? (
                      p.wonPlayers.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2 px-3">
                          No players won yet
                        </p>
                      ) : (
                        <div className="p-3">
                          <SlottedRosterView
                            wonPlayers={p.wonPlayers}
                            rosterSettings={rosterSettings}
                            maxRosterSize={maxRosterSize}
                          />
                        </div>
                      )
                    ) : p.wonPlayers.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2 px-3">
                        No players won yet
                      </p>
                    ) : (
                      <div className="divide-y divide-border/30">
                        {p.wonPlayers.map((wp) => (
                          <div
                            key={wp.playerId}
                            className="flex items-center justify-between py-2 px-3"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                                  wp.position === "QB"
                                    ? "bg-red-500/20 text-red-400 border-red-500/30"
                                    : wp.position === "RB"
                                      ? "bg-green-500/20 text-green-400 border-green-500/30"
                                      : wp.position === "WR"
                                        ? "bg-blue-400/20 text-blue-400 border-blue-500/30"
                                        : wp.position === "TE"
                                          ? "bg-orange-500/20 text-orange-400 border-orange-500/30"
                                          : "bg-muted text-muted-foreground border-border"
                                }`}
                              >
                                {wp.position}
                              </span>
                              <span className="text-xs font-medium text-foreground truncate">
                                {wp.playerName}
                              </span>
                            </div>
                            <span className="text-xs font-mono text-emerald-400 flex-shrink-0">
                              ${wp.winningBid.toString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
