import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@tanstack/react-router";
import {
  Clock,
  Filter,
  Globe,
  Loader2,
  Lock,
  Settings2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useIsMobile } from "../hooks/use-mobile";
import { useBackend } from "../hooks/useBackend";
import type { AuctionSettings, RosterSettings } from "../types";

const POSITIONS = [
  {
    value: "QB",
    label: "QB",
    color: "text-blue-400",
    border: "border-blue-400/60",
    bg: "bg-blue-400/10",
  },
  {
    value: "RB",
    label: "RB",
    color: "text-green-400",
    border: "border-green-400/60",
    bg: "bg-green-400/10",
  },
  {
    value: "WR",
    label: "WR",
    color: "text-purple-400",
    border: "border-purple-400/60",
    bg: "bg-purple-400/10",
  },
  {
    value: "TE",
    label: "TE",
    color: "text-orange-400",
    border: "border-orange-400/60",
    bg: "bg-orange-400/10",
  },
] as const;

type PositionValue = "QB" | "RB" | "WR" | "TE";
type FilterType = "all" | "rookies" | "veterans";

interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateRoomDialog({
  open,
  onOpenChange,
}: CreateRoomDialogProps) {
  const router = useRouter();
  const { actor } = useBackend();
  const isMobile = useIsMobile();

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [budget, setBudget] = useState(200);
  const [nomTimerHours, setNomTimerHours] = useState(0);
  const [nomTimerMinutes, setNomTimerMinutes] = useState(1);
  const [bidTimerHours, setBidTimerHours] = useState(0);
  const [bidTimerMinutes, setBidTimerMinutes] = useState(1);
  const [bidIncrement, setBidIncrement] = useState(1);
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [maxParticipants, setMaxParticipants] = useState(10);
  const [rosterCapEnabled, setRosterCapEnabled] = useState(false);
  const [maxRosterSize, setMaxRosterSize] = useState(10);

  // Roster Configuration state
  const [rosterConfig, setRosterConfig] = useState({
    qb: 1,
    rb: 2,
    wr: 2,
    te: 1,
    flex: 1,
    superflex: 0,
    bench: 6,
  });
  const [flexPositions, setFlexPositions] = useState<string[]>([
    "RB",
    "WR",
    "TE",
  ]);
  const [superflexPositions, setSuperflexPositions] = useState<string[]>([
    "QB",
    "RB",
    "WR",
    "TE",
  ]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(true);
  const [password, setPassword] = useState("");
  const [isPending, setIsPending] = useState(false);

  const nonBenchTotal =
    rosterConfig.qb +
    rosterConfig.rb +
    rosterConfig.wr +
    rosterConfig.te +
    rosterConfig.flex +
    rosterConfig.superflex;
  const lineupTotal = nonBenchTotal + rosterConfig.bench;

  // Player Pool Settings
  const [selectedPositions, setSelectedPositions] = useState<PositionValue[]>([
    "QB",
    "RB",
    "WR",
    "TE",
  ]);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [positionError, setPositionError] = useState<string | null>(null);

  const nomTimerSecs = nomTimerHours * 3600 + nomTimerMinutes * 60;
  const nomTimerValid = nomTimerSecs >= 60;
  const bidTimerSecs = bidTimerHours * 3600 + bidTimerMinutes * 60;
  const bidTimerValid = bidTimerSecs >= 60;

  function togglePosition(pos: PositionValue) {
    setPositionError(null);
    setSelectedPositions((prev) =>
      prev.includes(pos) ? prev.filter((p) => p !== pos) : [...prev, pos],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!actor) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Room name is required.");
      return;
    }
    if (!bidTimerValid) {
      toast.error("Bid timer must be at least 1 minute.");
      return;
    }
    if (!nomTimerValid) {
      toast.error("Nomination timer must be at least 1 minute.");
      return;
    }
    if (!isPublic && !password.trim()) {
      setNameError("A password is required for private rooms.");
      return;
    }
    if (selectedPositions.length === 0) {
      setPositionError("At least one position must be selected.");
      return;
    }

    // Check name uniqueness before submitting
    setIsPending(true);
    setNameError(null);
    setPositionError(null);
    try {
      const existingRooms = await actor.getRooms();
      const duplicate = existingRooms.some(
        (r) => r.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (duplicate) {
        setNameError(
          "Room name is already taken. Please choose a different name.",
        );
        setIsPending(false);
        return;
      }
    } catch {
      // Non-fatal: proceed to creation; backend will also enforce uniqueness
    }

    try {
      const settings: AuctionSettings = {
        nomTimerSecs: BigInt(nomTimerSecs),
        bidTimerSecs: BigInt(bidTimerSecs),
        minBidIncrement: BigInt(bidIncrement),
        maxActivePicks: BigInt(maxConcurrent),
        maxParticipants: BigInt(maxParticipants),
        adpDataset: filterType === "rookies" ? "rookies" : "all",
      };

      const playerFilter: { positions: string[]; filterType: string } | null = {
        positions: selectedPositions,
        filterType,
      };

      const rosterSettings: RosterSettings | null = rosterCapEnabled
        ? {
            qb: BigInt(rosterConfig.qb),
            rb: BigInt(rosterConfig.rb),
            wr: BigInt(rosterConfig.wr),
            te: BigInt(rosterConfig.te),
            flex: BigInt(rosterConfig.flex),
            superflex: BigInt(rosterConfig.superflex),
            bench: BigInt(rosterConfig.bench),
            flexPositions,
            superflexPositions,
          }
        : null;

      const result = await actor.createRoom(
        trimmedName,
        BigInt(budget),
        settings,
        isPublic,
        isPublic ? null : password.trim(),
        playerFilter,
        rosterCapEnabled ? BigInt(maxRosterSize) : null,
        rosterSettings,
        null,
        "redraft",
        2026n,
        { __kind__: "halfPpr", halfPpr: null },
      );

      if (result.__kind__ === "err") {
        const errMsg = result.err as string;
        if (
          errMsg.toLowerCase().includes("already") ||
          errMsg.toLowerCase().includes("taken") ||
          errMsg.toLowerCase().includes("name")
        ) {
          setNameError(
            "Room name is already taken. Please choose a different name.",
          );
        } else {
          toast.error(`Failed to create room: ${errMsg}`);
        }
        return;
      }
      const roomId = result.ok;
      toast.success(`Room "${trimmedName}" created!`);
      onOpenChange(false);
      router.navigate({ to: "/room/$roomId", params: { roomId } });
    } catch {
      toast.error("Unexpected error creating room.");
    } finally {
      setIsPending(false);
    }
  }

  function handleClose(open: boolean) {
    if (!isPending) {
      onOpenChange(open);
      if (!open) {
        setNameError(null);
        setPositionError(null);
        setPassword("");
      }
    }
  }

  const formContent = (
    <form
      onSubmit={handleSubmit}
      className="space-y-6 px-4 pb-6 pt-2 overflow-y-auto"
    >
      {/* Room details */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="room-name" className="text-foreground text-sm">
            Room Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="room-name"
            placeholder="e.g. The Arena"
            maxLength={40}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            className="bg-background border-input focus:border-primary focus:ring-primary/30 text-foreground"
            data-ocid="create-room-name-input"
            required
          />
          <div className="flex items-center justify-between">
            {nameError ? (
              <p
                className="text-[11px] text-destructive"
                role="alert"
                data-ocid="create-room-name-error"
              >
                {nameError}
              </p>
            ) : (
              <span />
            )}
            <p className="text-[11px] text-muted-foreground text-right">
              {name.length}/40
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="starting-budget"
              className="text-foreground text-sm"
            >
              Starting Budget ($)
            </Label>
            <Input
              id="starting-budget"
              type="number"
              min={10}
              max={10000}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              className="bg-background border-input focus:border-primary text-foreground"
              data-ocid="create-room-budget-input"
            />
          </div>

          {/* Max Participants */}
          <div className="space-y-1.5">
            <Label
              htmlFor="max-participants"
              className="text-foreground text-sm flex items-center gap-1.5"
            >
              <Users className="w-3.5 h-3.5 text-primary" />
              Max Participants
            </Label>
            <select
              id="max-participants"
              value={maxParticipants}
              onChange={(e) => setMaxParticipants(Number(e.target.value))}
              className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              data-ocid="create-room-max-participants-input"
            >
              {[8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => (
                <option key={n} value={n}>
                  {n} players
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">8 – 16 players</p>
          </div>
        </div>

        {/* Public / Private toggle */}
        <div className="flex items-center justify-between p-3 bg-muted/20 border border-border/50 rounded-lg">
          <div className="flex items-center gap-2">
            {isPublic ? (
              <Globe className="w-4 h-4 text-primary" />
            ) : (
              <Lock className="w-4 h-4 text-muted-foreground" />
            )}
            <div>
              <p className="text-sm font-medium text-foreground">
                {isPublic ? "Public room" : "Private room"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {isPublic
                  ? "Visible in the public lobby"
                  : "Join by password only"}
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isPublic}
            onClick={() => {
              setIsPublic((v) => !v);
              setNameError(null);
              setPassword("");
            }}
            className={`relative w-10 h-5.5 rounded-full border-2 transition-smooth shrink-0 ${
              isPublic ? "bg-primary border-primary" : "bg-muted border-border"
            }`}
            data-ocid="create-room-public-toggle"
          >
            <span
              className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-card transition-transform duration-200 ${
                isPublic ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* Password field — only for private rooms */}
        {!isPublic && (
          <div className="space-y-1.5">
            <Label
              htmlFor="room-password"
              className="text-foreground text-sm flex items-center gap-1.5"
            >
              <Lock className="w-3.5 h-3.5 text-muted-foreground" />
              Room Password <span className="text-destructive">*</span>
            </Label>
            <Input
              id="room-password"
              type="text"
              placeholder="Set a password for this private room"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-background border-input focus:border-primary text-foreground font-mono"
              data-ocid="create-room-password-input"
              required={!isPublic}
              maxLength={64}
            />
            <p className="text-[11px] text-muted-foreground">
              Other users will use this password to find and join your room.
            </p>
          </div>
        )}
      </div>

      {/* Auction settings */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Settings2 className="w-3.5 h-3.5" />
          Auction Settings
        </div>

        {/* Timers subsection */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Timers
          </p>

          {/* Nom Timer */}
          <div className="p-3 bg-muted/20 border border-border/50 rounded-lg space-y-2">
            <div className="flex items-center gap-1.5">
              <Clock className="w-3 h-3 text-primary" />
              <Label className="text-xs font-mono uppercase tracking-wider text-primary">
                Nom Timer
              </Label>
              {!nomTimerValid && (
                <span className="text-[10px] text-destructive font-mono ml-auto">
                  min 1 min
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={nomTimerHours}
                  onChange={(e) =>
                    setNomTimerHours(
                      Math.max(0, Math.min(23, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-8 w-16 font-mono text-xs text-center bg-background border-input focus:border-primary text-foreground"
                  data-ocid="create-room-nom-timer-hours-input"
                />
                <span className="text-xs text-muted-foreground font-mono">
                  hr
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={nomTimerMinutes}
                  onChange={(e) =>
                    setNomTimerMinutes(
                      Math.max(0, Math.min(59, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-8 w-16 font-mono text-xs text-center bg-background border-input focus:border-primary text-foreground"
                  data-ocid="create-room-nom-timer-minutes-input"
                />
                <span className="text-xs text-muted-foreground font-mono">
                  min
                </span>
              </div>
              <span className="text-[11px] text-muted-foreground/60 font-mono ml-auto">
                = {nomTimerSecs}s
              </span>
            </div>
          </div>

          {/* Bid Timer */}
          <div className="p-3 bg-muted/20 border border-border/50 rounded-lg space-y-2">
            <div className="flex items-center gap-1.5">
              <Clock className="w-3 h-3 text-primary" />
              <Label className="text-xs font-mono uppercase tracking-wider text-primary">
                Bid Timer
              </Label>
              {!bidTimerValid && (
                <span className="text-[10px] text-destructive font-mono ml-auto">
                  min 1 min
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={bidTimerHours}
                  onChange={(e) =>
                    setBidTimerHours(
                      Math.max(0, Math.min(23, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-8 w-16 font-mono text-xs text-center bg-background border-input focus:border-primary text-foreground"
                  data-ocid="create-room-bid-timer-hours-input"
                />
                <span className="text-xs text-muted-foreground font-mono">
                  hr
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={bidTimerMinutes}
                  onChange={(e) =>
                    setBidTimerMinutes(
                      Math.max(0, Math.min(59, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-8 w-16 font-mono text-xs text-center bg-background border-input focus:border-primary text-foreground"
                  data-ocid="create-room-bid-timer-minutes-input"
                />
                <span className="text-xs text-muted-foreground font-mono">
                  min
                </span>
              </div>
              <span className="text-[11px] text-muted-foreground/60 font-mono ml-auto">
                = {bidTimerSecs}s
              </span>
            </div>
          </div>
        </div>

        {/* Limits subsection */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Limits
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-foreground text-xs">
                Bid Increment ($)
              </Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={bidIncrement}
                onChange={(e) => setBidIncrement(Number(e.target.value))}
                className="bg-background border-input focus:border-primary text-foreground text-sm"
                data-ocid="create-room-bid-increment-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-foreground text-xs">Max Concurrent</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                className="bg-background border-input focus:border-primary text-foreground text-sm"
                data-ocid="create-room-max-concurrent-input"
              />
            </div>
          </div>

          {/* Roster cap toggle */}
          <div className="flex items-center justify-between p-3 bg-muted/20 border border-border/50 rounded-lg">
            <div>
              <p className="text-sm font-medium text-foreground">
                Enable roster cap
              </p>
              <p className="text-[11px] text-muted-foreground">
                Limit players each team can win
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={rosterCapEnabled}
              onClick={() => setRosterCapEnabled((v) => !v)}
              className={`relative w-10 h-5.5 rounded-full border-2 transition-smooth shrink-0 ${
                rosterCapEnabled
                  ? "bg-primary border-primary"
                  : "bg-muted border-border"
              }`}
              data-ocid="create-room-roster-cap-toggle"
            >
              <span
                className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-card transition-transform duration-200 ${
                  rosterCapEnabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {rosterCapEnabled && (
            <>
              <div className="space-y-1.5">
                <Label className="text-foreground text-xs">
                  Max Roster Size
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={maxRosterSize}
                  onChange={(e) => {
                    const newMax = Math.max(1, Number(e.target.value) || 1);
                    const newNonBench =
                      rosterConfig.qb +
                      rosterConfig.rb +
                      rosterConfig.wr +
                      rosterConfig.te +
                      rosterConfig.flex +
                      rosterConfig.superflex;
                    const newBench = newMax - newNonBench;
                    if (newBench < 0) {
                      setRosterError(
                        "Roster size cannot be smaller than your configured starter slots.",
                      );
                      return;
                    }
                    setRosterError(null);
                    setMaxRosterSize(newMax);
                    setRosterConfig((prev) => ({ ...prev, bench: newBench }));
                  }}
                  className="bg-background border-input focus:border-primary text-foreground text-sm"
                  data-ocid="create-room-max-roster-size-input"
                />
                <p className="text-[11px] text-muted-foreground">
                  Players per team (minimum 1)
                </p>
              </div>

              {/* Roster Configuration */}
              <div className="rounded-lg border border-border/40 bg-card/50 p-3 space-y-3">
                <p className="text-[11px] text-muted-foreground">
                  Configure lineup requirements for this league. These settings
                  power future roster-aware auction features.
                </p>

                {/* Position counts grid */}
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {[
                    { key: "qb", label: "QB", defaultValue: 1 },
                    { key: "rb", label: "RB", defaultValue: 2 },
                    { key: "wr", label: "WR", defaultValue: 2 },
                    { key: "te", label: "TE", defaultValue: 1 },
                    { key: "flex", label: "FLEX", defaultValue: 1 },
                    { key: "superflex", label: "SUPERFLEX", defaultValue: 0 },
                    { key: "bench", label: "Bench", defaultValue: 6 },
                  ].map((pos) => (
                    <div key={pos.key} className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        {pos.label}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        step={1}
                        readOnly={pos.key === "bench"}
                        value={
                          rosterConfig[pos.key as keyof typeof rosterConfig]
                        }
                        onChange={(e) => {
                          if (pos.key === "bench") return;
                          const val = Math.max(
                            0,
                            Math.min(20, Number(e.target.value) || 0),
                          );
                          const newNonBench =
                            (pos.key === "qb" ? val : rosterConfig.qb) +
                            (pos.key === "rb" ? val : rosterConfig.rb) +
                            (pos.key === "wr" ? val : rosterConfig.wr) +
                            (pos.key === "te" ? val : rosterConfig.te) +
                            (pos.key === "flex" ? val : rosterConfig.flex) +
                            (pos.key === "superflex"
                              ? val
                              : rosterConfig.superflex);
                          const newBench = maxRosterSize - newNonBench;
                          if (newBench < 0) {
                            setRosterError(
                              "Lineup slots exceed roster size. Increase roster size or reduce another position first.",
                            );
                            return;
                          }
                          setRosterError(null);
                          setRosterConfig((prev) => ({
                            ...prev,
                            [pos.key]: val,
                            bench: newBench,
                          }));
                        }}
                        className={`h-8 text-sm text-center bg-background border-input focus:border-primary text-foreground font-semibold ${
                          pos.key === "bench"
                            ? "opacity-70 cursor-not-allowed"
                            : ""
                        }`}
                      />
                      {pos.key === "bench" && (
                        <p className="text-[9px] text-muted-foreground/60 text-center">
                          (auto)
                        </p>
                      )}
                    </div>
                  ))}
                </div>

                {/* FLEX eligibility */}
                <div
                  className={`space-y-1.5 ${rosterConfig.flex === 0 ? "opacity-50" : ""}`}
                >
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    FLEX Eligible Positions
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {["RB", "WR", "TE"].map((pos) => {
                      const checked = flexPositions.includes(pos);
                      return (
                        <button
                          key={pos}
                          type="button"
                          disabled={rosterConfig.flex === 0}
                          onClick={() =>
                            setFlexPositions((prev) =>
                              prev.includes(pos)
                                ? prev.filter((p) => p !== pos)
                                : [...prev, pos],
                            )
                          }
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                            checked
                              ? "bg-primary/20 border-primary/40 text-primary"
                              : "bg-transparent border-border/40 text-muted-foreground hover:border-border"
                          } ${rosterConfig.flex === 0 ? "cursor-not-allowed" : ""}`}
                        >
                          {pos}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* SUPERFLEX eligibility */}
                <div
                  className={`space-y-1.5 ${rosterConfig.superflex === 0 ? "opacity-50" : ""}`}
                >
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    SUPERFLEX Eligible Positions
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {["QB", "RB", "WR", "TE"].map((pos) => {
                      const checked = superflexPositions.includes(pos);
                      return (
                        <button
                          key={pos}
                          type="button"
                          disabled={rosterConfig.superflex === 0}
                          onClick={() =>
                            setSuperflexPositions((prev) =>
                              prev.includes(pos)
                                ? prev.filter((p) => p !== pos)
                                : [...prev, pos],
                            )
                          }
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                            checked
                              ? "bg-primary/20 border-primary/40 text-primary"
                              : "bg-transparent border-border/40 text-muted-foreground hover:border-border"
                          } ${rosterConfig.superflex === 0 ? "cursor-not-allowed" : ""}`}
                        >
                          {pos}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Live summary line */}
                <p
                  className={`text-xs font-medium ${
                    lineupTotal === maxRosterSize
                      ? "text-emerald-400"
                      : lineupTotal > maxRosterSize
                        ? "text-red-400"
                        : "text-amber-400"
                  }`}
                >
                  Total slots: {lineupTotal} / {maxRosterSize} —{" "}
                  {rosterConfig.bench} bench spots
                </p>

                {rosterError && (
                  <p
                    className="text-[11px] text-destructive"
                    role="alert"
                    data-ocid="create-room-roster-error"
                  >
                    {rosterError}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Player Pool Settings */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Filter className="w-3.5 h-3.5" />
          Player Pool Settings
        </div>

        {/* Position checkboxes */}
        <div className="space-y-1.5">
          <Label className="text-foreground text-xs">Positions</Label>
          <div className="flex flex-wrap gap-2">
            {POSITIONS.map((pos) => {
              const checked = selectedPositions.includes(pos.value);
              const checkboxId = `pos-${pos.value}`;
              return (
                <label
                  key={pos.value}
                  htmlFor={checkboxId}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-semibold cursor-pointer transition-colors duration-150 ${
                    checked
                      ? `${pos.bg} ${pos.border} ${pos.color}`
                      : "bg-transparent border-border/40 text-muted-foreground hover:border-border"
                  }`}
                  data-ocid={`create-room-position-${pos.value.toLowerCase()}`}
                >
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePosition(pos.value)}
                    className="sr-only"
                  />
                  <span
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                      checked ? `${pos.border} ${pos.bg}` : "border-border/50"
                    }`}
                    aria-hidden="true"
                  >
                    {checked && (
                      <svg
                        viewBox="0 0 10 8"
                        className={`w-2.5 h-2 ${pos.color}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      >
                        <path
                          d="M1 4l3 3 5-6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>
                  <span className={checked ? pos.color : ""}>{pos.label}</span>
                </label>
              );
            })}
          </div>
          {positionError && (
            <p
              className="text-[11px] text-destructive"
              role="alert"
              data-ocid="create-room-position-error"
            >
              {positionError}
            </p>
          )}
        </div>

        {/* Player Type dropdown */}
        <div className="space-y-1.5">
          <Label htmlFor="player-type" className="text-foreground text-xs">
            Player Type
          </Label>
          <select
            id="player-type"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as FilterType)}
            className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            data-ocid="create-room-player-type-select"
          >
            <option value="all">All Players</option>
            <option value="rookies">Rookies Only</option>
            <option value="veterans">Veterans Only</option>
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={isPending}
          className="border-border text-muted-foreground hover:text-foreground"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            isPending ||
            !name.trim() ||
            !bidTimerValid ||
            !nomTimerValid ||
            (!isPublic && !password.trim()) ||
            (rosterCapEnabled && lineupTotal !== maxRosterSize)
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 min-w-[120px]"
          data-ocid="create-room-submit-btn"
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Creating…
            </>
          ) : (
            "Create Room"
          )}
        </Button>
        {rosterCapEnabled && lineupTotal !== maxRosterSize && (
          <p
            className="text-[11px] text-destructive text-right"
            role="alert"
            data-ocid="create-room-roster-submit-error"
          >
            Lineup configuration must match roster size before creating the
            room.
          </p>
        )}
      </div>
    </form>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleClose}>
        <DrawerContent
          className="bg-card border-t border-border max-h-[92vh]"
          data-ocid="create-room-dialog"
        >
          <DrawerHeader className="px-4 pt-4 pb-0">
            <DrawerTitle className="font-display flex items-center gap-2 text-foreground">
              Create Auction Room
            </DrawerTitle>
          </DrawerHeader>
          {formContent}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="bg-card border border-border max-w-md overflow-y-auto max-h-[90vh]"
        data-ocid="create-room-dialog"
      >
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2 text-foreground">
            Create Auction Room
          </DialogTitle>
        </DialogHeader>
        {formContent}
      </DialogContent>
    </Dialog>
  );
}

export default CreateRoomDialog;
