import type { Principal } from "@icp-sdk/core/principal";
import { useState } from "react";
import type { RosterSettings } from "../backend.d.ts";
import { MyBestBallTeamTab } from "./MyBestBallTeamTab";
import { PlayoffBracketTab } from "./PlayoffBracketTab";
import { StandingsTab } from "./StandingsTab";

type ScoresSubTab = "team" | "standings" | "bracket";

interface ScoresTabProps {
  roomId: string;
  participantId: Principal | null;
  /** playerId -> display name, built from the participant's won players. */
  playerNames: Record<string, string>;
  rosterSettings?: RosterSettings;
  /** The room's season, passed from the room being viewed. */
  season?: bigint;
  /** Number of playoff teams (4, 6, or 8) — drives the bracket round labels. */
  playoffTeams: number;
  /** principal text -> display name, built from the room's participants. */
  participantNames: Record<string, string>;
  /** Whether the My Team sub-tab is available (Best Ball + participant). */
  showTeam: boolean;
  /** Whether the Standings sub-tab is available (Best Ball + participant). */
  showStandings: boolean;
  /** Whether the Bracket sub-tab is available (H2H + playoffs). */
  showBracket: boolean;
}

/**
 * Thin container for the consolidated Scores tab. Renders a sub-tab nav
 * (same pill-button pattern as the Chat | News toggle) and conditionally
 * mounts exactly one of MyBestBallTeamTab / StandingsTab / PlayoffBracketTab
 * using the same && gating each view uses today — relocated, not reinvented.
 *
 * Only the active sub-tab is mounted so at most one useBestBallAutoSync
 * instance is active. Per-component state remains sufficient; no state is
 * lifted and no shared context is added.
 */
export function ScoresTab({
  roomId,
  participantId,
  playerNames,
  rosterSettings,
  season,
  playoffTeams,
  participantNames,
  showTeam,
  showStandings,
  showBracket,
}: ScoresTabProps) {
  // Sub-tab active state lives in the parent, mirroring the chatView
  // nested-toggle pattern. Default to the first available sub-tab.
  const [subTab, setSubTab] = useState<ScoresSubTab>(() => {
    if (showTeam) return "team";
    if (showStandings) return "standings";
    return "bracket";
  });

  const subTabs: { id: ScoresSubTab; label: string; ocid: string }[] = [];
  if (showTeam)
    subTabs.push({
      id: "team",
      label: "My Team",
      ocid: "scores-view-team-tab",
    });
  if (showStandings)
    subTabs.push({
      id: "standings",
      label: "Standings",
      ocid: "scores-view-standings-tab",
    });
  if (showBracket)
    subTabs.push({
      id: "bracket",
      label: "Bracket",
      ocid: "scores-view-bracket-tab",
    });

  return (
    <div data-ocid="scores-tab">
      {/* Nested sub-tab toggle */}
      <div className="flex items-center justify-center gap-1 px-4 pt-3 pb-2">
        {subTabs.map(({ id, label, ocid }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubTab(id)}
            data-ocid={ocid}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              subTab === id
                ? "bg-primary/15 text-primary border border-primary/30"
                : "text-muted-foreground hover:text-foreground border border-transparent hover:bg-muted/50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === "team" && showTeam && (
        <div
          className="pt-4 px-4 sm:pt-6 sm:px-6 max-w-6xl mx-auto pb-44"
          data-ocid="best-ball-tab-panel"
        >
          <MyBestBallTeamTab
            roomId={roomId}
            participantId={participantId}
            playerNames={playerNames}
            rosterSettings={rosterSettings}
            season={season}
          />
        </div>
      )}

      {subTab === "standings" && showStandings && (
        <div
          className="pt-4 px-4 sm:pt-6 sm:px-6 max-w-6xl mx-auto pb-44"
          data-ocid="standings-tab-panel"
        >
          <StandingsTab
            roomId={roomId}
            participantId={participantId}
            season={season}
          />
        </div>
      )}

      {subTab === "bracket" && showBracket && (
        <div
          className="pt-4 px-4 sm:pt-6 sm:px-6 max-w-6xl mx-auto pb-44"
          data-ocid="bracket-tab-panel"
        >
          <PlayoffBracketTab
            roomId={roomId}
            playoffTeams={playoffTeams}
            participantNames={participantNames}
          />
        </div>
      )}
    </div>
  );
}
