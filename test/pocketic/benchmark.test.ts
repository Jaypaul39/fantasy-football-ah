import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PocketIc, createIdentity } from "@dfinity/pic";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { idlFactory } from "./benchmark.did.js";

// Phase 14 — Lineup Optimizer Benchmark (measurement only).
//
// Installs the standalone benchmark canister (src/backend/test/benchmark-canister.mo)
// on a real PocketIC replica and runs runBenchmark(), which measures
// calculateOptimalWeeklyLineup with real IC instruction counts
// (Prim.performanceCounter(0) — it traps in the mops interpreter). The report
// is surfaced here via getReport() and printed in full so the build log carries
// the actual measured numbers.
//
// No production .mo file is modified, the optimizer is untouched, and no
// memoization is added — this is measurement only.

const PIC_URL = process.env.POCKET_IC_URL ?? "";

// The benchmark canister's Candid interface:
//   service : {
//     getReport: () -> (text) query;
//     runBenchmark: () -> ();
//     runControlled: (nat, nat) -> (text);
//     runCachingBenchmark: () -> (text);
//   }
interface BenchmarkService {
  runBenchmark: () => Promise<void>;
  getReport: () => Promise<string>;
  runControlled: (poolSize: number, benchSize: number) => Promise<string>;
  runCachingBenchmark: () => Promise<string>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

// Build the benchmark canister wasm from source with the verified moc command.
// The benchmark canister imports lib/lineup.mo and lib/auction-types.mo, so it
// must be compiled from the backend source tree with the core package wired up.
function buildBenchmarkWasm(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), "benchmark-wasm-"));
  const out = path.join(scratch, "benchmark.wasm");
  const moc = execFileSync("mops", ["toolchain", "bin", "moc"], { encoding: "utf8" }).trim();
  const coreSrc = execFileSync("bash", ["-c", "ls -d .mops/core@*/src"], {
    cwd: projectRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
  const corePath = path.join(projectRoot, coreSrc);
  const source = path.join(projectRoot, "src", "backend", "test", "benchmark-canister.mo");
  execFileSync(
    moc,
    [
      "--package",
      "core",
      corePath,
      "--release",
      "--default-persistent-actors",
      "--implicit-package=core",
      "-o",
      out,
      source,
    ],
    { cwd: projectRoot, stdio: "pipe" },
  );
  return out;
}

let pic: PocketIc | undefined;
let actor: BenchmarkService;
let wasmPath: string;

beforeAll(async () => {
  wasmPath = buildBenchmarkWasm();
  pic = await PocketIc.create(PIC_URL, { processingTimeoutMs: 120000 });
  const identity = createIdentity("benchmark-seed");
  ({ actor } = await pic.setupCanister<BenchmarkService>({
    idlFactory,
    wasm: wasmPath,
    sender: identity.getPrincipal(),
  }));
}, 180000);

afterAll(async () => {
  // The controlled benchmark's pool-14/16 attempts are genuinely enormous
  // computations that can leave the PocketIC server busy for minutes after the
  // client-side per-call timeout abandons them. tearDown() would then block
  // until the server drains, which exceeds any hook timeout. Bound the wait and
  // swallow the timeout: all benchmark data is already captured and printed by
  // the tests, and the sidecar reclaims the instance on its own lifecycle.
  try {
    await Promise.race([
      pic?.tearDown(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("tearDown timed out")), 30000)),
    ]);
  } catch {
    /* instance released by the sidecar's own lifecycle */
  }
}, 60000);

// ── Playoff bracket redundant-recomputation model ───────────────────────────
// The benchmark canister's runBenchmark() stops at its message-budget guard
// (cumulative > 12B instr) before reaching its own bracket section, because the
// single-call + aggregate measurements already consume the budget. The bracket
// model is pure counting (no optimizer calls) and deterministic, so we replicate
// its EXACT logic from benchmark-canister.mo here and measure it directly. This
// is a faithful measurement of the model's recursion, not an estimate.

type Slot = { kind: "Seed" } | { kind: "WinnerOf"; child: number };
interface Game {
  slot0: Slot;
  slot1: Slot;
}

