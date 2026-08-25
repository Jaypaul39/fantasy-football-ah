import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
  Clock,
  KeyRound,
  LogIn,
  PauseCircle,
  PlusCircle,
  Shield,
  Trophy,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useBackend } from "../hooks/useBackend";
import { useMyRooms } from "../hooks/useRoomPolling";
import { AuctionState, type RoomSummary } from "../types";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { JoinRoomDialog } from "./JoinRoomDialog";

interface SidebarProps {
  onNavigate: () => void;
  onProfileOpen?: () => void;
  onAdminOpen?: () => void;
}

function stateIcon(state: AuctionState) {
  switch (state) {
    case AuctionState.Active:
      return (
        <span className="w-2 h-2 rounded-full bg-primary pulse-neon inline-block" />
      );
    case AuctionState.Paused:
      return <PauseCircle className="w-3.5 h-3.5 text-yellow-400" />;
    case AuctionState.Waiting:
      return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
    case AuctionState.Completed:
      return <Trophy className="w-3.5 h-3.5 text-secondary" />;
  }
}

function stateBadgeClass(state: AuctionState): string {
  switch (state) {
    case AuctionState.Active:
      return "border-primary/50 text-primary bg-primary/10";
    case AuctionState.Paused:
      return "border-yellow-500/40 text-yellow-400 bg-yellow-500/10";
    case AuctionState.Waiting:
      return "border-blue-500/40 text-blue-400 bg-blue-500/10";
    case AuctionState.Completed:
      return "border-border text-muted-foreground";
  }
}

function stateLabel(state: AuctionState): string {
  switch (state) {
    case AuctionState.Active:
      return "LIVE";
    case AuctionState.Paused:
      return "PAUSED";
    case AuctionState.Waiting:
      return "WAITING";
    case AuctionState.Completed:
      return "DONE";
  }
}

interface RoomRowProps {
  room: RoomSummary;
  isActive: boolean;
  onClick: () => void;
}

function RoomRow({ room, isActive, onClick }: RoomRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-ocid="sidebar-room-row"
      className={`w-full text-left px-3 py-2.5 rounded-md flex items-center gap-2.5 transition-smooth group ${
        isActive
          ? "bg-primary/15 border border-primary/40 text-foreground"
          : "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
      }`}
    >
      <span className="shrink-0">{stateIcon(room.state)}</span>
      <span className="flex-1 truncate text-sm font-medium min-w-0">
        {room.name}
      </span>
      <Badge
        variant="outline"
        className={`text-[10px] shrink-0 font-mono ${stateBadgeClass(room.state)}`}
      >
        {stateLabel(room.state)}
      </Badge>
    </button>
  );
}

