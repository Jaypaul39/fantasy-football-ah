import { Badge } from "@/components/ui/badge";
import { Trophy, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useNflNews } from "../hooks/useNflNews";
import type { NewsItem } from "../lib/rss-parser";
import { relativeTime } from "../lib/time-utils";
import type { RosterSettings } from "../types";
import type { ParticipantView, WonPlayer } from "../types";

interface SlottedRosterViewProps {
  wonPlayers: WonPlayer[];
  rosterSettings: RosterSettings;
  maxRosterSize: number;
}

interface SlotAssignment {
  position: string;
  label: string;
  player: WonPlayer | null;
}

function assignSlotsToPlayers(
  players: WonPlayer[],
  rosterSettings: RosterSettings,
): SlotAssignment[] {
  const slots: SlotAssignment[] = [];
  const used = new Set<number>();

  const flexPositions = rosterSettings.flexPositions ?? ["RB", "WR", "TE"];
  const superflexPositions = rosterSettings.superflexPositions ?? [
    "QB",
    "RB",
    "WR",
    "TE",
  ];

  // Helper to find next unused player index matching a position
  const findNext = (positions: string[]) => {
    for (let i = 0; i < players.length; i++) {
      if (used.has(i)) continue;
      if (positions.includes(players[i].position.toUpperCase())) {
        used.add(i);
        return players[i];
      }
    }
    return null;
  };

  // Natural position slots
  const naturalPositions = [
    { key: "QB", count: rosterSettings.qb ?? 0 },
    { key: "RB", count: rosterSettings.rb ?? 0 },
    { key: "WR", count: rosterSettings.wr ?? 0 },
    { key: "TE", count: rosterSettings.te ?? 0 },
  ];

  for (const { key, count } of naturalPositions) {
    for (let i = 0; i < count; i++) {
      slots.push({ position: key, label: key, player: findNext([key]) });
    }
  }

  // FLEX slots
  const flexCount = rosterSettings.flex ?? 0;
  for (let i = 0; i < flexCount; i++) {
    slots.push({
      position: "FLEX",
      label: "FLX",
      player: findNext(flexPositions),
    });
  }

  // SUPERFLEX slots
  const superflexCount = rosterSettings.superflex ?? 0;
  for (let i = 0; i < superflexCount; i++) {
    slots.push({
      position: "SUPERFLEX",
      label: "SFX",
      player: findNext(superflexPositions),
    });
  }

  // Bench slots — remaining players fill in order won
  const benchCount = rosterSettings.bench ?? 0;
  for (let i = 0; i < benchCount; i++) {
    let player: WonPlayer | null = null;
    for (let j = 0; j < players.length; j++) {
      if (!used.has(j)) {
        used.add(j);
        player = players[j];
        break;
      }
    }
    slots.push({ position: "BN", label: "BN", player });
  }

  return slots;
}

