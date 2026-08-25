import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRouter } from "@tanstack/react-router";
import { Calendar, DoorOpen, Loader2, PlusCircle, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CreateRoomDialog } from "../components/CreateRoomDialog";
import { InstallPrompt } from "../components/InstallPrompt";
import { JoinRoomDialog } from "../components/JoinRoomDialog";
import { HERO_IMAGE_URL, LOGO_URL } from "../config/assets";
import { useAuth } from "../hooks/useAuth";
import { useBackend } from "../hooks/useBackend";
import { useMyRooms, useRoomsList } from "../hooks/useRoomPolling";
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

interface PublicRoomRowProps {
  room: RoomSummary;
  isParticipant: boolean;
}

function PublicRoomRow({ room, isParticipant }: PublicRoomRowProps) {
  const router = useRouter();
  const { actor } = useBackend();
  const [joining, setJoining] = useState(false);
  const isFull =
    room.maxParticipants != null &&
    room.participantCount >= room.maxParticipants;

  const isLive =
    room.state === AuctionState.Active || room.state === AuctionState.Paused;
  const isCompleted = room.state === AuctionState.Completed;

  const handleJoin = async () => {
    if (!actor) return;
    if (isParticipant) {
      router.navigate({ to: "/room/$roomId", params: { roomId: room.id } });
      return;
    }
    // Non-participants cannot join live or completed rooms
    if (isLive || isCompleted) return;
    setJoining(true);
    try {
      const result = await actor.joinRoom(room.id, "");
      if (result.__kind__ === "err") {
        const errMsg = result.err as string;
        if (errMsg === "Room is full") {
          toast.error("This room is full.");
        } else if (errMsg.toLowerCase().includes("already")) {
          // Stale isParticipant — user is actually already in the room.
          // Navigate instead of showing an error (mirrors RoomCard.tsx).
          router.navigate({ to: "/room/$roomId", params: { roomId: room.id } });
        } else {
          toast.error(`Could not join: ${errMsg}`);
        }
        return;
      }
      toast.success(`Joined "${room.name}"!`);
      router.navigate({ to: "/room/$roomId", params: { roomId: room.id } });
    } catch {
      toast.error("Unexpected error joining room.");
    } finally {
      setJoining(false);
    }
  };

  // Determine button state for non-participants
  const renderActionButton = () => {
    if (isParticipant) {
      if (isCompleted) {
        return (
          <Button
            size="sm"
            onClick={handleJoin}
            className="bg-muted/40 hover:bg-muted/60 text-muted-foreground border border-border font-mono text-xs min-w-[80px]"
            data-ocid="public-room-view-recap-btn"
          >
            View Recap
          </Button>
        );
      }
      return (
        <Button
          size="sm"
          onClick={handleJoin}
          className="bg-primary/20 hover:bg-primary/30 text-primary border border-primary/40 font-mono text-xs min-w-[80px]"
          data-ocid="public-room-enter-btn"
        >
          Enter
        </Button>
      );
    }

    if (isCompleted) {
      // Completed rooms — hide button entirely for non-participants
      return null;
    }

    if (isLive) {
      // Live rooms — show disabled button for non-participants
      return (
        <Button
          size="sm"
          disabled
          title="Auction is already in progress"
          className="bg-muted/40 text-muted-foreground border border-border font-mono text-xs min-w-[80px] cursor-not-allowed opacity-50"
          data-ocid="public-room-join-btn"
        >
          Live
        </Button>
      );
    }

    // Waiting — normal join. The button is NOT disabled when full: a stale
    // isParticipant flag could mean the user is actually already in the room.
    // Clicking Join attempts joinRoom; if the backend says "Already in room",
    // handleJoin navigates to the room instead of erroring. Only the in-flight
    // joining state disables the button.
    return (
      <Button
        size="sm"
        onClick={handleJoin}
        disabled={joining}
        className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs min-w-[80px]"
        data-ocid="public-room-join-btn"
      >
        {joining ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : isFull ? (
          "Try Join"
        ) : (
          "Join"
        )}
      </Button>
    );
  };

  return (
    <div
      className={`flex items-center gap-4 px-4 py-3.5 rounded-xl border bg-card transition-smooth ${
        room.state === AuctionState.Active
          ? "border-primary/30 hover:border-primary/60 hover:shadow-[0_0_16px_rgba(34,211,238,0.12)]"
          : "border-border hover:border-border/70"
      }`}
      data-ocid="public-room-row"
    >
      {/* Room info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-display font-semibold text-sm text-foreground truncate">
            {room.name}
          </span>
          <StateBadge state={room.state} />
          {isFull && (
            <Badge className="bg-destructive/20 text-destructive border border-destructive/40 font-mono text-[10px]">
              FULL
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Users className="w-3 h-3" />
            <span className={isFull ? "text-destructive font-semibold" : ""}>
              {room.participantCount != null && room.maxParticipants != null
                ? `${room.participantCount.toString()} / ${room.maxParticipants.toString()} players`
                : `${room.participantCount?.toString() ?? "0"} players`}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3" />
            {formatDate(room.createdAt)}
          </span>
        </div>
      </div>

      {/* Action button */}
      <div className="shrink-0">{renderActionButton()}</div>
    </div>
  );
}

