import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports GameType) imports ExternalBlob from
// @caffeineai/object-storage, whose dist/blob subpath does not resolve in the
// jsdom test environment. Mock it so the enum value can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import type { PlayoffBracketResult } from "../backend.d.ts";
import { PlayoffBracketTab } from "../components/PlayoffBracketTab";

// ── Mock principals ────────────────────────────────────────────────────────
function makePrincipal(text: string) {
  return {
    toText: () => text,
    toUint8Array: () => new Uint8Array(29),
    compareTo: () => "eq" as const,
    isAnonymous: () => false,
    _isPrincipal: true,
  } as unknown as import("@icp-sdk/core/principal").Principal;
}

const me = makePrincipal("2vxsx-fae"); // current user
const alice = makePrincipal("aaaaa-aa00-aaaa-aaaaa-aaa00-aaaaa-aaa-aa");
const bob = makePrincipal("bbbbb-bb00-bbbb-bbbbb-bbb00-bbbbb-bbb-bb");
const dave = makePrincipal("ccccc-cc00-cccc-ccccc-ccc00-ccccc-ccc-cc");

const participantNames: Record<string, string> = {
  [me.toText()]: "You",
  [alice.toText()]: "Alice",
  [bob.toText()]: "Bob",
  [dave.toText()]: "Dave",
};

// ── Mock the shared hook so the component consumes it without real calls ───
let bracketMock: PlayoffBracketResult | null = null;
let isLoadingMock = false;

vi.mock("../hooks/useGetPlayoffBracket", () => ({
  useGetPlayoffBracket: () => ({
    bracket: bracketMock,
    isLoading: isLoadingMock,
    error: null,
  }),
}));

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <PlayoffBracketTab
        roomId="room-001"
        playoffTeams={4}
        participantNames={participantNames}
      />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

/** Queries an element by its data-ocid deterministic marker. */
function byOcid(ocid: string): HTMLElement {
  const el = document.querySelector(`[data-ocid="${ocid}"]`);
  if (!el) throw new Error(`No element with data-ocid="${ocid}"`);
  return el as HTMLElement;
}

// ── Bracket fixtures ───────────────────────────────────────────────────────
// A 4-team bracket: Week 15 = Semifinals (2 games), Week 16 = Finals (1 game).
function resolvedGame(
  week: bigint,
  homeSeed: bigint,
  home: { participant: typeof me; score: number },
  awaySeed: bigint,
  away: { participant: typeof me; score: number },
  winner: typeof me,
) {
  return {
    game: {
      week,
      home: { __kind__: "Seed" as const, Seed: homeSeed },
      away: { __kind__: "Seed" as const, Seed: awaySeed },
    },
    home: {
      __kind__: "resolved" as const,
      resolved: {
        participant: home.participant,
        seed: homeSeed,
        score: home.score,
      },
    },
    away: {
      __kind__: "resolved" as const,
      resolved: {
        participant: away.participant,
        seed: awaySeed,
        score: away.score,
      },
    },
    status: {
      __kind__: "resolved" as const,
      resolved: { winner, homeScore: home.score, awayScore: away.score },
    },
  };
}

function pendingSyncGame(week: bigint, homeSeed: bigint, awaySeed: bigint) {
  return {
    game: {
      week,
      home: { __kind__: "Seed" as const, Seed: homeSeed },
      away: { __kind__: "Seed" as const, Seed: awaySeed },
    },
    home: { __kind__: "pendingOnSync" as const, pendingOnSync: null },
    away: { __kind__: "pendingOnSync" as const, pendingOnSync: null },
    status: { __kind__: "pendingOnSync" as const, pendingOnSync: null },
  };
}

function pendingDepGame(week: bigint) {
  return {
    game: {
      week,
      home: { __kind__: "WinnerOf" as const, WinnerOf: BigInt(0) },
      away: { __kind__: "WinnerOf" as const, WinnerOf: BigInt(1) },
    },
    home: {
      __kind__: "pendingOnDependency" as const,
      pendingOnDependency: null,
    },
    away: {
      __kind__: "pendingOnDependency" as const,
      pendingOnDependency: null,
    },
    status: {
      __kind__: "pendingOnDependency" as const,
      pendingOnDependency: null,
    },
  };
}

