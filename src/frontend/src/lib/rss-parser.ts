export interface NewsItem {
  headline: string;
  source: string;
  timestamp: Date;
  description: string;
  link: string;
}

function inferSource(link: string): string {
  const lower = link.toLowerCase();
  if (lower.includes("espn")) return "ESPN";
  if (lower.includes("nfl.com")) return "NFL.com";
  if (lower.includes("foxsports")) return "FOX Sports";
  if (lower.includes("pff")) return "PFF";
  return "ESPN";
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "");
}

function parseSingleFeed(xmlText: string): NewsItem[] {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");

    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      return [];
    }

    const items = doc.querySelectorAll("item");
    if (items.length === 0) {
      return [];
    }

    const newsItems: NewsItem[] = [];

    for (const item of items) {
      const titleEl = item.querySelector("title");
      const pubDateEl = item.querySelector("pubDate");
      const descriptionEl = item.querySelector("description");
      const linkEl = item.querySelector("link");
      const sourceEl = item.querySelector("source");

      const headline = titleEl?.textContent?.trim() ?? "";
      const link = linkEl?.textContent?.trim() ?? "";
      const description = descriptionEl?.textContent?.trim() ?? "";
      let source = sourceEl?.textContent?.trim() ?? "";

      if (!source) {
        source = inferSource(link);
      }

      let timestamp: Date;
      if (pubDateEl?.textContent) {
        timestamp = new Date(pubDateEl.textContent.trim());
        if (Number.isNaN(timestamp.getTime())) {
          timestamp = new Date();
        }
      } else {
        timestamp = new Date();
      }

      if (headline && link) {
        newsItems.push({
          headline,
          source,
          timestamp,
          description,
          link,
        });
      }
    }

    return newsItems;
  } catch {
    return [];
  }
}

export function parseRss(xmlText: string): NewsItem[] {
  // The backend may return a single RSS feed or multiple concatenated feeds.
  // Split on the XML declaration to detect multiple feeds.
  const feedTexts = xmlText
    .split(/(?=<\?xml)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const allItems: NewsItem[] = [];

  for (const feedText of feedTexts) {
    const items = parseSingleFeed(feedText);
    allItems.push(...items);
  }

  // Deduplicate by normalized title — keep the newest article when duplicates exist.
  const seen = new Map<string, NewsItem>();
  for (const item of allItems) {
    const key = normalizeTitle(item.headline);
    const existing = seen.get(key);
    if (!existing || item.timestamp > existing.timestamp) {
      seen.set(key, item);
    }
  }

  const deduped = Array.from(seen.values());

  // Sort by pubDate descending (newest first).
  deduped.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return deduped;
}
