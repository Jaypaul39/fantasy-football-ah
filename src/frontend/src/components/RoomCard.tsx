import { Badge } from "@/components/ui/badge";
import { useRouter } from "@tanstack/react-router";
import { Calendar, Loader2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useBackend } from "../hooks/useBackend";
import { AuctionState, type RoomSummary } from "../types";

function StateBadge({ state }: { state: AuctionState }) {
  switch (state) {
    case AuctionState.Active:
      return (
        <Badge className="bg-primary/20 text-primary border border-primary/50 font-mono text-xs pulse-neon">
          LIVE
        </Badge>
      );
    case AuctionState.Paused:
      return (
        <Badge className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 font-mono text-xs">
          PAUSED
        </Badge>
      );
    case AuctionState.Waiting:
      return (
        <Badge className="bg-blue-500/20 text-blue-400 border border-blue-500/40 font-mono text-xs">
          WAITING
        </Badge>
      );
    case AuctionState.Completed:
      return (
        <Badge className="bg-muted text-muted-foreground border border-border font-mono text-xs">
          DONE
        </Badge>
      );
  }
}

function formatDate(timestamp: bigint): string {
  const ms = Number(timestamp / 1_000_000n);
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface RoomCardProps {
  room: RoomSummary;
  isAuthenticated?: boolean;
  /** Whether the current user is already a participant of this room. */
  isParticipant?: boolean;
}

function getRoomTypeLabel(room: RoomSummary): string {
  const filterType = (
    room as RoomSummary & {
      playerFilter?: { filterType?: string; positions?: string[] };
    }
  ).playerFilter?.filterType;
  const positions = (
    room as RoomSummary & {
      playerFilter?: { filterType?: string; positions?: string[] };
    }
  ).playerFilter?.positions;
  if (filterType === "rookies") return "Rookie Auction";
  if (positions && positions.length >= 4) return "Full Redraft";
  return "Auction Draft";
}

export function RoomCard({
  room,
  isAuthenticated = true,
  isParticipant = false,
}: RoomCardProps) {
  const router = useRouter();
  const { actor } = useBackend();
  const [joining, setJoining] = useState(false);
  const isCompleted = room.state === AuctionState.Completed;
  const isFull =
    room.maxParticipants != null &&
    room.participantCount >= room.maxParticipants;
  const roomTypeLabel = getRoomTypeLabel(room);
  const startingBudget = (room as RoomSummary & { startingBudget?: bigint })
    .startingBudget;

  async function handleClick() {
    if (!isAuthenticated) return;
    // Already in the room — navigate directly
    if (isParticipant) {
      router.navigate({ to: "/room/$roomId", params: { roomId: room.id } });
      return;
    }
    if (!actor) return;
    // Public rooms: join directly with no password
    setJoining(true);
    try {
      const result = await actor.joinRoom(room.id, null);
      if (result.__kind__ === "err") {
        const errMsg = result.err as string;
        if (errMsg === "Room is full") {
          toast.error("This room is full and cannot accept more participants.");
        } else if (errMsg.toLowerCase().includes("already")) {
          // Already a member — just navigate
          router.navigate({ to: "/room/$roomId", params: { roomId: room.id } });
        } else {
          toast.error(`Could not join: ${errMsg}`);
        }
        return;
      }
      toast.success("Joined room!");
      router.navigate({ to: "/room/$roomId", params: { roomId: room.id } });
    } catch {
      toast.error("Unexpected error joining room.");
    } finally {
      setJoining(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!isAuthenticated || joining}
      data-ocid="rooms-room-card"
      className={[
        "group relative bg-card/80 backdrop-blur-sm border rounded-xl p-5 flex flex-col gap-4 text-left w-full",
        "shadow-[0_2px_8px_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.6)]",
        "transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isCompleted
          ? "border-white/8 opacity-60 hover:opacity-80 hover:border-white/15 cursor-pointer hover:shadow-[0_4px_16px_rgba(0,0,0,0.5),0_0_12px_rgba(34,211,238,0.06)] hover:-translate-y-0.5"
          : room.state === AuctionState.Active
            ? "border-primary/30 hover:border-primary/70 hover:glow-cyan cursor-pointer hover:shadow-[0_4px_16px_rgba(0,0,0,0.5),0_0_12px_rgba(34,211,238,0.06)] hover:-translate-y-0.5"
            : "border-white/8 hover:border-primary/40 cursor-pointer hover:shadow-[0_4px_16px_rgba(0,0,0,0.5),0_0_12px_rgba(34,211,238,0.06)] hover:-translate-y-0.5",
        !isAuthenticated && "cursor-default",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`font-display font-bold text-base truncate min-w-0 ${
            isCompleted
              ? "text-muted-foreground"
              : "text-foreground group-hover:text-primary transition-colors"
          }`}
        >
          {room.name}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {joining && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          )}
          {isFull && (
            <Badge className="bg-destructive/20 text-destructive border border-destructive/40 font-mono text-[10px]">
              FULL
            </Badge>
          )}
          <StateBadge state={room.state} />
        </div>
      </div>

      {/* Room type + budget metadata */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{roomTypeLabel}</span>
        <span className="text-border">•</span>
        <span className="truncate">
          ${startingBudget != null ? startingBudget.toString() : "0"} Budget
        </span>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5" />
          <span
            className={isFull ? "text-destructive font-semibold" : ""}
            data-ocid="room-card-participant-count"
          >
            {room.participantCount != null && room.maxParticipants != null
              ? `${room.participantCount.toString()} / ${room.maxParticipants.toString()} players`
              : `${room.participantCount?.toString() ?? "0"} players`}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" />
          <span>{formatDate(room.createdAt)}</span>
        </span>
      </div>
    </button>
  );
}

export default RoomCard;