describe("PlayoffBracketTab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    bracketMock = null;
    isLoadingMock = false;
  });

  it("renders round labels for a 4-team bracket", () => {
    bracketMock = {
      games: [
        resolvedGame(
          BigInt(15),
          BigInt(1),
          { participant: me, score: 120.5 },
          BigInt(4),
          { participant: dave, score: 88 },
          me,
        ),
        pendingSyncGame(BigInt(15), BigInt(2), BigInt(3)),
        pendingDepGame(BigInt(16)),
      ],
      champion: { __kind__: "inProgress", inProgress: null },
    };
    renderTab();

    expect(byOcid("bracket-round-1")).toHaveTextContent("Semifinals");
    expect(byOcid("bracket-round-2")).toHaveTextContent("Finals");
    expect(byOcid("bracket-round-champion")).toHaveTextContent("Champion");
  });

  it("shows participants, scores, and the winner for a resolved game", () => {
    bracketMock = {
      games: [
        resolvedGame(
          BigInt(15),
          BigInt(1),
          { participant: me, score: 120.5 },
          BigInt(4),
          { participant: dave, score: 88 },
          me,
        ),
        pendingSyncGame(BigInt(15), BigInt(2), BigInt(3)),
        pendingDepGame(BigInt(16)),
      ],
      champion: { __kind__: "inProgress", inProgress: null },
    };
    renderTab();

    const home = byOcid("bracket-team-1-1-home");
    expect(home).toHaveTextContent("You");
    expect(home).toHaveTextContent("120.5");
    // Winner's score carries the win treatment.
    expect(home.querySelector(".bracket-team-score")).toHaveClass("win");

    const away = byOcid("bracket-team-1-1-away");
    expect(away).toHaveTextContent("Dave");
    expect(away).toHaveTextContent("88.0");
    expect(away.querySelector(".bracket-team-score")).toHaveClass("loss");
  });

  it("shows 'awaiting sync' (not a numeric 0) for a pending-on-sync game", () => {
    bracketMock = {
      games: [
        resolvedGame(
          BigInt(15),
          BigInt(1),
          { participant: me, score: 120.5 },
          BigInt(4),
          { participant: dave, score: 88 },
          me,
        ),
        pendingSyncGame(BigInt(15), BigInt(2), BigInt(3)),
        pendingDepGame(BigInt(16)),
      ],
      champion: { __kind__: "inProgress", inProgress: null },
    };
    renderTab();

    expect(byOcid("bracket-pending-sync")).toHaveTextContent("awaiting sync");
    // Pending teams render TBD with a dash score, never a numeric 0.
    const home = byOcid("bracket-team-1-2-home");
    expect(home).toHaveTextContent("TBD");
    expect(home.querySelector(".bracket-team-score")).toHaveTextContent("–");
    expect(home.querySelector(".bracket-team-score")).not.toHaveTextContent(
      "0",
    );
  });

  it("shows 'TBD' for a pending-on-dependency game", () => {
    bracketMock = {
      games: [
        resolvedGame(
          BigInt(15),
          BigInt(1),
          { participant: me, score: 120.5 },
          BigInt(4),
          { participant: dave, score: 88 },
          me,
        ),
        pendingSyncGame(BigInt(15), BigInt(2), BigInt(3)),
        pendingDepGame(BigInt(16)),
      ],
      champion: { __kind__: "inProgress", inProgress: null },
    };
    renderTab();

    expect(byOcid("bracket-pending-dep")).toHaveTextContent("TBD");
    const home = byOcid("bracket-team-2-1-home");
    expect(home).toHaveTextContent("TBD");
    expect(home.querySelector(".bracket-team-score")).toHaveTextContent("–");
    expect(home.querySelector(".bracket-team-score")).not.toHaveTextContent(
      "0",
    );
  });

  it("shows the champion once the final game resolves", () => {
    bracketMock = {
      games: [
        resolvedGame(
          BigInt(15),
          BigInt(1),
          { participant: me, score: 120.5 },
          BigInt(4),
          { participant: dave, score: 88 },
          me,
        ),
        resolvedGame(
          BigInt(15),
          BigInt(2),
          { participant: alice, score: 110 },
          BigInt(3),
          { participant: bob, score: 95 },
          alice,
        ),
        resolvedGame(
          BigInt(16),
          BigInt(1),
          { participant: me, score: 130 },
          BigInt(2),
          { participant: alice, score: 105 },
          me,
        ),
      ],
      champion: {
        __kind__: "some",
        some: { participant: me, seed: BigInt(1), score: 130 },
      },
    };
    renderTab();

    expect(byOcid("bracket-champion")).toHaveTextContent("Champion");
    expect(byOcid("bracket-champion")).toHaveTextContent("You");
    expect(byOcid("bracket-champion")).toHaveTextContent("130.0");
    expect(
      document.querySelector('[data-ocid="bracket-champion-in-progress"]'),
    ).toBeNull();
  });

  it("shows an in-progress indicator when the champion is not yet determined", () => {
    bracketMock = {
      games: [
        resolvedGame(
          BigInt(15),
          BigInt(1),
          { participant: me, score: 120.5 },
          BigInt(4),
          { participant: dave, score: 88 },
          me,
        ),
        pendingSyncGame(BigInt(15), BigInt(2), BigInt(3)),
        pendingDepGame(BigInt(16)),
      ],
      champion: { __kind__: "inProgress", inProgress: null },
    };
    renderTab();

    expect(byOcid("bracket-champion-in-progress")).toHaveTextContent(
      "In Progress",
    );
    expect(document.querySelector('[data-ocid="bracket-champion"]')).toBeNull();
  });
});
