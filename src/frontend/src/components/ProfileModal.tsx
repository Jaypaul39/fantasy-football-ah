import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  Bell,
  BellOff,
  CheckCircle2,
  ChevronDown,
  Copy,
  Loader2,
  Shield,
  Shuffle,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useBackend } from "../hooks/useBackend";
import { useNewsDisplayPreference } from "../hooks/useNewsDisplayPreference";
import { useProfile, useSetDisplayName } from "../hooks/useProfile";
import { useValueDisplayPreference } from "../hooks/useValueDisplayPreference";
import {
  AVATAR_CATEGORIES,
  AVATAR_STYLES,
  BORING_AVATAR_PALETTES,
  BORING_AVATAR_STYLES,
  type BoringAvatarPaletteKey,
  boringAvatarUrl,
  dicebearUrl,
  getStylesByCategory,
  isBoringAvatarStyle,
  parseAvatarUrl,
} from "../lib/avatar-styles";
import {
  requestNotificationPermission,
  storeOneSignalPlayerId,
} from "../lib/onesignal";
import { AvatarThumb } from "./AvatarThumb";

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  isAdmin?: boolean;
}

export default function ProfileModal({
  isOpen,
  onClose,
  isAdmin = false,
}: ProfileModalProps) {
  const { profile, isLoading } = useProfile();
  const { principalText } = useAuth();

  const setDisplayName = useSetDisplayName();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { actor } = useBackend();

  const [nameInput, setNameInput] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [principalCopied, setPrincipalCopied] = useState(false);
  const [randomSeed, setRandomSeed] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [avatarTab, setAvatarTab] = useState<"dicebear" | "boring">("dicebear");
  const [boringPalette, setBoringPalette] = useState<BoringAvatarPaletteKey>(
    () => {
      try {
        const stored = localStorage.getItem("boring-avatar-palette");
        if (stored === "warm" || stored === "cool" || stored === "vibrant") {
          return stored;
        }
      } catch {
        // ignore
      }
      return "warm";
    },
  );
  const { showEstimatedValues, setShowEstimatedValues } =
    useValueDisplayPreference();
  const { showNewsOnCards, setShowNewsOnCards } = useNewsDisplayPreference();

  const [audioOn, setAudioOn] = useState(() => {
    try {
      return localStorage.getItem("audioPreference") !== "off";
    } catch {
      return true;
    }
  });

  const [pushPermission, setPushPermission] = useState<
    "granted" | "denied" | "default" | "unsupported"
  >("default");

  const inputRef = useRef<HTMLInputElement>(null);

  // Sync input with fetched profile
  useEffect(() => {
    if (profile?.displayName) setNameInput(profile.displayName);
  }, [profile?.displayName]);

  // Reset transient state when modal opens (no auto-focus to prevent mobile keyboard popup)
  useEffect(() => {
    if (isOpen) {
      setNameSaved(false);
      setRandomSeed(null);
      setExpandedCategory(null);
      setAvatarTab("dicebear");
    }
  }, [isOpen]);

  // Sync push notification permission state when modal opens
  useEffect(() => {
    if (!isOpen) return;
    if (typeof Notification === "undefined") {
      setPushPermission("unsupported");
      return;
    }
    setPushPermission(
      Notification.permission as "granted" | "denied" | "default",
    );
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const handlePaletteChange = (palette: BoringAvatarPaletteKey) => {
    setBoringPalette(palette);
    try {
      localStorage.setItem("boring-avatar-palette", palette);
    } catch {
      // ignore
    }
  };

  const handleToggleAudio = () => {
    const next = !audioOn;
    setAudioOn(next);
    try {
      localStorage.setItem("audioPreference", next ? "on" : "off");
    } catch {
      // ignore
    }
  };

  const handleEnablePush = async () => {
    try {
      await requestNotificationPermission();
      if (typeof Notification === "undefined") {
        setPushPermission("unsupported");
        return;
      }
      const permission = Notification.permission as
        | "granted"
        | "denied"
        | "default";
      setPushPermission(permission);
      if (permission === "granted" && actor) {
        void storeOneSignalPlayerId(actor);
      }
    } catch {
      setPushPermission("unsupported");
    }
  };

  const handleRandomize = () => {
    setRandomSeed(
      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    );
  };

  const effectiveSeed = randomSeed ?? principalText ?? "";
  const parsedAvatar = parseAvatarUrl(profile?.avatarUrl ?? null);
  const currentStyleId = parsedAvatar.styleId || AVATAR_STYLES[0].id;
  const currentBoringVariant = parsedAvatar.isBoring
    ? parsedAvatar.styleId || BORING_AVATAR_STYLES[0].id
    : BORING_AVATAR_STYLES[0].id;

  const handleCopyPrincipal = () => {
    if (!principalText) return;
    navigator.clipboard
      .writeText(principalText)
      .then(() => {
        setPrincipalCopied(true);
        setTimeout(() => setPrincipalCopied(false), 2000);
      })
      .catch(() => {
        // fallback: select the text
      });
  };

  const handleSaveName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    try {
      await setDisplayName.mutateAsync(trimmed);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2500);
    } catch {
      // error visible via setDisplayName.error
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="profile-modal-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
      data-ocid="profile-modal-overlay"
    >
      <dialog
        open
        className="profile-modal-card"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label="Edit profile"
        data-ocid="profile-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display font-semibold text-foreground text-base">
            Your Profile
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors rounded p-1.5 hover:bg-muted"
            aria-label="Close profile modal"
            data-ocid="profile-modal-close"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Avatar display */}
        <div className="flex flex-col items-center gap-2 mb-5">
          {parsedAvatar.styleId ? (
            <img
              src={
                parsedAvatar.isBoring
                  ? boringAvatarUrl(
                      parsedAvatar.styleId,
                      parsedAvatar.seed ?? principalText ?? "",
                    )
                  : dicebearUrl(
                      parsedAvatar.styleId,
                      parsedAvatar.seed ?? principalText ?? "",
                    )
              }
              alt={profile?.displayName ?? nameInput}
              loading="lazy"
              decoding="async"
              className="w-16 h-16 rounded-full"
            />
          ) : (
            <AvatarThumb
              size={64}
              displayName={profile?.displayName ?? nameInput}
              seed={principalText ?? ""}
            />
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleRandomize}
            className="mt-1"
            data-ocid="profile-avatar-shuffle"
          >
            <Shuffle className="w-3.5 h-3.5 mr-1.5" />
            Try different variations
          </Button>
          <p className="text-[10px] text-muted-foreground/60 text-center">
            Variations are random — click Shuffle for a new look.
          </p>
        </div>

        {/* Choose Your Avatar */}
        <div className="space-y-2 mb-5">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">
            Choose Your Avatar
          </Label>

          {/* Tab switcher + palette selector */}
          <div className="space-y-2">
            <div className="flex rounded-lg border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setAvatarTab("dicebear")}
                className={`flex-1 px-3 py-2 text-xs font-semibold transition-smooth ${
                  avatarTab === "dicebear"
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "bg-card text-muted-foreground hover:text-foreground"
                }`}
                data-ocid="profile-avatar-tab-dicebear"
              >
                DiceBear
              </button>
              <button
                type="button"
                onClick={() => setAvatarTab("boring")}
                className={`flex-1 px-3 py-2 text-xs font-semibold transition-smooth ${
                  avatarTab === "boring"
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "bg-card text-muted-foreground hover:text-foreground"
                }`}
                data-ocid="profile-avatar-tab-boring"
              >
                Boring Avatars
              </button>
            </div>

            {avatarTab === "boring" && (
              <div className="flex items-center gap-2 px-1">
                <span className="text-[10px] text-muted-foreground">
                  Palette:
                </span>
                <div className="flex items-center gap-1.5">
                  {(
                    Object.keys(
                      BORING_AVATAR_PALETTES,
                    ) as BoringAvatarPaletteKey[]
                  ).map((key) => {
                    const palette = BORING_AVATAR_PALETTES[key];
                    const isActive = boringPalette === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => handlePaletteChange(key)}
                        className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] font-medium transition-smooth ${
                          isActive
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-card text-muted-foreground hover:text-foreground"
                        }`}
                        data-ocid={`profile-avatar-palette-${key}`}
                      >
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full"
                          style={{
                            background: `linear-gradient(135deg, #${palette.colors[0]}, #${palette.colors[1]})`,
                          }}
                        />
                        {palette.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {avatarTab === "dicebear" ? (
            <div className="space-y-1">
              {AVATAR_CATEGORIES.map((category) => {
                const styles = getStylesByCategory()[category] ?? [];
                const isOpen = expandedCategory === category;
                return (
                  <div
                    key={category}
                    className="border border-border rounded-xl overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedCategory(isOpen ? null : category)
                      }
                      className="w-full flex items-center justify-between px-3 py-2.5 bg-card hover:bg-muted/40 transition-colors"
                      data-ocid={`profile-avatar-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <span className="text-xs font-semibold text-foreground">
                        {category}
                      </span>
                      <span className="text-[10px] text-muted-foreground mr-2">
                        {styles.length} styles
                      </span>
                      <ChevronDown
                        className={`w-4 h-4 text-muted-foreground transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-2 pb-2 pt-1 bg-background">
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                          {styles.map((style) => {
                            const isSelected = currentStyleId === style.id;
                            return (
                              <button
                                key={style.id}
                                type="button"
                                onClick={async () => {
                                  if (!actor) return;
                                  const urlToSave = randomSeed
                                    ? `${style.id}::${randomSeed}`
                                    : style.id;
                                  try {
                                    await actor.setAvatarUrl(urlToSave);
                                    queryClient.invalidateQueries({
                                      queryKey: ["profile"],
                                    });
                                  } catch {
                                    // ignore
                                  }
                                }}
                                className={`flex flex-col items-center gap-1 p-1.5 rounded-lg border transition-smooth ${
                                  isSelected
                                    ? "border-primary bg-primary/10"
                                    : "border-border bg-card hover:border-primary/40"
                                }`}
                                data-ocid={`profile-avatar-style-${style.id}`}
                              >
                                <img
                                  src={dicebearUrl(style.id, effectiveSeed)}
                                  alt={style.label}
                                  loading="lazy"
                                  className={`w-10 h-10 rounded-full ${
                                    isSelected ? "border-2 border-primary" : ""
                                  }`}
                                />
                                <span className="text-[10px] text-muted-foreground font-medium leading-tight">
                                  {style.label}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 px-1">
              {BORING_AVATAR_STYLES.map((style) => {
                const isSelected = currentBoringVariant === style.id;
                return (
                  <button
                    key={style.id}
                    type="button"
                    onClick={async () => {
                      if (!actor) return;
                      const urlToSave = randomSeed
                        ? `boring:${style.id}::${randomSeed}`
                        : `boring:${style.id}`;
                      try {
                        await actor.setAvatarUrl(urlToSave);
                        queryClient.invalidateQueries({
                          queryKey: ["profile"],
                        });
                      } catch {
                        // ignore
                      }
                    }}
                    className={`flex flex-col items-center gap-1 p-1.5 rounded-lg border transition-smooth ${
                      isSelected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:border-primary/40"
                    }`}
                    data-ocid={`profile-avatar-boring-${style.id}`}
                  >
                    <img
                      src={boringAvatarUrl(
                        style.id,
                        effectiveSeed,
                        boringPalette,
                      )}
                      alt={style.label}
                      loading="lazy"
                      className={`w-10 h-10 rounded-full ${
                        isSelected ? "border-2 border-primary" : ""
                      }`}
                    />
                    <span className="text-[10px] text-muted-foreground font-medium leading-tight">
                      {style.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={async () => {
              if (!actor) return;
              try {
                await actor.setAvatarUrl("");
                queryClient.invalidateQueries({ queryKey: ["profile"] });
              } catch {
                // ignore
              }
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
            data-ocid="profile-avatar-clear"
          >
            Use Initials Instead
          </button>
        </div>

        {/* Display name */}
        <div className="space-y-2 mb-5">
          <Label
            htmlFor="profile-display-name"
            className="text-xs text-muted-foreground uppercase tracking-wide"
          >
            Display Name
          </Label>
          <div className="flex gap-2">
            <Input
              id="profile-display-name"
              ref={inputRef}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveName();
              }}
              placeholder="Enter display name…"
              className="profile-input flex-1"
              maxLength={40}
              disabled={setDisplayName.isPending || isLoading}
              data-ocid="profile-name-input"
            />
            <Button
              onClick={handleSaveName}
              disabled={
                !nameInput.trim() ||
                setDisplayName.isPending ||
                nameInput.trim() === profile?.displayName
              }
              size="sm"
              className="shrink-0"
              data-ocid="profile-save-btn"
            >
              {setDisplayName.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : nameSaved ? (
                <CheckCircle2 className="w-4 h-4 text-green-400" />
              ) : (
                "Save"
              )}
            </Button>
          </div>

          {setDisplayName.isError && (
            <p className="text-xs text-destructive mt-1">
              {setDisplayName.error?.message ?? "Failed to save"}
            </p>
          )}
          {nameSaved && (
            <p className="text-xs text-green-400 mt-1">Display name updated!</p>
          )}
        </div>

        {/* Estimated values preference */}
        <div className="border-t border-border pt-4 mt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-foreground">
                Show Estimated Values
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Display ADP and estimated auction values on nomination cards and
                player search.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowEstimatedValues((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-smooth ${
                showEstimatedValues
                  ? "bg-primary/10 border-primary/40 text-primary"
                  : "bg-muted border-border text-muted-foreground hover:text-foreground"
              }`}
              aria-label={
                showEstimatedValues
                  ? "Hide estimated values"
                  : "Show estimated values"
              }
              data-ocid="profile-values-toggle"
            >
              {showEstimatedValues ? "On" : "Off"}
            </button>
          </div>
        </div>

        {/* Sound preference */}
        <div className="border-t border-border pt-4 mt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-foreground">
                Sound Effects
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Auction bid and timer sounds
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleAudio}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-smooth ${
                audioOn
                  ? "bg-primary/10 border-primary/40 text-primary"
                  : "bg-muted border-border text-muted-foreground hover:text-foreground"
              }`}
              aria-label={audioOn ? "Mute sounds" : "Enable sounds"}
              data-ocid="profile-audio-toggle"
            >
              {audioOn ? (
                <Volume2 className="w-3.5 h-3.5" />
              ) : (
                <VolumeX className="w-3.5 h-3.5" />
              )}
              {audioOn ? "On" : "Off"}
            </button>
          </div>
        </div>

        {/* Push notifications preference */}
        <div className="border-t border-border pt-4 mt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-foreground">
                Push Notifications
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Get notified about auction events and updates
              </p>
              {pushPermission === "denied" && (
                <p className="text-[10px] text-muted-foreground mt-1 max-w-[14rem]">
                  Blocked in this browser. Re-enable notifications in your
                  browser site settings to receive push alerts.
                </p>
              )}
            </div>
            {pushPermission === "granted" ? (
              <button
                type="button"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-smooth bg-primary/10 border-primary/40 text-primary"
                aria-label="Push notifications enabled on this device"
                data-ocid="profile-push-toggle"
              >
                <Bell className="w-3.5 h-3.5" />
                On
              </button>
            ) : pushPermission === "denied" ? (
              <button
                type="button"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-smooth bg-muted border-border text-muted-foreground"
                aria-label="Push notifications blocked"
                data-ocid="profile-push-toggle"
              >
                <BellOff className="w-3.5 h-3.5" />
                Blocked
              </button>
            ) : pushPermission === "unsupported" ? (
              <button
                type="button"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-smooth bg-muted border-border text-muted-foreground"
                aria-label="Push notifications not supported"
                data-ocid="profile-push-toggle"
              >
                Not Supported
              </button>
            ) : (
              <button
                type="button"
                onClick={handleEnablePush}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-smooth bg-muted border-border text-muted-foreground hover:text-foreground"
                aria-label="Enable push notifications"
                data-ocid="profile-push-enable"
              >
                <Bell className="w-3.5 h-3.5" />
                Enable
              </button>
            )}
          </div>
        </div>

        {/* News on player cards preference */}
        <div className="border-t border-border pt-4 mt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-foreground">
                News on Player Cards
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Show recent NFL news on nomination cards during auctions
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowNewsOnCards((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-smooth ${
                showNewsOnCards
                  ? "bg-primary/10 border-primary/40 text-primary"
                  : "bg-muted border-border text-muted-foreground hover:text-foreground"
              }`}
              aria-label={
                showNewsOnCards
                  ? "Hide news on player cards"
                  : "Show news on player cards"
              }
              data-ocid="profile-news-toggle"
            >
              {showNewsOnCards ? "On" : "Off"}
            </button>
          </div>
        </div>

        {/* Principal ID */}
        {principalText && (
          <div className="border-t border-border pt-4 mt-4 space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                Your Principal ID
              </Label>
              <button
                type="button"
                onClick={handleCopyPrincipal}
                className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors"
                aria-label="Copy principal ID"
                data-ocid="profile-copy-principal-btn"
              >
                {principalCopied ? (
                  <CheckCircle2 className="w-3 h-3 text-green-400" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                {principalCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <input
              readOnly
              value={principalText}
              className="w-full text-[10px] font-mono bg-muted/40 border border-border/60 rounded px-2 py-1.5 text-muted-foreground select-all cursor-text"
              onClick={(e) => (e.target as HTMLInputElement).select()}
              aria-label="Principal ID (read only)"
              data-ocid="profile-principal-id"
            />
            <p className="text-[10px] text-muted-foreground/50">
              Used for admin setup and support.
            </p>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
          Your display name appears across all rooms — bidding, nominations, and
          budgets.
        </p>

        {/* Admin link — only visible to admin */}
        {isAdmin && (
          <div className="border-t border-border pt-4 mt-4">
            <button
              type="button"
              onClick={() => {
                onClose();
                router.navigate({ to: "/admin" });
              }}
              className="flex items-center gap-2 text-sm text-primary/80 hover:text-primary transition-colors font-medium"
              data-ocid="profile-admin-link"
            >
              <Shield className="w-4 h-4 shrink-0" />
              Admin Panel
            </button>
          </div>
        )}

        {/* Done button */}
        <div className="pt-4 mt-4">
          <Button
            type="button"
            onClick={onClose}
            className="w-full"
            data-ocid="profile-done-btn"
          >
            Done
          </Button>
        </div>
      </dialog>
    </div>
  );
}
