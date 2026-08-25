/**
 * Estimated auction value calculator.
 * Uses Weighted VBD + Position Scarcity + FLEX/SUPERFLEX demand + Bench demand.
 * Pure function — no React, no side effects.
 */

// ── Tuning constants ─────────────────────────────────────────────────────────

export const SCARCITY_WEIGHT = 0.35;
export const SUPERFLEX_QB_BOOST = 1.5;
export const MAX_SCARCITY_RATIO = 2.0;
export const MIN_POSITION_MULTIPLIER = 0.9;
export const MAX_POSITION_MULTIPLIER = 1.75;
export const spendablePoolPct = 0.9;

export const FLEX_WEIGHTS: Record<string, number> = {
  RB: 0.45,
  WR: 0.45,
  TE: 0.1,
};

export const SUPERFLEX_WEIGHTS: Record<string, number> = {
  QB: 0.7,
  RB: 0.1,
  WR: 0.15,
  TE: 0.05,
};

export const BENCH_WEIGHTS: Record<string, number> = {
  QB: 0.1,
  RB: 0.4,
  WR: 0.4,
  TE: 0.1,
};

export const VAB_EXPONENT = 1.8;
export const QB_SUPERFLEX_PREMIUM = 1.25;

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Calculate estimated auction values for a list of players.
 *
 * @param players       Array of players with name, position, and ADP
 * @param rosterSettings League roster configuration (all numeric, bigints already converted)
 * @param numTeams      Number of teams in the league
 * @param totalBudget   Each team's starting auction budget
 * @param positions     Restricted position filter (e.g. rookie auctions). Empty = no restriction.
 * @returns Map keyed by player.name.trim().toLowerCase() → estimated auction value ($)
 */
