import { useInternetIdentity } from "@caffeineai/core-infrastructure";
import type { Principal } from "@icp-sdk/core/principal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type {
  BidHistoryEvent,
  ChatMessage,
  NominationId,
  RoomId,
  UserId,
} from "../backend.d.ts";
import type { RoomSummary, RoomView } from "../types";
import { useBackend } from "./useBackend";

/**
 * Polls getRoomState every 100ms when inside a room.
 * Also fires sweepNominations every 30000ms so the backend can auto-award
 * players whose timers have expired (IC has no background tasks).
 * Returns null if the room is not found or the user is not in it.
 */
export function useRoomPolling(roomId: string | null): {
  roomView: RoomView | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();
  const { identity } = useInternetIdentity();
  const principal = identity?.getPrincipal() ?? null;

  const { data, isLoading, error } = useQuery<RoomView | null, Error>({
    queryKey: ["room", roomId],
    queryFn: async () => {
      if (!actor || !roomId) return null;
      const result = await actor.getRoomState(roomId);
      if (result.__kind__ === "ok") {
        return result.ok;
      }
      return null;
    },
    enabled: !!actor && !isFetching && !!roomId,
    refetchInterval: 500,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    gcTime: 0,
  });

  const prevRoomViewRef = useRef<any>(null);
  const notifHasInitRef = useRef(false);

  useEffect(() => {
    if (!data || !principal) return;

    const currentView = data;
    const prevView = prevRoomViewRef.current;

    if (!notifHasInitRef.current) {
      notifHasInitRef.current = true;
      prevRoomViewRef.current = currentView;
      return;
    }

    if (!document.hidden) {
      prevRoomViewRef.current = currentView;
      return;
    }

    if (!prevView) {
      prevRoomViewRef.current = currentView;
      return;
    }

    const myPrincipalText = principal.toText();

    // Foreground/background notifications use the browser Notification API only.
    // All push sends go through the backend worker — the browser never calls
    // the OneSignal REST API directly.
    const notify = (title: string, body: string) => {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification(title, {
            body,
            icon: "/icon-192.png",
            badge: "/icon-192.png",
          });
        } catch {
          /* silent */
        }
      }
    };

    const prevRoom = prevView.room;
    const currRoom = currentView.room;
    const prevNoms = prevView.activeNominations ?? [];
    const currNoms = currentView.activeNominations ?? [];

    for (const currNom of currNoms) {
      const nomId = currNom.id.toString();
      const prevNom = prevNoms.find((n: any) => n.id.toString() === nomId);
      if (prevNom) {
        const prevLeader = prevNom.bidLeader?.toText?.() ?? null;
        const currLeader = currNom.bidLeader?.toText?.() ?? null;
        if (
          prevLeader === myPrincipalText &&
          currLeader !== myPrincipalText &&
          currLeader !== null
        ) {
          void notify(
            "You've been outbid!",
            `${currNom.playerName} — current bid is now ${currNom.currentBid}`,
          );
        }
      }
    }

    const prevNominatorIdx = prevRoom?.nominatorIndex ?? -1;
    const currNominatorIdx = currRoom?.nominatorIndex ?? -1;
    if (prevNominatorIdx !== currNominatorIdx) {
      const participants = currentView.participants ?? [];
      const currNominator = participants[Number(currNominatorIdx)];
      if (currNominator?.userId?.toText?.() === myPrincipalText) {
        void notify(
          "Your turn to nominate!",
          "You're up — open the app to nominate a player",
        );
      }
    }

    const prevCompletedNoms = prevView.completedNominations ?? [];
    const currCompletedNoms = currentView.completedNominations ?? [];
    const prevCompletedIds = new Set(
      prevCompletedNoms.map((n: any) => n.id.toString()),
    );
    for (const nom of currCompletedNoms) {
      const nomId = nom.id.toString();
      if (!prevCompletedIds.has(nomId)) {
        const winnerId = nom.bidLeader?.toText?.() ?? null;
        if (winnerId === myPrincipalText) {
          void notify(
            `You won ${nom.playerName}!`,
            `Winning bid: ${nom.currentBid}`,
          );
        }
      }
    }

    const prevState = prevRoom?.state;
    const currState = currRoom?.state;
    const prevStateStr =
      typeof prevState === "string"
        ? prevState
        : ((prevState as any)?.__kind__ ?? "");
    const currStateStr =
      typeof currState === "string"
        ? currState
        : ((currState as any)?.__kind__ ?? "");
    if (prevStateStr === "Waiting" && currStateStr === "Active") {
      void notify(
        "The auction is starting!",
        `${currRoom.name} — get in there`,
      );
    }

    prevRoomViewRef.current = currentView;
  }, [data, principal]);

  // Sweep nominations on mount and every 30s as a safety net.
  // Backend recurring timer is the primary driver — frontend interval is fallback only.
  // This is a fire-and-forget call; errors are silently ignored.
  const sweepRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!actor || !roomId) return;

    // Fire immediately on mount so state is correct right away
    actor.sweepNominations(roomId).catch(() => {});

    // Backend timer is primary — frontend is just a safety net
    sweepRef.current = setInterval(() => {
      actor.sweepNominations(roomId).catch(() => {
        // Intentionally silent — sweep is best-effort
      });
    }, 30000);

    return () => {
      if (sweepRef.current) clearInterval(sweepRef.current);
    };
  }, [actor, roomId]);

  // On window focus, await a sweep before refetching so the backend advances
  // any expired turns first — prevents the 0:00 flash on return from inactivity.
  const queryClient = useQueryClient();
  const isSweepingRef = useRef(false);

  useEffect(() => {
    const handleFocus = async () => {
      if (!actor || !roomId || isSweepingRef.current) return;

      isSweepingRef.current = true;
      try {
        // Await sweep BEFORE refetching — ensures backend advances any expired
        // turns so the first render shows correct state, not stale 0:00
        await actor.sweepNominations(roomId);
      } catch {
      } finally {
        isSweepingRef.current = false;
      }

      queryClient.invalidateQueries({ queryKey: ["room", roomId] });
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [actor, roomId, queryClient]);

  // On tab visibility restored, await a sweep before refetching — handles
  // mobile where window focus does not reliably fire on tab switch.
  const isSweepingVisRef = useRef(false);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== "visible") return;
      if (!actor || !roomId || isSweepingVisRef.current) return;

      isSweepingVisRef.current = true;

      try {
        // MUST await so backend advances before UI refetch
        await actor.sweepNominations(roomId);
      } catch {
      } finally {
        isSweepingVisRef.current = false;
      }

      queryClient.invalidateQueries({ queryKey: ["room", roomId] });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [actor, roomId, queryClient]);

  return {
    roomView: data ?? null,
    isLoading,
    error: error ?? null,
  };
}

