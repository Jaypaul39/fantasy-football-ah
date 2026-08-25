/**
 * Core ADP utility functions — standalone, no React dependencies.
 * All functions are pure: they do not mutate their inputs and have no side effects
 * beyond optional console logging for disambiguation diagnostics.
 */

import type { Player } from "../backend";
import type { ADPDataset, ADPEntry, EnrichedPlayer } from "./adp-types";

// ── Name normalization ─────────────────────────────────────────────────────

/**
 * Normalizes a player name for reliable matching between Sleeper and ADP datasets.
 *
 * Rules applied (in order):
 * 1. Lowercase
 * 2. Remove apostrophes, periods, commas, and hyphens
 * 3. Collapse multiple spaces into one
 * 4. Trim leading and trailing whitespace
 *
 * @param name - Raw player name from any source
 * @returns Normalized name string suitable for use as a lookup key
 */
export function normalizeName(name: string): string {
  // Handle "Last, First" CSV format → convert to "First Last" before normalizing
  let normalized = name;
  if (normalized.includes(",")) {
    const parts = normalized.split(",");
    normalized = `${parts[1].trim()} ${parts[0].trim()}`;
  }
  return normalized
    .toLowerCase()
    .replace(/['.,-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Sleeper lookup table ───────────────────────────────────────────────────

/**
 * Builds a normalized name → Player[] lookup map from a Sleeper player array.
 *
 * The value is an array to handle rare cases where two players share the same
 * normalized name (e.g., same first and last name but different teams).
 * Most keys will resolve to a single-element array.
 *
 * @param players - Array of Sleeper Player objects (authoritative source)
 * @returns Map keyed by normalized name, values are arrays of matching players
 */
export function buildSleeperLookup(players: Player[]): Map<string, Player[]> {
  const lookup = new Map<string, Player[]>();

  for (const player of players) {
    const key = normalizeName(player.name);
    const existing = lookup.get(key);
    if (existing) {
      existing.push(player);
    } else {
      lookup.set(key, [player]);
    }
  }

  return lookup;
}

// ── ADP entry matching ─────────────────────────────────────────────────────

/**
 * Attempts to match a single ADP entry against the Sleeper player lookup table.
 *
 * Matching strategy:
 * 1. Normalize the ADP entry name
 * 2. Look up candidates in the Sleeper map
 * 3. If exactly one candidate → return it
 * 4. If multiple candidates:
 *    a. Filter by position if ADP entry has one → if that yields one result, return it
 *    b. Filter by team if ADP entry has one → if that yields one result, return it
 *    c. Still ambiguous → log a warning and return null
 * 5. No candidates → return null (player not in Sleeper database)
 *
 * This function never creates new players from ADP data.
 *
 * @param entry - ADP entry to match
 * @param lookup - Sleeper player lookup map from `buildSleeperLookup`
 * @returns The matched Sleeper Player, or null if no unambiguous match found
 */
export function matchADPEntry(
  entry: ADPEntry,
  lookup: Map<string, Player[]>,
): Player | null {
  const key = normalizeName(entry.name);
  const candidates = lookup.get(key);

  if (!candidates || candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  // Multiple candidates — attempt disambiguation
  let narrowed = candidates;

  if (entry.position) {
    const byPosition = narrowed.filter(
      (p) => p.position.toUpperCase() === entry.position!.toUpperCase(),
    );
    if (byPosition.length === 1) return byPosition[0];
    if (byPosition.length > 0) narrowed = byPosition;
  }

  if (entry.team) {
    const byTeam = narrowed.filter(
      (p) => p.team.toUpperCase() === entry.team!.toUpperCase(),
    );
    if (byTeam.length === 1) return byTeam[0];
    if (byTeam.length > 0) narrowed = byTeam;
  }

  // Still ambiguous
  console.warn(
    `[ADP] Ambiguous match for "${entry.name}" (${narrowed.length} candidates) — skipping entry`,
  );
  return null;
}

// ── Player enrichment ──────────────────────────────────────────────────────

/**
 * Enriches an array of Sleeper players with ADP values from the active dataset.
 *
 * For each player:
 * - If the dataset contains a matching entry → `adp` is set to the numeric ADP value
 * - If no match is found → `adp` is set to `null` (never `undefined`)
 *
 * Does NOT mutate the input array or any player object.
 *
 * @param players - Array of Sleeper Player objects
 * @param dataset - Active ADP dataset, or null if none has been imported
 * @returns New array of EnrichedPlayer objects with `adp` field set
 */
export function enrichPlayersWithADP(
  players: Player[],
  dataset: ADPDataset | null,
): EnrichedPlayer[] {
  if (!dataset || dataset.entries.length === 0) {
    return players.map((p) => ({ ...p, adp: null }));
  }

  const lookup = buildSleeperLookup(players);

  // Build a playerId → ADP value map from the dataset via exact name matching
  const adpByPlayerId = new Map<string, number>();
  for (const entry of dataset.entries) {
    const matched = matchADPEntry(entry, lookup);
    if (matched) {
      adpByPlayerId.set(matched.id, entry.adp);
    }
  }

  // First pass: apply exact matches
  const enriched: EnrichedPlayer[] = players.map((p) => ({
    ...p,
    adp: adpByPlayerId.has(p.id) ? (adpByPlayerId.get(p.id) as number) : null,
  }));

  // Second pass: initial-based fallback for unmatched ADP entries
  // Handles abbreviated names like "J. Love" matching full names like "Jordan Love"
  for (const entry of dataset.entries) {
    const adpNormalized = normalizeName(entry.name);
    const [adpFirst, ...adpLastParts] = adpNormalized.split(" ");
    const adpLast = adpLastParts.join(" ");

    // Only apply when ADP first name is a single initial
    const isInitial = adpFirst.length === 1;
    if (!isInitial) continue;

    for (const p of enriched) {
      // Only apply fallback if this player has no ADP yet
      if (p.adp !== null) continue;

      const playerNormalized = normalizeName(p.name);
      const [playerFirst, ...playerLastParts] = playerNormalized.split(" ");
      const playerLast = playerLastParts.join(" ");

      if (adpFirst === playerFirst[0] && adpLast === playerLast) {
        p.adp = entry.adp;
      }
    }
  }

  return enriched;
}

// ── ADP sorting ────────────────────────────────────────────────────────────

/**
 * Sorts an array of enriched players by ADP in ascending order.
 *
 * Sort rules:
 * - Players with a numeric ADP are sorted ascending (lowest = highest draft value)
 * - Players with `adp: null` are always placed at the bottom
 * - Does NOT mutate the input array
 *
 * @param players - Array of EnrichedPlayer objects
 * @returns New sorted array — original array is not modified
 */
export function getPlayersSortedByADP(
  players: EnrichedPlayer[],
): EnrichedPlayer[] {
  return [...players].sort((a, b) => {
    if (a.adp === null && b.adp === null) return 0;
    if (a.adp === null) return 1;
    if (b.adp === null) return -1;
    return a.adp - b.adp;
  });
}

// ── Player eligibility filtering ───────────────────────────────────────────

/**
 * Filters a player array to only include draftable (active) players.
 *
 * Inclusion criteria:
 * - `status` is not "Retired" or "Inactive", AND
 * - `active !== false`
 * - If neither field exists on the player object → included as a safe fallback
 *
 * Excluded players:
 * - Players with status === "Retired" or status === "Inactive"
 * - Players with active === false
 *
 * Does NOT mutate the input array. Chainable with `getPlayersSortedByADP`.
 *
 * @param players - Array of Player or EnrichedPlayer objects
 * @returns New filtered array containing only draftable players
 */
export function getDraftablePlayers<T extends Player | EnrichedPlayer>(
  players: T[],
): T[] {
  return players.filter((p) => {
    const record = p as unknown as Record<string, unknown>;

    // Exclude by Sleeper string status field
    if ("status" in record) {
      const status = record.status;
      if (status === "Retired" || status === "Inactive") return false;
    }

    // Exclude by boolean active flag
    if ("active" in record) {
      if (record.active === false) return false;
    }

    // Neither field present — include by default (safe fallback)
    return true;
  });
}
