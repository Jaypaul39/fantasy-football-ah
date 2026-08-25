import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ChevronDown,
  ChevronUp,
  PanelRightClose,
  PanelRightOpen,
  Wallet,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { AuctionState, getAvailableBudget } from "../types";
import type { ParticipantView, RoomView } from "../types";
import ParticipantBudgetCard from "./ParticipantBudgetCard";
import WonPlayersList from "./WonPlayersList";

interface BudgetSidebarProps {
  roomView: RoomView;
  /** When true, renders as a full-width panel (for the Teams tab) instead of a sidebar */
  fullWidth?: boolean;
}

export default function BudgetSidebar({
  roomView,
  fullWidth = false,
}: BudgetSidebarProps) {
  const { principalText } = useAuth();
  const [rosterOpen, setRosterOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  const { room, participants } = roomView;
  const isCompleted = room.state === AuctionState.Completed;

  const maxRosterSize = (() => {
    const s = room.settings as unknown as { maxRosterSize?: bigint[] };
    if (s.maxRosterSize && s.maxRosterSize.length > 0) {
      return Number(s.maxRosterSize[0]);
    }
    return null;
  })();

  const currentUserPrincipal = principalText;

  // Sort by available budget descending — uses backend value via helper
  const sortedParticipants = useMemo(
    () =>
      [...participants].sort((a, b) => {
        const aAvail = getAvailableBudget(a.budgetView);
        const bAvail = getAvailableBudget(b.budgetView);
        return Number(bAvail - aAvail);
      }),
    [participants],
  );

  const currentParticipant = useMemo(
    () =>
      participants.find((p) => p.userId.toText() === currentUserPrincipal) ??
      null,
    [participants, currentUserPrincipal],
  );

  const allWonPlayers = useMemo(
    () => participants.flatMap((p: ParticipantView) => p.wonPlayers),
    [participants],
  );

  const SidebarContent = (
    <div className="flex flex-col h-full">
      {/* Sidebar header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" />
          <span className="font-display font-bold text-sm text-foreground">
            Budgets & Roster
          </span>
        </div>
        <Badge className="bg-muted text-muted-foreground border-0 font-mono text-[10px]">
          {participants.length} teams
        </Badge>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="p-3 space-y-3">
          {/* Participant budget cards */}
          <section>
            <div className="space-y-2" data-ocid="budget-sidebar-teams">
              {sortedParticipants.map((p) => (
                <ParticipantBudgetCard
                  key={p.userId.toText()}
                  participant={p}
                  isCurrentUser={p.userId.toText() === currentUserPrincipal}
                  isAdmin={p.userId.toText() === room.admin.toText()}
                  maxRosterSize={maxRosterSize}
                />
              ))}
            </div>
          </section>

          {/* Won Players section */}
          <section>
            <button
              type="button"
              onClick={() => setRosterOpen((v) => !v)}
              className="w-full flex items-center justify-between px-1 py-1.5 group"
              data-ocid="roster-toggle"
              aria-expanded={rosterOpen}
            >
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold group-hover:text-foreground transition-colors">
                {isCompleted ? "All Rosters" : "My Roster"}
              </p>
              {rosterOpen ? (
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>

            {rosterOpen && (
              <div
                className="mt-1 bg-muted/30 rounded-lg p-2"
                data-ocid="roster-panel"
              >
                {isCompleted ? (
                  <WonPlayersList
                    wonPlayers={allWonPlayers}
                    showAll
                    participants={sortedParticipants}
                  />
                ) : (
                  <WonPlayersList
                    wonPlayers={currentParticipant?.wonPlayers ?? []}
                    showAll={false}
                  />
                )}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  );

  // Full-width mode: used by the Teams tab — just render the content directly
  if (fullWidth) {
    return (
      <div
        className="flex flex-col bg-card min-h-full"
        data-ocid="budget-sidebar-fullwidth"
      >
        {SidebarContent}
      </div>
    );
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:flex flex-col w-72 xl:w-80 bg-card border-l border-border h-full flex-shrink-0"
        data-ocid="budget-sidebar-desktop"
      >
        {SidebarContent}
      </aside>

      {/* Mobile: floating toggle button */}
      <div
        className="lg:hidden fixed bottom-4 right-4 z-40"
        data-ocid="budget-sidebar-mobile-toggle"
      >
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="flex items-center gap-2 bg-card border border-primary/50 border-glow-cyan text-primary rounded-full px-4 py-2.5 shadow-lg font-mono text-xs font-semibold transition-smooth active:scale-95"
          aria-label={
            mobileOpen ? "Close budget sidebar" : "Open budget sidebar"
          }
        >
          {mobileOpen ? (
            <PanelRightClose className="w-4 h-4" />
          ) : (
            <PanelRightOpen className="w-4 h-4" />
          )}
          Budgets
        </button>
      </div>

      {/* Mobile slide-over panel */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-30 flex"
          data-ocid="budget-sidebar-mobile-panel"
        >
          {/* Backdrop */}
          <button
            type="button"
            className="flex-1 bg-background/60 backdrop-blur-sm cursor-default"
            onClick={() => setMobileOpen(false)}
            onKeyDown={(e) => e.key === "Escape" && setMobileOpen(false)}
            aria-label="Close budget sidebar"
          />
          {/* Panel */}
          <div className="w-80 max-w-[90vw] bg-card border-l border-border flex flex-col h-full shadow-xl">
            {SidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
