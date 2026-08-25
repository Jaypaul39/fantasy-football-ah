import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { KeyRound, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useBackend } from "../hooks/useBackend";
import { useProfile, useSetDisplayName } from "../hooks/useProfile";
import BottomNav from "./BottomNav";
import Header from "./Header";
import ProfileModal from "./ProfileModal";

interface LayoutProps {
  children: ReactNode;
}

/** Blocking modal shown on first login until Internet Identity is connected and a display name is set. */
/** Blocking modal shown on first login until Internet Identity is connected and a display name is set. */
function FirstLoginModal() {
  const { isAuthenticated, login, isLoading: authLoading } = useAuth();
  const setDisplayName = useSetDisplayName();
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the name input once Internet Identity auth completes
  useEffect(() => {
    if (isAuthenticated) {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [isAuthenticated]);

  const handleSubmit = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setError("Please enter a display name.");
      return;
    }
    if (trimmed.length < 2) {
      setError("Name must be at least 2 characters.");
      return;
    }
    setError(null);
    try {
      await setDisplayName.mutateAsync(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save name.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90 backdrop-blur-sm"
      data-ocid="first-login-overlay"
    >
      <div
        className="bg-card border border-border rounded-2xl p-8 w-full max-w-sm shadow-2xl space-y-5"
        data-ocid="first-login-modal"
      >
        <div className="text-center space-y-1.5">
          <h2 className="font-display font-bold text-xl text-foreground">
            Join Your Auction Room
          </h2>
          <p className="text-sm text-muted-foreground">
            {isAuthenticated
              ? "Choose a display name to get started. This is how other participants will see you."
              : "Use Face ID, fingerprint, or your device's secure login to continue — then choose your display name."}
          </p>
        </div>

        {/* Step 1: Internet Identity login */}
        {!isAuthenticated && (
          <Button
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold gap-2"
            onClick={() => {
              const currentPath = window.location.pathname;
              if (currentPath.startsWith("/room/")) {
                sessionStorage.setItem("intended_route", currentPath);
              }
              login();
            }}
            disabled={authLoading}
            data-ocid="first-login-ii-btn"
          >
            {authLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <KeyRound className="w-4 h-4" />
                Continue Securely
              </>
            )}
          </Button>
        )}

        {/* Helper text + trust bullets — shown below login button */}
        {!isAuthenticated && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground text-center">
              No passwords, downloads, or account required. Works like Apple and
              Google passkeys.
            </p>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>✓ No email signup required</p>
              <p>✓ No passwords to remember</p>
              <p>✓ Secure device-based authentication</p>
              <p>✓ Works like Face ID or Touch ID</p>
            </div>
            <p className="text-[10px] text-muted-foreground/50 text-center pt-1">
              Powered by Internet Identity secure authentication
            </p>
          </div>
        )}

        {/* Step 2: Set display name — only shown after authentication */}
        {isAuthenticated && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="first-login-name"
                className="text-xs uppercase tracking-wide font-semibold text-muted-foreground"
              >
                Display Name
              </label>
              <Input
                id="first-login-name"
                ref={inputRef}
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
                placeholder="e.g. DraftKing99"
                maxLength={40}
                disabled={setDisplayName.isPending}
                className="bg-background"
                data-ocid="first-login-name-input"
              />
              {error && (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>

            <Button
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
              onClick={handleSubmit}
              disabled={setDisplayName.isPending || !nameInput.trim()}
              data-ocid="first-login-submit-btn"
            >
              {setDisplayName.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                "Set Display Name"
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Layout({ children }: LayoutProps) {
  const [profileOpen, setProfileOpen] = useState(false);
  const { isAuthenticated } = useAuth();
  const { actor, isFetching: actorFetching } = useBackend();
  const { profile, isLoading: profileLoading } = useProfile();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const navigate = useNavigate();

  // Hide BottomNav inside auction rooms — they have their own room bottom nav
  const isInRoom = currentPath.startsWith("/room/");

  // Phase 1: actor is still initializing — block everything to prevent flash
  const actorReady = !!actor && !actorFetching;

  // Phase 2: authenticated but profile fetch still in-flight — block to prevent flash
  const profileDecisionPending = isAuthenticated && profileLoading;

  // Show a full-screen loader while we don't have enough info to make the routing decision
  const showLoader = !actorReady || profileDecisionPending;

  // Show the blocking first-login modal when:
  // (a) Not yet authenticated — user needs to sign in with Internet Identity first
  // (b) Authenticated, profile fetch done, but no display name set
  const needsOnboarding =
    !showLoader &&
    (!isAuthenticated ||
      (isAuthenticated &&
        (profile === null ||
          !profile.displayName ||
          profile.displayName.trim() === "")));

  // After successful login, check for intended route redirect
  useEffect(() => {
    if (
      isAuthenticated &&
      profile &&
      profile.displayName &&
      profile.displayName.trim() !== ""
    ) {
      const intended = sessionStorage.getItem("intended_route");
      if (intended) {
        sessionStorage.removeItem("intended_route");
        navigate({ to: intended });
      }
    }
  }, [isAuthenticated, profile, navigate]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background dark">
      {/* Full-screen loader while auth/profile state is unknown — prevents flash of main UI */}
      {showLoader && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-background"
          data-ocid="app-loading-overlay"
        >
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
      )}

      {/* Blocking first-login / onboarding modal */}
      {needsOnboarding && <FirstLoginModal />}

      {/* Header — always on top */}
      <Header onProfileOpen={() => setProfileOpen(true)} />

      {/* Main content — pb-20 ensures content clears bottom nav */}
      <main
        className={`flex-1 overflow-y-auto scrollbar-thin ${isInRoom ? "" : "pb-20"}`}
        data-ocid="main-content"
      >
        {children}
      </main>

      {/* Bottom navigation — hidden inside auction rooms */}
      {!isInRoom && <BottomNav />}

      {/* Profile modal — rendered at root so it overlays everything */}
      <ProfileModal
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
      />
    </div>
  );
}
