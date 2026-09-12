import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Activity,
  AlertCircle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  Download,
  Key,
  Minus,
  Plus,
  RefreshCw,
  Rss,
  Send,
  Shield,
  Trash2,
  TrendingUp,
  Upload,
  Users,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SyncStatus } from "../backend";
import { useBackend } from "../hooks/useBackend";
import { parseCSVToADP, parseJSONToADP } from "../lib/adp-parser";
import type { ADPIngestionResult } from "../lib/adp-types";
import type {
  Player,
  RoomSummary,
  SyncStatusRecord,
  WeeklyPlayerStats,
} from "../types";

// ── Sleeper import types ───────────────────────────────────────────────────

interface SleeperPlayer {
  player_id: string;
  full_name?: string;
  position?: string;
  team?: string;
  years_exp?: number | null;
  active?: boolean;
  status?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

const ELIGIBLE_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const BATCH_SIZE = 300;

// ── Helpers ────────────────────────────────────────────────────────────────

function positionColor(pos: string): string {
  switch (pos) {
    case "QB":
      return "bg-blue-500/20 text-blue-400 border-blue-500/40";
    case "RB":
      return "bg-green-500/20 text-green-400 border-green-500/40";
    case "WR":
      return "bg-purple-500/20 text-purple-400 border-purple-500/40";
    case "TE":
      return "bg-orange-500/20 text-orange-400 border-orange-500/40";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function formatImportDate(tsMs: number): string {
  return new Date(tsMs).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Formats a backend nanosecond bigint timestamp as a human-readable date, or
// "—" when the timestamp is missing/zero (the backend's "never" sentinel).
function formatSyncTimestamp(ts: bigint | undefined | null): string {
  if (ts == null || ts === 0n) return "—";
  const date = new Date(Number(ts / 1_000_000n));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Formats a syncWeeklyStats rejection into a clear admin-facing message. The
// backend rejects a resync of a settled/finalized week with a specific message
// like 'Week 5 of 2024 is finalized and cannot be resynced'; we surface that
// verbatim so the admin sees the exact reason instead of a generic error.
function formatSyncError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Unknown error occurred";
}

// ── Bye Weeks file parsers ─────────────────────────────────────────────────
// JSON: supports BOTH an array of objects [{"team": "ARI", "bye": 8}, ...] AND
// a flat object map {"ARI": 8, "ATL": 5, ...}. CSV: two columns with a header
// row (team,bye) — split on newlines and commas, skip the header row, trim
// whitespace, handle quoted fields minimally.

function parseByeWeeksJSON(text: string): Array<[string, string]> {
  const data = JSON.parse(text);
  const entries: Array<[string, string]> = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object") {
        const team = String(item.team ?? item.Team ?? item.TEAM ?? "").trim();
        const bye = String(item.bye ?? item.Bye ?? item.BYE ?? "").trim();
        if (team) entries.push([team, bye]);
      }
    }
  } else if (data && typeof data === "object") {
    for (const [team, bye] of Object.entries(data as Record<string, unknown>)) {
      const t = String(team).trim();
      const b = String(bye ?? "").trim();
      if (t) entries.push([t, b]);
    }
  } else {
    throw new Error("JSON must be an array of objects or a flat object map.");
  }
  return entries;
}

function parseByeWeeksCSV(text: string): Array<[string, string]> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // Detect and skip a header row.
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes("team") && first.includes("bye");
  const rows = hasHeader ? lines.slice(1) : lines;
  const entries: Array<[string, string]> = [];
  for (const line of rows) {
    // Minimal CSV split: handle quoted fields by stripping surrounding quotes.
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 2) continue;
    const team = cols[0].trim();
    const bye = cols[1].trim();
    if (team) entries.push([team, bye]);
  }
  return entries;
}

// ── ADP Section state type ─────────────────────────────────────────────────

interface AdpSectionState {
  parseResult: ADPIngestionResult | null;
  pendingFile: string | null;
  uploading: boolean;
  uploadResult: { type: "success" | "error"; message: string } | null;
  currentDataset: { entryCount: number; importedAt: number } | null;
  datasetLoading: boolean;
  errorsExpanded: boolean;
  removing: boolean;
}

function makeAdpState(): AdpSectionState {
  return {
    parseResult: null,
    pendingFile: null,
    uploading: false,
    uploadResult: null,
    currentDataset: null,
    datasetLoading: false,
    errorsExpanded: false,
    removing: false,
  };
}

// ── ADP Section sub-component ──────────────────────────────────────────────

interface AdpSectionProps {
  title: string;
  subtitle?: string;
  datasetKey: "all" | "rookies";
  state: AdpSectionState;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onUpload: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  onToggleErrors: () => void;
}

