# Design Brief

## Direction

**Neon Arena** — Real-time fantasy football auction platform with dark neon aesthetic: live bidding energy through cyan, lime, and magenta accents on deep charcoal. The new **Head-to-Head regular season** extends the arena into a **Scoreboard** — matchup cards and a W/L/T/PF standings table that read like a stadium jumbotron while preserving the existing cumulative Best Ball views. The **Playoff Bracket** extends the scoreboard into a **Tournament Board** — a left-to-right bracket tree with seed pills, resolved scores, and an amber champion glow.

## Tone

Futuristic, competitive, high-energy dark sports arena with neon signage. H2H views favor scoreboard clarity: two-team matchup cards, dense standings rows, and obvious win/loss/tie color coding.

## Differentiation

The H2H standings table uses a jumbotron scoreboard language — mono uppercase column headers, circular rank pills (lime when leading), cyan points-for, and color-coded W/L/T records — so weekly head-to-head results are scannable at a glance without breaking the existing arena aesthetic.

## Color Palette

| Token      | OKLCH           | Role                              |
| ---------- | --------------- | --------------------------------- |
| background | 0.13 0.01 260   | Dark charcoal base (arena)        |
| foreground | 0.95 0.01 260   | High-contrast text (white)        |
| card       | 0.17 0.012 260  | Elevated surfaces (dark slate)    |
| primary    | 0.72 0.22 190   | Neon cyan (actions, points-for)   |
| secondary  | 0.68 0.24 110   | Neon lime (wins, top rank, PF)    |
| accent     | 0.65 0.25 315   | Magenta (active bids/leader)      |
| destructive| 0.6 0.28 15     | Red (losses, remove/cancel)       |
| success    | 0.68 0.24 110   | Lime (positive totals/rank)       |
| warning    | 0.75 0.15 85    | Amber (near-empty / caution)      |
| muted      | 0.21 0.01 260   | Quiet backgrounds (secondary info)|

## Typography

- Display: Space Grotesk — bold headings, player/team names, slot titles
- Body: DM Sans — UI labels, chat, form inputs, bench names
- Mono: Geist Mono — points, totals, rank, W/L/T/PF, position badges, countdowns
- Scale: hero `text-5xl md:text-7xl font-bold`, h2 `text-3xl md:text-4xl font-bold`, label `text-xs font-semibold tracking-widest uppercase`, body `text-base`

## Elevation & Depth

Card layering through lightness shifts (0.13 → 0.17 → 0.21); minimal shadows — subtle/elevated box shadows on cards, `shadow-matchup` on H2H matchup cards, neon glow on interactive/live elements; no drop shadows.

## Structural Zones

| Zone        | Background     | Border                        | Notes                                             |
| ----------- | -------------- | ----------------------------- | ------------------------------------------------- |
| Header      | card (0.17)    | border-primary (cyan, 1px)    | State indicator badge; logo + room name; profile  |
| Sidebar     | sidebar (0.15) | sidebar-border (subtle)       | Room list, collapsible on mobile drawer           |
| Content     | background     | —                             | Lineup slots (elevated cards), bench, total       |
| Standings   | card (0.17)    | border-border                 | H2H table rows on card, muted/20 header band      |
| Matchups    | card (0.17)    | border-border                 | Two-team scoreboard cards, hover border-primary   |
| Bracket     | background     | —                             | Round columns (card matchup cards), champion gold |
| Snapshot    | card (0.17)    | border-border                 | Season snapshot panel, lime rank badge            |
| Profile     | popover (0.21) | border-border                 | Avatar picker grid, display name input            |

## Spacing & Rhythm

Spacious vertical rhythm (gap-6 between sections, gap-4 within groups); compact horizontal grouping; 1rem base unit. H2H standings rows tight (px-3 py-2.5) for density; matchup cards gap-4 between teams.

## Component Patterns

- Buttons: Rounded (md), primary (cyan bg + dark text), hover scale 105% + glow-cyan, 150ms transition
- Cards: Rounded (lg for sections, md for slots), card background, 1px border-border, hover lifted
- Standings table: `.standings-table` (mono uppercase header on muted/20 band, hover row muted/10), `.standings-rank` circular pill (lime `.top`), `.standings-team` display name, `.wl-record` color-coded W/L/T, `.pf-value` cyan mono
- Matchup card: `.matchup-card` (card bg, rounded-xl, hover border-primary/40, shadow-matchup), `.matchup-team` rows with `.matchup-team-score` (lime win / muted loss/tie), `.matchup-result-badge` (win lime / loss red / tie muted)
- Rank badge: `.rank-badge` (mono uppercase pill, lime when `.top`)
- Input: Dark input bg, neon border on focus (primary cyan), placeholder muted-foreground, 200ms transition