// Mirrors `bracketGames` in benchmark-canister.mo: g0-g3 QF (seeds), g4/g5 SF
// (winners of QFs), g6 Championship (winners of SFs).
const bracketGames: Game[] = [
  { slot0: { kind: "Seed" }, slot1: { kind: "Seed" } },
  { slot0: { kind: "Seed" }, slot1: { kind: "Seed" } },
  { slot0: { kind: "Seed" }, slot1: { kind: "Seed" } },
  { slot0: { kind: "Seed" }, slot1: { kind: "Seed" } },
  { slot0: { kind: "WinnerOf", child: 0 }, slot1: { kind: "WinnerOf", child: 1 } },
  { slot0: { kind: "WinnerOf", child: 2 }, slot1: { kind: "WinnerOf", child: 3 } },
  { slot0: { kind: "WinnerOf", child: 4 }, slot1: { kind: "WinnerOf", child: 5 } },
];

function measureBracket(): string {
  let bracketCalls = 0;
  const gameResolveCount = new Array<number>(7).fill(0);

  const resolveSlot = (slot: Slot): void => {
    if (slot.kind === "Seed") {
      bracketCalls += 1;
    } else {
      resolveGame(slot.child);
      bracketCalls += 2;
    }
  };

  function resolveGame(idx: number): void {
    gameResolveCount[idx] += 1;
    const g = bracketGames[idx];
    resolveSlot(g.slot0);
    resolveSlot(g.slot1);
  }

  // Seeding pass: getH2HStandings for an 8-team round-robin regular season.
  // matchups = numTeams * (numTeams - 1) / 2 = 8 * 7 / 2 = 28; home + away each.
  const matchups = 28;
  const seedingCalls = matchups * 2;

  // Bracket resolution: iterate over all 7 games, resolving each recursively.
  for (let i = 0; i < bracketGames.length; i++) {
    resolveGame(i);
  }

  // Ideal (non-redundant) bracket resolution: each game resolved once, WinnerOf
  // slots reference already-computed child results (no recomputation).
  //   g0..g3: 2 seed calls each = 8
  //   g4, g5: 2 WinnerOf slots, +2 per slot (current week) = 4 each = 8
  //   g6:     2 WinnerOf slots, +2 per slot = 4
  const idealBracketCalls = 8 + 8 + 4; // 20
  const totalGameResolves = gameResolveCount.reduce((a, b) => a + b, 0);

  return [
    "PLAYOFF BRACKET (8-team, 7 games) — measured from the model (canister's own section was skipped by its message-budget guard):",
    `  seeding pass (getH2HStandings round-robin) calls: ${seedingCalls}`,
    `  bracket resolution calls: ${bracketCalls}`,
    `  total optimizer calls (seeding + bracket): ${seedingCalls + bracketCalls}`,
    `  per-game resolution counts: ${gameResolveCount.join(",")}`,
    `  total game resolutions: ${totalGameResolves}`,
    `  ideal (non-redundant) game resolutions: 7`,
    `  redundant factor (game resolutions): ${(totalGameResolves / 7).toFixed(3)}`,
    `  ideal (non-redundant) bracket calls: ${idealBracketCalls}`,
    `  redundant factor (bracket calls): ${(bracketCalls / idealBracketCalls).toFixed(3)}`,
  ].join("\n");
}

