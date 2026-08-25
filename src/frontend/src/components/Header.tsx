import { Button } from "@/components/ui/button";
import { useInternetIdentity } from "@caffeineai/core-infrastructure";
import { useRouterState } from "@tanstack/react-router";
import { Bell, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LOGO_URL } from "../config/assets";
import { useAuth } from "../hooks/useAuth";
import { useProfile } from "../hooks/useProfile";
import { useRoomsList } from "../hooks/useRoomPolling";
import { AvatarThumb } from "./AvatarThumb";

interface HeaderProps {
  onProfileOpen?: () => void;
}

export default function Header({ onProfileOpen }: HeaderProps) {
  const { isAuthenticated, login, logout, isLoading, displayName } = useAuth();
  const { profile } = useProfile();
  const { identity } = useInternetIdentity();

  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const [shareCopied, setShareCopied] = useState(false);

  const currentRoomId = currentPath.startsWith("/room/")
    ? currentPath.replace("/room/", "")
    : null;

  const { rooms } = useRoomsList();
  const currentRoomMeta = currentRoomId
    ? rooms.find((r) => r.id === currentRoomId)
    : null;

  const handleShare = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
        toast("Copied!", { description: "Link copied to clipboard" });
      }
    } catch {
      // User cancelled share or clipboard not available
    }
  };

  return (
    <header
      className="shrink-0 h-14 bg-gradient-to-b from-[#10002b] to-black border-b border-border flex items-center px-3 gap-3 z-10"
      data-ocid="app-header"
    >
      {/* App name */}
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        <img
          src={LOGO_URL}
          alt="Fantasy Football Auction House logo"
          className="w-7 h-7 object-contain shrink-0"
        />
        <span className="font-display font-bold text-base sm:text-lg text-foreground tracking-tight truncate">
          Fantasy Football Auction House
        </span>
      </div>

      {/* Current room info — only shown outside room (room has its own header) */}
      {currentRoomMeta && !currentPath.startsWith("/room/") && (
        <div className="flex items-center gap-2 min-w-0 flex-1 sm:flex-none">
          <span className="text-muted-foreground text-xs hidden sm:inline">
            /
          </span>
          <span
            className="text-sm font-medium text-foreground truncate max-w-[120px]"
            title={currentRoomMeta.name}
          >
            {currentRoomMeta.name}
          </span>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Display name + bell (authenticated only) */}
      {isAuthenticated && displayName && (
        <button
          type="button"
          onClick={onProfileOpen}
          aria-label="Open profile"
          className="flex items-center gap-2 shrink-0 min-w-0 hover:opacity-80 transition-opacity cursor-pointer"
          data-ocid="header-profile-btn"
        >
          <AvatarThumb
            size={24}
            displayName={displayName}
            seed={identity?.getPrincipal()?.toText() ?? ""}
            avatarUrl={profile?.avatarUrl ?? null}
          />
          <span className="text-sm text-muted-foreground font-medium truncate max-w-[120px]">
            {displayName}
          </span>
          <Bell className="w-4 h-4 text-muted-foreground/60 shrink-0" />
        </button>
      )}

      {/* Share + Auth */}
      <button
        type="button"
        onClick={handleShare}
        className="shrink-0 flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        aria-label="Share current page"
        data-ocid="header-share-btn"
      >
        {shareCopied ? (
          <span className="text-[10px] font-mono font-semibold text-primary">
            ✓
          </span>
        ) : (
          <Share2 className="w-4 h-4" />
        )}
      </button>

      {/* Auth */}
      {isAuthenticated ? (
        <Button
          variant="outline"
          size="sm"
          onClick={logout}
          className="text-xs border-border text-muted-foreground hover:text-foreground shrink-0"
          data-ocid="header-logout-btn"
        >
          Log out
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => {
            const currentPath = window.location.pathname;
            if (currentPath.startsWith("/room/")) {
              sessionStorage.setItem("intended_route", currentPath);
            }
            login();
          }}
          disabled={isLoading}
          className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 text-xs"
          data-ocid="header-login-btn"
        >
          {isLoading ? "Connecting…" : "Sign In"}
        </Button>
      )}
    </header>
  );
}