function SlottedRosterView({
  wonPlayers,
  rosterSettings,
  maxRosterSize,
}: SlottedRosterViewProps) {
  const slots = useMemo(
    () => assignSlotsToPlayers(wonPlayers, rosterSettings),
    [wonPlayers, rosterSettings],
  );

  const filledCount = slots.filter((s) => s.player != null).length;

  const positionBadgeStyle = (pos: string) => {
    switch (pos) {
      case "QB":
        return "bg-red-500/20 text-red-400";
      case "RB":
        return "bg-green-500/20 text-green-400";
      case "WR":
        return "bg-blue-400/20 text-blue-400";
      case "TE":
        return "bg-orange-500/20 text-orange-400";
      case "FLEX":
        return "bg-cyan-500/20 text-cyan-400";
      case "SUPERFLEX":
        return "bg-violet-500/20 text-violet-400";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
        <span
          className={
            filledCount >= maxRosterSize ? "text-emerald-400 font-semibold" : ""
          }
        >
          {filledCount} / {maxRosterSize} players
        </span>
      </div>
      {slots.map((slot, idx) => (
        <div
          key={`${slot.position}-${idx}`}
          className={`flex items-center gap-2 py-1.5 px-2 rounded-md ${
            slot.player
              ? "bg-muted/20 border border-border/40"
              : "bg-muted/10 border border-dashed border-border/30"
          }`}
          data-ocid="slotted-roster-row"
        >
          <Badge
            className={`${positionBadgeStyle(slot.position)} border-0 text-[10px] font-mono font-bold w-8 text-center flex-shrink-0 justify-center`}
          >
            {slot.label}
          </Badge>
          {slot.player ? (
            <>
              <span className="text-sm font-semibold text-foreground truncate flex-1 min-w-0">
                {slot.player.playerName}
              </span>
              {slot.player.byeWeek != null ? (
                <span
                  className="text-[10px] text-muted-foreground/70 font-mono flex-shrink-0"
                  data-ocid="slotted-roster-bye-week"
                >
                  Bye {slot.player.byeWeek.toString()}
                </span>
              ) : null}
              <span className="text-emerald-400 font-mono text-xs font-semibold flex-shrink-0">
                ${slot.player.winningBid.toString()}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground/40 italic text-sm">—</span>
          )}
        </div>
      ))}
    </div>
  );
}

function matchNewsToPlayer(
  newsItems: NewsItem[],
  playerName: string,
): NewsItem[] {
  const parts = playerName.trim().split(/\s+/);
  const firstName = parts[0]?.toLowerCase() ?? "";
  const lastName = parts.slice(1).join(" ").toLowerCase() ?? "";
  const fullName = playerName.toLowerCase();

  const scored = newsItems.map((item) => {
    const text = `${item.headline} ${item.description}`.toLowerCase();

    // Priority 1 — full name match
    if (text.includes(fullName)) return { item, score: 3 };

    // Priority 2 — first + last name match (both must be present)
    if (
      firstName &&
      lastName &&
      text.includes(firstName) &&
      text.includes(lastName)
    ) {
      return { item, score: 2 };
    }

    // Priority 3 — last name only (length >= 6 to avoid false matches)
    if (lastName.length >= 6 && text.includes(lastName)) {
      return { item, score: 1 };
    }

    return { item, score: 0 };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}

interface PlayerNewsSectionProps {
  playerName: string;
}

function PlayerNewsSection({ playerName }: PlayerNewsSectionProps) {
  const { newsItems, isLoading } = useNflNews();

  const matched = useMemo(
    () => matchNewsToPlayer(newsItems, playerName).slice(0, 3),
    [newsItems, playerName],
  );

  if (isLoading) {
    return (
      <div className="space-y-2 mt-2" data-ocid="player-news-loading">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
          Recent News
        </p>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-10 bg-white/5 rounded-lg animate-pulse"
              data-ocid={`player-news-skeleton.item.${i}`}
            />
          ))}
        </div>
      </div>
    );
  }

  if (matched.length === 0) {
    return (
      <div className="mt-2" data-ocid="player-news-empty_state">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1.5">
          Recent News
        </p>
        <p className="text-xs text-muted-foreground/60">
          No news found for {playerName}.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2" data-ocid="player-news-section">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1.5">
        Recent News
      </p>
      <div className="space-y-2">
        {matched.map((item, index) => (
          <a
            key={item.link}
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/15 rounded-lg p-2.5 transition-colors group"
            data-ocid={`player-news.item.${index + 1}`}
          >
            <p className="text-xs font-medium text-foreground group-hover:text-primary transition-colors line-clamp-2 leading-snug">
              {item.headline}
            </p>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[10px] text-muted-foreground/70">
                {item.source}
              </span>
              <span className="text-[10px] text-muted-foreground/40">•</span>
              <span className="text-[10px] text-muted-foreground/50">
                {relativeTime(item.timestamp)}
              </span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

type SortMode = "bid" | "name" | "position";

interface WonPlayersListProps {
  wonPlayers: WonPlayer[];
  showAll?: boolean;
  participants?: ParticipantView[];
  rosterSettings?: RosterSettings | null;
  maxRosterSize?: number;
}

const POSITION_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  QB: { bg: "bg-red-500/20", text: "text-red-400", label: "QB" },
  RB: { bg: "bg-green-500/20", text: "text-green-400", label: "RB" },
  WR: { bg: "bg-blue-400/20", text: "text-blue-400", label: "WR" },
  TE: { bg: "bg-orange-500/20", text: "text-orange-400", label: "TE" },
  K: { bg: "bg-muted", text: "text-muted-foreground", label: "K" },
  DEF: { bg: "bg-purple-500/20", text: "text-purple-400", label: "DEF" },
};

function positionStyle(pos: string) {
  return (
    POSITION_STYLES[pos.toUpperCase()] ?? {
      bg: "bg-muted",
      text: "text-muted-foreground",
      label: pos,
    }
  );
}

function sortWonPlayers(players: WonPlayer[], mode: SortMode): WonPlayer[] {
  return [...players].sort((a, b) => {
    if (mode === "bid") return Number(b.winningBid - a.winningBid);
    if (mode === "name") return a.playerName.localeCompare(b.playerName);
    if (mode === "position") return a.position.localeCompare(b.position);
    return 0;
  });
}

function PlayerRow({ player }: { player: WonPlayer }) {
  const ps = positionStyle(player.position);
  return (
    <div
      className="py-2 px-2 rounded-md hover:bg-muted/40 transition-colors group"
      data-ocid="won-player-row"
    >
      <div className="flex items-center gap-2.5">
        <Badge
          className={`${ps.bg} ${ps.text} border-0 text-[10px] font-mono font-bold w-8 text-center flex-shrink-0 justify-center`}
        >
          {ps.label}
        </Badge>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate leading-tight">
            {player.playerName}
          </p>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
            <span>{player.team}</span>
            {player.byeWeek != null ? (
              <span
                className="text-muted-foreground/70"
                data-ocid="won-player-bye-week"
              >
                · Bye {player.byeWeek.toString()}
              </span>
            ) : null}
          </div>
        </div>
        <span className="font-mono text-sm font-bold text-secondary text-glow-lime flex-shrink-0">
          ${player.winningBid.toString()}
        </span>
      </div>
      <PlayerNewsSection playerName={player.playerName} />
    </div>
  );
}

function SummaryLine({ players }: { players: WonPlayer[] }) {
  if (players.length === 0) return null;
  const total = players.reduce((acc, p) => acc + p.winningBid, 0n);
  return (
    <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">
        {players.length} player{players.length !== 1 ? "s" : ""}
      </span>
      <span className="font-mono font-semibold text-foreground">
        ${total.toString()} total
      </span>
    </div>
  );
}

export default function WonPlayersList({
  wonPlayers,
  showAll = false,
  participants = [],
  rosterSettings,
  maxRosterSize,
}: WonPlayersListProps) {
  const [sort, setSort] = useState<SortMode>("bid");

  const SORTS: { key: SortMode; label: string }[] = [
    { key: "bid", label: "By Bid" },
    { key: "name", label: "By Name" },
    { key: "position", label: "By Pos" },
  ];

  const sortedPlayers = useMemo(
    () => sortWonPlayers(wonPlayers, sort),
    [wonPlayers, sort],
  );

  // Group by participant for showAll mode
  const participantGroups = useMemo(() => {
    if (!showAll || participants.length === 0) return null;
    return participants
      .map((p) => ({
        participant: p,
        players: sortWonPlayers(p.wonPlayers, sort),
      }))
      .filter((g) => g.players.length > 0);
  }, [showAll, participants, sort]);

  return (
    <div className="space-y-2" data-ocid="won-players-list">
      {/* Sort controls */}
      <div className="flex items-center gap-1">
        {SORTS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setSort(key)}
            data-ocid={`sort-${key}`}
            className={`text-[10px] font-mono px-2 py-0.5 rounded transition-smooth border ${
              sort === key
                ? "bg-primary/20 text-primary border-primary/50"
                : "bg-transparent text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {wonPlayers.length === 0 && !showAll && (
        <div
          className="flex flex-col items-center justify-center py-6 gap-2 text-center"
          data-ocid="won-players-empty"
        >
          <Trophy className="w-7 h-7 text-muted-foreground/30" />
          <p className="text-xs font-medium text-muted-foreground">
            No players won yet
          </p>
          <p className="text-[11px] text-muted-foreground/60">
            Players you win will appear here
          </p>
        </div>
      )}

      {/* ShowAll mode — group by participant */}
      {showAll && participantGroups && (
        <div className="space-y-4">
          {participantGroups.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-6 gap-2 text-center"
              data-ocid="won-players-empty-all"
            >
              <Users className="w-7 h-7 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">
                No players drafted yet
              </p>
            </div>
          ) : (
            participantGroups.map(({ participant, players }) => (
              <div key={participant.userId.toText()} className="space-y-1">
                <div className="flex items-center justify-between pb-1">
                  <span className="text-[11px] font-semibold font-display text-foreground uppercase tracking-wide">
                    {participant.displayName}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {players.length} picks
                  </span>
                </div>
                {rosterSettings && maxRosterSize ? (
                  <SlottedRosterView
                    wonPlayers={players}
                    rosterSettings={rosterSettings}
                    maxRosterSize={maxRosterSize}
                  />
                ) : (
                  <>
                    {players.map((p) => (
                      <PlayerRow key={p.playerId} player={p} />
                    ))}
                    <SummaryLine players={players} />
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Normal mode — flat list */}
      {!showAll && sortedPlayers.length > 0 && (
        <div className="space-y-0.5">
          {sortedPlayers.map((p) => (
            <PlayerRow key={p.playerId} player={p} />
          ))}
          <SummaryLine players={sortedPlayers} />
        </div>
      )}
    </div>
  );
}
