import type {
  ParticipantView,
  RosterSettings,
  UserId,
  WonPlayer,
} from "@/types";

function getRosterSettingValue(rs: RosterSettings, key: string): bigint {
  switch (key) {
    case "qb":
      return rs.qb;
    case "rb":
      return rs.rb;
    case "wr":
      return rs.wr;
    case "te":
      return rs.te;
    case "flex":
      return rs.flex;
    case "superflex":
      return rs.superflex;
    case "bench":
      return rs.bench;
    default:
      return BigInt(0);
  }
}

/**
 * Total starters required across all teams in the league.
 */
export function calcLeaguePositionRequirements(
  participants: ParticipantView[],
  rosterSettings: RosterSettings,
): Record<string, number> {
  const teamCount = participants.length;
  const required: Record<string, number> = {};

  const positions = ["qb", "rb", "wr", "te", "flex", "superflex", "bench"];
  for (const pos of positions) {
    const count = Number(getRosterSettingValue(rosterSettings, pos));
    required[pos.toUpperCase()] = count * teamCount;
  }

  return required;
}

/**
 * Remaining starters needed league-wide, accounting for already-won players.
 */
export function calcLeaguePositionRemaining(
  allWonPlayers: { principal: string; players: WonPlayer[] }[],
  rosterSettings: RosterSettings,
): Record<string, number> {
  const required = calcLeaguePositionRequirements(
    allWonPlayers.map((p) => ({
      userId: { toText: () => p.principal } as unknown as UserId,
      displayName: "",
      budgetView: {
        __kind__: "public",
        public: {
          publicAvailableBudget: BigInt(0),
          totalBudget: BigInt(0),
          spentBudget: BigInt(0),
        },
      },
      wonPlayers: p.players,
      skipNominationTurn: false,
    })),
    rosterSettings,
  );

  const filled: Record<string, number> = {};
  for (const pos of Object.keys(required)) {
    filled[pos] = 0;
  }

  for (const entry of allWonPlayers) {
    for (const p of entry.players) {
      const pos = p.position.toUpperCase();
      if (filled[pos] !== undefined) {
        filled[pos]++;
      }
    }
  }

  const remaining: Record<string, number> = {};
  for (const pos of Object.keys(required)) {
    remaining[pos] = Math.max(0, required[pos] - (filled[pos] ?? 0));
  }

  return remaining;
}

/**
 * Positional scarcity weight per position (higher = more scarce).
 */
export function calcScarcityWeights(
  remaining: Record<string, number>,
  required: Record<string, number>,
): Record<string, number> {
  const weights: Record<string, number> = {};

  for (const pos of Object.keys(required)) {
    const req = required[pos];
    const rem = remaining[pos] ?? 0;
    if (req === 0) {
      weights[pos] = 0;
    } else {
      weights[pos] = rem === 0 ? 10 : req / rem;
    }
  }

  return weights;
}

/**
 * Normalized demand ratios from scarcity weights.
 */
export function calcDemandRatios(
  scarcityWeights: Record<string, number>,
): Record<string, number> {
  const positions = Object.keys(scarcityWeights);
  if (positions.length === 0) return {};

  const maxWeight = Math.max(...positions.map((p) => scarcityWeights[p]));
  if (maxWeight === 0) {
    const equal = 1 / positions.length;
    return Object.fromEntries(positions.map((p) => [p, equal]));
  }

  const ratios: Record<string, number> = {};
  for (const pos of positions) {
    ratios[pos] = scarcityWeights[pos] / maxWeight;
  }

  return ratios;
}
