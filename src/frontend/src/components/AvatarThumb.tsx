/**
 * AvatarThumb — circular avatar with initials or DiceBear image.
 * Used in nomination order, budget cards, bid panels, chat, header.
 */
import {
  AVATAR_STYLES,
  BORING_AVATAR_PALETTES,
  type BoringAvatarPaletteKey,
  boringAvatarUrl,
  dicebearUrl,
  isBoringAvatarStyle,
  parseAvatarUrl,
} from "@/lib/avatar-styles";

interface AvatarThumbProps {
  displayName: string;
  avatarUrl?: string | null;
  seed: string;
  size?: number;
  highlight?: boolean;
  className?: string;
}

function getBoringPalette(): BoringAvatarPaletteKey {
  try {
    const stored = localStorage.getItem("boring-avatar-palette");
    if (stored === "warm" || stored === "cool" || stored === "vibrant") {
      return stored;
    }
  } catch {
    // ignore
  }
  return "warm";
}

export function AvatarThumb({
  displayName,
  avatarUrl,
  seed,
  size = 32,
  highlight = false,
  className = "",
}: AvatarThumbProps) {
  const dim = `${size}px`;
  const parsed = parseAvatarUrl(avatarUrl);

  if (
    parsed.isBoring &&
    parsed.styleId &&
    isBoringAvatarStyle(parsed.styleId)
  ) {
    const effectiveSeed = parsed.seed ?? seed;
    const palette = getBoringPalette();
    return (
      <img
        src={boringAvatarUrl(parsed.styleId, effectiveSeed, palette)}
        alt={displayName}
        loading="lazy"
        decoding="async"
        style={{ width: dim, height: dim }}
        className={`rounded-full flex-shrink-0 ${
          highlight ? "border border-primary/40" : "border border-border/40"
        } ${className}`}
      />
    );
  }

  const isKnownDiceBear = parsed.styleId
    ? AVATAR_STYLES.some((s) => s.id === parsed.styleId)
    : false;

  if (isKnownDiceBear) {
    const effectiveSeed = parsed.seed ?? seed;
    return (
      <img
        src={dicebearUrl(parsed.styleId, effectiveSeed)}
        alt={displayName}
        loading="lazy"
        decoding="async"
        style={{ width: dim, height: dim }}
        className={`rounded-full flex-shrink-0 ${
          highlight ? "border border-primary/40" : "border border-border/40"
        } ${className}`}
      />
    );
  }

  const initials = (displayName || "?").trim().charAt(0).toUpperCase();

  return (
    <div
      style={{
        width: dim,
        height: dim,
        fontSize: `${Math.round(size * 0.4)}px`,
      }}
      className={`rounded-full flex items-center justify-center flex-shrink-0 font-bold select-none ${
        highlight
          ? "bg-primary/20 text-primary border border-primary/40"
          : "bg-muted text-muted-foreground border border-border/40"
      } ${className}`}
      aria-label={displayName}
    >
      {initials}
    </div>
  );
}