export default function Sidebar({
  onNavigate,
  onProfileOpen,
  onAdminOpen,
}: SidebarProps) {
  const { isAuthenticated, login } = useAuth();
  const { actor } = useBackend();
  const { myRooms, isLoading: myRoomsLoading } = useMyRooms();
  const router = useRouter();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Check admin status on mount and when actor becomes available
  useEffect(() => {
    if (!actor || !isAuthenticated) {
      setIsAdmin(false);
      return;
    }
    actor
      .checkIsAdmin()
      .then(setIsAdmin)
      .catch(() => setIsAdmin(false));
  }, [actor, isAuthenticated]);

  const currentRoomId = currentPath.startsWith("/room/")
    ? currentPath.replace("/room/", "")
    : null;

  const navigateToRoom = (roomId: string) => {
    router.navigate({ to: "/room/$roomId", params: { roomId } });
    onNavigate();
  };

  const handleRoomsLobby = () => {
    router.navigate({ to: "/" });
    onNavigate();
  };

  return (
    <div className="flex flex-col h-full py-4 gap-1">
      {/* Brand */}
      <div className="px-4 pb-3 flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-md bg-primary/20 border border-primary/40 flex items-center justify-center text-sm"
          aria-hidden="true"
        >
          🏈
        </div>
        <span className="font-display font-bold text-sm text-foreground tracking-wide">
          Fantasy Football Auction House
        </span>
      </div>

      <Separator className="bg-sidebar-border mx-3 w-auto" />

      <div className="flex flex-col gap-1 px-2 pt-2 flex-1 overflow-y-auto scrollbar-thin">
        {/* ── Section 1: Create Auction Room ── */}
        <div className="px-2 pt-1 pb-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
            Create
          </p>
        </div>
        <Button
          variant="outline"
          className="w-full justify-start gap-2.5 px-3 h-9 border-primary/30 text-primary hover:bg-primary/10 hover:border-primary/60 text-sm font-medium"
          onClick={() => {
            if (!isAuthenticated) {
              login();
              return;
            }
            setCreateOpen(true);
          }}
          data-ocid="sidebar-create-room-btn"
        >
          <PlusCircle className="w-4 h-4 shrink-0" />
          Create Auction Room
        </Button>

        <div className="h-3" />

        {/* ── Section 2: Join Auction Room ── */}
        <div className="px-2 pb-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
            Join
          </p>
        </div>
        <button
          type="button"
          onClick={handleRoomsLobby}
          data-ocid="sidebar-rooms-lobby-btn"
          className={`w-full text-left px-3 py-2 rounded-md flex items-center gap-2.5 text-sm transition-smooth ${
            currentPath === "/"
              ? "bg-primary/15 border border-primary/30 text-primary"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }`}
        >
          <LogIn className="w-4 h-4 shrink-0" />
          Public Room Lobby
        </button>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2.5 px-3 h-9 text-muted-foreground hover:text-foreground hover:bg-muted/60 text-sm"
          onClick={() => {
            if (!isAuthenticated) {
              login();
              return;
            }
            setJoinOpen(true);
          }}
          data-ocid="sidebar-join-private-room-btn"
        >
          <KeyRound className="w-4 h-4 shrink-0" />
          Join Private Room
        </Button>

        <div className="h-3" />
        <Separator className="bg-sidebar-border" />
        <div className="h-1" />

        {/* ── Section 3: My Auction Rooms ── */}
        <div className="px-2 pb-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
            My Rooms
          </p>
        </div>

        {!isAuthenticated ? (
          <div
            className="mx-1 px-3 py-3 rounded-md border border-dashed border-border/50 text-center"
            data-ocid="sidebar-my-rooms-login-prompt"
          >
            <p className="text-xs text-muted-foreground mb-2">
              Log in to see your rooms
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={login}
              className="border-primary/40 text-primary hover:bg-primary/10 text-xs h-7"
              data-ocid="sidebar-login-btn"
            >
              Log In
            </Button>
          </div>
        ) : myRoomsLoading ? (
          <div className="space-y-1.5 px-1">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-9 w-full rounded-md" />
            ))}
          </div>
        ) : myRooms.length === 0 ? (
          <div
            className="mx-1 px-3 py-3 rounded-md border border-dashed border-border/40 text-center"
            data-ocid="sidebar-my-rooms-empty"
          >
            <p className="text-xs text-muted-foreground">
              No rooms yet. Create or join one!
            </p>
          </div>
        ) : (
          <div className="space-y-0.5" data-ocid="sidebar-my-rooms-list">
            {myRooms.map((room) => (
              <RoomRow
                key={room.id}
                room={room}
                isActive={currentRoomId === room.id}
                onClick={() => navigateToRoom(room.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom section: Admin (if admin) + Profile ── */}
      <div className="px-2 pt-2 mt-auto space-y-0.5">
        <Separator className="bg-sidebar-border mb-2" />

        {/* Admin section — only visible when user is admin */}
        {isAdmin && (
          <Button
            variant="ghost"
            className="w-full justify-start gap-2.5 px-3 h-9 text-primary/80 hover:text-primary hover:bg-primary/10 text-sm"
            onClick={() => {
              if (onAdminOpen) onAdminOpen();
              onNavigate();
            }}
            data-ocid="sidebar-admin-btn"
          >
            <Shield className="w-4 h-4 shrink-0" />
            Admin Panel
          </Button>
        )}

        <Button
          variant="ghost"
          className="w-full justify-start gap-2.5 px-3 h-9 text-muted-foreground hover:text-foreground hover:bg-muted/60 text-sm"
          onClick={() => {
            if (onProfileOpen) onProfileOpen();
            onNavigate();
          }}
          data-ocid="sidebar-profile-btn"
        >
          <User className="w-4 h-4 shrink-0" />
          Profile Settings
        </Button>
      </div>

      {/* Dialogs */}
      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinRoomDialog open={joinOpen} onOpenChange={setJoinOpen} />
    </div>
  );
}