/**
 * Polls listPublicRooms to keep the public lobby list up-to-date.
 *
 * The lobby does not need auction-speed updates, so it polls at a clearly
 * slower cadence (12s) than the active auction room (500ms). It still refreshes
 * promptly when the user returns to the lobby via React Query's
 * refetchOnWindowFocus, so newly created/joined/changed rooms appear without
 * waiting for the next interval tick.
 * Only returns public rooms — private-room metadata is never exposed here.
 */
export function useRoomsList(): {
  rooms: RoomSummary[];
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading, error } = useQuery<RoomSummary[], Error>({
    queryKey: ["rooms"],
    queryFn: async () => {
      if (!actor) return [];
      return actor.listPublicRooms();
    },
    enabled: !!actor && !isFetching,
    refetchInterval: 12000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  return {
    rooms: data ?? [],
    isLoading,
    error: error ?? null,
  };
}

/**
 * Polls getUserRooms() to keep the current user's joined rooms up-to-date.
 * MUST poll at the same interval as useRoomsList (12s) so the myRoomIds set is
 * never stale relative to the rooms list — otherwise a participant's Waiting
 * room can briefly appear in openRooms with isParticipant=false, blocking
 * re-entry to a full room. Both lobby queries share the same cadence and both
 * refresh on window focus, so they stay in sync when the user returns.
 * Only runs when the user is authenticated (has an identity).
 */
export function useMyRooms(): {
  myRooms: RoomSummary[];
  isLoading: boolean;
  error: Error | null;
} {
  const { actor, isFetching } = useBackend();
  const { identity } = useInternetIdentity();

  const { data, isLoading, error } = useQuery<RoomSummary[], Error>({
    queryKey: ["myRooms"],
    queryFn: async () => {
      if (!actor) return [];
      return actor.getUserRooms();
    },
    enabled: !!actor && !isFetching && !!identity,
    refetchInterval: 12000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  return {
    myRooms: data ?? [],
    isLoading,
    error: error ?? null,
  };
}

/**
 * Fetches the stored bid history events for a single nomination.
 * Polls every 2000ms — events only change on nomination/leader/end triggers,
 * so a slower interval is sufficient and avoids noise.
 * Returns an empty array while the nomination ID is null/undefined.
 */
export function useNominationHistory(
  nominationId: NominationId | null | undefined,
  roomId: RoomId | null | undefined,
): {
  events: BidHistoryEvent[];
  isLoading: boolean;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading } = useQuery<BidHistoryEvent[], Error>({
    queryKey: [
      "nominationHistory",
      roomId?.toString(),
      nominationId?.toString(),
    ],
    queryFn: async () => {
      if (!actor || nominationId == null) return [];
      return actor.getNominationHistory(nominationId);
    },
    enabled: !!actor && !isFetching && nominationId != null,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
  });

  return {
    events: data ?? [],
    isLoading,
  };
}

/**
 * Polls getMessages() every 1000ms to fetch the latest chat messages for a room.
 * Returns messages in the order the backend provides them (newest first).
 */
export function useMessages(roomId: string | null): {
  messages: ChatMessage[];
  isLoading: boolean;
} {
  const { actor, isFetching } = useBackend();

  const { data, isLoading } = useQuery<ChatMessage[], Error>({
    queryKey: ["messages", roomId],
    queryFn: async () => {
      if (!actor || !roomId) return [];
      return actor.getMessages(roomId, BigInt(50));
    },
    enabled: !!actor && !isFetching && !!roomId,
    refetchInterval: 1000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
  });

  return {
    messages: data ?? [],
    isLoading,
  };
}

/**
 * Returns a function to send a chat message, then refetches message list.
 */
export function useSendMessage(roomId: string | null) {
  const { actor } = useBackend();
  const queryClient = useQueryClient();

  const sendMessage = async (message: string): Promise<void> => {
    if (!actor || !roomId || !message.trim()) return;
    const result = await actor.sendMessage(roomId, message.trim());
    if (result.__kind__ === "err") throw new Error(result.err);
    await queryClient.invalidateQueries({ queryKey: ["messages", roomId] });
  };

  return sendMessage;
}

/**
 * Mutation hook to mark a participant as paid or unpaid.
 * Mirrors the useSendMessage pattern: calls actor.setParticipantPaid,
 * throws on err, and invalidates the ['room', roomId] query on success
 * so the waiting room re-fetches the updated paidParticipants list.
 *
 * Paid status is informational only — it does not affect starting the auction.
 */
export function useSetParticipantPaid(roomId: RoomId | null) {
  const { actor } = useBackend();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: {
      targetUserId: UserId;
      paid: boolean;
    }): Promise<void> => {
      if (!actor || !roomId) return;
      const result = await actor.setParticipantPaid(
        roomId,
        args.targetUserId,
        args.paid,
      );
      if (result.__kind__ === "err") throw new Error(result.err);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["room", roomId] });
    },
  });
}
