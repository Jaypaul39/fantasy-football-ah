/**
 * CSV and JSON parsers for ADP dataset ingestion.
 * Standalone — no React, no UI, no backend dependencies.
 *
 * Both parsers delegate to `validateADPEntries` for shared validation logic:
 * required fields, numeric ADP, deduplication, and the 2,000-player limit.
 */

import type { ADPEntry, ADPIngestionResult } from "./adp-types";
import { normalizeName } from "./adp-utils";

/** Maximum number of valid ADP entries allowed in a single dataset. */
const MAX_DATASET_SIZE = 2000;

// ── Shared validation ──────────────────────────────────────────────────────

/**
 * Validates and deduplicates a raw array of unknown entries into typed ADPEntry objects.
 *
 * Rules applied:
 * - Each entry must have a non-empty `name` string field
 * - Each entry must have a numeric (finite, non-NaN) `adp` field
 * - Duplicate entries (by normalized name) are skipped and counted
 * - The dataset must not exceed 2,000 valid entries after deduplication
 * - Invalid entries are logged with a human-readable error message
 *
 * @param rawEntries - Array of unknown objects to validate
 * @returns ADPIngestionResult with validEntries, skippedCount, errorCount, and errors
 */
export function validateADPEntries(rawEntries: unknown[]): ADPIngestionResult {
  const validEntries: ADPEntry[] = [];
  const errors: string[] = [];
  const seenNames = new Set<string>();
  let skippedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < rawEntries.length; i++) {
    const raw = rawEntries[i];
    const rowLabel = `Entry ${i + 1}`;

    if (!raw || typeof raw !== "object") {
      errors.push(`${rowLabel}: not a valid object`);
      errorCount++;
      continue;
    }

    const entry = raw as Record<string, unknown>;

    // Validate name
    const rawName = entry.name;
    if (!rawName || typeof rawName !== "string" || rawName.trim() === "") {
      errors.push(`${rowLabel}: missing or empty "name" field`);
      errorCount++;
      continue;
    }
    const name = rawName.trim();

    // Validate adp
    const rawAdp = entry.adp;
    const adpNum = Number(rawAdp);
    if (
      rawAdp === null ||
      rawAdp === undefined ||
      rawAdp === "" ||
      !Number.isFinite(adpNum) ||
      Number.isNaN(adpNum)
    ) {
      errors.push(
        `${rowLabel} ("${name}"): invalid or non-numeric "adp" value: ${String(rawAdp)}`,
      );
      errorCount++;
      continue;
    }

    // Deduplication check (by normalized name)
    const normalizedKey = normalizeName(name);
    if (seenNames.has(normalizedKey)) {
      skippedCount++;
      continue;
    }

    // Check dataset size limit before adding
    if (validEntries.length >= MAX_DATASET_SIZE) {
      errors.push(
        `Dataset exceeds maximum size of ${MAX_DATASET_SIZE} players. Remaining entries were rejected.`,
      );
      errorCount++;
      break;
    }

    seenNames.add(normalizedKey);

    // Build the validated entry
    const validEntry: ADPEntry = { name, adp: adpNum };

    if (
      entry.position &&
      typeof entry.position === "string" &&
      entry.position.trim()
    ) {
      validEntry.position = entry.position.trim();
    }
    if (entry.team && typeof entry.team === "string" && entry.team.trim()) {
      validEntry.team = entry.team.trim();
    }

    validEntries.push(validEntry);
  }

  return { validEntries, skippedCount, errorCount, errors };
}

// ── CSV parser ─────────────────────────────────────────────────────────────

/**
 * Parses a CSV string into an ADPIngestionResult.
 *
 * Supported column names (case-insensitive, trimmed):
 * - Name column: `player_name` or `name`
 * - ADP column: `adp`
 * - Optional: `position`, `team`
 *
 * Parsing rules:
 * - First row is treated as the header row
 * - Column headers are normalized to lowercase and trimmed
 * - All cell values are trimmed before processing
 * - Rows with no name and no ADP value are silently skipped
 * - Invalid rows are logged and counted but do not abort the import
 * - The result is passed through `validateADPEntries` for final validation
 *
 * @param csvText - Raw CSV file content as a string
 * @returns ADPIngestionResult with parsed and validated entries
 */
