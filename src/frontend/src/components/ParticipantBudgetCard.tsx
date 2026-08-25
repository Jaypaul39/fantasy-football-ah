import { Badge } from "@/components/ui/badge";
import { Crown } from "lucide-react";
import {
  getAvailableBudget,
  getPrivateBudget,
  getSpentBudget,
  getTotalBudget,
  isPrivateBudget,
} from "../types";
import type { ParticipantView } from "../types";
import { AvatarThumb } from "./AvatarThumb";

interface ParticipantBudgetCardProps {
  participant: ParticipantView;
  isCurrentUser: boolean;
  isAdmin: boolean;
  maxRosterSize?: number | null;
}

function budgetPercent(available: bigint, total: bigint): number {
  if (total === 0n) return 0;
  const pct = Number((available * 100n) / total);
  return Math.max(0, Math.min(100, pct));
}

function barColor(pct: number): string {
  if (pct > 60) return "bg-green-500";
  if (pct >= 30) return "bg-yellow-400";
  return "bg-destructive";
}

function availableTextColor(pct: number): string {
  if (pct > 60) return "text-green-400";
  if (pct >= 30) return "text-yellow-400";
  return "text-destructive";
}

export default function ParticipantBudgetCard({
  participant,
  isCurrentUser,
  isAdmin,
  maxRosterSize,
}: ParticipantBudgetCardProps) {
  const { budgetView } = participant;
  const available = getAvailableBudget(budgetView);
  const total = getTotalBudget(budgetView);
  const spent = getSpentBudget(budgetView);

  const pct = budgetPercent(available, total);
  const isBroke = available <= 5n;

  // Private budget (owner's own entry) — show full breakdown
  const privateBudget = isPrivateBudget(budgetView)
    ? getPrivateBudget(budgetView)
    : null;

  return (
    <div
      className={`relative rounded-lg p-3 border transition-smooth space-y-2.5 ${
        isCurrentUser
          ? "bg-primary/5 border-primary/50 border-glow-cyan"
          : isBroke
            ? "bg-card border-border opacity-70"
            : "bg-card border-border hover:border-border/80"
      }`}
      data-ocid="participant-budget-card"
    >
      {/* Header row */}
      <div className="flex items-center gap-2 min-w-0">
        {/* Avatar */}
        <AvatarThumb
          displayName={participant.displayName}
          size={28}
          highlight={isCurrentUser}
          seed={participant.userId.toText()}
          avatarUrl={participant.avatarUrl ?? null}
        />

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          {isCurrentUser && (
            <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 pulse-neon" />
          )}
          <span
            className={`font-display font-semibold text-sm truncate ${
              isCurrentUser ? "text-primary" : "text-foreground"
            }`}
          >
            {participant.displayName}
          </span>
        </div>

        {isAdmin && (
          <Badge
            className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 font-mono text-[9px] px-1.5 py-0 flex-shrink-0"
            data-ocid="admin-badge"
          >
            <Crown className="w-2.5 h-2.5 mr-0.5" />
            ADMIN
          </Badge>
        )}

        {maxRosterSize != null ? (
          <span
            className={`font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
              participant.wonPlayers.length === maxRosterSize
                ? "bg-emerald-500/15 text-emerald-400"
                : participant.wonPlayers.length === 0
                  ? "bg-muted/40 text-muted-foreground/40"
                  : "bg-muted text-muted-foreground"
            }`}
            data-ocid="won-count-badge"
          >
            <span className="font-semibold text-foreground">
              {participant.wonPlayers.length}
            </span>
            <span className="font-normal text-muted-foreground">
              /{maxRosterSize}
            </span>{" "}
            <span className="text-muted-foreground">players</span>
          </span>
        ) : (
          <span
            className="bg-muted text-muted-foreground font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
            data-ocid="won-count-badge"
          >
            {participant.wonPlayers.length}W
          </span>
        )}
      </div>

      {/* Budget bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            ${spent.toString()} spent
            {/* Committed amount — only shown for the logged-in user's own card (private view) */}
            {privateBudget && privateBudget.committedBudget > 0n && (
              <span className="ml-1 text-yellow-400/70">
                · ${privateBudget.committedBudget.toString()} committed
              </span>
            )}
          </span>
          <div className="flex flex-col items-end">
            <span
              className={`font-mono text-sm font-bold ${availableTextColor(pct)}`}
            >
              ${available.toString()}
            </span>
            <span className="text-[9px] text-muted-foreground/60 font-mono">
              available
            </span>
          </div>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor(pct)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
