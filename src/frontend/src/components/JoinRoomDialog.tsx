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
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useIsMobile } from "../hooks/use-mobile";
import { useBackend } from "../hooks/useBackend";

interface JoinRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function JoinRoomDialog({ open, onOpenChange }: JoinRoomDialogProps) {
  const router = useRouter();
  const { actor } = useBackend();
  const isMobile = useIsMobile();

  const [password, setPassword] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!actor) return;
    const trimmedPassword = password.trim();
    if (!trimmedPassword) {
      setInlineError("Please enter the room password.");
      return;
    }

    setInlineError(null);
    setIsPending(true);
    try {
      // Match the private room server-side by password. The backend returns
      // the matched RoomId on success or a single generic error on failure.
      const result = await actor.joinPrivateRoomByPassword(trimmedPassword);

      if (result.__kind__ === "err") {
        setInlineError(result.err);
        return;
      }

      const joinedRoomId = result.ok;
      toast.success("Joined private room!");
      onOpenChange(false);
      router.navigate({
        to: "/room/$roomId",
        params: { roomId: joinedRoomId },
      });
    } catch {
      toast.error("Unexpected error joining room.");
    } finally {
      setIsPending(false);
    }
  }

  function handleClose(open: boolean) {
    if (!isPending) {
      onOpenChange(open);
      if (!open) {
        setPassword("");
        setInlineError(null);
      }
    }
  }

  const formContent = (
    <form onSubmit={handleSubmit} className="space-y-5 px-4 pb-6 pt-2">
      <div className="space-y-1.5">
        <Label htmlFor="join-room-password" className="text-foreground text-sm">
          Room Password <span className="text-destructive">*</span>
        </Label>
        <Input
          id="join-room-password"
          type="text"
          placeholder="Enter the room password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setInlineError(null);
          }}
          className="bg-background border-input focus:border-primary text-foreground font-mono text-sm"
          data-ocid="join-room-password-input"
          required
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          Enter the password shared by the room host to join their private room.
        </p>
      </div>

      {/* Inline error */}
      {inlineError && (
        <div
          className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-sm"
          data-ocid="join-room-inline-error"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{inlineError}</span>
        </div>
      )}

      <div className="flex justify-end gap-3 pt-1">
        <Button
          type="button"
          variant="outline"
          onClick={() => handleClose(false)}
          disabled={isPending}
          className="border-border text-muted-foreground hover:text-foreground"
          data-ocid="join-room-cancel-btn"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isPending || !password.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 min-w-[100px]"
          data-ocid="join-room-submit-btn"
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Joining…
            </>
          ) : (
            "Join Room"
          )}
        </Button>
      </div>
    </form>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleClose}>
        <DrawerContent
          className="bg-card border-t border-border"
          data-ocid="join-room-dialog"
        >
          <DrawerHeader className="px-4 pt-4 pb-0">
            <DrawerTitle className="font-display flex items-center gap-2 text-foreground">
              <KeyRound className="w-5 h-5 text-primary" />
              Join Private Room
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
        className="bg-card border border-border max-w-sm"
        data-ocid="join-room-dialog"
      >
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2 text-foreground">
            <KeyRound className="w-5 h-5 text-primary" />
            Join Private Room
          </DialogTitle>
        </DialogHeader>
        {formContent}
      </DialogContent>
    </Dialog>
  );
}

export default JoinRoomDialog;
