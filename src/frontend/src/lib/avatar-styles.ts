export const AVATAR_STYLES = [
  { id: "avataaars", label: "Cartoon", category: "Characters" },
  { id: "avataaars-neutral", label: "Cartoon Neutral", category: "Characters" },
  { id: "adventurer", label: "Adventurer", category: "Characters" },
  {
    id: "adventurer-neutral",
    label: "Adventurer Neutral",
    category: "Characters",
  },
  { id: "big-ears", label: "Big Ears", category: "Characters" },
  { id: "big-ears-neutral", label: "Big Ears Neutral", category: "Characters" },
  { id: "big-smile", label: "Big Smile", category: "Characters" },
  { id: "croodles", label: "Croodles", category: "Characters" },
  { id: "croodles-neutral", label: "Croodles Neutral", category: "Characters" },
  { id: "dylan", label: "Dylan", category: "Characters" },
  { id: "lorelei", label: "Illustrated", category: "Characters" },
  {
    id: "lorelei-neutral",
    label: "Illustrated Neutral",
    category: "Characters",
  },
  { id: "micah", label: "Micah", category: "Characters" },
  { id: "miniavs", label: "Miniavs", category: "Characters" },
  { id: "notionists", label: "Notionists", category: "Characters" },
  {
    id: "notionists-neutral",
    label: "Notionists Neutral",
    category: "Characters",
  },
  { id: "open-peeps", label: "Open Peeps", category: "Characters" },
  { id: "personas", label: "Personas", category: "Characters" },
  { id: "bottts", label: "Robot", category: "Robots & Bots" },
  { id: "bottts-neutral", label: "Robot Neutral", category: "Robots & Bots" },
  { id: "pixel-art", label: "Pixel Art", category: "Pixel & Retro" },
  {
    id: "pixel-art-neutral",
    label: "Pixel Art Neutral",
    category: "Pixel & Retro",
  },
  { id: "fun-emoji", label: "Fun Emoji", category: "Fun & Emoji" },
  { id: "identicon", label: "Pattern", category: "Patterns & Abstract" },
  { id: "icons", label: "Icon", category: "Patterns & Abstract" },
  { id: "shapes", label: "Shapes", category: "Patterns & Abstract" },
  { id: "rings", label: "Rings", category: "Patterns & Abstract" },
  { id: "thumbs", label: "Thumbs", category: "Patterns & Abstract" },
  { id: "disco", label: "Disco", category: "Patterns & Abstract" },
  { id: "glass", label: "Glass", category: "Patterns & Abstract" },
  { id: "glyphs", label: "Glyphs", category: "Patterns & Abstract" },
  {
    id: "initial-face",
    label: "Initial Face",
    category: "Patterns & Abstract",
  },
  { id: "shape-grid", label: "Shape Grid", category: "Patterns & Abstract" },
  { id: "stripes", label: "Stripes", category: "Patterns & Abstract" },
  { id: "triangles", label: "Triangles", category: "Patterns & Abstract" },
] as const;

export type AvatarStyle = (typeof AVATAR_STYLES)[number];

export const AVATAR_CATEGORIES = [
  "Characters",
  "Robots & Bots",
  "Pixel & Retro",
  "Fun & Emoji",
  "Patterns & Abstract",
] as const;

export function getStylesByCategory(): Record<string, AvatarStyle[]> {
  const map: Record<string, AvatarStyle[]> = {};
  for (const style of AVATAR_STYLES) {
    if (!map[style.category]) map[style.category] = [];
    map[style.category].push(style);
  }
  return map;
}

export function dicebearUrl(style: string, seed: string): string {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

export const BORING_AVATAR_STYLES = [
  { id: "marble", label: "Marble" },
  { id: "beam", label: "Beam" },
  { id: "pixel", label: "Pixel" },
  { id: "sunset", label: "Sunset" },
  { id: "ring", label: "Ring" },
  { id: "bauhaus", label: "Bauhaus" },
] as const;

export type BoringAvatarStyle = (typeof BORING_AVATAR_STYLES)[number];

export const BORING_AVATAR_PALETTES = {
  warm: { label: "Warm", colors: ["e9c46a", "f4a261", "e76f51"] },
  cool: { label: "Cool", colors: ["264653", "2a9d8f", "3a86ff"] },
  vibrant: { label: "Vibrant", colors: ["8338ec", "ff006e", "06ffa5"] },
} as const;

export type BoringAvatarPaletteKey = keyof typeof BORING_AVATAR_PALETTES;

export function boringAvatarUrl(
  variant: string,
  seed: string,
  palette?: BoringAvatarPaletteKey,
): string {
  let url = `https://boringavatarsapi.hkom.org/${encodeURIComponent(seed)}.svg?variant=${encodeURIComponent(variant)}`;
  if (palette && BORING_AVATAR_PALETTES[palette]) {
    const colors = BORING_AVATAR_PALETTES[palette].colors.join(",");
    url += `&colors=${colors}`;
  }
  return url;
}

export function isBoringAvatarStyle(id: string): boolean {
  return BORING_AVATAR_STYLES.some((s) => s.id === id);
}

export function parseAvatarUrl(avatarUrl: string | null | undefined): {
  styleId: string;
  seed: string | null;
  isBoring: boolean;
} {
  if (!avatarUrl) return { styleId: "", seed: null, isBoring: false };

  // Boring Avatars format: boring:{variant}::seed
  if (avatarUrl.startsWith("boring:")) {
    const rest = avatarUrl.slice("boring:".length);
    if (rest.includes("::")) {
      const [variant, seed] = rest.split("::");
      return { styleId: variant, seed, isBoring: true };
    }
    return { styleId: rest, seed: null, isBoring: true };
  }

  // DiceBear format: styleId::seed
  if (avatarUrl.includes("::")) {
    const [styleId, seed] = avatarUrl.split("::");
    return { styleId, seed, isBoring: false };
  }

  return { styleId: avatarUrl, seed: null, isBoring: false };
}
