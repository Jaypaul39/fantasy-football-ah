import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { NominationView } from "../types";

interface BidEntry {
  nominationId: bigint;
  bidderName: string;
  amount: bigint;
  isProxy: boolean;
  timestamp: number;
  isLeader: boolean;
}

interface BidHistoryProps {
  nominations: NominationView[];
  focusedNominationId?: bigint | null;
  bidHistory: BidEntry[];
  currentUserPrincipal: string | null;
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  return `${Math.floor(diffM / 60)}h ago`;
}

export function BidHistory({
  nominations,
  focusedNominationId,
  bidHistory,
  currentUserPrincipal,
}: BidHistoryProps) {
  // Filter bids to focused nomination or all
  const filtered = focusedNominationId
    ? bidHistory.filter((b) => b.nominationId === focusedNominationId)
    : bidHistory;

  const recent = filtered.slice(0, 10);

  return (
    <div
      className="bg-card border border-border rounded-lg overflow-hidden flex flex-col"
      data-ocid="bid-history"
    >
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          Bid History
        </span>
        {focusedNominationId != null && (
          <Badge
            variant="outline"
            className="text-xs font-mono border-border text-muted-foreground"
          >
            {nominations.find((n) => n.id === focusedNominationId)
              ?.playerName ?? "Focused"}
          </Badge>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin max-h-64">
        {recent.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No bids yet
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {recent.map((bid) => {
              const isCurrentUser = currentUserPrincipal
                ? bid.bidderName === currentUserPrincipal
                : false;
              return (
                <li
                  key={`${bid.nominationId.toString()}-${bid.timestamp}-${bid.bidderName}`}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 text-xs transition-colors",
                    bid.isLeader ? "bg-secondary/5" : "hover:bg-muted/30",
                  )}
                  data-ocid="bid-history-row"
                >
                  <span
                    className={cn(
                      "font-medium truncate max-w-[90px]",
                      isCurrentUser ? "text-primary" : "text-foreground/80",
                    )}
                  >
                    {bid.bidderName}
                  </span>
                  <span
                    className={cn(
                      "font-mono font-bold ml-auto shrink-0",
                      bid.isLeader
                        ? "text-secondary text-glow-lime"
                        : "text-foreground",
                    )}
                  >
                    ${bid.amount.toString()}
                  </span>
                  {bid.isProxy && (
                    <Badge className="bg-accent/15 text-accent border border-accent/30 text-[9px] px-1 py-0 shrink-0">
                      PROXY
                    </Badge>
                  )}
                  <span className="text-muted-foreground/60 shrink-0 tabular-nums">
                    {formatRelativeTime(bid.timestamp)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export type { BidEntry };
