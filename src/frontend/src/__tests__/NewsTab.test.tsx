import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { backendInterface } from "../backend.d.ts";
import { NewsTab } from "../components/NewsTab";

// ── Actor mock ─────────────────────────────────────────────────────────────
// NewsTab consumes the actor through useBackend() and calls fetchRssFeeds() to
// load the news feed. We stub the hook with a typed actor mock so the component
// can be rendered in isolation without a live canister.
const fetchRssFeedsMock = vi.fn(async () => "");
const actorMock = {
  fetchRssFeeds: fetchRssFeedsMock,
} as unknown as backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

// A minimal RSS feed with two articles. The scroll fix changes the sheet
// layout, not the article rendering — this protects the article rendering
// behavior that should remain unchanged.
const TWO_ARTICLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Chiefs win the opener</title>
      <link>https://www.espn.com/nfl/story/1</link>
      <description>Kansas City opened the season with a win.</description>
      <pubDate>Wed, 20 Aug 2026 12:00:00 GMT</pubDate>
      <source>ESPN</source>
    </item>
    <item>
      <title>Rookie QB impresses in debut</title>
      <link>https://www.nfl.com/news/story/2</link>
      <description>The first-round pick threw for three scores.</description>
      <pubDate>Wed, 20 Aug 2026 13:00:00 GMT</pubDate>
      <source>NFL.com</source>
    </item>
  </channel>
</rss>`;

function renderNewsTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewsTab />
    </QueryClientProvider>,
  );
}

describe("NewsTab article rendering", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the news header", () => {
    renderNewsTab();
    expect(screen.getByText("NFL News")).toBeInTheDocument();
  });

  it("renders every loaded article headline and source", async () => {
    fetchRssFeedsMock.mockResolvedValue(TWO_ARTICLE_FEED);
    renderNewsTab();

    expect(
      await screen.findByText("Chiefs win the opener"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Rookie QB impresses in debut"),
    ).toBeInTheDocument();
    expect(screen.getByText("ESPN")).toBeInTheDocument();
    expect(screen.getByText("NFL.com")).toBeInTheDocument();
  });

  it("shows the article count in the header", async () => {
    fetchRssFeedsMock.mockResolvedValue(TWO_ARTICLE_FEED);
    renderNewsTab();

    await screen.findByText("Chiefs win the opener");
    expect(screen.getByText("(2)")).toBeInTheDocument();
  });

  it("renders an external link for each article", async () => {
    fetchRssFeedsMock.mockResolvedValue(TWO_ARTICLE_FEED);
    renderNewsTab();

    await screen.findByText("Chiefs win the opener");
    const links = screen.getAllByRole("link", {
      name: "Open article in new tab",
    });
    expect(links).toHaveLength(2);
    // Articles are sorted newest-first by pubDate, so the 13:00 NFL.com
    // article renders before the 12:00 ESPN article.
    expect(links[0]).toHaveAttribute(
      "href",
      "https://www.nfl.com/news/story/2",
    );
    expect(links[1]).toHaveAttribute(
      "href",
      "https://www.espn.com/nfl/story/1",
    );
  });

  it("shows the empty state when the feed has no articles", async () => {
    fetchRssFeedsMock.mockResolvedValue("");
    renderNewsTab();

    expect(
      await screen.findByText("No news items available."),
    ).toBeInTheDocument();
  });

  it("refetches the feed when the refresh button is clicked", async () => {
    const user = userEvent.setup();
    fetchRssFeedsMock.mockResolvedValue(TWO_ARTICLE_FEED);
    renderNewsTab();

    await screen.findByText("Chiefs win the opener");
    expect(fetchRssFeedsMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "" }));
    await waitFor(() => {
      expect(fetchRssFeedsMock.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