## Motion

- Entrance: Fade-in + slide-up 300ms ease-out (components on load)
- Hover: Button scale 105%, slot/matchup card border→cyan + subtle glow, 150ms smooth
- Live updates: Pulse-neon on countdown <10s (1.5s loop), bid leader glow-magenta, toast slide-in from top
- Decorative: Subtle glow halos on active nomination card

## Constraints

- No full-page backgrounds or decorative gradients — focus on content clarity
- Glow effects only on interactive/live elements (buttons, timer, active bid, selected avatar)
- High contrast maintained for readability (foreground ~0.95 on background ~0.13)
- Mobile-first responsive: sidebar drawer, full-width lineup, stacked slots, standings below matchups
- H2H views branch on competitionMode without duplicating components; bracket view is read-only, fixed-slot, no reseeding, no consolation
- Every number comes directly from backend (getWeeklyLineup/getStandings); no client-side scoring

## Signature Detail

Countdown timer at <10 seconds pulses with neon cyan glow and audible toggle in header — bidding tension in one interaction. DiceBear avatar picker offers 6 styled avatars with cyan highlight. The H2H signature is the scoreboard standings table: circular rank pills, color-coded W/L/T records, and cyan points-for that make weekly head-to-head results scannable like a stadium jumbotron. The bracket signature is the amber champion card — a gold-glow trophy that reads as the tournament's crown.

## New Component Specs

### H2H Standings Table
- **Structure**: `.standings-table` — mono uppercase header (Rank/Team/W/L/T/PF) on muted/20 band, dense rows (px-3 py-2.5), hover row muted/10
- **Rank**: `.standings-rank` circular pill, `.top` lime when leading; `.standings-team` display name
- **Record**: `.wl-record` with `.win` lime / `.loss` destructive / `.tie` muted; numeric columns right-aligned mono
- **Points For**: `.pf-value` cyan mono semibold

### H2H Matchup Card
- **Card**: `.matchup-card` (card bg, rounded-xl, hover border-primary/40, shadow-matchup)
- **Teams**: `.matchup-team` rows — `.matchup-team-name` display name + `.matchup-team-score` (lime win / muted loss/tie)
- **Result**: `.matchup-result-badge` — win lime / loss red / tie muted; `.h2h-section-label` mono uppercase section label

### Utility Classes
`standings-table`, `standings-rank`, `standings-rank.top`, `standings-team`, `wl-record`, `wl-record.win`, `wl-record.loss`, `wl-record.tie`, `pf-value`, `matchup-card`, `matchup-team`, `matchup-team-name`, `matchup-team-score`, `matchup-result-badge`, `h2h-section-label` — all token-based, no new colors

### Playoff Bracket View
- **Layout**: `.bracket-grid` (responsive grid, `gap-6 md:gap-8`) of `.bracket-round` columns (Quarterfinals → Semifinals → Finals → Champion), each with `.bracket-round-label` mono uppercase header
- **Matchup**: `.bracket-matchup` card (card bg, rounded-lg, shadow-matchup) with two `.bracket-team-row`s (divider `border-t border-border/60`); `.bracket-seed` circular pill (cyan `.filled` / muted `.tbd`)
- **Team**: `.bracket-team-name` display name (`.tbd` italic muted); `.bracket-team-score` mono bold — lime `.win` / muted `.loss` / muted `.pending`
- **Resolved vs pending**: resolved cards show numeric scores on solid `border-border`; `.pending-sync` uses dashed `border-primary/40` + pulsing cyan `.bracket-pending-badge.sync` ("awaiting sync", dash score) so it is never read as a zero; `.pending-dep` uses dashed `border-muted` + static muted `.bracket-pending-badge.dep` ("TBD") for games waiting on a prior round
- **Champion**: `.bracket-champion` card (border-2 `border-warning/60`, `glow-gold`) with `.bracket-champion-crown` amber label, `.bracket-champion-name` display, `.bracket-champion-score` amber mono

### Utility Classes
`bracket-grid`, `bracket-round`, `bracket-round-label`, `bracket-matchup`, `bracket-matchup.resolved`, `bracket-matchup.pending-sync`, `bracket-matchup.pending-dep`, `bracket-seed`, `bracket-seed.filled`, `bracket-seed.tbd`, `bracket-team-row`, `bracket-team-name`, `bracket-team-name.tbd`, `bracket-team-score`, `bracket-team-score.win`, `bracket-team-score.loss`, `bracket-team-score.pending`, `bracket-pending-badge.sync`, `bracket-pending-badge.dep`, `bracket-champion`, `bracket-champion-crown`, `bracket-champion-name`, `bracket-champion-score`, `glow-gold` — all token-based, no new colors