function AdpSection({
  title,
  subtitle,
  state,
  fileInputRef,
  onFileChange,
  onUpload,
  onRefresh,
  onRemove,
  onToggleErrors,
}: AdpSectionProps) {
  const canUpload =
    !state.uploading &&
    !!state.parseResult &&
    state.parseResult.validEntries.length > 0;
  const visibleErrors = state.parseResult?.errors.slice(0, 5) ?? [];
  const hiddenErrorCount = (state.parseResult?.errors.length ?? 0) - 5;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {subtitle && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={state.datasetLoading}
          className="text-muted-foreground hover:text-foreground shrink-0 text-xs h-7 px-2"
        >
          {state.datasetLoading ? (
            <div className="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
          ) : (
            "Refresh"
          )}
        </Button>
      </div>

      {/* Current dataset status */}
      <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/40 border border-border">
        <div className="text-sm text-muted-foreground min-w-0 flex-1">
          {state.datasetLoading ? (
            <span className="text-muted-foreground/60 italic">
              Loading dataset info…
            </span>
          ) : state.currentDataset ? (
            <span>
              <span className="text-foreground font-semibold font-mono">
                {state.currentDataset.entryCount.toLocaleString()}
              </span>{" "}
              entries · imported{" "}
              <span className="text-foreground">
                {formatImportDate(state.currentDataset.importedAt)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground/70 italic">
              No dataset uploaded
            </span>
          )}
        </div>
        {state.currentDataset && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={state.removing}
            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 shrink-0 text-xs h-7 px-2"
          >
            {state.removing ? (
              <div className="w-3 h-3 border-2 border-destructive/30 border-t-destructive rounded-full animate-spin" />
            ) : (
              <>
                <Trash2 className="w-3 h-3 mr-1" />
                Remove
              </>
            )}
          </Button>
        )}
      </div>

      {/* File input */}
      <div className="space-y-2">
        <p className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Select ADP File (.json or .csv)
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv"
          onChange={onFileChange}
          className="block w-full text-sm text-muted-foreground
            file:mr-3 file:py-1.5 file:px-3
            file:rounded-md file:border file:border-border
            file:bg-muted file:text-foreground file:text-sm file:font-medium
            file:cursor-pointer
            hover:file:bg-muted/80
            cursor-pointer"
        />
        {state.pendingFile && (
          <p className="text-xs text-muted-foreground/70 font-mono truncate">
            Selected: {state.pendingFile}
          </p>
        )}
      </div>

      {/* Parse preview */}
      {state.parseResult && (
        <div className="space-y-3 rounded-lg bg-muted/30 border border-border p-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-green-500/10 border border-green-500/30 text-green-400 font-mono text-xs font-semibold">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {state.parseResult.validEntries.length.toLocaleString()} valid
            </span>
            {state.parseResult.skippedCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 font-mono text-xs font-semibold">
                {state.parseResult.skippedCount.toLocaleString()} skipped
              </span>
            )}
            {state.parseResult.errorCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-destructive/10 border border-destructive/30 text-destructive font-mono text-xs font-semibold">
                <AlertCircle className="w-3.5 h-3.5" />
                {state.parseResult.errorCount.toLocaleString()} errors
              </span>
            )}
          </div>

          {state.parseResult.errors.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={onToggleErrors}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {state.errorsExpanded ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
                {state.errorsExpanded ? "Hide" : "Show"} parse errors (
                {state.parseResult.errors.length})
              </button>
              {state.errorsExpanded && (
                <ul className="space-y-1">
                  {visibleErrors.map((err) => (
                    <li
                      key={err}
                      className="text-xs font-mono text-destructive/80 bg-destructive/5 px-2 py-1 rounded break-all"
                    >
                      {err}
                    </li>
                  ))}
                  {hiddenErrorCount > 0 && (
                    <li className="text-xs text-muted-foreground/60 italic px-2">
                      …and {hiddenErrorCount} more error
                      {hiddenErrorCount !== 1 ? "s" : ""}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {state.parseResult.validEntries.length === 0 && (
            <p className="text-xs text-destructive italic">
              No valid entries found — fix the errors above and re-select the
              file.
            </p>
          )}
        </div>
      )}

      {/* Upload result messages */}
      {state.uploadResult?.type === "success" && (
        <div className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{state.uploadResult.message}</span>
        </div>
      )}
      {state.uploadResult?.type === "error" && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="break-all">{state.uploadResult.message}</span>
        </div>
      )}

      {/* Upload button */}
      <Button
        onClick={onUpload}
        disabled={!canUpload}
        className="bg-accent text-accent-foreground hover:bg-accent/90 font-mono w-full sm:w-auto disabled:opacity-40"
      >
        {state.uploading ? (
          <>
            <div className="w-3.5 h-3.5 border-2 border-accent-foreground/30 border-t-accent-foreground rounded-full animate-spin mr-2" />
            Uploading…
          </>
        ) : (
          <>
            <Upload className="w-4 h-4 mr-2" />
            Upload ADP Dataset
            {state.parseResult && state.parseResult.validEntries.length > 0 && (
              <span className="ml-1.5 font-mono text-xs opacity-75">
                ({state.parseResult.validEntries.length.toLocaleString()}{" "}
                entries)
              </span>
            )}
          </>
        )}
      </Button>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

// Module-scoped in-session in-flight guard: a Set of "season:week" keys
// currently being synced. It lives at module scope (not in a useRef) so it
// survives a component remount within the same app session — a remount while a
// sync is still in-flight must not start a second concurrent fetch for the
// same (season, week). The backend's atomic guard remains the real correctness
// guarantee; this is purely an optimization to avoid hammering Sleeper.
const inFlightSyncKeys = new Set<string>();

export default function AdminPanel() {
  const { actor } = useBackend();

  // ── Sleeper import state ─────────────────────────────────────────────────
  const [cycleBalance, setCycleBalance] = useState<bigint | null>(null);
  const [cycleBalanceLoading, setCycleBalanceLoading] = useState(false);

  const fetchCycleBalance = async () => {
    if (!actor) return;
    setCycleBalanceLoading(true);
    try {
      const bal = await actor.getCycleBalance();
      setCycleBalance(bal);
    } catch {
      // silent
    } finally {
      setCycleBalanceLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchCycleBalance intentionally omitted
  useEffect(() => {
    if (!actor) return;
    void fetchCycleBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  // ── Sleeper import state ─────────────────────────────────────────────────
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{
    imported: number;
    total: number;
  } | null>(null);
  const [sleeperResult, setSleeperResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [positionBreakdown, setPositionBreakdown] = useState<
    Record<string, number>
  >({});

  // ── Weekly stats sync state ──────────────────────────────────────────────
  // Mirrors the Sleeper player-import pattern: fetch directly in the browser,
  // map raw categories, then call the backend in one batch. The player list is
  // cached in a ref so a second sync reuses it instead of re-fetching.
  const [season, setSeason] = useState("");
  const [week, setWeek] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{
    synced: number;
    total: number;
  } | null>(null);
  const [syncResult, setSyncResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);
  const playerListRef = useRef<Record<string, SleeperPlayer> | null>(null);

  // ── Weekly sync status view + auto-sync state ────────────────────────────
  // Phase 10: surfaces the backend's per-(season, week) sync status records
  // and, on admin session load, automatically runs the existing fetch+parse+
  // submit flow once for each currently-flagged week. This is a visibility
  // aid, NOT full autonomy: the backend's atomic guard is the real correctness
  // guarantee, and this frontend guard only avoids hammering Sleeper with
  // duplicate concurrent fetches for the same (season, week) within a session.
  const [syncStatusRecords, setSyncStatusRecords] = useState<
    SyncStatusRecord[]
  >([]);
  const [syncStatusLoading, setSyncStatusLoading] = useState(false);
  const [syncStatusError, setSyncStatusError] = useState<string | null>(null);
  // Guards the auto-sync so it only re-runs after a minimum interval has
  // elapsed since the last run (~5 minutes). Unlike the previous one-shot
  // guard, this lets the same auto-sync trigger safely run repeatedly while
  // the Admin Panel stays open, without hammering Sleeper.
  const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
  const lastAutoSyncRef = useRef(0);

  // ── Clear players state ──────────────────────────────────────────────────
  const [clearConfirming, setClearConfirming] = useState(false);
  const [clearPending, setClearPending] = useState(false);

  const handleClearPlayers = async () => {
    if (!actor) return;
    setClearPending(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (actor as any).clearPlayers();
      if (res?.__kind__ === "err") throw new Error(res.err as string);
      toast.success("All players cleared.");
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to clear players.",
      );
    } finally {
      setClearPending(false);
      setClearConfirming(false);
    }
  };

  // ── Delete room state ─────────────────────────────────────────────────────
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [confirmDeleteRoomId, setConfirmDeleteRoomId] = useState<string | null>(
    null,
  );
  const [deletingRoomId, setDeletingRoomId] = useState<string | null>(null);

  const loadRooms = async () => {
    if (!actor) return;
    setRoomsLoading(true);
    try {
      const list = await actor.getRooms();
      setRooms(list);
    } catch {
      // silent
    } finally {
      setRoomsLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRooms intentionally omitted
  useEffect(() => {
    if (!actor) return;
    void loadRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  const handleDeleteRoom = async (roomId: string) => {
    if (!actor) return;
    setDeletingRoomId(roomId);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (actor as any).deleteRoom(roomId);
      if (res?.__kind__ === "err") throw new Error(res.err as string);
      toast.success("Room deleted.");
      setConfirmDeleteRoomId(null);
      await loadRooms();
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete room.",
      );
    } finally {
      setDeletingRoomId(null);
    }
  };

  // ── Giphy API key state ─────────────────────────────────────────────────
  const [giphyKey, setGiphyKey] = useState("");
  const [giphyKeySet, setGiphyKeySet] = useState(false);
  const [giphyKeyLoading, setGiphyKeyLoading] = useState(false);
  const [giphyKeyResult, setGiphyKeyResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [giphyRemoving, setGiphyRemoving] = useState(false);

  // ── OneSignal API key state ──────────────────────────────────────────────
  const [oneSignalKey, setOneSignalKey] = useState("");
  const [oneSignalKeySet, setOneSignalKeySet] = useState(false);
  const [oneSignalKeyLoading, setOneSignalKeyLoading] = useState(false);
  const [oneSignalKeyResult, setOneSignalKeyResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [oneSignalRemoving, setOneSignalRemoving] = useState(false);

  // ── Recovery password state ──────────────────────────────────────────────
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryPasswordConfirm, setRecoveryPasswordConfirm] = useState("");
  const [recoveryPasswordLoading, setRecoveryPasswordLoading] = useState(false);
  const [recoveryPasswordResult, setRecoveryPasswordResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // ── OneSignal player IDs state (read-only diagnostic view) ───────────────
  // Each tuple is [principalText, playerId]. Surfaced so the admin can confirm
  // entries exist without exposing full raw values on screen.
  const [oneSignalPlayerIds, setOneSignalPlayerIds] = useState<
    Array<[string, string]>
  >([]);
  const [oneSignalPlayerIdsLoading, setOneSignalPlayerIdsLoading] =
    useState(false);
  const [oneSignalPlayerIdsError, setOneSignalPlayerIdsError] = useState<
    string | null
  >(null);

  // ── OneSignal test push state (diagnostic) ──────────────────────────────
  // sendTestPush() is added by a separate task and is NOT yet present in the
  // bindings. We call it via (actor as any) so this compiles today and works
  // once the binding lands — mirrors the clearPlayers/getByeWeeks pattern.
  // On #ok the variant carries { looksSuccessful; body; playerId } where
  // looksSuccessful is a boolean and body/playerId are strings.
  // On #err the variant carries the error message string.
  const [testPushLoading, setTestPushLoading] = useState(false);
  const [testPushResult, setTestPushResult] = useState<
    | {
        ok: true;
        looksSuccessful: boolean;
        body: string;
        playerId: string;
      }
    | { ok: false; message: string }
    | null
  >(null);

  // ── Notification Pipeline Diagnostics state ────────────────────────────
  // Three new backend methods (getNotificationCounters,
  // getNotificationQueueSnapshot, adminDrainQueueNow) are added by a separate
  // task and are NOT yet present in the bindings. We call them via
  // (actor as any) with typeof guards so this compiles today and works once
  // the bindings land — mirrors the clearPlayers/getCycleBalanceHistory pattern.
  //
  // getNotificationCounters() → { queued, processed, sent, expired, retried,
  //   failed } (all Nat / bigint)
  // getNotificationQueueSnapshot() → Array<{ id, userId, title, attempts,
  //   ageSeconds }> (id/attempts/ageSeconds are Nat / bigint)
  // adminDrainQueueNow() → { #ok: Nat; #err: Text } (variant)
  interface NotificationCounters {
    queued: bigint;
    processed: bigint;
    sent: bigint;
    expired: bigint;
    retried: bigint;
    failed: bigint;
  }
  interface NotificationQueueEntry {
    id: bigint;
    userId: string;
    title: string;
    attempts: bigint;
    ageSeconds: bigint;
  }
  // getHeartbeatDiagnostics() → { notificationWorkerEntryCount,
  //   lastNotificationWorkerStartedAt, lastNotificationWorkerCompletedAt,
  //   lastNotificationWorkerError }
  // The three *At fields are Int (nanosecond) timestamps; zero means "never".
  // lastNotificationWorkerError is Text or null.
  interface HeartbeatDiagnostics {
    notificationWorkerEntryCount: bigint;
    lastNotificationWorkerStartedAt: bigint;
    lastNotificationWorkerCompletedAt: bigint;
    lastNotificationWorkerError: string | null;
  }
  const [notifCounters, setNotifCounters] =
    useState<NotificationCounters | null>(null);
  const [notifCountersLoading, setNotifCountersLoading] = useState(false);
  const [notifCountersError, setNotifCountersError] = useState<string | null>(
    null,
  );
  const [notifQueue, setNotifQueue] = useState<NotificationQueueEntry[]>([]);
  const [notifQueueLoading, setNotifQueueLoading] = useState(false);
  const [notifQueueError, setNotifQueueError] = useState<string | null>(null);
  const [drainLoading, setDrainLoading] = useState(false);
  const [drainResult, setDrainResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatDiagnostics | null>(null);
  const [heartbeatLoading, setHeartbeatLoading] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);

  const fetchOneSignalPlayerIds = async () => {
    if (!actor) return;
    setOneSignalPlayerIdsLoading(true);
    setOneSignalPlayerIdsError(null);
    try {
      const ids = await actor.getOneSignalPlayerIds();
      setOneSignalPlayerIds(ids);
    } catch (err: unknown) {
      setOneSignalPlayerIdsError(
        err instanceof Error ? err.message : "Failed to load player IDs.",
      );
    } finally {
      setOneSignalPlayerIdsLoading(false);
    }
  };

  // ── RSS feed sources state ──────────────────────────────────────────────
  const [rssUrls, setRssUrls] = useState<string[]>([]);
  const [rssUrlsLoading, setRssUrlsLoading] = useState(false);
  const [rssUrlsResult, setRssUrlsResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [newRssUrl, setNewRssUrl] = useState("");
  const [newRssUrlError, setNewRssUrlError] = useState<string | null>(null);

  // ── RSS last fetch status state ──────────────────────────────────────────
  // Each tuple is [feedUrl, succeeded]. Used to show a per-source status
  // indicator (green check / red cross / neutral dash) in the sources list.
  const [rssFetchStatus, setRssFetchStatus] = useState<
    Array<[string, boolean]>
  >([]);

  // ── RSS refresh interval state ───────────────────────────────────────────
  const MIN_REFRESH_MINUTES = 1;
  const [refreshMinutes, setRefreshMinutes] = useState<string>("");
  const [refreshIntervalLoading, setRefreshIntervalLoading] = useState(false);
  const [refreshIntervalResult, setRefreshIntervalResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // ── Bye Weeks state ──────────────────────────────────────────────────────
  // Each entry is an editable [teamAbbrev, byeWeek] row. byeWeek is stored as
  // a string in the UI so the admin can type freely; it is coerced to a
  // bigint when saving.
  const [byeWeeks, setByeWeeks] = useState<Array<[string, string]>>([]);
  const [byeWeeksLoading, setByeWeeksLoading] = useState(false);
  const [byeWeeksSaving, setByeWeeksSaving] = useState(false);
  const [byeWeeksResult, setByeWeeksResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const byeWeekFileInputRef = useRef<HTMLInputElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchOneSignalPlayerIds intentionally omitted
  useEffect(() => {
    if (!actor) return;
    void (async () => {
      try {
        const res = await actor.getGiphyApiKey();
        setGiphyKeySet(!!res);
      } catch {
        // silent
      }
    })();
    void (async () => {
      try {
        const res = await actor.getOneSignalApiKey();
        setOneSignalKeySet(!!res);
      } catch {
        // silent
      }
    })();
    void fetchOneSignalPlayerIds();
    // Notification Pipeline Diagnostics — load counters + queue snapshot on
    // mount alongside the other OneSignal diagnostics.
    void fetchDiagnostics();
    void (async () => {
      try {
        const urls = await actor.getRssFeedUrls();
        setRssUrls(urls);
      } catch {
        // silent
      }
    })();
    void (async () => {
      try {
        const status = await actor.getLastRssFetchStatus();
        setRssFetchStatus(status);
      } catch {
        // silent
      }
    })();
    void (async () => {
      try {
        const secs = await actor.getRssRefreshIntervalSecs();
        const mins = Number(secs) / 60;
        setRefreshMinutes(String(mins));
      } catch {
        // silent
      }
    })();
    // Bye Weeks — defensive check: this method was newly added and the
    // frontend binding may not be present on older deployed canisters.
    if (typeof (actor as any).getByeWeeks === "function") {
      setByeWeeksLoading(true);
      void (async () => {
        try {
          const mapping = (await (actor as any).getByeWeeks()) as Array<
            [string, bigint]
          >;
          setByeWeeks(mapping.map(([team, week]) => [team, String(week)]));
        } catch {
          // silent
        } finally {
          setByeWeeksLoading(false);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  // ── RSS feed source handlers ─────────────────────────────────────────────
  const isValidHttpsUrl = (value: string): boolean => {
    if (!value.startsWith("https://")) return false;
    try {
      // eslint-disable-next-line no-new
      new URL(value);
      return true;
    } catch {
      return false;
    }
  };

  const handleAddRssUrl = () => {
    const trimmed = newRssUrl.trim();
    if (!trimmed) return;
    if (!isValidHttpsUrl(trimmed)) {
      setNewRssUrlError("URL must start with https:// and be valid.");
      return;
    }
    if (rssUrls.includes(trimmed)) {
      setNewRssUrlError("This source is already in the list.");
      return;
    }
    setRssUrls((prev) => [...prev, trimmed]);
    setNewRssUrl("");
    setNewRssUrlError(null);
  };

  const handleEditRssUrl = (index: number, value: string) => {
    setRssUrls((prev) => prev.map((u, i) => (i === index ? value : u)));
  };

  const handleRemoveRssUrl = (index: number) => {
    setRssUrls((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveRssUrls = async () => {
    if (!actor) return;
    // Validate every entry before submitting — each must be a valid https URL.
    const trimmed = rssUrls.map((u) => u.trim()).filter((u) => u.length > 0);
    const invalid = trimmed.find((u) => !isValidHttpsUrl(u));
    if (invalid) {
      setRssUrlsResult({
        type: "error",
        message: `Invalid URL: "${invalid}". Every source must start with https://.`,
      });
      return;
    }
    setRssUrlsLoading(true);
    setRssUrlsResult(null);
    try {
      const res = await actor.setRssFeedUrls(trimmed);
      if (res.__kind__ === "err") throw new Error(res.err);
      setRssUrls(trimmed);
      setRssUrlsResult({
        type: "success",
        message: "Sources updated — cache cleared",
      });
    } catch (err: unknown) {
      setRssUrlsResult({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to save feed sources.",
      });
    } finally {
      setRssUrlsLoading(false);
    }
  };

  // ── Bye Weeks handlers ────────────────────────────────────────────────────
  // Validation rules: team abbreviation is 2-4 uppercase A-Z letters; bye week
  // is an integer between 1 and 18.
  const isValidTeam = (team: string): boolean =>
    /^[A-Z]{2,4}$/.test(team.trim());

  const isValidByeWeek = (week: string): boolean => {
    const n = Number(week);
    return (
      Number.isInteger(n) && n >= 1 && n <= 18 && String(n) === week.trim()
    );
  };

  const isByeWeekRowValid = (row: [string, string]): boolean =>
    isValidTeam(row[0]) && isValidByeWeek(row[1]);

  const handleEditByeWeekTeam = (index: number, value: string) => {
    setByeWeeks((prev) =>
      prev.map((r, i) => (i === index ? [value, r[1]] : r)),
    );
    if (byeWeeksResult) setByeWeeksResult(null);
  };

  const handleEditByeWeek = (index: number, value: string) => {
    setByeWeeks((prev) =>
      prev.map((r, i) => (i === index ? [r[0], value] : r)),
    );
    if (byeWeeksResult) setByeWeeksResult(null);
  };

  const handleRemoveByeWeek = (index: number) => {
    setByeWeeks((prev) => prev.filter((_, i) => i !== index));
    if (byeWeeksResult) setByeWeeksResult(null);
  };

  const handleAddByeWeek = () => {
    setByeWeeks((prev) => [...prev, ["", ""]]);
    if (byeWeeksResult) setByeWeeksResult(null);
  };

  // Parse an uploaded .json or .csv file client-side and replace the editable
  // rows with the parsed entries. Supports two JSON shapes (array of objects
  // with team/bye keys, or a flat object map) and a two-column CSV with a
  // header row.
  const handleByeWeekFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    const text = await file.text();
    let parsed: Array<[string, string]> = [];
    let parseError: string | null = null;
    try {
      if (name.endsWith(".json")) {
        parsed = parseByeWeeksJSON(text);
      } else if (name.endsWith(".csv")) {
        parsed = parseByeWeeksCSV(text);
      } else {
        parseError = "Unsupported file type. Use .json or .csv.";
      }
    } catch (err: unknown) {
      parseError = err instanceof Error ? err.message : "Failed to parse file.";
    }
    // Reset the input so the same file can be re-selected later.
    if (byeWeekFileInputRef.current) byeWeekFileInputRef.current.value = "";
    if (parseError) {
      setByeWeeksResult({ type: "error", message: parseError });
      return;
    }
    setByeWeeks(parsed);
    setByeWeeksResult({
      type: "success",
      message: `Loaded ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"} — review and save.`,
    });
  };

  const handleSaveByeWeeks = async () => {
    if (!actor) return;
    // Validate every row before submitting.
    const invalidIndex = byeWeeks.findIndex((r) => !isByeWeekRowValid(r));
    if (invalidIndex !== -1) {
      setByeWeeksResult({
        type: "error",
        message: `Row ${invalidIndex + 1} is invalid. Team must be 2-4 uppercase letters; bye week must be an integer 1-18.`,
      });
      return;
    }
    // Dedupe by team (last wins) and coerce to bigint tuples for the backend.
    const dedup = new Map<string, bigint>();
    for (const [team, week] of byeWeeks) {
      dedup.set(team.trim(), BigInt(Number(week)));
    }
    const tuples: Array<[string, bigint]> = Array.from(dedup.entries());
    setByeWeeksSaving(true);
    setByeWeeksResult(null);
    try {
      const res = await actor.setByeWeeks(tuples);
      if (res.__kind__ === "err") throw new Error(res.err);
      setByeWeeks(tuples.map(([team, week]) => [team, String(week)]));
      setByeWeeksResult({ type: "success", message: "Bye weeks updated" });
    } catch (err: unknown) {
      setByeWeeksResult({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to save bye weeks.",
      });
    } finally {
      setByeWeeksSaving(false);
    }
  };

  const handleSaveRefreshInterval = async () => {
    if (!actor) return;
    const parsed = Number(refreshMinutes);
    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_REFRESH_MINUTES ||
      !Number.isInteger(parsed)
    ) {
      setRefreshIntervalResult({
        type: "error",
        message: `Enter a whole number of minutes (minimum ${MIN_REFRESH_MINUTES}).`,
      });
      return;
    }
    const seconds = BigInt(parsed * 60);
    setRefreshIntervalLoading(true);
    setRefreshIntervalResult(null);
    try {
      const res = await actor.setRssRefreshIntervalSecs(seconds);
      if (res.__kind__ === "err") throw new Error(res.err);
      setRefreshMinutes(String(parsed));
      setRefreshIntervalResult({
        type: "success",
        message: "Refresh interval updated.",
      });
    } catch (err: unknown) {
      setRefreshIntervalResult({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to save refresh interval.",
      });
    } finally {
      setRefreshIntervalLoading(false);
    }
  };

  const handleSaveGiphyKey = async () => {
    if (!actor) return;
    const trimmed = giphyKey.trim();
    setGiphyKeyLoading(true);
    setGiphyKeyResult(null);
    try {
      const res = await actor.setGiphyApiKey(trimmed);
      if (res.__kind__ === "err") throw new Error(res.err);
      setGiphyKeySet(!!trimmed);
      setGiphyKey("");
      setGiphyKeyResult({
        type: "success",
        message: "API key saved successfully.",
      });
    } catch (err: unknown) {
      setGiphyKeyResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to save API key.",
      });
    } finally {
      setGiphyKeyLoading(false);
    }
  };

  const handleRemoveGiphyKey = async () => {
    if (!actor) return;
    setGiphyRemoving(true);
    setGiphyKeyResult(null);
    try {
      const res = await actor.setGiphyApiKey("");
      if (res.__kind__ === "err") throw new Error(res.err);
      setGiphyKeySet(false);
      setGiphyKey("");
      setGiphyKeyResult({ type: "success", message: "API key removed." });
    } catch (err: unknown) {
      setGiphyKeyResult({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to remove API key.",
      });
    } finally {
      setGiphyRemoving(false);
    }
  };

  const handleSaveOneSignalKey = async () => {
    if (!actor) return;
    const trimmed = oneSignalKey.trim();
    setOneSignalKeyLoading(true);
    setOneSignalKeyResult(null);
    try {
      const res = await actor.setOneSignalApiKey(trimmed);
      if (res.__kind__ === "err") throw new Error(res.err);
      setOneSignalKeySet(!!trimmed);
      setOneSignalKey("");
      setOneSignalKeyResult({
        type: "success",
        message: "API key saved successfully.",
      });
    } catch (err: unknown) {
      setOneSignalKeyResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to save API key.",
      });
    } finally {
      setOneSignalKeyLoading(false);
    }
  };

  const handleRemoveOneSignalKey = async () => {
    if (!actor) return;
    setOneSignalRemoving(true);
    setOneSignalKeyResult(null);
    try {
      const res = await actor.setOneSignalApiKey("");
      if (res.__kind__ === "err") throw new Error(res.err);
      setOneSignalKeySet(false);
      setOneSignalKey("");
      setOneSignalKeyResult({ type: "success", message: "API key removed." });
    } catch (err: unknown) {
      setOneSignalKeyResult({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to remove API key.",
      });
    } finally {
      setOneSignalRemoving(false);
    }
  };

  // ── Recovery password handler ────────────────────────────────────────────
  // Sets or updates the admin recovery password via setRecoveryPassword. The
  // password is used by recoverAdmin to restore admin access if the admin
  // principal is ever lost. Requires a non-empty value and a matching
  // confirmation before submitting.
  const handleSaveRecoveryPassword = async () => {
    if (!actor) return;
    const trimmed = recoveryPassword.trim();
    if (!trimmed) {
      setRecoveryPasswordResult({
        type: "error",
        message: "Enter a recovery password.",
      });
      return;
    }
    if (trimmed !== recoveryPasswordConfirm) {
      setRecoveryPasswordResult({
        type: "error",
        message: "Passwords do not match.",
      });
      return;
    }
    setRecoveryPasswordLoading(true);
    setRecoveryPasswordResult(null);
    try {
      const res = await actor.setRecoveryPassword(trimmed);
      if (res.__kind__ === "err") throw new Error(res.err);
      setRecoveryPassword("");
      setRecoveryPasswordConfirm("");
      setRecoveryPasswordResult({
        type: "success",
        message: "Recovery password saved successfully.",
      });
    } catch (err: unknown) {
      setRecoveryPasswordResult({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to save recovery password.",
      });
    } finally {
      setRecoveryPasswordLoading(false);
    }
  };

  // ── Send test push ──────────────────────────────────────────────────────
  // Diagnostic only: fires a single test notification to the caller's own
  // stored OneSignal player ID and surfaces the raw OneSignal response so the
  // admin can confirm the API key + subscription end-to-end. Does NOT touch
  // the notification queue, worker, triggers, or auction logic.
  const handleSendTestPush = async () => {
    if (!actor) return;
    setTestPushLoading(true);
    setTestPushResult(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (actor as any).sendTestPush();
      if (res?.__kind__ === "ok") {
        const v = res.ok;
        setTestPushResult({
          ok: true,
          looksSuccessful: Boolean(v?.looksSuccessful),
          body: String(v?.body ?? ""),
          playerId: String(v?.playerId ?? ""),
        });
      } else if (res?.__kind__ === "err") {
        setTestPushResult({
          ok: false,
          message: String(res.err ?? "Unknown error."),
        });
      } else {
        // Unexpected shape — surface it verbatim so it's never silently lost.
        setTestPushResult({
          ok: false,
          message: `Unexpected response: ${JSON.stringify(res)}`,
        });
      }
    } catch (err: unknown) {
      setTestPushResult({
        ok: false,
        message:
          err instanceof Error ? err.message : "Failed to send test push.",
      });
    } finally {
      setTestPushLoading(false);
    }
  };

  // ── Notification Pipeline Diagnostics ──────────────────────────────────
  // fetchDiagnostics loads BOTH counters and queue snapshot together so the
  // single Refresh button (and post-drain refetch) refreshes both at once.
  const fetchNotificationCounters = async () => {
    if (!actor) return;
    setNotifCountersLoading(true);
    setNotifCountersError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw =
        typeof (actor as any).getNotificationCounters === "function"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (actor as any).getNotificationCounters()
          : null;
      if (raw == null) {
        setNotifCounters(null);
        return;
      }
      setNotifCounters({
        queued: BigInt(raw.queued ?? 0),
        processed: BigInt(raw.processed ?? 0),
        sent: BigInt(raw.sent ?? 0),
        expired: BigInt(raw.expired ?? 0),
        retried: BigInt(raw.retried ?? 0),
        failed: BigInt(raw.failed ?? 0),
      });
    } catch (err: unknown) {
      setNotifCountersError(
        err instanceof Error ? err.message : "Failed to load counters.",
      );
    } finally {
      setNotifCountersLoading(false);
    }
  };

  const fetchNotificationQueueSnapshot = async () => {
    if (!actor) return;
    setNotifQueueLoading(true);
    setNotifQueueError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw =
        typeof (actor as any).getNotificationQueueSnapshot === "function"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (actor as any).getNotificationQueueSnapshot()
          : null;
      if (!Array.isArray(raw)) {
        setNotifQueue([]);
        return;
      }
      setNotifQueue(
        raw.map((e: Record<string, unknown>) => ({
          id: BigInt((e.id as bigint | number) ?? 0),
          userId: String(e.userId ?? ""),
          title: String(e.title ?? ""),
          attempts: BigInt((e.attempts as bigint | number) ?? 0),
          ageSeconds: BigInt((e.ageSeconds as bigint | number) ?? 0),
        })),
      );
    } catch (err: unknown) {
      setNotifQueueError(
        err instanceof Error ? err.message : "Failed to load queue snapshot.",
      );
    } finally {
      setNotifQueueLoading(false);
    }
  };

  // ── Heartbeat Diagnostics ──────────────────────────────────────────────
  // getHeartbeatDiagnostics() → { heartbeatTickCount, lastHeartbeatTickAt,
  //   notificationWorkerEntryCount, lastNotificationWorkerStartedAt,
  //   lastNotificationWorkerCompletedAt, lastNotificationWorkerError }.
  // Same defensive (actor as any) + typeof guard pattern as the other
  // notification diagnostics fetchers; BigInt-coerces the numeric fields and
  // normalizes lastNotificationWorkerError to string | null.
  // Formats an Int (nanosecond) timestamp from the backend as a human-readable
  // relative time like "12s ago", "5m ago", "3h ago", or "2d ago". Returns
  // "Never" when the timestamp is 0n (the backend's sentinel for "never ran").
  const formatHeartbeatRelative = (nsTimestamp: bigint): string => {
    if (nsTimestamp === 0n) return "Never";
    const seconds = Number(nsTimestamp / 1_000_000_000n);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const diff = nowSeconds - seconds;
    if (diff < 0) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const fetchHeartbeatDiagnostics = async () => {
    if (!actor) return;
    setHeartbeatLoading(true);
    setHeartbeatError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw =
        typeof (actor as any).getHeartbeatDiagnostics === "function"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (actor as any).getHeartbeatDiagnostics()
          : null;
      if (raw == null) {
        setHeartbeat(null);
        return;
      }
      const errVal = raw.lastNotificationWorkerError;
      setHeartbeat({
        notificationWorkerEntryCount: BigInt(
          raw.notificationWorkerEntryCount ?? 0,
        ),
        lastNotificationWorkerStartedAt: BigInt(
          raw.lastNotificationWorkerStartedAt ?? 0,
        ),
        lastNotificationWorkerCompletedAt: BigInt(
          raw.lastNotificationWorkerCompletedAt ?? 0,
        ),
        lastNotificationWorkerError: errVal == null ? null : String(errVal),
      });
    } catch (err: unknown) {
      setHeartbeatError(
        err instanceof Error
          ? err.message
          : "Failed to load heartbeat diagnostics.",
      );
    } finally {
      setHeartbeatLoading(false);
    }
  };

  // Shared refresh: fetches counters, queue snapshot, and heartbeat together.
  const fetchDiagnostics = async () => {
    await Promise.all([
      void fetchNotificationCounters(),
      void fetchNotificationQueueSnapshot(),
      void fetchHeartbeatDiagnostics(),
    ]);
  };

  // ── Drain Queue Now ─────────────────────────────────────────────────────
  // adminDrainQueueNow() → { #ok: Nat; #err: Text }. On #ok the variant
  // carries the number of notifications processed. After a successful drain we
  // immediately refetch BOTH counters and queue snapshot so the admin sees the
  // before/after without a manual refresh.
  const handleDrainQueueNow = async () => {
    if (!actor) return;
    setDrainLoading(true);
    setDrainResult(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (actor as any).adminDrainQueueNow();
      if (res?.__kind__ === "ok") {
        const count = Number(res.ok ?? 0);
        setDrainResult({
          type: "success",
          message: `Drained ${count} notification${count === 1 ? "" : "s"}.`,
        });
        // Refetch both so the admin sees the post-drain state immediately.
        void fetchDiagnostics();
      } else if (res?.__kind__ === "err") {
        setDrainResult({
          type: "error",
          message: String(res.err ?? "Unknown error."),
        });
      } else {
        // Unexpected shape — surface it verbatim so it's never silently lost.
        setDrainResult({
          type: "error",
          message: `Unexpected response: ${JSON.stringify(res)}`,
        });
      }
    } catch (err: unknown) {
      setDrainResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to drain queue.",
      });
    } finally {
      setDrainLoading(false);
    }
  };

  // ── ADP "all" dataset state ──────────────────────────────────────────────
  const [allAdp, setAllAdp] = useState<AdpSectionState>(makeAdpState());
  const allFileInputRef = useRef<HTMLInputElement>(null);

  // ── ADP "rookies" dataset state ──────────────────────────────────────────
  const [rookiesAdp, setRookiesAdp] = useState<AdpSectionState>(makeAdpState());
  const rookiesFileInputRef = useRef<HTMLInputElement>(null);

  // ── Load both datasets on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!actor) return;
    void loadDataset("all");
    void loadDataset("rookies");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  const setAdpState = (
    key: "all" | "rookies",
    updater: (prev: AdpSectionState) => AdpSectionState,
  ) => {
    if (key === "all") setAllAdp(updater);
    else setRookiesAdp(updater);
  };

  const loadDataset = async (key: "all" | "rookies") => {
    if (!actor) return;
    setAdpState(key, (s) => ({ ...s, datasetLoading: true }));
    try {
      const res = await actor.getADPDatasetByType(key);
      if (res != null) {
        setAdpState(key, (s) => ({
          ...s,
          currentDataset: {
            entryCount: res.entries.length,
            importedAt: Number(res.importedAt / BigInt(1_000_000)),
          },
        }));
      } else {
        setAdpState(key, (s) => ({ ...s, currentDataset: null }));
      }
    } catch {
      // silent
    } finally {
      setAdpState(key, (s) => ({ ...s, datasetLoading: false }));
    }
  };

  const handleFileChange =
    (key: "all" | "rookies") => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setAdpState(key, (s) => ({
        ...s,
        parseResult: null,
        uploadResult: null,
        pendingFile: file.name,
        errorsExpanded: false,
      }));

      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result;
        if (typeof text !== "string") return;
        const ext = file.name.split(".").pop()?.toLowerCase();
        const result =
          ext === "csv" ? parseCSVToADP(text) : parseJSONToADP(text);
        setAdpState(key, (s) => ({ ...s, parseResult: result }));
      };
      reader.readAsText(file);
    };

  const handleUpload = (key: "all" | "rookies") => async () => {
    if (!actor) return;
    const state = key === "all" ? allAdp : rookiesAdp;
    if (!state.parseResult || state.parseResult.validEntries.length === 0)
      return;

    setAdpState(key, (s) => ({ ...s, uploading: true, uploadResult: null }));
    try {
      const res = await actor.importADPDataset(
        state.parseResult.validEntries,
        key,
      );
      if (res.__kind__ === "err") throw new Error(res.err);
      await loadDataset(key);
      setAdpState(key, (s) => ({
        ...s,
        uploadResult: {
          type: "success",
          message: `ADP dataset uploaded successfully. ${res.ok}`,
        },
        parseResult: null,
        pendingFile: null,
      }));
      const ref = key === "all" ? allFileInputRef : rookiesFileInputRef;
      if (ref.current) ref.current.value = "";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error occurred";
      setAdpState(key, (s) => ({
        ...s,
        uploadResult: { type: "error", message: msg },
      }));
    } finally {
      setAdpState(key, (s) => ({ ...s, uploading: false }));
    }
  };

  const handleRemove = (key: "all" | "rookies") => async () => {
    if (!actor) return;
    setAdpState(key, (s) => ({ ...s, removing: true }));
    try {
      const res = await actor.removeADPDataset(key);
      if (res.__kind__ === "err") throw new Error(res.err);
      toast.success(
        `${key === "all" ? "All Players" : "Rookies"} ADP dataset removed.`,
      );
      setAdpState(key, (s) => ({ ...s, currentDataset: null }));
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove dataset.",
      );
    } finally {
      setAdpState(key, (s) => ({ ...s, removing: false }));
    }
  };

  const handleSleeperImport = async () => {
    if (!actor) return;
    setImporting(true);
    setSleeperResult(null);
    setProgress(null);
    setPositionBreakdown({});

    try {
      const response = await fetch("https://api.sleeper.app/v1/players/nfl");
      if (!response.ok) {
        throw new Error(
          `Sleeper API error: ${response.status} ${response.statusText}`,
        );
      }
      const raw: Record<string, SleeperPlayer> = await response.json();

      // Build the import payload WITHOUT byeWeek — the backend assigns it from
      // its team→bye-week lookup table during importPlayers. The Sleeper API
      // does not provide bye weeks, so the frontend must not hardcode a value
      // (previously 0n, which silently broke the bye-week collision warning).
      type PlayerImportPayload = Omit<Player, "byeWeek">;
      const eligible: PlayerImportPayload[] = [];
      const breakdown: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };

      for (const [player_id, p] of Object.entries(raw)) {
        const pos = p.position ?? "";
        if (!ELIGIBLE_POSITIONS.has(pos)) continue;
        if (!p.full_name?.trim()) continue;
        const isDraftable =
          p.active === true &&
          (!p.status || (p.status !== "Inactive" && p.status !== "Retired"));
        if (!isDraftable) continue;

        const yearsExp = p.years_exp == null ? 0 : p.years_exp;
        eligible.push({
          id: player_id,
          name: p.full_name.trim(),
          position: pos,
          team: p.team ?? "FA",
          adp: 0,
          headshotUrl: `https://sleepercdn.com/content/nfl/players/${player_id}.jpg`,
          yearsExp: BigInt(yearsExp),
        });
        breakdown[pos] = (breakdown[pos] ?? 0) + 1;
      }

      if (eligible.length === 0) {
        throw new Error("No eligible players found after filtering.");
      }

      setPositionBreakdown(breakdown);
      setProgress({ imported: 0, total: eligible.length });

      let totalImported = 0;
      for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
        const batch = eligible.slice(i, i + BATCH_SIZE);
        // Cast to Array<Player>: byeWeek is omitted from the payload so the
        // backend fills it in from its lookup table. The cast is needed while
        // the generated Player type still declares byeWeek as required (bigint);
        // once the binding is regenerated to ?Nat the cast becomes a no-op.
        const res = await actor.importPlayers(batch as Player[]);
        if (res.__kind__ === "err") {
          throw new Error(res.err);
        }
        totalImported = Number(res.ok);
        setProgress({
          imported: Math.min(i + BATCH_SIZE, eligible.length),
          total: eligible.length,
        });
      }

      setSleeperResult({
        type: "success",
        message: `${totalImported.toLocaleString()} players imported successfully.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error occurred";
      setSleeperResult({ type: "error", message: msg });
    } finally {
      setImporting(false);
    }
  };

  // ── Weekly stats sync core ───────────────────────────────────────────────
  // Shared fetch+parse+submit flow used by BOTH the manual button and the
  // automatic on-load sync. Fetches Sleeper's weekly stats map directly in the
  // browser (same direct-fetch pattern as handleSleeperImport — no backend
  // outcall), filters out team-defense keys and K/DST players by
  // cross-referencing the cached player list, maps raw categories into
  // WeeklyPlayerStats, then calls actor.syncWeeklyStats with the full batch.
  //
  // The in-session in-flight guard (module-scoped inFlightSyncKeys) ensures the
  // same (season, week) is never fetched concurrently twice within this session
  // — from a re-render, remount, or multiple tabs. This is purely an
  // optimization to avoid hammering Sleeper; the backend's atomic guard is the
  // real correctness guarantee. After the sync settles, the status view is
  // refreshed so it reflects the new status (synced/empty/failed).
  const runWeeklyStatsSync = async (seasonNum: number, weekNum: number) => {
    if (!actor) return;
    const key = `${seasonNum}:${weekNum}`;
    // Skip if this (season, week) is already in-flight in this session.
    if (inFlightSyncKeys.has(key)) return;
    inFlightSyncKeys.add(key);

    setSyncing(true);
    setSyncResult(null);
    setSyncProgress(null);
    setSkippedCount(0);

    try {
      // Fetch the weekly stats map: player-ID keys → raw stat objects.
      const statsResponse = await fetch(
        `https://api.sleeper.app/v1/stats/nfl/regular/${seasonNum}/${weekNum}`,
      );
      if (!statsResponse.ok) {
        throw new Error(
          `Sleeper API error: ${statsResponse.status} ${statsResponse.statusText}`,
        );
      }
      const statsRaw: Record<
        string,
        Record<string, number>
      > = await statsResponse.json();

      // The stats response does not carry position. Cross-reference the player
      // list (the same one the player import fetches) to exclude K/DST. Cache
      // it so a second sync reuses it.
      if (!playerListRef.current) {
        const playersResponse = await fetch(
          "https://api.sleeper.app/v1/players/nfl",
        );
        if (!playersResponse.ok) {
          throw new Error(
            `Sleeper API error: ${playersResponse.status} ${playersResponse.statusText}`,
          );
        }
        playerListRef.current = (await playersResponse.json()) as Record<
          string,
          SleeperPlayer
        >;
      }
      const players = playerListRef.current;

      const batch: WeeklyPlayerStats[] = [];
      let skipped = 0;

      for (const [playerId, stats] of Object.entries(statsRaw)) {
        // Skip any key that is not purely numeric (team defense entries like
        // 'TEAM_BUF' or 'BUF').
        if (!/^\d+$/.test(playerId)) {
          skipped++;
          continue;
        }
        // Skip K and DST players using the player metadata.
        const pos = players[playerId]?.position ?? "";
        if (pos === "K" || pos === "DST") {
          skipped++;
          continue;
        }
        // Map raw Sleeper categories → WeeklyPlayerStats, defaulting to 0.
        batch.push({
          playerId,
          season: BigInt(seasonNum),
          week: BigInt(weekNum),
          passYds: BigInt(stats.pass_yd ?? 0),
          passTds: BigInt(stats.pass_td ?? 0),
          ints: BigInt(stats.pass_int ?? 0),
          rushYds: BigInt(stats.rush_yd ?? 0),
          rushTds: BigInt(stats.rush_td ?? 0),
          receptions: BigInt(stats.rec ?? 0),
          recYds: BigInt(stats.rec_yd ?? 0),
          recTds: BigInt(stats.rec_td ?? 0),
          fumblesLost: BigInt(stats.fum_lost ?? 0),
          twoPtConversions: BigInt(stats.two_pt_conversions ?? 0),
        });
      }

      if (batch.length === 0) {
        throw new Error("No eligible players found after filtering.");
      }

      setSkippedCount(skipped);
      setSyncProgress({ synced: 0, total: batch.length });

      const res = await actor.syncWeeklyStats(
        // The backend's syncWeeklyStats now takes a roomId. For the global
        // admin the roomId is ignored for authorization (the admin is
        // authorized unconditionally), so an empty string is a safe placeholder
        // — the admin panel syncs global stats, not a specific room's.
        "",
        BigInt(seasonNum),
        BigInt(weekNum),
        batch,
      );
      if (res.__kind__ === "err") throw new Error(res.err);
      const count = Number(res.ok);
      setSyncProgress({ synced: count, total: batch.length });
      setSyncResult({
        type: "success",
        message: `${count.toLocaleString()} player stat records synced for ${seasonNum} week ${weekNum}.`,
      });
      // Record the sync outcome. Base the empty-vs-synced decision on the
      // backend's actual stored count (res.ok), not the pre-submission batch.
      // The backend's atomic guard may reject a duplicate with #err 'Already
      // synced' — that is not an application error, so ignore it silently.
      const recordRes = await actor.recordSyncStatus(
        BigInt(seasonNum),
        BigInt(weekNum),
        count > 0 ? SyncStatus.partial : SyncStatus.notYetAttempted,
        null,
        count > 0 ? BigInt(Date.now()) * 1_000_000n : null,
      );
      if (recordRes.__kind__ === "err" && recordRes.err !== "Already synced") {
        throw new Error(recordRes.err);
      }
    } catch (err: unknown) {
      // Surface the backend's specific rejection message (e.g. a finalized
      // week) verbatim rather than a generic error string.
      const msg = formatSyncError(err);
      setSyncResult({ type: "error", message: msg });
      // Record the failure so the status view reflects it. Ignore the atomic
      // guard's 'Already synced' rejection silently; a best-effort record
      // failure must never mask the original sync error.
      try {
        const recordRes = await actor.recordSyncStatus(
          BigInt(seasonNum),
          BigInt(weekNum),
          SyncStatus.notYetAttempted,
          msg,
          null,
        );
        if (
          recordRes.__kind__ === "err" &&
          recordRes.err !== "Already synced"
        ) {
          // Non-guard record failures are surfaced via the status refresh.
        }
      } catch {
        // Best-effort status recording must never mask the original sync error.
      }
    } finally {
      inFlightSyncKeys.delete(key);
      setSyncing(false);
      // Refresh the status view so it reflects the new status.
      void fetchSyncStatusRecords();
    }
  };

  // Manual weekly stats sync handler — validates the season/week inputs then
  // delegates to the shared core flow.
  const handleWeeklyStatsSync = async () => {
    if (!actor) return;
    const seasonNum = Number(season);
    const weekNum = Number(week);
    if (!Number.isInteger(seasonNum) || seasonNum <= 0) {
      setSyncResult({
        type: "error",
        message: "Enter a valid season (e.g. 2024).",
      });
      return;
    }
    if (!Number.isInteger(weekNum) || weekNum < 1 || weekNum > 18) {
      setSyncResult({
        type: "error",
        message: "Enter a valid week (1-18).",
      });
      return;
    }
    await runWeeklyStatsSync(seasonNum, weekNum);
  };

  // ── Sync status view ─────────────────────────────────────────────────────
  // Loads the backend's per-(season, week) sync status records for the admin
  // status list. This is a visibility aid only — it is NOT wired into any
  // existing UI's sync-detection logic (the starters.length === 0 heuristic
  // used by Phases 7-9 is untouched).
  const fetchSyncStatusRecords = async () => {
    if (!actor) return;
    setSyncStatusLoading(true);
    setSyncStatusError(null);
    try {
      const records = await actor.getSyncStatusRecords();
      setSyncStatusRecords(records);
    } catch (err: unknown) {
      setSyncStatusError(
        err instanceof Error ? err.message : "Failed to load sync status.",
      );
    } finally {
      setSyncStatusLoading(false);
    }
  };

  // ── Automatic sync on admin session load ─────────────────────────────────
  // When the admin panel loads, fetch the currently-flagged (season, week)
  // pairs and run the shared fetch+parse+submit flow for each. This is
  // silent/automatic by default and re-runs at most once every ~5 minutes
  // (minimum-time-since-last-sync interval) while the panel stays open — no
  // uncontrolled polling or refetch loop. The in-flight guard prevents
  // duplicate concurrent fetches for the same (season, week) from a re-render
  // or remount. Documented as visibility, not full autonomy: the backend's
  // atomic guard remains the real correctness guarantee.
  const runAutoSync = async () => {
    if (!actor) return;
    const now = Date.now();
    if (now - lastAutoSyncRef.current < AUTO_SYNC_INTERVAL_MS) return;
    lastAutoSyncRef.current = now;
    try {
      const flagged = await actor.getFlaggedWeeks();
      for (const record of flagged) {
        const seasonNum = Number(record.season);
        const weekNum = Number(record.week);
        if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
        if (!Number.isInteger(weekNum) || weekNum < 1 || weekNum > 18) continue;
        await runWeeklyStatsSync(seasonNum, weekNum);
      }
    } catch {
      // silent — the status view still reflects whatever the backend reports
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runAutoSync intentionally omitted
  useEffect(() => {
    if (!actor) return;
    void fetchSyncStatusRecords();
    void runAutoSync();
    const interval = window.setInterval(() => {
      void runAutoSync();
    }, AUTO_SYNC_INTERVAL_MS);
    // Browsers throttle background-tab setInterval timers, so the 5-minute
    // sync can fire late when the tab is backgrounded or the screen is locked.
    // When the tab regains visibility, run the same overdue check immediately
    // instead of waiting for the next (possibly clamped) interval tick.
    // runAutoSync's own lastAutoSyncRef rate-limit guard still enforces the
    // 5-minute minimum, so a visible tab never syncs more often than that.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runAutoSync();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  const progressPct = progress
    ? Math.round((progress.imported / progress.total) * 100)
    : 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/40 flex items-center justify-center">
          <Shield className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-2xl font-bold text-foreground">
            Admin Panel
          </h2>
          <p className="text-muted-foreground text-sm">
            Platform administration tools
          </p>
        </div>
      </div>

      {/* ── Canister Health Card ─────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0 mt-0.5">
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              Canister Health
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Monitor the backend canister's cycle balance. Low balances may
              require a top-up to keep the app running smoothly.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/40 border border-border">
          <div className="text-sm min-w-0 flex-1">
            <span className="text-muted-foreground">Cycle Balance:</span>{" "}
            {cycleBalanceLoading ? (
              <span className="text-muted-foreground/60 italic">Loading…</span>
            ) : cycleBalance != null ? (
              <span
                className={`font-mono font-bold text-lg ${
                  Number(cycleBalance) / 1_000_000_000_000 > 1.0
                    ? "text-emerald-400"
                    : Number(cycleBalance) / 1_000_000_000_000 > 0.25
                      ? "text-amber-400"
                      : "text-red-400"
                }`}
              >
                {(Number(cycleBalance) / 1_000_000_000_000).toFixed(2)} TC
              </span>
            ) : (
              <span className="text-muted-foreground/70 italic">
                Unable to fetch
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchCycleBalance}
            disabled={cycleBalanceLoading || !actor}
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs h-7 px-2"
            data-ocid="admin-cycle-refresh-btn"
          >
            {cycleBalanceLoading ? (
              <div className="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
            ) : (
              "Refresh"
            )}
          </Button>
        </div>
      </div>

      {/* ── Sleeper Import Card ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-secondary/15 border border-secondary/40 flex items-center justify-center shrink-0 mt-0.5">
            <Database className="w-4.5 h-4.5 text-secondary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              Import Players from Sleeper API
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Fetches active NFL players (QB, RB, WR, TE) directly from the
              Sleeper API and uploads them to the backend in batches of{" "}
              {BATCH_SIZE}. Existing players are upserted — no duplicates
              created.
            </p>
          </div>
        </div>

        {importing && progress && (
          <div className="space-y-2" data-ocid="admin-import-progress">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                Importing{" "}
                <span className="text-foreground font-mono font-semibold">
                  {progress.imported.toLocaleString()}
                </span>{" "}
                of{" "}
                <span className="text-foreground font-mono font-semibold">
                  {progress.total.toLocaleString()}
                </span>{" "}
                players…
              </span>
              <span className="font-mono">{progressPct}%</span>
            </div>
            <Progress value={progressPct} className="h-2" />
          </div>
        )}

        {!importing && Object.keys(positionBreakdown).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {Object.entries(positionBreakdown).map(([pos, count]) => (
              <Badge
                key={pos}
                variant="outline"
                className={`font-mono text-xs ${positionColor(pos)}`}
              >
                {pos}: {count.toLocaleString()}
              </Badge>
            ))}
          </div>
        )}

        {sleeperResult && sleeperResult.type === "success" && (
          <div
            className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
            data-ocid="admin-import-success"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{sleeperResult.message}</span>
          </div>
        )}
        {sleeperResult && sleeperResult.type === "error" && (
          <div
            className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
            data-ocid="admin-import-error"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{sleeperResult.message}</span>
          </div>
        )}

        <Button
          onClick={handleSleeperImport}
          disabled={importing || !actor}
          className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono w-full sm:w-auto"
          data-ocid="admin-import-btn"
        >
          {importing ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
              Importing…
            </>
          ) : (
            <>
              <Download className="w-4 h-4 mr-2" />
              Import Players from Sleeper
            </>
          )}
        </Button>
      </div>

      {/* ── Sync Weekly Stats Card ──────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/15 border border-accent/40 flex items-center justify-center shrink-0 mt-0.5">
            <BarChart3 className="w-4 h-4 text-accent-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              Sync Weekly Stats from Sleeper
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Fetches raw weekly stat categories for a given season and week
              directly from the Sleeper API and uploads them to the backend.
              Team-defense entries and K/DST players are skipped automatically.
            </p>
          </div>
        </div>

        {/* Season / week inputs */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <label
              htmlFor="weekly-stats-season-input"
              className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Season
            </label>
            <input
              id="weekly-stats-season-input"
              type="number"
              min={2000}
              step={1}
              value={season}
              onChange={(e) => {
                setSeason(e.target.value);
                if (syncResult) setSyncResult(null);
              }}
              placeholder="2024"
              className="w-28 h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
              data-ocid="admin-weekly-stats-season-input"
            />
          </div>
          <div className="space-y-2">
            <label
              htmlFor="weekly-stats-week-input"
              className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Week
            </label>
            <input
              id="weekly-stats-week-input"
              type="number"
              min={1}
              max={18}
              step={1}
              value={week}
              onChange={(e) => {
                setWeek(e.target.value);
                if (syncResult) setSyncResult(null);
              }}
              placeholder="1"
              className="w-24 h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
              data-ocid="admin-weekly-stats-week-input"
            />
          </div>
        </div>

        {/* Progress */}
        {syncing && syncProgress && (
          <div className="space-y-2" data-ocid="admin-weekly-stats-progress">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                Syncing{" "}
                <span className="text-foreground font-mono font-semibold">
                  {syncProgress.synced.toLocaleString()}
                </span>{" "}
                of{" "}
                <span className="text-foreground font-mono font-semibold">
                  {syncProgress.total.toLocaleString()}
                </span>{" "}
                players…
              </span>
              <span className="font-mono">
                {syncProgress.total > 0
                  ? Math.round((syncProgress.synced / syncProgress.total) * 100)
                  : 0}
                %
              </span>
            </div>
            <Progress
              value={
                syncProgress.total > 0
                  ? Math.round((syncProgress.synced / syncProgress.total) * 100)
                  : 0
              }
              className="h-2"
            />
          </div>
        )}

        {/* Skipped diagnostic */}
        {!syncing && skippedCount > 0 && (
          <div
            className="flex items-center gap-2.5 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm"
            data-ocid="admin-weekly-stats-skipped"
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              {skippedCount.toLocaleString()} entr
              {skippedCount === 1 ? "y" : "ies"} skipped (team defense or
              K/DST).
            </span>
          </div>
        )}

        {/* Result messages */}
        {syncResult && syncResult.type === "success" && (
          <div
            className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
            data-ocid="admin-weekly-stats-success"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{syncResult.message}</span>
          </div>
        )}
        {syncResult && syncResult.type === "error" && (
          <div
            className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
            data-ocid="admin-weekly-stats-error"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{syncResult.message}</span>
          </div>
        )}

        <Button
          onClick={handleWeeklyStatsSync}
          disabled={syncing || !actor || !season.trim() || !week.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono w-full sm:w-auto disabled:opacity-40"
          data-ocid="admin-weekly-stats-btn"
        >
          {syncing ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
              Syncing…
            </>
          ) : (
            <>
              <BarChart3 className="w-4 h-4 mr-2" />
              Sync Weekly Stats
            </>
          )}
        </Button>
      </div>

      {/* ── Weekly Sync Status Card ─────────────────────────────────────── */}
      {/* Minimal admin-facing status view: for each tracked (season, week),
          show its status and the relevant timestamp — lastSuccessfulAt if
          synced, lastAttemptedAt + lastError if failed, lastAttemptedAt if
          empty/pending. This is a visibility aid, not full autonomy: it does
          not drive any existing sync-detection logic. */}
      <div
        className="rounded-xl border border-border bg-card p-5 space-y-4"
        data-ocid="admin-weekly-sync-status-section"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent/15 border border-accent/40 flex items-center justify-center shrink-0 mt-0.5">
              <BarChart3 className="w-4 h-4 text-accent-foreground" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground mb-1">
                Weekly Sync Status
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Tracks the sync state of each (season, week). Flagged weeks are
                synced automatically when this panel loads. This view is for
                visibility only — it does not control any other feature.
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchSyncStatusRecords}
            disabled={syncStatusLoading || !actor}
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs h-7 px-2 mt-0.5"
            data-ocid="admin-weekly-sync-status-refresh-btn"
          >
            {syncStatusLoading ? (
              <div className="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
            ) : (
              <>
                <RefreshCw className="w-3 h-3 mr-1" />
                Refresh
              </>
            )}
          </Button>
        </div>

        {/* Loading state */}
        {syncStatusLoading && (
          <div
            className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
            data-ocid="admin-weekly-sync-status-loading_state"
          >
            <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin shrink-0" />
            <span>Loading sync status…</span>
          </div>
        )}

        {/* Error state */}
        {!syncStatusLoading && syncStatusError && (
          <div
            className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
            data-ocid="admin-weekly-sync-status-error_state"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{syncStatusError}</span>
          </div>
        )}

        {/* Empty state */}
        {!syncStatusLoading &&
          !syncStatusError &&
          syncStatusRecords.length === 0 && (
            <div
              className="flex items-start gap-2.5 p-3 rounded-lg bg-muted/40 border border-border text-sm"
              data-ocid="admin-weekly-sync-status-empty_state"
            >
              <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-foreground font-medium">
                  No tracked weeks yet
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Sync a season/week above to start tracking its status.
                </p>
              </div>
            </div>
          )}

        {/* Status list */}
        {!syncStatusLoading &&
          !syncStatusError &&
          syncStatusRecords.length > 0 && (
            <ul className="space-y-2" data-ocid="admin-weekly-sync-status-list">
              {syncStatusRecords.map((record, i) => {
                const status = record.status;
                const isFinalized = status === "finalized";
                const isPartial = status === "partial";
                const isPending = status === "notYetAttempted";
                const statusLabel = isFinalized
                  ? "Finalized"
                  : isPartial
                    ? "Partial"
                    : "Pending";
                const statusTone = isFinalized
                  ? "bg-green-500/10 border-green-500/30 text-green-400"
                  : isPartial
                    ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                    : "bg-muted/40 border-border text-muted-foreground";
                return (
                  <li
                    key={`${record.season}-${record.week}`}
                    className="flex items-start justify-between gap-3 p-3 rounded-lg bg-muted/30 border border-border"
                    data-ocid={`admin-weekly-sync-status-item.${i + 1}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        Season{" "}
                        <span className="font-mono">
                          {Number(record.season)}
                        </span>{" "}
                        · Week{" "}
                        <span className="font-mono">{Number(record.week)}</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {isFinalized && (
                          <>
                            Finalized{" "}
                            <span className="font-mono">
                              {formatSyncTimestamp(record.lastSuccessfulAt)}
                            </span>
                          </>
                        )}
                        {(isPartial || isPending) && (
                          <>
                            Last attempted{" "}
                            <span className="font-mono">
                              {formatSyncTimestamp(record.lastAttemptedAt)}
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold shrink-0 ${statusTone}`}
                      data-ocid={`admin-weekly-sync-status-badge.${i + 1}`}
                    >
                      {isFinalized ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <Clock className="w-3.5 h-3.5" />
                      )}
                      {statusLabel}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
      </div>

      {/* ── Clear Players Card ──────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-destructive/10 border border-destructive/30 flex items-center justify-center shrink-0 mt-0.5">
            <Trash2 className="w-4 h-4 text-destructive" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              Clear All Players
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Permanently removes all players from the backend. This cannot be
              undone. Use before re-importing a fresh Sleeper dataset.
            </p>
          </div>
        </div>

        {!clearConfirming ? (
          <Button
            variant="outline"
            onClick={() => setClearConfirming(true)}
            disabled={!actor}
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive font-mono w-full sm:w-auto"
            data-ocid="admin-clear-players-btn"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Clear Players
          </Button>
        ) : (
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
            <p className="text-sm text-destructive font-medium flex-1">
              Are you sure? This will delete all players permanently.
            </p>
            <div className="flex gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setClearConfirming(false)}
                disabled={clearPending}
                className="border-border text-muted-foreground hover:text-foreground"
                data-ocid="admin-clear-players-cancel-btn"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleClearPlayers}
                disabled={clearPending || !actor}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 font-mono"
                data-ocid="admin-clear-players-confirm-btn"
              >
                {clearPending ? (
                  <>
                    <div className="w-3 h-3 border-2 border-destructive-foreground/30 border-t-destructive-foreground rounded-full animate-spin mr-1.5" />
                    Clearing…
                  </>
                ) : (
                  "Yes, clear all"
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Delete Room Card ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-destructive/10 border border-destructive/30 flex items-center justify-center shrink-0 mt-0.5">
              <Trash2 className="w-4 h-4 text-destructive" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground mb-1">
                Delete Room
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Permanently deletes a room and all associated data
                (participants, nominations, bids, chat).
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadRooms}
            disabled={roomsLoading || !actor}
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs h-7 px-2 mt-0.5"
            data-ocid="admin-rooms-refresh-btn"
          >
            {roomsLoading ? (
              <div className="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
            ) : (
              "Refresh"
            )}
          </Button>
        </div>

        {roomsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
            Loading rooms…
          </div>
        ) : rooms.length === 0 ? (
          <p
            className="text-sm text-muted-foreground/60 italic py-1"
            data-ocid="admin-rooms-empty"
          >
            No rooms found.
          </p>
        ) : (
          <ul className="space-y-2" data-ocid="admin-rooms-list">
            {rooms.map((room, i) => (
              <li
                key={room.id}
                className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/30 border border-border"
                data-ocid={`admin-room-item.${i + 1}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {room.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground font-mono">
                    {room.state} · {Number(room.participantCount)} participants
                  </p>
                </div>

                {confirmDeleteRoomId === room.id ? (
                  <div className="flex gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDeleteRoomId(null)}
                      disabled={deletingRoomId === room.id}
                      className="h-7 px-2 text-xs border-border text-muted-foreground"
                      data-ocid={`admin-room-delete-cancel-btn.${i + 1}`}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleDeleteRoom(room.id)}
                      disabled={deletingRoomId === room.id}
                      className="h-7 px-2 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      data-ocid={`admin-room-delete-confirm-btn.${i + 1}`}
                    >
                      {deletingRoomId === room.id ? (
                        <div className="w-3 h-3 border-2 border-destructive-foreground/30 border-t-destructive-foreground rounded-full animate-spin" />
                      ) : (
                        "Delete"
                      )}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDeleteRoomId(room.id)}
                    className="h-7 px-2 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 shrink-0"
                    data-ocid={`admin-room-delete-btn.${i + 1}`}
                  >
                    <Trash2 className="w-3 h-3 mr-1" />
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Giphy API Key Card ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
            <Key className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              Giphy API Key
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Stores the Giphy API key in canister memory. When set, users can
              send GIFs in room chat. Removing the key disables the GIF button
              for all users.
            </p>
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm">
          {giphyKeySet ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
              <span className="text-green-400 font-medium">
                API key configured
              </span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">No API key set.</span>
            </>
          )}
        </div>

        {/* Key input */}
        <div className="space-y-2">
          <label
            htmlFor="giphy-key-input"
            className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
          >
            {giphyKeySet ? "Replace API Key" : "Enter API Key"}
          </label>
          <input
            id="giphy-key-input"
            type="password"
            value={giphyKey}
            onChange={(e) => setGiphyKey(e.target.value)}
            placeholder={
              giphyKeySet ? "••••••••••••" : "Paste your Giphy API key…"
            }
            className="w-full h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            data-ocid="admin-giphy-key-input"
          />
        </div>

        {/* Feedback */}
        {giphyKeyResult?.type === "success" && (
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{giphyKeyResult.message}</span>
          </div>
        )}
        {giphyKeyResult?.type === "error" && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{giphyKeyResult.message}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSaveGiphyKey}
            disabled={!giphyKey.trim() || giphyKeyLoading || !actor}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono disabled:opacity-40"
            data-ocid="admin-giphy-save-btn"
          >
            {giphyKeyLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                Saving…
              </>
            ) : (
              <>Save API Key</>
            )}
          </Button>
          {giphyKeySet && (
            <Button
              variant="outline"
              onClick={handleRemoveGiphyKey}
              disabled={giphyRemoving || !actor}
              className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive font-mono disabled:opacity-40"
              data-ocid="admin-giphy-remove-btn"
            >
              {giphyRemoving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-destructive/30 border-t-destructive rounded-full animate-spin mr-2" />
                  Removing…
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Remove Key
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* ── OneSignal API Key Card ──────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
            <Key className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              OneSignal REST API Key
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Stores the OneSignal REST API key in canister memory. Required to
              send push notifications to participants for outbid alerts,
              nomination turns, and auction events.
            </p>
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm">
          {oneSignalKeySet ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
              <span className="text-green-400 font-medium">
                API key configured
              </span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">No API key set.</span>
            </>
          )}
        </div>

        {/* Key input */}
        <div className="space-y-2">
          <label
            htmlFor="onesignal-key-input"
            className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
          >
            {oneSignalKeySet ? "Replace API Key" : "Enter API Key"}
          </label>
          <input
            id="onesignal-key-input"
            type="password"
            value={oneSignalKey}
            onChange={(e) => setOneSignalKey(e.target.value)}
            placeholder={
              oneSignalKeySet
                ? "••••••••••••"
                : "Paste your OneSignal REST API key…"
            }
            className="w-full h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            data-ocid="admin-onesignal-key-input"
          />
        </div>

        {/* Feedback */}
        {oneSignalKeyResult?.type === "success" && (
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{oneSignalKeyResult.message}</span>
          </div>
        )}
        {oneSignalKeyResult?.type === "error" && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{oneSignalKeyResult.message}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSaveOneSignalKey}
            disabled={!oneSignalKey.trim() || oneSignalKeyLoading || !actor}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono disabled:opacity-40"
            data-ocid="admin-onesignal-save-btn"
          >
            {oneSignalKeyLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                Saving…
              </>
            ) : (
              <>Save API Key</>
            )}
          </Button>
          {oneSignalKeySet && (
            <Button
              variant="outline"
              onClick={handleRemoveOneSignalKey}
              disabled={oneSignalRemoving || !actor}
              className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive font-mono disabled:opacity-40"
              data-ocid="admin-onesignal-remove-btn"
            >
              {oneSignalRemoving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-destructive/30 border-t-destructive rounded-full animate-spin mr-2" />
                  Removing…
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Remove Key
                </>
              )}
            </Button>
          )}
        </div>

        {/* ── Stored Player IDs (read-only diagnostic view) ──────────────── */}
        {/* Read-only: no edit/remove controls. Surfaces getOneSignalPlayerIds
            so the admin can confirm entries exist without exposing raw values. */}
        <div className="space-y-3">
          {/* Header row */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Users className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-semibold text-foreground">
                Stored Player IDs:{" "}
                <span className="font-mono text-muted-foreground">
                  {oneSignalPlayerIds.length}
                </span>
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchOneSignalPlayerIds}
              disabled={oneSignalPlayerIdsLoading || !actor}
              className="text-muted-foreground hover:text-foreground shrink-0 text-xs h-7 px-2"
              data-ocid="admin-onesignal-playerids-refresh-btn"
            >
              {oneSignalPlayerIdsLoading ? (
                <div className="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Refresh
                </>
              )}
            </Button>
          </div>

          {/* Loading state */}
          {oneSignalPlayerIdsLoading && (
            <div
              className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
              data-ocid="admin-onesignal-playerids-loading_state"
            >
              <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin shrink-0" />
              <span>Loading…</span>
            </div>
          )}

          {/* Error state */}
          {!oneSignalPlayerIdsLoading && oneSignalPlayerIdsError && (
            <div
              className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
              data-ocid="admin-onesignal-playerids-error_state"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-all">{oneSignalPlayerIdsError}</span>
            </div>
          )}

          {/* Empty state */}
          {!oneSignalPlayerIdsLoading &&
            !oneSignalPlayerIdsError &&
            oneSignalPlayerIds.length === 0 && (
              <div
                className="flex items-start gap-2.5 p-3 rounded-lg bg-muted/40 border border-border text-sm"
                data-ocid="admin-onesignal-playerids-empty_state"
              >
                <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-foreground font-medium">
                    No player IDs stored yet
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    An empty result means push notifications are being silently
                    dropped for everyone — no participants have registered a
                    OneSignal player ID yet.
                  </p>
                </div>
              </div>
            )}

          {/* List of entries */}
          {!oneSignalPlayerIdsLoading &&
            !oneSignalPlayerIdsError &&
            oneSignalPlayerIds.length > 0 && (
              <ul className="space-y-1.5">
                {oneSignalPlayerIds.map(([principal, playerId], i) => {
                  const principalShort =
                    principal.length > 12
                      ? `${principal.slice(0, 8)}…${principal.slice(-4)}`
                      : principal;
                  const playerIdShort = playerId.slice(0, 8);
                  return (
                    <li
                      key={`${principal}-${playerId}`}
                      className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-muted/40 border border-border text-xs"
                      data-ocid={`admin-onesignal-playerids-item.${i + 1}`}
                    >
                      <span className="font-mono text-foreground truncate min-w-0">
                        {principalShort}
                      </span>
                      <span className="font-mono text-muted-foreground shrink-0">
                        {playerIdShort}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>

        {/* ── Send Test Push (diagnostic) ─────────────────────────────── */}
        {/* Fires a single test notification to the caller's own stored
            OneSignal player ID. Surfaces the raw OneSignal response so the
            admin can confirm the API key + subscription end-to-end. */}
        <div className="space-y-3 pt-1 border-t border-border">
          <div className="flex items-center gap-2 pt-3">
            <Send className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-semibold text-foreground">
              Send Test Push
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Sends a single test notification to your own stored OneSignal player
            ID and shows the raw OneSignal response. An HTTP outcall can take a
            few seconds.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleSendTestPush}
              disabled={testPushLoading || !actor}
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono disabled:opacity-40"
              data-ocid="admin-onesignal-testpush-btn"
            >
              {testPushLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Send Test Push
                </>
              )}
            </Button>
          </div>

          {/* Loading state */}
          {testPushLoading && (
            <div
              className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
              data-ocid="admin-onesignal-testpush-loading_state"
            >
              <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin shrink-0" />
              <span>Calling OneSignal…</span>
            </div>
          )}

          {/* #ok result: body verbatim (green when looksSuccessful, red otherwise) + playerId */}
          {!testPushLoading && testPushResult?.ok && (
            <div
              className="space-y-2 p-3 rounded-lg bg-muted/40 border border-border text-sm"
              data-ocid="admin-onesignal-testpush-success_state"
            >
              {(() => {
                const tone = testPushResult.looksSuccessful
                  ? "text-green-400 border-green-500/30 bg-green-500/10"
                  : "text-destructive border-destructive/30 bg-destructive/10";
                return (
                  <>
                    <div
                      className={`flex items-start gap-2.5 p-2.5 rounded-md border ${tone}`}
                    >
                      <span className="font-mono break-all whitespace-pre-wrap min-w-0">
                        {`body: ${testPushResult.body || "(empty)"}`}
                      </span>
                    </div>
                    {testPushResult.playerId && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Sent to player ID:</span>
                        <span className="font-mono text-foreground truncate min-w-0">
                          {testPushResult.playerId.length > 12
                            ? `${testPushResult.playerId.slice(0, 8)}…${testPushResult.playerId.slice(-4)}`
                            : testPushResult.playerId}
                        </span>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* #err result: show message verbatim */}
          {!testPushLoading && testPushResult && !testPushResult.ok && (
            <div
              className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
              data-ocid="admin-onesignal-testpush-error_state"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-all">{testPushResult.message}</span>
            </div>
          )}
        </div>

        {/* ── Notification Pipeline Diagnostics ─────────────────────────── */}
        {/* Surfaces getNotificationCounters + getNotificationQueueSnapshot so
            the admin can see the live pipeline state, plus adminDrainQueueNow
            to force-process the pending queue. */}
        <div className="space-y-3 pt-1 border-t border-border">
          {/* Header row */}
          <div className="flex items-center justify-between gap-3 pt-3">
            <div className="flex items-center gap-2 min-w-0">
              <Activity className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-semibold text-foreground">
                Notification Pipeline Diagnostics
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchDiagnostics}
              disabled={
                notifCountersLoading ||
                notifQueueLoading ||
                heartbeatLoading ||
                !actor
              }
              className="text-muted-foreground hover:text-foreground shrink-0 text-xs h-7 px-2"
              data-ocid="admin-onesignal-diagnostics-refresh-btn"
            >
              {notifCountersLoading || notifQueueLoading || heartbeatLoading ? (
                <div className="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Refresh
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Live snapshot of the notification pipeline: counters track each
            lifecycle stage, and the queue table shows pending notifications
            waiting to be processed.
          </p>

          {/* Counters row */}
          <div className="space-y-2">
            <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Counters
            </span>

            {/* Counters loading state */}
            {notifCountersLoading && (
              <div
                className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
                data-ocid="admin-onesignal-diagnostics-counters-loading_state"
              >
                <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin shrink-0" />
                <span>Loading counters…</span>
              </div>
            )}

            {/* Counters error state */}
            {!notifCountersLoading && notifCountersError && (
              <div
                className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
                data-ocid="admin-onesignal-diagnostics-counters-error_state"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-all">{notifCountersError}</span>
              </div>
            )}

            {/* Counters grid */}
            {!notifCountersLoading && !notifCountersError && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  {
                    label: "Queued",
                    value: Number(notifCounters?.queued),
                  },
                  {
                    label: "Processed",
                    value: Number(notifCounters?.processed),
                  },
                  { label: "Sent", value: Number(notifCounters?.sent) },
                  {
                    label: "Expired",
                    value: Number(notifCounters?.expired),
                  },
                  {
                    label: "Retried",
                    value: Number(notifCounters?.retried),
                  },
                  { label: "Failed", value: Number(notifCounters?.failed) },
                ].map((c) => (
                  <div
                    key={c.label}
                    className="flex flex-col gap-1 p-2.5 rounded-lg bg-muted/40 border border-border"
                  >
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">
                      {c.label}
                    </span>
                    <span className="font-mono text-lg text-foreground tabular-nums">
                      {notifCounters == null ? "—" : c.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Queue snapshot */}
          <div className="space-y-2">
            <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Pending:{" "}
              <span className="font-mono normal-case tracking-normal">
                {notifQueue.length}
              </span>
            </span>

            {/* Queue loading state */}
            {notifQueueLoading && (
              <div
                className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
                data-ocid="admin-onesignal-diagnostics-queue-loading_state"
              >
                <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin shrink-0" />
                <span>Loading queue…</span>
              </div>
            )}

            {/* Queue error state */}
            {!notifQueueLoading && notifQueueError && (
              <div
                className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
                data-ocid="admin-onesignal-diagnostics-queue-error_state"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-all">{notifQueueError}</span>
              </div>
            )}

            {/* Queue empty state */}
            {!notifQueueLoading &&
              !notifQueueError &&
              notifQueue.length === 0 && (
                <div
                  className="flex items-start gap-2.5 p-3 rounded-lg bg-muted/40 border border-border text-sm"
                  data-ocid="admin-onesignal-diagnostics-queue-empty_state"
                >
                  <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-foreground font-medium">
                      Queue is empty
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      No pending notifications. Everything has been processed or
                      the pipeline is idle.
                    </p>
                  </div>
                </div>
              )}

            {/* Queue table */}
            {!notifQueueLoading &&
              !notifQueueError &&
              notifQueue.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                        <th className="px-3 py-2 font-medium">ID</th>
                        <th className="px-3 py-2 font-medium">User</th>
                        <th className="px-3 py-2 font-medium">Title</th>
                        <th className="px-3 py-2 font-medium text-right">
                          Attempts
                        </th>
                        <th className="px-3 py-2 font-medium text-right">
                          Age
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {notifQueue.map((entry, i) => {
                        const totalSeconds = Number(entry.ageSeconds);
                        const minutes = Math.floor(totalSeconds / 60);
                        const seconds = totalSeconds % 60;
                        const age =
                          minutes > 0
                            ? `${minutes}m ${seconds}s`
                            : `${seconds}s`;
                        const userIdShort =
                          entry.userId.length > 12
                            ? `${entry.userId.slice(0, 8)}…${entry.userId.slice(-4)}`
                            : entry.userId;
                        return (
                          <tr
                            key={`notif-queue-${entry.id}`}
                            className="text-foreground"
                            data-ocid={`admin-onesignal-diagnostics-queue-row.${i + 1}`}
                          >
                            <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                              {Number(entry.id)}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                              {userIdShort}
                            </td>
                            <td className="px-3 py-2 min-w-0">
                              <span className="truncate block max-w-[16rem]">
                                {entry.title || "(no title)"}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-right tabular-nums">
                              {Number(entry.attempts)}
                            </td>
                            <td className="px-3 py-2 font-mono text-right tabular-nums whitespace-nowrap">
                              {age}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </div>

          {/* Drain Queue Now */}
          <div className="space-y-2">
            <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Manual Drain
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleDrainQueueNow}
                disabled={drainLoading || !actor}
                className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono disabled:opacity-40"
                data-ocid="admin-onesignal-diagnostics-drain-btn"
              >
                {drainLoading ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                    Draining…
                  </>
                ) : (
                  <>
                    <Activity className="w-4 h-4 mr-2" />
                    Drain Queue Now
                  </>
                )}
              </Button>
            </div>

            {/* Drain success result */}
            {drainResult?.type === "success" && (
              <div
                className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
                data-ocid="admin-onesignal-diagnostics-drain-success_state"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{drainResult.message}</span>
              </div>
            )}

            {/* Drain error result */}
            {drainResult?.type === "error" && (
              <div
                className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
                data-ocid="admin-onesignal-diagnostics-drain-error_state"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-all">{drainResult.message}</span>
              </div>
            )}
          </div>

          {/* ── Worker Diagnostics ────────────────────────────────────── */}
          {/* Surfaces getHeartbeatDiagnostics() so the admin can see the
              notification worker's run history (entry count, last
              start/complete timestamps, and the most recent error if any).
              Data is fetched alongside the counters and queue via
              fetchDiagnostics(). */}
          <div className="space-y-2">
            <span className="flex items-center gap-1.5 block text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              Worker
            </span>

            {/* Worker loading state */}
            {heartbeatLoading && (
              <div
                className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
                data-ocid="admin-onesignal-diagnostics-worker-loading_state"
              >
                <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin shrink-0" />
                <span>Loading worker diagnostics…</span>
              </div>
            )}

            {/* Worker error state */}
            {!heartbeatLoading && heartbeatError && (
              <div
                className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
                data-ocid="admin-onesignal-diagnostics-worker-error_state"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-all">{heartbeatError}</span>
              </div>
            )}

            {/* Worker grid + error row */}
            {!heartbeatLoading && !heartbeatError && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[
                    {
                      label: "Worker Entries",
                      value:
                        heartbeat == null
                          ? "—"
                          : String(
                              Number(heartbeat.notificationWorkerEntryCount),
                            ),
                    },
                    {
                      label: "Worker Started",
                      value:
                        heartbeat == null
                          ? "—"
                          : formatHeartbeatRelative(
                              heartbeat.lastNotificationWorkerStartedAt,
                            ),
                    },
                    {
                      label: "Worker Completed",
                      value:
                        heartbeat == null
                          ? "—"
                          : formatHeartbeatRelative(
                              heartbeat.lastNotificationWorkerCompletedAt,
                            ),
                    },
                  ].map((c) => (
                    <div
                      key={c.label}
                      className="flex flex-col gap-1 p-2.5 rounded-lg bg-muted/40 border border-border"
                    >
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">
                        {c.label}
                      </span>
                      <span className="font-mono text-lg text-foreground tabular-nums">
                        {c.value}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Last worker error row */}
                <div
                  className="flex items-start gap-2.5 p-2.5 rounded-lg bg-muted/40 border border-border"
                  data-ocid="admin-onesignal-diagnostics-worker-error_text"
                >
                  <span className="text-xs text-muted-foreground uppercase tracking-wider shrink-0 pt-0.5">
                    Last Worker Error
                  </span>
                  <span
                    className={`font-mono text-sm break-all min-w-0 ${
                      heartbeat?.lastNotificationWorkerError
                        ? "text-destructive"
                        : "text-foreground"
                    }`}
                  >
                    {heartbeat == null
                      ? "—"
                      : (heartbeat.lastNotificationWorkerError ?? "None")}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Recovery Password Card ─────────────────────────────────────── */}
      <div
        className="rounded-xl border border-border bg-card p-5 space-y-4"
        data-ocid="admin-recovery-section"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
            <Key className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              Recovery Password
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Set or update the recovery password used to restore admin access
              if the admin principal is ever lost. Store it somewhere safe — it
              cannot be recovered if forgotten.
            </p>
          </div>
        </div>

        {/* Password input */}
        <div className="space-y-2">
          <label
            htmlFor="recovery-password-input"
            className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
          >
            New Recovery Password
          </label>
          <input
            id="recovery-password-input"
            type="password"
            value={recoveryPassword}
            onChange={(e) => {
              setRecoveryPassword(e.target.value);
              if (recoveryPasswordResult) setRecoveryPasswordResult(null);
            }}
            placeholder="Enter a recovery password…"
            autoComplete="new-password"
            className="w-full h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            data-ocid="admin-recovery-password-input"
          />
        </div>

        {/* Confirm input */}
        <div className="space-y-2">
          <label
            htmlFor="recovery-password-confirm-input"
            className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
          >
            Confirm Recovery Password
          </label>
          <input
            id="recovery-password-confirm-input"
            type="password"
            value={recoveryPasswordConfirm}
            onChange={(e) => {
              setRecoveryPasswordConfirm(e.target.value);
              if (recoveryPasswordResult) setRecoveryPasswordResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSaveRecoveryPassword();
              }
            }}
            placeholder="Re-enter the recovery password…"
            autoComplete="new-password"
            className="w-full h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            data-ocid="admin-recovery-password-confirm-input"
          />
        </div>

        {/* Feedback */}
        {recoveryPasswordResult?.type === "success" && (
          <div
            className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
            data-ocid="admin-recovery.success_state"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{recoveryPasswordResult.message}</span>
          </div>
        )}
        {recoveryPasswordResult?.type === "error" && (
          <div
            className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
            data-ocid="admin-recovery.error_state"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{recoveryPasswordResult.message}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSaveRecoveryPassword}
            disabled={
              !recoveryPassword.trim() ||
              !recoveryPasswordConfirm.trim() ||
              recoveryPasswordLoading ||
              !actor
            }
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono disabled:opacity-40"
            data-ocid="admin-recovery-save-btn"
          >
            {recoveryPasswordLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                Saving…
              </>
            ) : (
              <>
                <Key className="w-4 h-4 mr-2" />
                Save Recovery Password
              </>
            )}
          </Button>
        </div>
      </div>

      {/* ── News Feed Sources Card ─────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
            <Rss className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              News Feed Sources
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Configure the RSS feeds fetched for the NFL News tab. Each source
              must be a valid <span className="font-mono">https://</span> URL.
              Saving clears the backend cache so new sources take effect
              immediately.
            </p>
          </div>
        </div>

        {/* Current sources list */}
        <div className="space-y-2">
          <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Current Sources{" "}
            {rssUrls.length > 0 && (
              <span className="font-mono normal-case tracking-normal">
                ({rssUrls.length})
              </span>
            )}
          </span>
          {rssUrls.length === 0 ? (
            <div
              className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
              data-ocid="admin-rss-empty-state"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>No sources configured. Add one below.</span>
            </div>
          ) : (
            <ul className="space-y-2">
              {rssUrls.map((url, i) => {
                const statusEntry = rssFetchStatus.find(
                  ([feedUrl]) => feedUrl === url,
                );
                const succeeded = statusEntry?.[1];
                return (
                  <li
                    key={`rss-url-${url}`}
                    className="flex items-center gap-2"
                    data-ocid={`admin-rss-item.${i + 1}`}
                  >
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => handleEditRssUrl(i, e.target.value)}
                      className="flex-1 min-w-0 h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
                      aria-label={`RSS source ${i + 1}`}
                      data-ocid={`admin-rss-input.${i + 1}`}
                    />
                    {succeeded === true ? (
                      <span
                        className="flex items-center justify-center w-9 h-9 shrink-0 rounded-md bg-emerald-500/10 border border-emerald-500/30"
                        title="Last fetch succeeded"
                        aria-label={`Source ${i + 1}: last fetch succeeded`}
                        data-ocid={`admin-rss-status-success.${i + 1}`}
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      </span>
                    ) : succeeded === false ? (
                      <span
                        className="flex items-center justify-center w-9 h-9 shrink-0 rounded-md bg-red-500/10 border border-red-500/30"
                        title="Last fetch failed"
                        aria-label={`Source ${i + 1}: last fetch failed`}
                        data-ocid={`admin-rss-status-failed.${i + 1}`}
                      >
                        <XCircle className="w-4 h-4 text-red-400" />
                      </span>
                    ) : (
                      <span
                        className="flex items-center justify-center w-9 h-9 shrink-0 rounded-md bg-muted/40 border border-border"
                        title="No fetch status available"
                        aria-label={`Source ${i + 1}: no fetch status`}
                        data-ocid={`admin-rss-status-unknown.${i + 1}`}
                      >
                        <Minus className="w-4 h-4 text-muted-foreground" />
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRemoveRssUrl(i)}
                      className="h-9 px-2 border-destructive/40 text-destructive hover:bg-destructive/10 shrink-0"
                      aria-label={`Remove source ${i + 1}`}
                      data-ocid={`admin-rss-remove-btn.${i + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Add source */}
        <div className="space-y-2">
          <label
            htmlFor="rss-add-input"
            className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
          >
            Add Source
          </label>
          <div className="flex items-center gap-2">
            <input
              id="rss-add-input"
              type="url"
              value={newRssUrl}
              onChange={(e) => {
                setNewRssUrl(e.target.value);
                if (newRssUrlError) setNewRssUrlError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddRssUrl();
                }
              }}
              placeholder="https://example.com/feed.xml"
              className="flex-1 min-w-0 h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
              data-ocid="admin-rss-add-input"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddRssUrl}
              disabled={!newRssUrl.trim()}
              className="h-9 shrink-0 disabled:opacity-40"
              data-ocid="admin-rss-add-btn"
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              Add
            </Button>
          </div>
          {newRssUrlError && (
            <p
              className="text-xs text-destructive"
              data-ocid="admin-rss-add.field_error"
            >
              {newRssUrlError}
            </p>
          )}
        </div>

        {/* Feedback */}
        {rssUrlsResult?.type === "success" && (
          <div
            className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
            data-ocid="admin-rss-save.success_state"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{rssUrlsResult.message}</span>
          </div>
        )}
        {rssUrlsResult?.type === "error" && (
          <div
            className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
            data-ocid="admin-rss-save.error_state"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{rssUrlsResult.message}</span>
          </div>
        )}

        {/* Save sources */}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSaveRssUrls}
            disabled={rssUrlsLoading || !actor}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono disabled:opacity-40"
            data-ocid="admin-rss-save-btn"
          >
            {rssUrlsLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                Saving…
              </>
            ) : (
              <>Save Sources</>
            )}
          </Button>
        </div>

        {/* Refresh interval */}
        <div
          className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-3"
          data-ocid="admin-rss-interval-section"
        >
          <div className="flex items-start gap-2.5">
            <Clock className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-foreground">
                Refresh Interval
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                How often the backend re-fetches RSS feeds. Minimum{" "}
                {MIN_REFRESH_MINUTES} minute{MIN_REFRESH_MINUTES !== 1 && "s"}{" "}
                to match the backend floor of 60 seconds.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label
              htmlFor="rss-refresh-input"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider shrink-0"
            >
              Minutes
            </label>
            <input
              id="rss-refresh-input"
              type="number"
              min={MIN_REFRESH_MINUTES}
              step={1}
              value={refreshMinutes}
              onChange={(e) => {
                setRefreshMinutes(e.target.value);
                if (refreshIntervalResult) setRefreshIntervalResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveRefreshInterval();
                }
              }}
              placeholder="15"
              className="w-28 h-9 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
              data-ocid="admin-rss-interval-input"
            />
            <Button
              onClick={handleSaveRefreshInterval}
              disabled={
                refreshIntervalLoading || !actor || !refreshMinutes.trim()
              }
              variant="outline"
              className="h-9 font-mono disabled:opacity-40"
              data-ocid="admin-rss-interval-save-btn"
            >
              {refreshIntervalLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin mr-2" />
                  Saving…
                </>
              ) : (
                <>Save Interval</>
              )}
            </Button>
          </div>
          {refreshIntervalResult?.type === "success" && (
            <div
              className="flex items-center gap-2.5 p-2.5 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
              data-ocid="admin-rss-interval.success_state"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{refreshIntervalResult.message}</span>
            </div>
          )}
          {refreshIntervalResult?.type === "error" && (
            <div
              className="flex items-start gap-2.5 p-2.5 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
              data-ocid="admin-rss-interval.error_state"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-all">{refreshIntervalResult.message}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── ADP Dataset Card ────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-6">
        {/* Section heading */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/15 border border-accent/40 flex items-center justify-center shrink-0 mt-0.5">
            <TrendingUp className="w-4 h-4 text-accent-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">ADP Datasets</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Upload CSV or JSON files to enrich player rankings with Average
              Draft Position data. Separate datasets for all players and rookies
              allow rooms to use the most relevant rankings.
            </p>
          </div>
        </div>

        {/* All Players ADP */}
        <div
          className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-3"
          data-ocid="adp-all-section"
        >
          <AdpSection
            title="All Players ADP"
            datasetKey="all"
            state={allAdp}
            fileInputRef={allFileInputRef}
            onFileChange={handleFileChange("all")}
            onUpload={handleUpload("all")}
            onRefresh={() => loadDataset("all")}
            onRemove={handleRemove("all")}
            onToggleErrors={() =>
              setAllAdp((s) => ({ ...s, errorsExpanded: !s.errorsExpanded }))
            }
          />
        </div>

        {/* Rookies ADP */}
        <div
          className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-3"
          data-ocid="adp-rookies-section"
        >
          <AdpSection
            title="Rookies ADP"
            subtitle="Used automatically for rooms with Rookie ADP enabled"
            datasetKey="rookies"
            state={rookiesAdp}
            fileInputRef={rookiesFileInputRef}
            onFileChange={handleFileChange("rookies")}
            onUpload={handleUpload("rookies")}
            onRefresh={() => loadDataset("rookies")}
            onRemove={handleRemove("rookies")}
            onToggleErrors={() =>
              setRookiesAdp((s) => ({
                ...s,
                errorsExpanded: !s.errorsExpanded,
              }))
            }
          />
        </div>
      </div>

      {/* ── Bye Weeks Card ─────────────────────────────────────────────── */}
      <div
        className="rounded-xl border border-border bg-card p-5 space-y-4"
        data-ocid="admin-byeweeks-section"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
            <CalendarDays className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground mb-1">Bye Weeks</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Map each NFL team abbreviation to its bye week (1-18). Used by the
              backend to assign bye weeks to imported players and power the
              bye-week collision warning during nominations.
            </p>
          </div>
        </div>

        {/* Current bye weeks list */}
        <div className="space-y-2">
          <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Current Bye Weeks{" "}
            {byeWeeks.length > 0 && (
              <span className="font-mono normal-case tracking-normal">
                ({byeWeeks.length})
              </span>
            )}
          </span>
          {byeWeeksLoading ? (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground">
              <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              Loading bye weeks…
            </div>
          ) : byeWeeks.length === 0 ? (
            <div
              className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border text-sm text-muted-foreground"
              data-ocid="admin-byeweeks-empty-state"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                No bye weeks configured. Add rows below or import a file.
              </span>
            </div>
          ) : (
            <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {byeWeeks.map((row, i) => {
                const valid = isByeWeekRowValid(row);
                return (
                  <li
                    key={`byeweek-${row[0]}-${row[1]}-${i}`}
                    className={`flex items-center gap-2 p-2 rounded-lg border ${
                      valid
                        ? "border-transparent bg-muted/30"
                        : "border-destructive/50 bg-destructive/5"
                    }`}
                    data-ocid={`admin-byeweeks-item.${i + 1}`}
                  >
                    <input
                      type="text"
                      value={row[0]}
                      onChange={(e) =>
                        handleEditByeWeekTeam(i, e.target.value.toUpperCase())
                      }
                      placeholder="ARI"
                      maxLength={4}
                      className="flex-1 min-w-0 h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono uppercase"
                      aria-label={`Bye week team ${i + 1}`}
                      data-ocid={`admin-byeweeks-team-input.${i + 1}`}
                    />
                    <input
                      type="number"
                      min={1}
                      max={18}
                      step={1}
                      value={row[1]}
                      onChange={(e) => handleEditByeWeek(i, e.target.value)}
                      placeholder="8"
                      className="w-20 h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono text-center"
                      aria-label={`Bye week number ${i + 1}`}
                      data-ocid={`admin-byeweeks-bye-input.${i + 1}`}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRemoveByeWeek(i)}
                      className="h-9 px-2 border-destructive/40 text-destructive hover:bg-destructive/10 shrink-0"
                      aria-label={`Remove bye week row ${i + 1}`}
                      data-ocid={`admin-byeweeks-remove-btn.${i + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Add bye week row */}
        <div className="space-y-2">
          <label
            htmlFor="byeweeks-add-btn"
            className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
          >
            Add Bye Week
          </label>
          <Button
            id="byeweeks-add-btn"
            variant="outline"
            size="sm"
            onClick={handleAddByeWeek}
            disabled={!actor}
            className="h-9 shrink-0 disabled:opacity-40"
            data-ocid="admin-byeweeks-add-btn"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add Row
          </Button>
        </div>

        {/* File import */}
        <div className="space-y-2">
          <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Import from File
          </span>
          <input
            ref={byeWeekFileInputRef}
            type="file"
            accept=".json,.csv"
            onChange={handleByeWeekFileChange}
            className="hidden"
            data-ocid="admin-byeweeks-file-input"
            aria-label="Import bye weeks from JSON or CSV file"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => byeWeekFileInputRef.current?.click()}
            disabled={!actor}
            className="h-9 shrink-0 disabled:opacity-40"
            data-ocid="admin-byeweeks-upload-btn"
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            Choose File (.json / .csv)
          </Button>
          <p className="text-xs text-muted-foreground/70 leading-relaxed">
            <span className="font-semibold text-muted-foreground">JSON:</span>{" "}
            array of objects{" "}
            <span className="font-mono">
              [&#123;"team":"ARI","bye":8&#125;]
            </span>{" "}
            or a flat map{" "}
            <span className="font-mono">&#123;"ARI":8,"ATL":5&#125;</span>.{" "}
            <span className="font-semibold text-muted-foreground">CSV:</span>{" "}
            two columns with a header row{" "}
            <span className="font-mono">team,bye</span> — e.g.{" "}
            <span className="font-mono">ARI,8</span>.
          </p>
        </div>

        {/* Feedback */}
        {byeWeeksResult?.type === "success" && (
          <div
            className="flex items-center gap-2.5 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
            data-ocid="admin-byeweeks-save.success_state"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{byeWeeksResult.message}</span>
          </div>
        )}
        {byeWeeksResult?.type === "error" && (
          <div
            className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
            data-ocid="admin-byeweeks-save.error_state"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{byeWeeksResult.message}</span>
          </div>
        )}

        {/* Save bye weeks */}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSaveByeWeeks}
            disabled={byeWeeksSaving || !actor}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono disabled:opacity-40"
            data-ocid="admin-byeweeks-save-btn"
          >
            {byeWeeksSaving ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                Saving…
              </>
            ) : (
              <>Save Bye Weeks</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