export function parseCSVToADP(csvText: string): ADPIngestionResult {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim() !== "");

  if (lines.length < 2) {
    return {
      validEntries: [],
      skippedCount: 0,
      errorCount: 1,
      errors: ["CSV file must contain a header row and at least one data row"],
    };
  }

  /**
   * RFC-4180 compliant CSV row parser.
   * Handles quoted fields (including commas inside quotes) and escaped double-quotes ("").
   */
  function parseCSVRow(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          // Peek ahead: "" inside quotes is an escaped quote
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          fields.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  }

  // Parse header row
  const headers = parseCSVRow(lines[0]).map((h) =>
    h.toLowerCase().replace(/\s+/g, "_").replace(/[.]/g, ""),
  );

  const nameIdx = (() => {
    const byPlayerName = headers.indexOf("player_name");
    if (byPlayerName !== -1) return byPlayerName;

    const byPlayerNameNoUnderscore = headers.indexOf("playername");
    if (byPlayerNameNoUnderscore !== -1) return byPlayerNameNoUnderscore;

    return headers.indexOf("name");
  })();

  const adpIdx = (() => {
    const direct = headers.indexOf("adp");
    if (direct !== -1) return direct;

    const avgPick = headers.indexOf("avg_pick");
    if (avgPick !== -1) return avgPick;

    const averagePick = headers.indexOf("average_pick");
    if (averagePick !== -1) return averagePick;

    const average = headers.indexOf("average");
    if (average !== -1) return average;

    const avg = headers.indexOf("avg");
    if (avg !== -1) return avg;

    return -1;
  })();
  const posIdx =
    headers.indexOf("position") !== -1
      ? headers.indexOf("position")
      : headers.indexOf("pos");
  const teamIdx = headers.indexOf("team");

  if (nameIdx === -1) {
    return {
      validEntries: [],
      skippedCount: 0,
      errorCount: 1,
      errors: ['CSV must have a "player_name" or "name" column'],
    };
  }

  if (adpIdx === -1) {
    return {
      validEntries: [],
      skippedCount: 0,
      errorCount: 1,
      errors: ['CSV must have an "adp" column'],
    };
  }

  // Parse data rows into raw objects for validateADPEntries
  const rawEntries: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVRow(lines[i]);

    // Skip entirely empty rows
    if (cells.every((c) => c === "")) continue;

    const raw: Record<string, unknown> = {
      name: cells[nameIdx] ?? "",
      adp: cells[adpIdx] ?? "",
    };

    if (posIdx !== -1 && cells[posIdx]) {
      raw.position = cells[posIdx];
    }
    if (teamIdx !== -1 && cells[teamIdx]) {
      raw.team = cells[teamIdx];
    }

    rawEntries.push(raw);
  }

  if (rawEntries.length === 0) {
    return {
      validEntries: [],
      skippedCount: 0,
      errorCount: 1,
      errors: ["CSV file contained no data rows after the header"],
    };
  }

  return validateADPEntries(rawEntries);
}

// ── JSON parser ────────────────────────────────────────────────────────────

/**
 * Parses a JSON string into an ADPIngestionResult.
 *
 * Expected format: a JSON array of objects, each with at least:
 * - `name` (string)
 * - `adp` (number)
 * - Optional: `position` (string), `team` (string)
 *
 * Parsing rules:
 * - The top-level JSON value must be an array
 * - Each element is validated individually — invalid elements are skipped
 * - The result is passed through `validateADPEntries` for final validation
 *
 * @param jsonText - Raw JSON file content as a string
 * @returns ADPIngestionResult with parsed and validated entries
 */
export function parseJSONToADP(jsonText: string): ADPIngestionResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      validEntries: [],
      skippedCount: 0,
      errorCount: 1,
      errors: ["Invalid JSON: file could not be parsed"],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      validEntries: [],
      skippedCount: 0,
      errorCount: 1,
      errors: ["JSON file must contain an array at the top level"],
    };
  }

  if (parsed.length === 0) {
    return {
      validEntries: [],
      skippedCount: 0,
      errorCount: 1,
      errors: ["JSON array is empty — no entries to import"],
    };
  }

  return validateADPEntries(parsed);
}
