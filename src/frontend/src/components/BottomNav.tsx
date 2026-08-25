import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Home, List, Newspaper, PlusCircle, User } from "lucide-react";
import { Clock, PauseCircle, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useBackend } from "../hooks/useBackend";
import { useMyRooms } from "../hooks/useRoomPolling";
import { AuctionState, type RoomSummary } from "../types";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { NewsTab } from "./NewsTab";
import ProfileModal from "./ProfileModal";

// ─── helpers reused from Sidebar ───────────────────────────────────────────

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

// ─── My Rooms Sheet ─────────────────────────────────────────────────────────

interface MyRoomsSheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

function MyRoomsSheet({ open, onOpenChange }: MyRoomsSheetProps) {
  const { isAuthenticated, login } = useAuth();
  const { myRooms, isLoading } = useMyRooms();
  const router = useRouter();

  const navigateToRoom = (room: RoomSummary) => {
    router.navigate({ to: "/room/$roomId", params: { roomId: room.id } });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-card border-t border-border rounded-t-2xl pb-safe max-h-[70dvh] overflow-y-auto"
        data-ocid="my-rooms-sheet"
      >
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="font-display text-base text-foreground text-left">
            My Rooms
          </SheetTitle>
        </SheetHeader>

        <div className="px-4 pb-6">
          {!isAuthenticated ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                Log in to see your rooms
              </p>
              <button
                type="button"
                onClick={login}
                className="text-xs text-primary font-semibold border border-primary/40 rounded-md px-3 py-1.5 hover:bg-primary/10 transition-colors"
                data-ocid="my-rooms-sheet-login-btn"
              >
                Log In
              </button>
            </div>
          ) : isLoading ? (
            <div className="space-y-2 py-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : myRooms.length === 0 ? (
            <div className="py-10 text-center" data-ocid="my-rooms-sheet-empty">
              <p className="text-sm text-muted-foreground">
                No rooms yet. Create or join one!
              </p>
            </div>
          ) : (
            <div className="space-y-1.5 mt-1" data-ocid="my-rooms-sheet-list">
              {myRooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => navigateToRoom(room)}
                  data-ocid="my-rooms-sheet-room-row"
                  className="w-full text-left px-3 py-3 rounded-xl flex items-center gap-3 bg-muted/30 hover:bg-muted/60 transition-colors border border-border/40"
                >
                  <span className="shrink-0">{stateIcon(room.state)}</span>
                  <span className="flex-1 truncate text-sm font-medium text-foreground min-w-0">
                    {room.name}
                  </span>
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 font-mono ${stateBadgeClass(room.state)}`}
                  >
                    {stateLabel(room.state)}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Bottom Nav ──────────────────────────────────────────────────────────────

type NavTab = "rooms" | "news" | "my-rooms" | "create" | "profile";

export default function BottomNav() {
  const routerState = useRouterState();
  const router = useRouter();
  const currentPath = routerState.location.pathname;
  const { isAuthenticated, login } = useAuth();
  const { actor } = useBackend();
  const [isAdmin, setIsAdmin] = useState(false);

  const [myRoomsOpen, setMyRoomsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);

  // Derive active tab from route (currently only "rooms" maps to a path)

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

  const handleTab = (tab: NavTab) => {
    switch (tab) {
      case "rooms":
        router.navigate({ to: "/" });
        break;
      case "news":
        setNewsOpen(true);
        break;
      case "my-rooms":
        setMyRoomsOpen(true);
        break;
      case "create":
        if (!isAuthenticated) {
          login();
          return;
        }
        setCreateOpen(true);
        break;
      case "profile":
        setProfileOpen(true);
        break;
    }
  };

  const tabs: {
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    ocid: string;
  }[] = [
    {
      id: "rooms",
      label: "Rooms",
      icon: <Home className="h-5 w-5" />,
      ocid: "bottom-nav-rooms",
    },
    {
      id: "news",
      label: "News",
      icon: <Newspaper className="h-5 w-5" />,
      ocid: "bottom-nav-news",
    },
    {
      id: "my-rooms",
      label: "My Rooms",
      icon: <List className="h-5 w-5" />,
      ocid: "bottom-nav-my-rooms",
    },
    {
      id: "create",
      label: "Create Room",
      icon: <PlusCircle className="h-5 w-5" />,
      ocid: "bottom-nav-create",
    },
    {
      id: "profile",
      label: "Profile",
      icon: <User className="h-5 w-5" />,
      ocid: "bottom-nav-profile",
    },
  ];

  const isTabActive = (id: NavTab) => {
    if (id === "rooms" && currentPath === "/") return true;
    return false;
  };

  return (
    <>
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 h-16 bg-background/40 backdrop-blur-xl backdrop-saturate-150 border-t border-white/10 flex items-stretch"
        data-ocid="bottom-nav"
        aria-label="Main navigation"
      >
        {tabs.map(({ id, label, icon, ocid }) => {
          const active = isTabActive(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleTab(id)}
              data-ocid={ocid}
              aria-label={label}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span
                className={`flex flex-col items-center gap-0.5 rounded-lg px-2 py-1 transition-colors ${
                  active ? "bg-primary/10" : ""
                }`}
              >
                {icon}
                <span className="text-[10px] font-medium leading-none">
                  {label}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      {/* My Rooms slide-up sheet */}
      <MyRoomsSheet open={myRoomsOpen} onOpenChange={setMyRoomsOpen} />

      {/* News slide-up sheet */}
      <Sheet open={newsOpen} onOpenChange={setNewsOpen}>
        <SheetContent
          side="bottom"
          className="bg-card border-t border-border rounded-t-2xl pb-safe p-0 max-h-[80dvh] overflow-hidden flex flex-col"
          data-ocid="news-sheet"
          showCloseButton={false}
        >
          <SheetHeader className="px-4 pt-4 pb-2 sr-only">
            <SheetTitle className="font-display text-base text-foreground text-left">
              NFL News
            </SheetTitle>
          </SheetHeader>
          <NewsTab />
        </SheetContent>
      </Sheet>

      {/* Create Room dialog */}
      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Profile modal — passes isAdmin so it can show admin link */}
      <ProfileModal
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        isAdmin={isAdmin}
      />
    </>
  );
}
