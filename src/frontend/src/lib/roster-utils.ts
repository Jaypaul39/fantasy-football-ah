import type { RosterSettings, WonPlayer } from "@/types";

/**
 * Calculate how many roster spots of each position a user has filled.
 * Ignores unsupported positions (K, DST, IDP, etc.).
 */
export function calcRosterComposition(
  wonPlayers: WonPlayer[],
  rosterSettings: RosterSettings,
): {
  qb: number;
  rb: number;
  wr: number;
  te: number;
  flex: number;
  bench: number;
} {
  const counts = {
    qb: 0,
    rb: 0,
    wr: 0,
    te: 0,
    flex: 0,
    bench: 0,
  };

  const supported = new Set(["QB", "RB", "WR", "TE"]);

  for (const p of wonPlayers) {
    const pos = p.position.toUpperCase();
    if (!supported.has(pos)) continue;

    // Fill dedicated spots first
    if (pos === "QB" && counts.qb < Number(rosterSettings.qb)) {
      counts.qb++;
    } else if (pos === "RB" && counts.rb < Number(rosterSettings.rb)) {
      counts.rb++;
    } else if (pos === "WR" && counts.wr < Number(rosterSettings.wr)) {
      counts.wr++;
    } else if (pos === "TE" && counts.te < Number(rosterSettings.te)) {
      counts.te++;
    } else if (
      (pos === "RB" || pos === "WR" || pos === "TE") &&
      counts.flex < Number(rosterSettings.flex) &&
      rosterSettings.flexPositions.includes(pos)
    ) {
      counts.flex++;
    } else {
      counts.bench++;
    }
  }

  return counts;
}

/**
 * Calculate how many roster spots remain to fill for each position.
 */
export function calcRosterRemaining(
  wonPlayers: WonPlayer[],
  rosterSettings: RosterSettings,
): {
  remaining: {
    qb: number;
    rb: number;
    wr: number;
    te: number;
    flex: number;
    superflex: number;
    bench: number;
  };
} {
  const filled = calcRosterComposition(wonPlayers, rosterSettings);

  return {
    remaining: {
      qb: Math.max(0, Number(rosterSettings.qb) - filled.qb),
      rb: Math.max(0, Number(rosterSettings.rb) - filled.rb),
      wr: Math.max(0, Number(rosterSettings.wr) - filled.wr),
      te: Math.max(0, Number(rosterSettings.te) - filled.te),
      flex: Math.max(0, Number(rosterSettings.flex) - filled.flex),
      superflex: Math.max(0, Number(rosterSettings.superflex) - 0),
      bench: Math.max(0, Number(rosterSettings.bench) - filled.bench),
    },
  };
}
