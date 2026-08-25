import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Crown, Loader2, Trophy, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useBackend } from "../hooks/useBackend";
import { getAvailableBudget } from "../types";
import type { ParticipantView, RoomId, UserId } from "../types";

interface RosterPanelProps {
  roomId: RoomId;
  participants: ParticipantView[];
  adminId: UserId;
  currentUserId: UserId | null;
}

export function RosterPanel({
  roomId,
  participants,
  adminId,
  currentUserId,
}: RosterPanelProps) {
  const { actor } = useBackend();
  const [removingId, setRemovingId] = useState<string | null>(null);

  const isCurrentUserAdmin =
    currentUserId != null && currentUserId.toText() === adminId.toText();

  async function handleRemove(userId: UserId, displayName: string) {
    if (!actor) return;
    const idText = userId.toText();
    setRemovingId(idText);
    try {
      const result = await actor.removeUserFromRoom(roomId, userId);
      if (result.__kind__ === "err") {
        toast.error(`Failed to remove ${displayName}: ${result.err}`);
      } else {
        toast.success(`${displayName} removed from room.`);
      }
    } catch (err) {
      toast.error("Unexpected error removing user.");
      console.error(err);
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div
      className="bg-card border border-border rounded-xl overflow-hidden"
      data-ocid="roster-panel"
    >
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Trophy className="w-4 h-4 text-primary" />
        <h3 className="font-display font-semibold text-sm text-foreground">
          Roster ({participants.length})
        </h3>
      </div>

      <ScrollArea className="max-h-[420px]">
        <ul className="divide-y divide-border/50">
          {participants.map((p) => {
            const idText = p.userId.toText();
            const isAdmin = idText === adminId.toText();
            const isMe =
              currentUserId != null && idText === currentUserId.toText();
            const isRemoving = removingId === idText;

            return (
              <li
                key={idText}
                className={`flex items-center gap-3 px-4 py-3 ${
                  isMe ? "bg-primary/5 border-l-2 border-l-primary" : ""
                }`}
                data-ocid="roster-participant-row"
              >
                {/* Avatar letter */}
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
                    isMe
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {p.displayName.charAt(0).toUpperCase()}
                </div>

                {/* Name + badges */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`font-medium text-sm truncate ${
                        isMe ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {p.displayName}
                    </span>
                    {isAdmin && (
                      <Badge className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 px-1.5 py-0 text-[10px] font-mono">
                        <Crown className="w-2.5 h-2.5 mr-0.5" />
                        ADMIN
                      </Badge>
                    )}
                    {isMe && !isAdmin && (
                      <span className="text-[10px] text-primary/70 font-mono">
                        (you)
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                    <span className="font-mono text-secondary font-semibold">
                      ${getAvailableBudget(p.budgetView).toString()}
                    </span>
                    <span>{p.wonPlayers.length} picks</span>
                  </div>
                </div>

                {/* Remove button — admin only, not for themselves */}
                {isCurrentUserAdmin && !isMe && (
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={isRemoving}
                    onClick={() => handleRemove(p.userId, p.displayName)}
                    className="w-7 h-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                    aria-label={`Remove ${p.displayName}`}
                    data-ocid="roster-remove-user-btn"
                  >
                    {isRemoving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <X className="w-3.5 h-3.5" />
                    )}
                  </Button>
                )}
              </li>
            );
          })}

          {participants.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">
              No participants yet.
            </li>
          )}
        </ul>
      </ScrollArea>
    </div>
  );
}

export default RosterPanel;
