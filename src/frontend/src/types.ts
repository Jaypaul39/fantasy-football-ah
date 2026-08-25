// Re-export all backend-generated types
export type {
  Player,
  Room,
  RoomId,
  RoomSummary,
  RoomView,
  WonPlayer,
  NominationView,
  NominationId,
  ProxyBid,
  AuctionSettings,
  UserId,
  Timestamp,
  UserProfile,
  ParticipantView,
  ParticipantBudgetView,
  PrivateParticipantBudget,
  PublicParticipantBudget,
  WeeklyPlayerStats,
} from "./backend";

import type { RosterSettings } from "./backend";
export type { RosterSettings };

export { AuctionState, NominationState } from "./backend";

// UI-only types

export type AudioPreference = "on" | "off";

export interface UserSession {
  principalText: string;
  displayName: string | null;
  isAdmin: boolean;
}

export interface AppState {
  currentRoomId: string | null;
  audioPreference: AudioPreference;
  sidebarOpen: boolean;
}

export interface BidEvent {
  nominationId: bigint;
  bidderName: string;
  amount: bigint;
  timestamp: number;
}

export type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "K" | "DEF";

export interface PlayerPoolFilter {
  positions: string[];
  filterType: "all" | "rookies" | "veterans" | string;
}

export interface CreateRoomFormData {
  name: string;
  startingBudget: number;
  minBidIncrement: number;
  nomTimerSecs: number;
  bidTimerSecs: number;
  maxActivePicks: number;
  /** Maximum number of participants allowed in the room (8–16) */
  maxParticipants: number;
  playerFilter?: PlayerPoolFilter;
  rosterSettings?: RosterSettings;
  teamCount?: number;
  leagueFormat?: string;
  scoringType?: string;
}

export function defaultRosterSettings(): RosterSettings {
  return {
    qb: BigInt(1),
    rb: BigInt(2),
    wr: BigInt(2),
    te: BigInt(1),
    flex: BigInt(1),
    superflex: BigInt(0),
    bench: BigInt(6),
    flexPositions: ["RB", "WR", "TE"],
    superflexPositions: ["QB", "RB", "WR", "TE"],
  };
}

// ── Budget view helpers ────────────────────────────────────────────────────
// ParticipantBudgetView is a discriminated union from the backend:
//   { __kind__: "private"; private: PrivateParticipantBudget }
//   { __kind__: "public";  public:  PublicParticipantBudget  }
//
// Use these helpers everywhere instead of reading the variant directly.

import type {
  ParticipantBudgetView,
  PrivateParticipantBudget,
  PublicParticipantBudget,
} from "./backend";

export function isPrivateBudget(bv: ParticipantBudgetView): boolean {
  return bv.__kind__ === "private";
}

export function getPrivateBudget(
  bv: ParticipantBudgetView,
): PrivateParticipantBudget | null {
  if (bv.__kind__ === "private") return bv.private;
  return null;
}

export function getPublicBudget(
  bv: ParticipantBudgetView,
): PublicParticipantBudget | null {
  if (bv.__kind__ === "public") return bv.public;
  return null;
}

/** Returns availableBudget (private) or publicAvailableBudget (public). */
export function getAvailableBudget(bv: ParticipantBudgetView): bigint {
  if (bv.__kind__ === "private") return bv.private.availableBudget;
  return bv.public.publicAvailableBudget;
}

export function getTotalBudget(bv: ParticipantBudgetView): bigint {
  if (bv.__kind__ === "private") return bv.private.totalBudget;
  return bv.public.totalBudget;
}

export function getSpentBudget(bv: ParticipantBudgetView): bigint {
  if (bv.__kind__ === "private") return bv.private.spentBudget;
  return bv.public.spentBudget;
}

// ── Roster-reserve ceiling ──────────────────────────────────────────────────
// When a room enforces a roster cap, a bidder must keep enough budget in reserve
// to fill every remaining open roster slot (cap - already won - 1 for the slot
// the current nomination would fill). The effective max bid is therefore the
// available budget minus that reserve. When no cap is set, the full available
// budget is the max bid.

/**
 * Computes the effective max bid given the available budget and roster cap.
 *
 * @param availableBudget  - The bidder's current available budget (bigint).
 * @param maxRosterSize    - The room's roster cap, or null when uncapped.
 * @param wonPlayersCount  - How many players the bidder has already won.
 * @returns The maximum amount the bidder can commit to a single nomination
 *          without losing the ability to fill the rest of their roster.
 *          Never negative.
 */
export function getReserveCeiling(
  availableBudget: bigint,
  maxRosterSize: bigint | null,
  wonPlayersCount: number,
): bigint {
  if (maxRosterSize == null) return availableBudget;
  const cap = Number(maxRosterSize);
  const reserveRequired = Math.max(0, cap - wonPlayersCount - 1);
  const ceiling = availableBudget - BigInt(reserveRequired);
  return ceiling < BigInt(0) ? BigInt(0) : ceiling;
}

// ── Over-commitment safeguard message ───────────────────────────────────────
// Shared copy shown when a bid is blocked because the user is already leading
// an active nomination and bidding again would exceed their roster cap.
// Import this constant instead of duplicating the string across components.
export const OVERCOMMIT_SAFEGUARD_MESSAGE =
  "You are currently leading an active nomination. Bidding on another player would exceed your roster cap.";

/** Profile modal visibility context */
export interface ProfileModalState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}