export function calculateEstimatedValues(
  players: Array<{
    name: string;
    position: string;
    adp: number;
  }>,
  rosterSettings: {
    qb: number;
    rb: number;
    wr: number;
    te: number;
    flex: number;
    superflex: number;
    bench: number;
    flexPositions: string[];
    superflexPositions: string[];
  },
  numTeams: number,
  totalBudget: number,
  positions: string[],
): Map<string, number> {
  // ── Step 1: Effective starter demand with weighted FLEX/SUPERFLEX allocation ──

  const eligibleFlexPositions = Object.keys(FLEX_WEIGHTS).filter((p) =>
    rosterSettings.flexPositions.includes(p),
  );
  const flexWeightSum = eligibleFlexPositions.reduce(
    (sum, p) => sum + FLEX_WEIGHTS[p],
    0,
  );
  const flexAllocation: Record<string, number> = {};
  for (const p of eligibleFlexPositions) {
    flexAllocation[p] = rosterSettings.flex * (FLEX_WEIGHTS[p] / flexWeightSum);
  }

  const eligibleSFPositions = Object.keys(SUPERFLEX_WEIGHTS).filter((p) =>
    rosterSettings.superflexPositions.includes(p),
  );
  const sfWeightSum = eligibleSFPositions.reduce(
    (sum, p) => sum + SUPERFLEX_WEIGHTS[p],
    0,
  );
  const sfAllocation: Record<string, number> = {};
  for (const p of eligibleSFPositions) {
    sfAllocation[p] =
      rosterSettings.superflex * (SUPERFLEX_WEIGHTS[p] / sfWeightSum);
  }

  const starterSlots: Record<string, number> = {
    QB: numTeams * (rosterSettings.qb + (sfAllocation.QB ?? 0)),
    RB:
      numTeams *
      (rosterSettings.rb + (flexAllocation.RB ?? 0) + (sfAllocation.RB ?? 0)),
    WR:
      numTeams *
      (rosterSettings.wr + (flexAllocation.WR ?? 0) + (sfAllocation.WR ?? 0)),
    TE:
      numTeams *
      (rosterSettings.te + (flexAllocation.TE ?? 0) + (sfAllocation.TE ?? 0)),
  };

  // ── Step 1B: Bench demand ──────────────────────────────────────────────────

  // In restricted player pool formats (rookie-only, positional auctions),
  // reduce bench influence by 50% to prevent artificial scarcity inflation.
  const BENCH_DEMAND_FACTOR = positions.length > 0 ? 0.5 : 1.0;
  const totalBenchSlots = numTeams * rosterSettings.bench * BENCH_DEMAND_FACTOR;

  const benchAllocation = {
    QB: totalBenchSlots * BENCH_WEIGHTS.QB,
    RB: totalBenchSlots * BENCH_WEIGHTS.RB,
    WR: totalBenchSlots * BENCH_WEIGHTS.WR,
    TE: totalBenchSlots * BENCH_WEIGHTS.TE,
  };

  starterSlots.QB += benchAllocation.QB;
  starterSlots.RB += benchAllocation.RB;
  starterSlots.WR += benchAllocation.WR;
  starterSlots.TE += benchAllocation.TE;

  // When positions is non-empty, only relevant slots are active.
  // Other positions will be excluded from VBD but still returned with $1.
  const activePositions =
    positions.length > 0
      ? positions.map((p) => p.toUpperCase())
      : ["QB", "RB", "WR", "TE"];

  // ── Step 2: Baseline players ───────────────────────────────────────────────

  const playersByPosition: Record<
    string,
    Array<{ name: string; position: string; adp: number }>
  > = {};
  for (const player of players) {
    const pos = player.position.toUpperCase();
    if (!playersByPosition[pos]) playersByPosition[pos] = [];
    playersByPosition[pos].push(player);
  }

  // Sort each position group by ADP ascending
  for (const pos of Object.keys(playersByPosition)) {
    playersByPosition[pos].sort((a, b) => a.adp - b.adp);
  }

  const isSuperflex = rosterSettings.superflex > 0;

  const baseline: Record<string, number> = {};
  for (const pos of activePositions) {
    const posPlayers = playersByPosition[pos];
    if (!posPlayers || posPlayers.length === 0) continue;
    const slots = starterSlots[pos] ?? 0;
    // When Superflex is active, use the 32nd QB (index 31) as the QB baseline
    // to model the real-world NFL scarcity constraint (only 32 starting QBs).
    // Fall back to the last available QB if fewer than 32 exist in the pool.
    const baselineIdx =
      isSuperflex && pos === "QB"
        ? Math.min(31, posPlayers.length - 1)
        : Math.max(0, Math.ceil(slots) - 1);
    const baselinePlayer =
      posPlayers[Math.min(baselineIdx, posPlayers.length - 1)];
    baseline[pos] = baselinePlayer.adp;
  }

  // ── Step 4: Position scarcity multipliers ─────────────────────────────────

  const positionMultiplier: Record<string, number> = {};
  for (const pos of activePositions) {
    const available = playersByPosition[pos]?.length ?? 0;
    if (available === 0) {
      positionMultiplier[pos] = MIN_POSITION_MULTIPLIER;
      continue;
    }
    const slots = starterSlots[pos] ?? 0;
    const rawScarcity = slots / available;
    const cappedScarcity = Math.min(rawScarcity, MAX_SCARCITY_RATIO);
    const normalizedScarcity = 1 + cappedScarcity * SCARCITY_WEIGHT;
    positionMultiplier[pos] = Math.min(
      MAX_POSITION_MULTIPLIER,
      Math.max(MIN_POSITION_MULTIPLIER, normalizedScarcity),
    );
  }

  // ── Step 5: SUPERFLEX QB boost ─────────────────────────────────────────────

  if (rosterSettings.superflex > 0 && positionMultiplier.QB !== undefined) {
    positionMultiplier.QB *= SUPERFLEX_QB_BOOST;
    positionMultiplier.QB = Math.min(
      positionMultiplier.QB,
      MAX_POSITION_MULTIPLIER,
    );
  }

  // ── Steps 3 + 6: VAB and weighted VAB per player ──────────────────────────

  const weightedVABs: number[] = [];
  let totalWeightedVAB = 0;

  for (const player of players) {
    const pos = player.position.toUpperCase();
    const isActivePos = activePositions.includes(pos);

    if (!isActivePos) {
      weightedVABs.push(0);
      continue;
    }

    // Step 3: VAB
    const vab = Math.max(0, (baseline[pos] ?? 999) - player.adp);

    // Step 6: Weighted VAB
    const mult = positionMultiplier[pos] ?? MIN_POSITION_MULTIPLIER;
    const curvedVAB = vab > 0 ? vab ** VAB_EXPONENT : 0;
    // Apply QB Superflex premium on top of the existing (capped) positionMultiplier.
    // This stacks with the existing 1.75-capped QB boost to reward scarcity
    // beyond what the generic scarcity formula can express.
    const sfPremium = isSuperflex && pos === "QB" ? QB_SUPERFLEX_PREMIUM : 1.0;
    const wvab = curvedVAB * mult * sfPremium;
    weightedVABs.push(wvab);
    totalWeightedVAB += wvab;
  }

  // ── Step 7: Safety fallback ────────────────────────────────────────────────

  if (totalWeightedVAB <= 0) {
    return new Map(players.map((p) => [p.name.trim().toLowerCase(), 1]));
  }

  // ── Step 8: Normalize to budget ────────────────────────────────────────────

  const totalPoolMoney = totalBudget * numTeams * spendablePoolPct;

  const result = new Map<string, number>();
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const wvab = weightedVABs[i];
    const estimatedValue =
      wvab > 0
        ? Math.max(1, Math.round((wvab / totalWeightedVAB) * totalPoolMoney))
        : 1;
    result.set(player.name.trim().toLowerCase(), estimatedValue);
  }

  return result;
}
