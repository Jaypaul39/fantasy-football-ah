import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Principal } from "@icp-sdk/core/principal";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  Clock,
  Copy,
  Loader2,
  Lock,
  Pause,
  Play,
  Shuffle,
  Square,
  Trash2,
  Trophy,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useBackend } from "../hooks/useBackend";
import { useSendMessage } from "../hooks/useRoomPolling";
import {
  type AuctionSettings,
  AuctionState,
  GameType,
  type ParticipantView,
  type RoomId,
  type UserId,
} from "../types";

interface HostControlsProps {
  roomId: RoomId;
  state: AuctionState;
  settings?: AuctionSettings;
  participants?: ParticipantView[];
  onRefresh?: () => void;
  /** maxRosterSize from room settings — null means no cap */
  maxRosterSize?: number | null;
}

function secsToHM(secs: bigint): { hours: number; minutes: number } {
  const total = Number(secs);
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Principal ID display (subtle, click-to-copy) ─────────────────────────────

interface PrincipalIdProps {
  userId: UserId;
  /** stable index for deterministic marker */
  index?: number;
  /** marker scope, e.g. "budget" | "remove" | "nom-order" */
  scope: string;
}

function truncatePrincipal(text: string): string {
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}…${text.slice(-5)}`;
}

function PrincipalId({ userId, index, scope }: PrincipalIdProps) {
  const full = userId.toText();
  const marker = `principal.${scope}${
    index !== undefined ? `.${index + 1}` : ""
  }`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      toast.success("Principal ID copied to clipboard.");
    } catch {
      toast.error("Failed to copy principal ID.");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Click to copy: ${full}`}
      aria-label={`Copy principal ID ${full}`}
      className="group inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors shrink-0 max-w-[40%] min-w-0"
      data-ocid={marker}
    >
      <span className="truncate">{truncatePrincipal(full)}</span>
      <Copy className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

interface TimerAdjustProps {
  label: string;
  hours: number;
  minutes: number;
  onHoursChange: (v: number) => void;
  onMinutesChange: (v: number) => void;
}

function TimerAdjust({
  label,
  hours,
  minutes,
  onHoursChange,
  onMinutesChange,
}: TimerAdjustProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1">
          <Input
            type="number"
            min={0}
            max={23}
            value={hours}
            onChange={(e) =>
              onHoursChange(clamp(Number.parseInt(e.target.value) || 0, 0, 23))
            }
            className="h-8 w-16 font-mono text-xs text-center bg-background border-input"
            data-ocid="timer-hours-input"
          />
          <span className="text-xs text-muted-foreground font-mono">hr</span>
        </div>
        <div className="flex items-center gap-1.5 flex-1">
          <Input
            type="number"
            min={0}
            max={59}
            value={minutes}
            onChange={(e) =>
              onMinutesChange(
                clamp(Number.parseInt(e.target.value) || 0, 0, 59),
              )
            }
            className="h-8 w-16 font-mono text-xs text-center bg-background border-input"
            data-ocid="timer-minutes-input"
          />
          <span className="text-xs text-muted-foreground font-mono">min</span>
        </div>
        <span className="text-[11px] text-muted-foreground/60 font-mono w-12 text-right">
          = {hours * 60 + minutes}m
        </span>
      </div>
    </div>
  );
}

// ── Budget edit row ─────────────────────────────────────────────────────────

interface BudgetEditRowProps {
  participant: ParticipantView;
  roomId: RoomId;
  onSuccess: () => void;
}

