/**
 * ADP (Average Draft Position) data layer type definitions.
 * All types are standalone — no React, no UI, no backend dependencies.
 */

import type { Player } from "../backend";

// ── Core ADP entry ─────────────────────────────────────────────────────────

/**
 * A single player entry from an external ADP dataset.
 * Contains the minimum fields required for matching against Sleeper players.
 */
export interface ADPEntry {
  /** Player name as it appears in the ADP source data */
  name: string;
  /** Average Draft Position — lower value means higher draft value */
  adp: number;
  /** Optional position string (QB, RB, WR, TE) — used for disambiguation */
  position?: string;
  /** Optional team abbreviation — used for disambiguation */
  team?: string;
}

// ── Dataset container ──────────────────────────────────────────────────────

/**
 * A complete ADP dataset ready for use.
 * Only one active dataset exists at a time; a new upload replaces the previous one.
 */
export interface ADPDataset {
  /** Validated, deduplicated ADP entries */
  entries: ADPEntry[];
  /** Unix timestamp (ms) when this dataset was imported */
  importedAt: number;
}

// ── Enriched player ────────────────────────────────────────────────────────

/**
 * A Sleeper Player extended with an ADP value.
 * `adp` is `null` when no match was found in the active ADP dataset.
 * This overrides the `adp: number` field from the base Player type.
 */
export interface EnrichedPlayer extends Omit<Player, "adp"> {
  /**
   * ADP from the active dataset, or `null` if the player was not matched.
   * Never `undefined` — always explicitly set.
   */
  adp: number | null;
}

// ── Ingestion result ───────────────────────────────────────────────────────

/**
 * Result returned after parsing and validating a CSV or JSON ADP file.
 * Consumers should check `validEntries.length > 0` before proceeding.
 */
export interface ADPIngestionResult {
  /** Successfully parsed and validated ADP entries (deduplicated) */
  validEntries: ADPEntry[];
  /** Number of rows/entries that were silently skipped (duplicate names, etc.) */
  skippedCount: number;
  /** Number of rows/entries that were invalid and logged as errors */
  errorCount: number;
  /** Human-readable error messages for each invalid row */
  errors: string[];
}
