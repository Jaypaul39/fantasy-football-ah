import { Trophy } from "lucide-react";
import type {
  BracketSlot,
  BracketSlotState,
  GameStatus,
  PlayoffBracketResult,
  PlayoffGameResult,
} from "../backend.d.ts";
import { useGetPlayoffBracket } from "../hooks/useGetPlayoffBracket";

interface PlayoffBracketTabProps {
  roomId: string;
  /** Number of playoff teams (4, 6, or 8) — drives the round labels. */
  playoffTeams: number;
  /** principal text -> display name, built from the room's participants. */
  participantNames: Record<string, string>;
}

// Round labels left-to-right by playoff-team count. The backend derives
// playoffRounds(playoffTeams): 2 for 4 teams, 3 for 6 or 8 teams.
const ROUND_LABELS: Record<number, string[]> = {
  4: ["Semifinals", "Finals"],
  6: ["Quarterfinals", "Semifinals", "Finals"],
  8: ["Quarterfinals", "Semifinals", "Finals"],
};

/**
 * Read-only playoff bracket for a Head-to-Head room with playoffs.
 *
 * Games are grouped by week (each playoff week is one round) and laid out
 * left-to-right, with a final Champion column. Resolved games show both
 * participants with their scores and the winner highlighted; pending games
 * show TBD with a dash (never a numeric 0) and a badge distinguishing
 * pending-on-sync ("awaiting sync", pulsing cyan) from pending-on-dependency
 * ("TBD", static muted). The champion is shown once the final game resolves,
 * or an in-progress indicator otherwise. Read-only — no editing controls.
 */