function BudgetEditRow({ participant, roomId, onSuccess }: BudgetEditRowProps) {
  const { actor } = useBackend();
  const [budgetInput, setBudgetInput] = useState("");
  const [pendingBudget, setPendingBudget] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Read current total budget for display
  const currentBudget = (() => {
    const bv = participant.budgetView;
    if (bv.__kind__ === "private") return Number(bv.private.totalBudget);
    return Number(bv.public.totalBudget);
  })();

  const handleEditClick = () => {
    const parsed = Number(budgetInput);
    if (!budgetInput.trim() || Number.isNaN(parsed) || parsed < 0) {
      toast.error("Enter a valid budget amount.");
      return;
    }
    setPendingBudget(parsed);
    setDialogOpen(true);
  };

  const handleConfirm = async () => {
    if (!actor || pendingBudget === null) return;
    setSaving(true);
    try {
      const result = await (
        actor as unknown as {
          editParticipantBudget: (
            roomId: RoomId,
            userId: UserId,
            budget: bigint,
          ) => Promise<
            { __kind__: "ok"; ok: null } | { __kind__: "err"; err: string }
          >;
        }
      ).editParticipantBudget(
        roomId,
        participant.userId,
        BigInt(pendingBudget),
      );
      if (result.__kind__ === "err") {
        toast.error(`Error: ${result.err}`);
      } else {
        toast.success(`Budget updated to $${pendingBudget}.`);
        setBudgetInput("");
        onSuccess();
      }
    } catch {
      toast.error("Failed to update budget.");
    } finally {
      setSaving(false);
      setDialogOpen(false);
      setPendingBudget(null);
    }
  };

  return (
    <div className="flex items-center gap-2 py-2" data-ocid="budget-edit-row">
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground truncate min-w-0">
          {participant.displayName}
        </span>
        <PrincipalId
          userId={participant.userId}
          scope="budget"
          index={undefined}
        />
      </div>
      <span className="text-xs font-mono text-muted-foreground shrink-0">
        ${currentBudget}
      </span>
      <Input
        type="number"
        min={0}
        value={budgetInput}
        onChange={(e) => setBudgetInput(e.target.value)}
        placeholder="New budget"
        className="h-7 w-24 text-xs font-mono bg-background border-input text-center"
        data-ocid="budget-edit-input"
      />

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            onClick={handleEditClick}
            disabled={saving || !budgetInput.trim()}
            className="h-7 text-xs px-2 border-primary/40 text-primary hover:bg-primary/10"
            data-ocid="budget-edit-update-btn"
          >
            Update
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          className="bg-card border border-border"
          data-ocid="budget-edit-confirm-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-foreground">
              Change Budget?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              Change{" "}
              <span className="font-semibold text-foreground">
                {participant.displayName}
              </span>
              &apos;s budget from{" "}
              <span className="font-mono font-bold text-foreground">
                ${currentBudget}
              </span>{" "}
              to{" "}
              <span className="font-mono font-bold text-primary">
                ${pendingBudget}
              </span>
              ?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-muted-foreground hover:text-foreground">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              data-ocid="budget-edit-confirm-btn"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Confirm Change"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Nomination order reorder ─────────────────────────────────────────────────

interface NominationOrderEditorProps {
  participants: ParticipantView[];
  roomId: RoomId;
  onSuccess: () => void;
}

function NominationOrderEditor({
  participants,
  roomId,
  onSuccess,
}: NominationOrderEditorProps) {
  const { actor } = useBackend();
  const [order, setOrder] = useState<ParticipantView[]>([...participants]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [randomizing, setRandomizing] = useState(false);
  const [randomizedMsg, setRandomizedMsg] = useState(false);

  // Keep order in sync if participants list changes (e.g. user removed)
  useEffect(() => {
    setOrder((prev) => {
      const prevIds = new Set(prev.map((p) => p.userId.toText()));
      const newIds = new Set(participants.map((p) => p.userId.toText()));
      // Remove any departed participants, add new ones at end
      const filtered = prev.filter((p) => newIds.has(p.userId.toText()));
      const added = participants.filter((p) => !prevIds.has(p.userId.toText()));
      return [...filtered, ...added];
    });
  }, [participants]);

  const handleRandomize = async () => {
    if (!actor) return;
    setRandomizing(true);
    try {
      const result = await actor.randomizeNominationOrder(roomId);
      if (result.__kind__ === "err") {
        toast.error(`Error: ${result.err}`);
      } else {
        // Apply the randomized order to local state
        const newOrderIds = result.ok.map((u) => u.toText());
        setOrder((prev) => {
          const map = new Map(prev.map((p) => [p.userId.toText(), p]));
          return newOrderIds
            .map((id) => map.get(id))
            .filter((p): p is ParticipantView => p !== undefined);
        });
        setRandomizedMsg(true);
        setTimeout(() => setRandomizedMsg(false), 2000);
        onSuccess();
      }
    } catch {
      toast.error("Failed to randomize order.");
    } finally {
      setRandomizing(false);
    }
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    setOrder((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveDown = (index: number) => {
    if (index === order.length - 1) return;
    setOrder((prev) => {
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  const handleSaveConfirm = async () => {
    if (!actor) return;
    setSaving(true);
    try {
      const orderedIds = order.map((p) => p.userId);
      const result = await (
        actor as unknown as {
          setNominationOrder: (
            roomId: RoomId,
            orderedUsers: UserId[],
          ) => Promise<
            { __kind__: "ok"; ok: null } | { __kind__: "err"; err: string }
          >;
        }
      ).setNominationOrder(roomId, orderedIds);
      if (result.__kind__ === "err") {
        toast.error(`Error: ${result.err}`);
      } else {
        toast.success("Nomination order saved.");
        onSuccess();
      }
    } catch {
      toast.error("Failed to save order.");
    } finally {
      setSaving(false);
      setDialogOpen(false);
    }
  };

  return (
    <div className="space-y-2" data-ocid="nomination-order-editor">
      <div className="space-y-1">
        {order.map((p, index) => (
          <div
            key={p.userId.toText()}
            className="flex items-center gap-2 py-1.5 px-2 rounded-md bg-muted/20 border border-border/40"
            data-ocid="nomination-order-editor-row"
          >
            <span className="w-5 font-mono text-xs text-muted-foreground font-bold text-center shrink-0">
              {index + 1}
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground truncate min-w-0">
                {p.displayName}
              </span>
              <PrincipalId userId={p.userId} scope="nom-order" index={index} />
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={() => moveUp(index)}
                disabled={index === 0}
                aria-label={`Move ${p.displayName} up`}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                data-ocid="nomination-order-move-up-btn"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => moveDown(index)}
                disabled={index === order.length - 1}
                aria-label={`Move ${p.displayName} down`}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                data-ocid="nomination-order-move-down-btn"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Randomize button */}
      <Button
        size="sm"
        onClick={handleRandomize}
        disabled={randomizing || saving}
        className="w-full bg-muted/40 border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/60 font-mono text-xs mt-1"
        data-ocid="nomination-order-randomize-btn"
      >
        {randomizing ? (
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
        ) : (
          <Shuffle className="w-3.5 h-3.5 mr-1.5" />
        )}
        Randomize Order
      </Button>

      {randomizedMsg && (
        <p className="text-[11px] text-primary font-mono text-center animate-in fade-in duration-200">
          Order randomized!
        </p>
      )}

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            className="w-full bg-primary/20 border border-primary/50 text-primary hover:bg-primary/30 font-mono text-xs mt-1"
            data-ocid="nomination-order-save-btn"
          >
            Save Order
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          className="bg-card border border-border"
          data-ocid="nomination-order-confirm-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-foreground">
              Save Nomination Order?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This will update the nomination order for all participants. The
              new order will take effect immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-muted-foreground hover:text-foreground">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSaveConfirm}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              data-ocid="nomination-order-confirm-btn"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Save Order"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Remove user button ───────────────────────────────────────────────────────

interface RemoveUserButtonProps {
  participant: ParticipantView;
  roomId: RoomId;
  onSuccess: () => void;
}

function RemoveUserButton({
  participant,
  roomId,
  onSuccess,
}: RemoveUserButtonProps) {
  const { actor } = useBackend();
  const [removing, setRemoving] = useState(false);

  const handleConfirm = async () => {
    if (!actor) return;
    setRemoving(true);
    try {
      const result = await actor.removeUserFromRoom(roomId, participant.userId);
      if (result.__kind__ === "err") {
        toast.error(`Error: ${result.err}`);
      } else {
        toast.success(`${participant.displayName} removed from room.`);
        onSuccess();
      }
    } catch {
      toast.error("Failed to remove user.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          aria-label={`Remove ${participant.displayName}`}
          className="p-1 rounded text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors"
          data-ocid="remove-user-btn"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent
        className="bg-card border border-border"
        data-ocid="remove-user-confirm-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-foreground">
            Remove Participant?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-muted-foreground">
            Remove{" "}
            <span className="font-semibold text-foreground">
              {participant.displayName}
            </span>{" "}
            from the auction? This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-border text-muted-foreground hover:text-foreground">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={removing}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-ocid="remove-user-confirm-btn"
          >
            {removing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Transfer participant identity ─────────────────────────────────────────────

interface TransferIdentityControlProps {
  participants: ParticipantView[];
  roomId: RoomId;
  onSuccess: () => void;
}

function TransferIdentityControl({
  participants,
  roomId,
  onSuccess,
}: TransferIdentityControlProps) {
  const { actor } = useBackend();
  const [oldPrincipalText, setOldPrincipalText] = useState("");
  const [newPrincipalText, setNewPrincipalText] = useState("");
  const [transferring, setTransferring] = useState(false);

  const handleSubmit = async () => {
    if (!actor) return;
    if (!oldPrincipalText) {
      toast.error("Select the old principal to reassign.");
      return;
    }
    const trimmedNew = newPrincipalText.trim();
    if (!trimmedNew) {
      toast.error("Paste the new principal to transfer to.");
      return;
    }

    let oldPrincipal: UserId;
    let newPrincipal: UserId;
    try {
      oldPrincipal = Principal.fromText(oldPrincipalText) as unknown as UserId;
    } catch {
      toast.error("Old principal is invalid.");
      return;
    }
    try {
      newPrincipal = Principal.fromText(trimmedNew) as unknown as UserId;
    } catch {
      toast.error("New principal is not a valid Principal ID.");
      return;
    }

    if (oldPrincipalText === trimmedNew) {
      toast.error("Old and new principals must differ.");
      return;
    }

    setTransferring(true);
    try {
      const result = await (
        actor as unknown as {
          transferParticipantIdentity: (
            roomId: RoomId,
            oldPrincipal: UserId,
            newPrincipal: UserId,
          ) => Promise<
            { __kind__: "ok"; ok: string } | { __kind__: "err"; err: string }
          >;
        }
      ).transferParticipantIdentity(roomId, oldPrincipal, newPrincipal);
      if (result.__kind__ === "err") {
        toast.error(`Error: ${result.err}`);
      } else {
        toast.success(result.ok || "Participant identity transferred.");
        setNewPrincipalText("");
        onSuccess();
      }
    } catch {
      toast.error("Failed to transfer participant identity.");
    } finally {
      setTransferring(false);
    }
  };

  return (
    <div
      className="p-4 bg-muted/30 border border-border/60 rounded-xl space-y-3"
      data-ocid="transfer-identity.section"
    >
      <div className="flex items-center gap-2 mb-1">
        <ArrowLeftRight className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-semibold font-mono text-primary uppercase tracking-wider">
          Transfer Participant Identity
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground/70 font-mono leading-relaxed">
        Reassigns a participant slot from an old principal to a current login
        principal. Preserves roster, budget, and bid history. Use when a
        participant is locked out due to a principal mismatch.
      </p>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
          Old Principal (from roster)
        </Label>
        <select
          value={oldPrincipalText}
          onChange={(e) => setOldPrincipalText(e.target.value)}
          disabled={transferring || participants.length === 0}
          className="h-8 w-full text-xs font-mono bg-background border border-input rounded-md px-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          data-ocid="transfer-identity.old_principal.select"
        >
          <option value="">— Select participant —</option>
          {participants.map((p) => (
            <option key={p.userId.toText()} value={p.userId.toText()}>
              {p.displayName} ({truncatePrincipal(p.userId.toText())})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
          New Principal (paste current login)
        </Label>
        <Input
          value={newPrincipalText}
          onChange={(e) => setNewPrincipalText(e.target.value)}
          placeholder="e.g. 2vxsx-fae..."
          disabled={transferring}
          className="h-8 text-xs font-mono bg-background border-input"
          data-ocid="transfer-identity.new_principal.input"
        />
      </div>

      <Button
        size="sm"
        disabled={transferring || !oldPrincipalText || !newPrincipalText.trim()}
        onClick={handleSubmit}
        className="w-full bg-primary/20 border border-primary/50 text-primary hover:bg-primary/30 font-mono text-xs"
        data-ocid="transfer-identity.submit_button"
      >
        {transferring ? (
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
        ) : (
          <ArrowLeftRight className="w-3.5 h-3.5 mr-1.5" />
        )}
        Transfer Identity
      </Button>
    </div>
  );
}

// ── Active Nomination Count ──────────────────────────────────────────────────

interface ActiveNomCountProps {
  roomId: RoomId;
  currentCount: bigint;
  maxCount: bigint;
  onSuccess: () => void;
}

function ActiveNomCount({
  roomId,
  currentCount,
  maxCount,
  onSuccess,
}: ActiveNomCountProps) {
  const { actor } = useBackend();
  const [countInput, setCountInput] = useState(Number(currentCount).toString());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCountInput(Number(currentCount).toString());
  }, [currentCount]);

  const handleSave = async () => {
    if (!actor) return;
    const parsed = Number.parseInt(countInput);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > Number(maxCount)) {
      toast.error(`Count must be between 1 and ${maxCount}.`);
      return;
    }
    setSaving(true);
    try {
      const result = await (
        actor as unknown as {
          setActiveNominationCount: (
            roomId: RoomId,
            count: bigint,
          ) => Promise<
            { __kind__: "ok"; ok: null } | { __kind__: "err"; err: string }
          >;
        }
      ).setActiveNominationCount(roomId, BigInt(parsed));
      if (result.__kind__ === "err") {
        toast.error(`Error: ${result.err}`);
      } else {
        toast.success(`Active nominations set to ${parsed}.`);
        onSuccess();
      }
    } catch {
      toast.error("Failed to update nomination count.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2" data-ocid="active-nom-count">
      <Input
        type="number"
        min={1}
        max={Number(maxCount)}
        value={countInput}
        onChange={(e) => setCountInput(e.target.value)}
        className="h-8 w-16 font-mono text-xs text-center bg-background border-input"
        data-ocid="active-nom-count-input"
      />
      <span className="text-xs text-muted-foreground">
        / {Number(maxCount)} max
      </span>
      <Button
        size="sm"
        disabled={saving}
        onClick={handleSave}
        className="h-8 px-3 bg-primary/20 border border-primary/50 text-primary hover:bg-primary/30 font-mono text-xs"
        data-ocid="active-nom-count-save-btn"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Apply"}
      </Button>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function HostControls({
  roomId,
  state,
  settings,
  participants = [],
  onRefresh,
  maxRosterSize: initialMaxRosterSize,
}: HostControlsProps) {
  const { actor } = useBackend();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Best Ball end-auction start week. gameType is resolved from the room so
  // HostControls can decide whether to collect a start week without the parent
  // needing to pass it down.
  const [gameType, setGameType] = useState<GameType | null>(null);
  const [startWeekInput, setStartWeekInput] = useState("");

  const [noteText, setNoteText] = useState("");
  const [noteLoading, setNoteLoading] = useState(false);
  const sendMessage = useSendMessage(roomId);

  const nomDefault = settings
    ? secsToHM(settings.nomTimerSecs)
    : { hours: 0, minutes: 2 };
  const bidDefault = settings
    ? secsToHM(settings.bidTimerSecs)
    : { hours: 0, minutes: 1 };

  const [nomHours, setNomHours] = useState(nomDefault.hours);
  const [nomMinutes, setNomMinutes] = useState(nomDefault.minutes);
  const [bidHours, setBidHours] = useState(bidDefault.hours);
  const [bidMinutes, setBidMinutes] = useState(bidDefault.minutes);
  const [rosterCapEnabled, setRosterCapEnabled] = useState(
    initialMaxRosterSize != null,
  );
  const [rosterCapValue, setRosterCapValue] = useState(
    initialMaxRosterSize ?? 10,
  );

  // Sync inputs if settings arrive after mount
  useEffect(() => {
    if (settings) {
      const nom = secsToHM(settings.nomTimerSecs);
      const bid = secsToHM(settings.bidTimerSecs);
      setNomHours(nom.hours);
      setNomMinutes(nom.minutes);
      setBidHours(bid.hours);
      setBidMinutes(bid.minutes);
    }
  }, [settings]);

  // Resolve the room's game type so the End Auction flow knows whether to
  // collect a start week (Best Ball) or pass null (Auction).
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    actor
      .getRoomState(roomId)
      .then((res) => {
        if (cancelled || res.__kind__ !== "ok") return;
        setGameType(res.ok.room.gameType);
      })
      .catch(() => {
        // Non-fatal: default to no start-week input if the room can't be read.
      });
    return () => {
      cancelled = true;
    };
  }, [actor, roomId]);

  // Convenience pre-fill for Best Ball: fetch the current NFL week from
  // Sleeper and use it only when the season is regular. Any failure,
  // non-regular season, or unexpected shape leaves the field blank — this is
  // purely a convenience and never blocks or errors the flow.
  useEffect(() => {
    if (gameType !== GameType.BestBall) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("https://api.sleeper.app/v1/state/nfl");
        if (!response.ok) return;
        const raw: unknown = await response.json();
        const state =
          raw && typeof raw === "object"
            ? (raw as { season_type?: unknown; week?: unknown })
            : null;
        if (
          state &&
          state.season_type === "regular" &&
          typeof state.week === "number"
        ) {
          if (!cancelled) setStartWeekInput(String(state.week));
        }
      } catch {
        // Convenience only — leave blank on any failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameType]);

  const handlePostNote = async () => {
    const t = noteText.trim();
    if (!t) return;
    setNoteLoading(true);
    try {
      await sendMessage(`SYSTEM: 📌 Commissioner: ${t}`);
      setNoteText("");
    } catch {
      // ignore
    } finally {
      setNoteLoading(false);
    }
  };

  async function runAction(
    action: string,
    fn: () => Promise<
      { __kind__: "ok"; ok: null } | { __kind__: "err"; err: string }
    >,
    successMsg: string,
  ) {
    if (!actor) return;
    setPendingAction(action);
    try {
      const result = await fn();
      if (result.__kind__ === "err") {
        toast.error(`Error: ${result.err}`);
      } else {
        toast.success(successMsg);
        onRefresh?.();
      }
    } catch (err) {
      toast.error("Unexpected error. Please try again.");
      console.error(err);
    } finally {
      setPendingAction(null);
    }
  }

  // Best Ball end-auction start week validation (client-side UX only; the
  // backend remains the authority). Auction rooms collect no start week.
  const isBestBall = gameType === GameType.BestBall;
  const parsedStartWeek = Number.parseInt(startWeekInput, 10);
  const startWeekValid =
    !isBestBall ||
    (startWeekInput.trim() !== "" &&
      !Number.isNaN(parsedStartWeek) &&
      parsedStartWeek >= 1 &&
      parsedStartWeek <= 17);

  function handleEndAuction() {
    if (!actor) return;
    if (isBestBall) {
      if (!startWeekValid) {
        toast.error("Enter a valid start week (1-17).");
        return;
      }
      runAction(
        "end",
        () => actor!.endAuction(roomId, BigInt(parsedStartWeek)),
        "Auction ended.",
      );
    } else {
      runAction("end", () => actor!.endAuction(roomId, null), "Auction ended.");
    }
  }

  async function handleApplySettings() {
    if (!actor) return;
    const nomSecs = BigInt(nomHours * 3600 + nomMinutes * 60);
    const bidSecs = BigInt(bidHours * 3600 + bidMinutes * 60);
    if (bidSecs < BigInt(60)) {
      toast.error("Bid timer must be at least 1 minute.");
      return;
    }
    const maxRosterSizeArg = rosterCapEnabled ? BigInt(rosterCapValue) : null;
    const adpDataset = settings?.adpDataset === "rookies" ? "rookies" : "all";
    await runAction(
      "applySettings",
      () =>
        (
          actor as unknown as {
            updateRoomSettings: (
              roomId: RoomId,
              nomSecs: bigint,
              bidSecs: bigint,
              maxRosterSize: bigint | null,
              adpDataset: string,
            ) => Promise<
              { __kind__: "ok"; ok: null } | { __kind__: "err"; err: string }
            >;
          }
        ).updateRoomSettings(
          roomId,
          nomSecs,
          bidSecs,
          maxRosterSizeArg,
          adpDataset,
        ),
      "Settings applied.",
    );
  }

  const isLoading = pendingAction !== null;
  const isWaiting = state === AuctionState.Waiting;
  const isPaused = state === AuctionState.Paused;
  const showTimerSettings = isWaiting || isPaused;
  const showParticipantControls = isWaiting || isPaused;

  if (state === AuctionState.Completed) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-lg text-sm text-muted-foreground"
        data-ocid="host-controls-completed"
      >
        <Trophy className="w-4 h-4" />
        <span className="font-medium">Auction Completed</span>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-ocid="host-controls">
      {/* Commissioner Notes */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-foreground text-sm">
          Commissioner Notes
        </h3>
        <p className="text-xs text-muted-foreground">
          Post a pinned note visible to all participants in chat.
        </p>
        <div className="flex gap-2">
          <Input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handlePostNote();
              }
            }}
            placeholder="Add a note for all participants..."
            className="flex-1 bg-background border-input text-sm"
            disabled={noteLoading}
          />
          <Button
            onClick={handlePostNote}
            disabled={!noteText.trim() || noteLoading}
            size="sm"
            className="shrink-0"
          >
            📌 Post Note
          </Button>
        </div>
      </div>

      {/* Timer adjustment — while waiting or paused */}
      {showTimerSettings ? (
        <div
          className="p-4 bg-muted/30 border border-border/60 rounded-xl space-y-4"
          data-ocid="host-timer-settings"
        >
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold font-mono text-primary uppercase tracking-wider">
              Timer Settings
            </span>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
              Timers
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TimerAdjust
                label="Nomination Timer"
                hours={nomHours}
                minutes={nomMinutes}
                onHoursChange={setNomHours}
                onMinutesChange={setNomMinutes}
              />
              <TimerAdjust
                label="Bid Timer"
                hours={bidHours}
                minutes={bidMinutes}
                onHoursChange={setBidHours}
                onMinutesChange={setBidMinutes}
              />
            </div>
          </div>

          {isPaused ? (
            <>
              {/* Roster cap toggle — also available while paused */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
                  Limits
                </p>
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
                    data-ocid="host-roster-cap-toggle"
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-card transition-transform duration-200 ${
                        rosterCapEnabled ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                {rosterCapEnabled && (
                  <div className="mt-2 space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                      Max Roster Size
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={rosterCapValue}
                      onChange={(e) =>
                        setRosterCapValue(
                          Math.max(1, Number(e.target.value) || 1),
                        )
                      }
                      className="h-8 w-24 font-mono text-xs text-center bg-background border-input"
                      data-ocid="host-roster-cap-input"
                    />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between pt-1">
                <p className="text-[11px] text-muted-foreground/60 font-mono">
                  Changes apply immediately to all future nominations.
                </p>
                <Button
                  size="sm"
                  disabled={isLoading}
                  onClick={handleApplySettings}
                  className="bg-primary/20 border border-primary/50 text-primary hover:bg-primary/30 font-mono text-xs"
                  data-ocid="host-apply-settings-btn"
                >
                  {pendingAction === "applySettings" ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Apply Changes
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Roster cap toggle — in Limits, available while waiting */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
                  Limits
                </p>
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
                    data-ocid="host-roster-cap-toggle"
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-card transition-transform duration-200 ${
                        rosterCapEnabled ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                {rosterCapEnabled && (
                  <div className="mt-2 space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                      Max Roster Size
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={rosterCapValue}
                      onChange={(e) =>
                        setRosterCapValue(
                          Math.max(1, Number(e.target.value) || 1),
                        )
                      }
                      className="h-8 w-24 font-mono text-xs text-center bg-background border-input"
                      data-ocid="host-roster-cap-input"
                    />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between pt-1">
                <p className="text-[11px] text-muted-foreground/60 font-mono">
                  Timer and limits changes apply when the auction starts.
                  Current backend nomination timer:{" "}
                  {settings ? `${Number(settings.nomTimerSecs)}s` : "—"}
                </p>
                <Button
                  size="sm"
                  disabled={isLoading}
                  onClick={handleApplySettings}
                  className="bg-primary/20 border border-primary/50 text-primary hover:bg-primary/30 font-mono text-xs ml-3 shrink-0"
                  data-ocid="host-apply-settings-waiting-btn"
                >
                  {pendingAction === "applySettings" ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Save Settings
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          className="flex items-center gap-2 px-3 py-2 bg-muted/20 border border-border/40 rounded-lg"
          data-ocid="host-timers-locked"
        >
          <Lock className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground font-mono">
            Timers locked (auction in progress)
          </span>
        </div>
      )}

      {/* Active nomination count */}
      {showParticipantControls && settings && (
        <div
          className="p-4 bg-muted/30 border border-border/60 rounded-xl space-y-3"
          data-ocid="host-nom-count-settings"
        >
          <div className="flex items-center gap-2 mb-1">
            <Users className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold font-mono text-primary uppercase tracking-wider">
              Active Nominations
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground/70 font-mono">
            Number of simultaneous active nominations allowed.
          </p>
          <ActiveNomCount
            roomId={roomId}
            currentCount={settings.maxActivePicks}
            maxCount={BigInt(10)}
            onSuccess={() => onRefresh?.()}
          />
        </div>
      )}

      {/* Participant management — waiting or paused */}
      {showParticipantControls && participants.length > 0 && (
        <>
          {/* Budget editing */}
          <div
            className="p-4 bg-muted/30 border border-border/60 rounded-xl space-y-3"
            data-ocid="host-budget-settings"
          >
            <div className="flex items-center gap-2 mb-1">
              <Users className="w-3.5 h-3.5 text-secondary" />
              <span className="text-xs font-semibold font-mono text-secondary uppercase tracking-wider">
                Edit Participant Budgets
              </span>
            </div>
            <div className="divide-y divide-border/40">
              {participants.map((p) => (
                <BudgetEditRow
                  key={p.userId.toText()}
                  participant={p}
                  roomId={roomId}
                  onSuccess={() => onRefresh?.()}
                />
              ))}
            </div>
          </div>

          <Separator className="bg-border/40" />

          {/* Remove users */}
          <div
            className="p-4 bg-muted/30 border border-border/60 rounded-xl space-y-3"
            data-ocid="host-remove-users"
          >
            <div className="flex items-center gap-2 mb-1">
              <Trash2 className="w-3.5 h-3.5 text-destructive" />
              <span className="text-xs font-semibold font-mono text-destructive uppercase tracking-wider">
                Remove Participants
              </span>
            </div>
            <div className="space-y-1">
              {participants.map((p, index) => (
                <div
                  key={p.userId.toText()}
                  className="flex items-center gap-2 py-1.5 px-2 rounded-md bg-background/40"
                >
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="text-sm text-foreground truncate min-w-0">
                      {p.displayName}
                    </span>
                    <PrincipalId
                      userId={p.userId}
                      scope="remove"
                      index={index}
                    />
                  </div>
                  <RemoveUserButton
                    participant={p}
                    roomId={roomId}
                    onSuccess={() => onRefresh?.()}
                  />
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Transfer participant identity — NOT gated on showParticipantControls */}
      {participants.length > 0 && (
        <>
          <Separator className="bg-border/40" />
          <TransferIdentityControl
            participants={participants}
            roomId={roomId}
            onSuccess={() => onRefresh?.()}
          />
        </>
      )}

      {/* Nomination order — waiting or paused */}
      {showParticipantControls && participants.length > 0 && (
        <>
          <Separator className="bg-border/40" />
          <div
            className="p-4 bg-muted/30 border border-border/60 rounded-xl space-y-3"
            data-ocid="host-nom-order"
          >
            <div className="flex items-center gap-2 mb-1">
              <Trophy className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold font-mono text-primary uppercase tracking-wider">
                Nomination Order
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground/70 font-mono">
              Drag to reorder or use arrows. Click Save Order to apply.
            </p>
            <NominationOrderEditor
              participants={participants}
              roomId={roomId}
              onSuccess={() => onRefresh?.()}
            />
          </div>
        </>
      )}

      {/* Action buttons */}
      <div
        className="flex flex-wrap items-center gap-2"
        data-ocid="host-action-buttons"
      >
        {state === AuctionState.Waiting && (
          <Button
            size="sm"
            disabled={isLoading}
            onClick={() =>
              runAction(
                "start",
                () => actor!.startAuction(roomId),
                "Auction started!",
              )
            }
            className="bg-primary text-primary-foreground hover:bg-primary/90 border-glow-cyan font-mono text-xs"
            data-ocid="host-start-btn"
          >
            {pendingAction === "start" ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Play className="w-4 h-4 mr-1.5" />
            )}
            Start Auction
          </Button>
        )}

        {state === AuctionState.Active && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={isLoading}
              onClick={() =>
                runAction(
                  "pause",
                  () => actor!.pauseAuction(roomId),
                  "Auction paused.",
                )
              }
              className="border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10 font-mono text-xs"
              data-ocid="host-pause-btn"
            >
              {pendingAction === "pause" ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Pause className="w-4 h-4 mr-1.5" />
              )}
              Pause
            </Button>

            <EndAuctionButton
              disabled={isLoading}
              loading={pendingAction === "end"}
              onConfirm={handleEndAuction}
              showStartWeek={isBestBall}
              startWeek={startWeekInput}
              onStartWeekChange={setStartWeekInput}
              startWeekValid={startWeekValid}
            />
          </>
        )}

        {state === AuctionState.Paused && (
          <>
            <Button
              size="sm"
              disabled={isLoading}
              onClick={() =>
                runAction(
                  "resume",
                  () => actor!.resumeAuction(roomId),
                  "Auction resumed!",
                )
              }
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs"
              data-ocid="host-resume-btn"
            >
              {pendingAction === "resume" ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-1.5" />
              )}
              Resume
            </Button>

            <EndAuctionButton
              disabled={isLoading}
              loading={pendingAction === "end"}
              onConfirm={handleEndAuction}
              showStartWeek={isBestBall}
              startWeek={startWeekInput}
              onStartWeekChange={setStartWeekInput}
              startWeekValid={startWeekValid}
            />
          </>
        )}
      </div>
    </div>
  );
}

function EndAuctionButton({
  disabled,
  loading,
  onConfirm,
  showStartWeek,
  startWeek,
  onStartWeekChange,
  startWeekValid,
}: {
  disabled: boolean;
  loading: boolean;
  onConfirm: () => void;
  showStartWeek: boolean;
  startWeek: string;
  onStartWeekChange: (v: string) => void;
  startWeekValid: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          className="border-destructive/50 text-destructive hover:bg-destructive/10 font-mono text-xs"
          data-ocid="host-end-btn"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
          ) : (
            <Square className="w-4 h-4 mr-1.5" />
          )}
          End Auction
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        className="bg-card border border-border"
        data-ocid="end-auction-confirm-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-foreground">
            End Auction?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-muted-foreground">
            This will permanently close the auction. All active nominations will
            expire and no more bidding will be allowed. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {showStartWeek && (
          <div className="space-y-1.5">
            <Label
              htmlFor="end-auction-start-week"
              className="text-xs text-muted-foreground font-mono uppercase tracking-wider"
            >
              Best Ball Start Week
            </Label>
            <Input
              id="end-auction-start-week"
              type="number"
              min={1}
              max={17}
              value={startWeek}
              onChange={(e) => onStartWeekChange(e.target.value)}
              placeholder="1-17"
              className="h-9 w-24 font-mono text-xs text-center bg-background border-input"
              data-ocid="end-auction-start-week-input"
            />
            {!startWeekValid && (
              <p
                className="text-[11px] text-destructive font-mono"
                data-ocid="end-auction-start-week-error"
              >
                Enter a valid start week (1-17).
              </p>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel className="border-border text-muted-foreground hover:text-foreground">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={loading || (showStartWeek && !startWeekValid)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-ocid="end-auction-confirm-btn"
          >
            End Auction
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default HostControls;