describe("lineup optimizer benchmark", () => {
  it("runs the full benchmark and reports measured numbers", async () => {
    // Update call: runs every measurement and stores the text report.
    await actor.runBenchmark();
    // Query call: read the report back and surface it in the build log.
    const report = await actor.getReport();
    const bracket = measureBracket();
    console.log("\n===== LINEUP OPTIMIZER BENCHMARK REPORT =====\n" + report + "\n" + bracket + "\n===== END REPORT =====\n");
    // The report must be non-empty and carry the sections that always run.
    // The bracket and scaling sections are NOT guaranteed: the benchmark's own
    // message-budget guard (cumulative > 12B instr) stops the run early when
    // the earlier single-call + aggregate measurements already consume the
    // update-call budget, so they are not asserted here.
    expect(report.length).toBeGreaterThan(0);
    expect(report).toContain("SINGLE default-13");
    expect(report).toContain("AGGREGATE");
  }, 180000);

  it("reports the Best Ball caching optimizer-call reduction", async () => {
    // Phase 3 (Best Ball caching): the caching model runs as its own update
    // message (runCachingBenchmark) so it is never dropped by runBenchmark's
    // cumulative message-budget guard. It reports the exact optimizer-invocation
    // count before (full recompute of every finalized week) and after (finalized
    // weeks read from cache, only the live week computed).
    const caching = await actor.runCachingBenchmark();
    console.log("\n===== BEST BALL CACHING BENCHMARK =====\n" + caching + "\n===== END CACHING BENCHMARK =====\n");
    // 16 teams x 6 weeks (5 finalized + 1 live) = 96 calls before.
    expect(caching).toContain("BEFORE (full recompute): 96 optimizer calls (16 teams x 6 weeks)");
    // 16 teams x 1 live week = 16 calls after.
    expect(caching).toContain("AFTER (cached finalized + 1 live): 16 optimizer calls (16 teams x 1 live week)");
    expect(caching).toContain("optimizer-call reduction: 96 -> 16 (80 fewer)");
  }, 180000);

  it("runs the controlled benchmark (pool-size and bench-size curves)", async () => {
    // Phase 14 follow-up: isolate pool-size scaling from roster complexity.
    // The roster is FIXED at QB1/RB2/WR2/TE1/FLEX2/SUPERFLEX1 (9 required
    // starters) for every measurement. Each config is a separate update message
    // (runControlled), so an explosive config is measured in isolation and never
    // lost to a cumulative message-budget guard.
    //
    // The bench-size curve runs FIRST because it is measurable at pool 12
    // (~4.2B instr/call) and must be captured before the expensive pool-14/16
    // attempts, which exceed the 5s/20B per-call limit and can overwhelm the
    // server. Each call is bounded by a per-call timeout so a config that
    // exceeds the limit is recorded (not silently skipped) without hanging the
    // whole test or cascading "Server busy" into later measurements.
    const lines: string[] = [];
    lines.push("CONTROLLED BENCHMARK — roster FIXED at QB1/RB2/WR2/TE1/FLEX2/SUPERFLEX1 (9 starters)");

    const measure = async (poolSize: number, benchSize: number): Promise<string> => {
      const timeoutMs = 120000;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              `CONTROLLED pool ${poolSize} bench ${benchSize}: TIMEOUT (>${timeoutMs / 1000}s — exceeds per-call limit)`,
            ),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([actor.runControlled(poolSize, benchSize), timeout]);
      } catch (e) {
        return `CONTROLLED pool ${poolSize} bench ${benchSize}: TRAPPED/EXCEEDS per-call limit (${String(e)})`;
      } finally {
        clearTimeout(timer);
      }
    };

    lines.push("BENCH-SIZE-ONLY CURVE: pool fixed at 12, vary bench 3,6,9,12 (same 9 starters)");
    const benchSizes = [3, 6, 9, 12];
    for (const bs of benchSizes) {
      lines.push(await measure(12, bs));
    }

    lines.push("POOL-SIZE-ONLY CURVE: bench fixed at 6, vary pool size 9,10,11,12,14,16");
    const poolSizes = [9, 10, 11, 12, 13, 14, 15, 16];
    for (const ps of poolSizes) {
      lines.push(await measure(ps, 6));
    }

    const controlledReport = lines.join("\n");
    console.log("\n===== CONTROLLED BENCHMARK REPORT =====\n" + controlledReport + "\n===== END CONTROLLED REPORT =====\n");

    // Every requested data point must be captured — assert none was dropped.
    for (const ps of poolSizes) {
      expect(controlledReport).toContain(`pool ${ps} bench 6`);
    }
    for (const bs of benchSizes) {
      expect(controlledReport).toContain(`pool 12 bench ${bs}`);
    }
  }, 900000);
});