export function PlayoffBracketTab({
  roomId,
  playoffTeams,
  participantNames,
}: PlayoffBracketTabProps) {
  const { bracket, isLoading } = useGetPlayoffBracket(roomId);

  if (isLoading) {
    return (
      <div className="space-y-4" data-ocid="bracket-loading">
        <div className="h-8 w-48 skeleton-shimmer rounded" aria-hidden="true" />
        <div
          className="grid gap-6 md:gap-8"
          style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        >
          {[0, 1, 2].map((col) => (
            <div key={col} className="space-y-4">
              <div
                className="h-4 w-24 mx-auto skeleton-shimmer rounded"
                aria-hidden="true"
              />
              {[0, 1].map((row) => (
                <div
                  key={row}
                  className="h-20 skeleton-shimmer rounded-lg"
                  aria-hidden="true"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!bracket) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-16 text-center"
        data-ocid="bracket-empty"
      >
        <Trophy className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-muted-foreground text-sm">
          The playoff bracket is not available yet.
        </p>
      </div>
    );
  }

  const rounds = groupByWeek(bracket.games);
  const labels = ROUND_LABELS[playoffTeams] ?? [];
  const columns = rounds.length + 1; // rounds + champion column

  return (
    <div className="space-y-6" data-ocid="bracket-view">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-foreground">
          Playoff Bracket
        </h2>
        <span className="font-mono text-xs text-muted-foreground">
          {playoffTeams}-team bracket
        </span>
      </div>

      <div className="overflow-x-auto pb-2 scrollbar-thin">
        <div
          className="bracket-grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(220px, 1fr))`,
          }}
        >
          {rounds.map((round, roundIdx) => (
            <div key={round[0].game.week} className="bracket-round">
              <div
                className="bracket-round-label"
                data-ocid={`bracket-round-${roundIdx + 1}`}
              >
                {labels[roundIdx] ?? `Round ${roundIdx + 1}`}
              </div>
              {round.map((game, gameIdx) => (
                <MatchupCard
                  key={`${round[0].game.week}-${slotKey(game.game.home)}`}
                  game={game}
                  round={roundIdx + 1}
                  index={gameIdx + 1}
                  participantNames={participantNames}
                />
              ))}
            </div>
          ))}

          <div className="bracket-round">
            <div
              className="bracket-round-label"
              data-ocid="bracket-round-champion"
            >
              Champion
            </div>
            <ChampionCard
              champion={bracket.champion}
              participantNames={participantNames}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Groups games by their playoff week (each week is one round), weeks ascending. */
function groupByWeek(games: PlayoffGameResult[]): PlayoffGameResult[][] {
  const map = new Map<number, PlayoffGameResult[]>();
  for (const g of games) {
    const week = Number(g.game.week);
    const arr = map.get(week) ?? [];
    arr.push(g);
    map.set(week, arr);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, arr]) => arr);
}

/** Stable string key for a bracket slot (seed N or winner-of M). */
function slotKey(slot: BracketSlot): string {
  return slot.__kind__ === "Seed" ? `s${slot.Seed}` : `w${slot.WinnerOf}`;
}

function MatchupCard({
  game,
  round,
  index,
  participantNames,
}: {
  game: PlayoffGameResult;
  round: number;
  index: number;
  participantNames: Record<string, string>;
}) {
  const statusKind = game.status.__kind__;
  const cardClass =
    statusKind === "resolved"
      ? "bracket-matchup resolved"
      : statusKind === "pendingOnSync"
        ? "bracket-matchup pending-sync"
        : "bracket-matchup pending-dep";
  const isSync = statusKind === "pendingOnSync";

  return (
    <div className={cardClass} data-ocid={`bracket-matchup-${round}-${index}`}>
      <TeamRow
        slot={game.home}
        slotDef={game.game.home}
        status={game.status}
        side="home"
        round={round}
        index={index}
        participantNames={participantNames}
      />
      <TeamRow
        slot={game.away}
        slotDef={game.game.away}
        status={game.status}
        side="away"
        round={round}
        index={index}
        participantNames={participantNames}
      />
      {statusKind !== "resolved" && (
        <div className="px-3 pb-2">
          <span
            className={`bracket-pending-badge ${isSync ? "sync" : "dep"}`}
            data-ocid={isSync ? "bracket-pending-sync" : "bracket-pending-dep"}
          >
            {isSync ? "awaiting sync" : "TBD"}
          </span>
        </div>
      )}
    </div>
  );
}

function TeamRow({
  slot,
  slotDef,
  status,
  side,
  round,
  index,
  participantNames,
}: {
  slot: BracketSlotState;
  slotDef: BracketSlot;
  status: GameStatus;
  side: "home" | "away";
  round: number;
  index: number;
  participantNames: Record<string, string>;
}) {
  if (slot.__kind__ === "resolved") {
    const resolved = slot.resolved;
    const name = participantNames[resolved.participant.toText()] ?? "Team";
    const isWinner =
      status.__kind__ === "resolved" &&
      status.resolved.winner.toText() === resolved.participant.toText();
    return (
      <div
        className="bracket-team-row"
        data-ocid={`bracket-team-${round}-${index}-${side}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="bracket-seed filled">{Number(resolved.seed)}</span>
          <span className="bracket-team-name">{name}</span>
        </div>
        <span className={`bracket-team-score ${isWinner ? "win" : "loss"}`}>
          {resolved.score.toFixed(1)}
        </span>
      </div>
    );
  }

  // Pending slot — never show a numeric score (dash instead) so "not yet
  // played" is never read as a zero.
  const seed = slotDef.__kind__ === "Seed" ? Number(slotDef.Seed) : null;
  return (
    <div
      className="bracket-team-row"
      data-ocid={`bracket-team-${round}-${index}-${side}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="bracket-seed tbd">{seed ?? "–"}</span>
        <span className="bracket-team-name tbd">TBD</span>
      </div>
      <span className="bracket-team-score pending">–</span>
    </div>
  );
}

function ChampionCard({
  champion,
  participantNames,
}: {
  champion: PlayoffBracketResult["champion"];
  participantNames: Record<string, string>;
}) {
  if (champion.__kind__ === "some") {
    const c = champion.some;
    const name = participantNames[c.participant.toText()] ?? "Team";
    return (
      <div className="bracket-champion" data-ocid="bracket-champion">
        <div className="bracket-champion-card">
          <Trophy className="h-8 w-8 text-warning" aria-hidden="true" />
          <span className="bracket-champion-crown">Champion</span>
          <span className="bracket-champion-name">{name}</span>
          <span className="bracket-champion-score">{c.score.toFixed(1)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bracket-champion" data-ocid="bracket-champion-in-progress">
      <div className="bracket-champion-card">
        <Trophy className="h-8 w-8 text-warning/60" aria-hidden="true" />
        <span className="bracket-champion-crown">Champion</span>
        <span className="bracket-champion-name">In Progress</span>
      </div>
    </div>
  );
}
