import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Newspaper, RefreshCw } from "lucide-react";
import { useBackend } from "../hooks/useBackend";
import { parseRss } from "../lib/rss-parser";
import { relativeTime } from "../lib/time-utils";

export function NewsTab() {
  const { actor } = useBackend();
  const queryClient = useQueryClient();

  const {
    data: newsItems,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["nfl-news"],
    queryFn: async () => {
      if (!actor) return [];
      const xml = await actor.fetchRssFeeds();
      return parseRss(xml);
    },
    enabled: !!actor,
    staleTime: 15 * 60 * 1000,
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["nfl-news"] });
    void refetch();
  };

  return (
    <div className="flex flex-col flex-1 min-h-0" data-ocid="news-tab">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/90 shrink-0">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-primary" />
          <span className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground">
            NFL News
          </span>
          {newsItems && newsItems.length > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              ({newsItems.length})
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isLoading}
          className="h-8 px-2 text-muted-foreground hover:text-foreground"
          data-ocid="news-refresh-btn"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-3 min-h-0 bg-background">
        {isLoading && (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="bg-card rounded-lg border border-border/50 p-4 space-y-2"
              >
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        )}

        {error && !isLoading && (
          <div
            className="flex flex-col items-center justify-center h-full min-h-[120px] gap-3"
            data-ocid="news-error-state"
          >
            <p className="text-sm text-muted-foreground text-center">
              Couldn&apos;t load news feed.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={handleRefresh}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              data-ocid="news-retry-btn"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Retry
            </Button>
          </div>
        )}

        {!isLoading && !error && newsItems && newsItems.length === 0 && (
          <div
            className="flex flex-col items-center justify-center h-full min-h-[120px] gap-2"
            data-ocid="news-empty-state"
          >
            <Newspaper className="w-7 h-7 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground text-center">
              No news items available.
            </p>
          </div>
        )}

        {!isLoading &&
          !error &&
          newsItems &&
          newsItems.map((item, idx) => (
            <article
              key={`${item.link}-${idx}`}
              className="bg-card rounded-lg border border-border/50 p-4 space-y-2 transition-smooth hover:border-border/80 hover:shadow-[0_2px_8px_rgba(0,0,0,0.2)]"
              data-ocid={`news-item.${idx + 1}`}
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-sm text-foreground leading-snug flex-1">
                  {item.headline}
                </h3>
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                  aria-label="Open article in new tab"
                  data-ocid={`news-external-link.${idx + 1}`}
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                  {item.source}
                </span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {relativeTime(item.timestamp)}
                </span>
              </div>

              {item.description && (
                <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                  {item.description}
                </p>
              )}
            </article>
          ))}
      </div>
    </div>
  );
}