export default function RoomsPage() {
  const { rooms, isLoading } = useRoomsList();
  const { isAuthenticated, login } = useAuth();
  const { myRooms } = useMyRooms();
  const myRoomIds = new Set(myRooms.map((r) => r.id));
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "my-rooms" | "open-rooms" | "my-completed"
  >("my-rooms");

  // Filter to public rooms only (isPublic field may not yet exist on all records)
  const publicRooms = rooms.filter(
    (r: RoomSummary) =>
      !("isPublic" in r) ||
      (r as RoomSummary & { isPublic?: boolean }).isPublic !== false,
  );

  // Categorize rooms
  const myActiveRooms = publicRooms.filter(
    (r: RoomSummary) =>
      myRoomIds.has(r.id) && r.state !== AuctionState.Completed,
  );
  const myCompletedRooms = publicRooms.filter(
    (r: RoomSummary) =>
      myRoomIds.has(r.id) && r.state === AuctionState.Completed,
  );
  const openRooms = publicRooms.filter(
    (r: RoomSummary) =>
      r.state === AuctionState.Waiting && !myRoomIds.has(r.id),
  );
  const liveDrafts = publicRooms.filter(
    (r: RoomSummary) =>
      (r.state === AuctionState.Active || r.state === AuctionState.Paused) &&
      !myRoomIds.has(r.id),
  );
  const completedDrafts = publicRooms.filter(
    (r: RoomSummary) =>
      r.state === AuctionState.Completed && !myRoomIds.has(r.id),
  );

  // Detect first-time user: no joined rooms and no rooms exist at all
  const isFirstTimeUser =
    !isLoading && myRooms.length === 0 && rooms.length === 0;

  if (!isAuthenticated) {
    return (
      <div
        className="relative flex flex-col items-center justify-center min-h-screen gap-6 px-4 overflow-hidden"
        style={{
          backgroundImage: `url('${HERO_IMAGE_URL}')`,

          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
        data-ocid="rooms-unauthenticated"
      >
        {/* Dark overlay for readability */}
        <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" />

        {/* Content */}
        <div className="relative z-10 text-center space-y-3">
          <div className="flex justify-center mb-4">
            <img
              src={LOGO_URL}
              alt="Fantasy Football Auction House logo"
              className="w-20 h-20 object-contain"
            />
          </div>
          <h1 className="font-display text-3xl font-bold text-foreground">
            Fantasy Football Auction House
          </h1>
          <p className="text-muted-foreground max-w-sm">
            Live bidding, proxy bids, real-time timers. Log in with Internet
            Identity to create or join a draft room.
          </p>
        </div>
        <Button
          onClick={login}
          className="relative z-10 bg-primary text-primary-foreground hover:bg-primary/90 px-8"
          data-ocid="rooms-login-cta"
        >
          Log in to Get Started
        </Button>
      </div>
    );
  }

  return (
    <>
      <div
        className="p-4 sm:p-6 max-w-3xl mx-auto space-y-8 min-h-screen"
        style={{
          background:
            "radial-gradient(ellipse at top, rgba(13,0,31,0.6) 0%, rgba(0,0,0,1) 70%)",
        }}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-bold text-foreground mb-1">
              Public Auction Rooms
            </h2>
            <p className="text-muted-foreground text-sm">
              Join a live or upcoming auction, or create your own draft.
            </p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-sm"
            data-ocid="rooms-create-btn"
          >
            <PlusCircle className="w-4 h-4 mr-2" />
            Create Room
          </Button>
        </div>

        {/* Lobby tabs */}
        <div
          className="flex items-center gap-1 p-1 rounded-lg bg-muted/50 border border-border/50 w-fit"
          role="tablist"
          aria-label="Lobby sections"
        >
          {[
            {
              id: "my-rooms" as const,
              label: "My Rooms",
              count: myActiveRooms.length,
              ocid: "lobby-tab-my-rooms",
            },
            {
              id: "open-rooms" as const,
              label: "Open Rooms",
              count: openRooms.length,
              ocid: "lobby-tab-open-rooms",
            },
            {
              id: "my-completed" as const,
              label: "My Completed Drafts",
              count: myCompletedRooms.length,
              ocid: "lobby-tab-my-completed",
            },
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-ocid={tab.ocid}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span
                    className={`ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-mono ${
                      isActive
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Loading skeletons */}
        {isLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton
                key={i}
                className="h-20 w-full rounded-xl skeleton-shimmer"
              />
            ))}
          </div>
        )}

        {/* First-time user onboarding */}
        {!isLoading && isFirstTimeUser && (
          <div className="space-y-6" data-ocid="rooms-onboarding-section">
            <div className="text-center space-y-2">
              <h3 className="font-display text-xl font-bold text-foreground">
                Welcome to the Auction House
              </h3>
              <p className="text-muted-foreground text-sm">
                Get started by creating your own draft or joining one.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Create Room CTA */}
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="group relative flex flex-col items-center gap-3 p-6 rounded-xl border border-white/8 bg-card/80 backdrop-blur-sm shadow-[0_2px_8px_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.6)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.5),0_0_12px_rgba(34,211,238,0.06)] hover:-translate-y-0.5 transition-all duration-150 text-left"
                data-ocid="rooms-onboarding-create-btn"
              >
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <PlusCircle className="w-6 h-6 text-primary" />
                </div>
                <div className="text-center">
                  <p className="font-display font-semibold text-foreground group-hover:text-primary transition-colors">
                    Create a Room
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Create and host your own live auction draft
                  </p>
                </div>
              </button>

              {/* Join Room CTA */}
              <button
                type="button"
                onClick={() => setJoinOpen(true)}
                className="group relative flex flex-col items-center gap-3 p-6 rounded-xl border border-white/8 bg-card/80 backdrop-blur-sm shadow-[0_2px_8px_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.6)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.5),0_0_12px_rgba(34,211,238,0.06)] hover:-translate-y-0.5 transition-all duration-150 text-left"
                data-ocid="rooms-onboarding-join-btn"
              >
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <DoorOpen className="w-6 h-6 text-primary" />
                </div>
                <div className="text-center">
                  <p className="font-display font-semibold text-foreground group-hover:text-primary transition-colors">
                    Join a Room
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Join a commissioner's room using an invite link
                  </p>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Generic empty state (non-first-time, no rooms at all) */}
        {!isLoading &&
          !isFirstTimeUser &&
          myActiveRooms.length === 0 &&
          myCompletedRooms.length === 0 &&
          openRooms.length === 0 &&
          liveDrafts.length === 0 &&
          completedDrafts.length === 0 && (
            <div
              className="flex flex-col items-center justify-center py-20 gap-4 text-center"
              data-ocid="rooms-empty-state"
            >
              <div
                className="w-14 h-14 rounded-full bg-muted flex items-center justify-center text-2xl"
                role="img"
                aria-label="Football"
              >
                🏈
              </div>
              <div>
                <p className="font-medium text-foreground mb-1">
                  No public rooms yet
                </p>
                <p className="text-muted-foreground text-sm">
                  Create a room to host your first auction draft.
                </p>
              </div>
              <Button
                onClick={() => setCreateOpen(true)}
                className="bg-primary text-primary-foreground hover:bg-primary/90 mt-2"
                data-ocid="rooms-empty-create-btn"
              >
                <PlusCircle className="w-4 h-4 mr-2" />
                Create First Room
              </Button>
            </div>
          )}

        {/* Tabbed lobby panels */}
        {!isLoading && !isFirstTimeUser && (
          <div
            className="rounded-xl border border-border bg-card/60 backdrop-blur-sm p-5 sm:p-6 shadow-[0_2px_8px_rgba(0,0,0,0.3)] animate-fade-in"
            data-ocid="lobby-panel"
          >
            {/* My Rooms tab */}
            {activeTab === "my-rooms" && (
              <div className="space-y-8" data-ocid="lobby-panel-my-rooms">
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    My Rooms
                  </h3>
                  {myActiveRooms.length > 0 ? (
                    <div className="space-y-2">
                      {myActiveRooms.map((room: RoomSummary) => (
                        <PublicRoomRow
                          key={room.id}
                          room={room}
                          isParticipant={true}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4">
                      Your leagues will appear here.
                    </p>
                  )}
                </section>

                {/* Live Drafts — user-relevant live drafts, kept under My Rooms tab */}
                {liveDrafts.length > 0 && (
                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Live Drafts
                    </h3>
                    <div className="space-y-2">
                      {liveDrafts.map((room: RoomSummary) => (
                        <PublicRoomRow
                          key={room.id}
                          room={room}
                          isParticipant={false}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {/* Completed Drafts — kept under My Rooms tab */}
                {completedDrafts.length > 0 && (
                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Completed Drafts
                    </h3>
                    <div className="space-y-2">
                      {completedDrafts.map((room: RoomSummary) => (
                        <PublicRoomRow
                          key={room.id}
                          room={room}
                          isParticipant={false}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}

            {/* Open Rooms tab */}
            {activeTab === "open-rooms" && (
              <div className="space-y-8" data-ocid="lobby-panel-open-rooms">
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Open Rooms — Accepting Participants
                  </h3>
                  {openRooms.length > 0 ? (
                    <div className="space-y-2">
                      {openRooms.map((room: RoomSummary) => (
                        <PublicRoomRow
                          key={room.id}
                          room={room}
                          isParticipant={false}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4">
                      Ask your commissioner for an invite link.
                    </p>
                  )}
                </section>
              </div>
            )}

            {/* My Completed Drafts tab */}
            {activeTab === "my-completed" && (
              <div className="space-y-8" data-ocid="lobby-panel-my-completed">
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    My Completed Drafts
                  </h3>
                  {myCompletedRooms.length > 0 ? (
                    <div className="space-y-2">
                      {myCompletedRooms.map((room: RoomSummary) => (
                        <PublicRoomRow
                          key={room.id}
                          room={room}
                          isParticipant={true}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4">
                      Your completed drafts will appear here.
                    </p>
                  )}
                </section>
              </div>
            )}
          </div>
        )}
      </div>

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinRoomDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <InstallPrompt />
    </>
  );
}
