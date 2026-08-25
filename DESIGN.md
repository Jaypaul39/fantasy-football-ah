# Design Brief

## Direction

**Neon Arena** — Real-time fantasy football auction platform with dark neon aesthetic, emphasizing live bidding action and urgency through vibrant cyan, lime, and magenta accents on deep charcoal backgrounds.

## Tone

Futuristic, competitive, high-energy. Dark sports arena with neon signage — urgency and real-time action drive every visual choice.

## Differentiation

Animated countdown timer pulses with neon cyan glow at <10 seconds, creating bidding tension; live bid leader badge in magenta highlight; smooth state transitions in header indicator; DiceBear avatar style picker adds playful personalization while maintaining dark theme coherence.

## Color Palette

| Token      | OKLCH           | Role                              |
| ---------- | --------------- | --------------------------------- |
| background | 0.13 0.01 260   | Dark charcoal base (arena)        |
| foreground | 0.95 0.01 260   | High-contrast text (white)        |
| card       | 0.17 0.012 260  | Elevated surfaces (dark slate)    |
| primary    | 0.72 0.22 190   | Neon cyan (primary actions/live)  |
| secondary  | 0.68 0.24 110   | Neon lime (budget/gains)          |
| accent     | 0.65 0.25 315   | Magenta (active bids/leader)      |
| destructive| 0.6 0.28 15     | Red (remove/cancel)               |
| muted      | 0.21 0.01 260   | Quiet backgrounds (secondary info)|

## Typography

- Display: Space Grotesk — bold, tech-forward headings, auction state, player names
- Body: DM Sans — UI labels, bid amounts, chat, form inputs, avatar style labels
- Mono: Geist Mono — price values, budget tracking, timer countdowns
- Scale: hero `text-5xl md:text-7xl font-bold`, h2 `text-3xl md:text-4xl font-bold`, label `text-xs font-semibold tracking-widest uppercase`, body `text-base`

## Elevation & Depth

Card layering through lightness shifts (0.13 → 0.17 → 0.21); minimal shadows — neon glow effects on interactive elements and live updates; no drop shadows.

## Structural Zones

| Zone    | Background     | Border                        | Notes                                          |
| ------- | -------------- | ----------------------------- | ---------------------------------------------- |
| Header  | card (0.17)    | border-primary (cyan, 1px)    | State indicator badge; logo + room name; profile |
| Sidebar | sidebar (0.15) | sidebar-border (subtle)       | Room list, collapsible on mobile drawer         |
| Content | background     | —                             | Live nomination card (elevated), bid feed       |
| Budget  | muted/30       | border                        | Sidebar panel, lime highlight on gains         |
| Profile | popover (0.21) | border-border                 | Avatar picker grid, display name input         |

## Spacing & Rhythm

Spacious vertical rhythm (gap-6 between sections, gap-4 within groups); compact horizontal grouping; 1rem base unit. Section alternation: nomination card elevated, bid history on background.

## Component Patterns

- Buttons: Rounded (md), primary (cyan bg + dark text), hover scale 105% + glow-cyan, 150ms transition
- Cards: Rounded (md), card background, 1px border-border, hover state lifted
- Input: Dark input bg, neon border on focus (primary cyan), placeholder muted-foreground, 200ms transition
- Badge: Lime (gains) or magenta (active), font-mono, uppercase label
- Avatar Picker: 6-style grid (responsive 3 cols mobile, 6 cols desktop), 48×48px circles with muted borders, cyan ring + glow on selected

## Motion

- Entrance: Fade-in + slide-up 300ms ease-out (components on load)
- Hover: Button scale 105%, color shift, 150ms smooth
- Live updates: Pulse-neon on countdown <10s (1.5s loop), bid leader glow-magenta, toast slide-in from top
- Avatar hover: Border cyan, 150ms transition
- Decorative: Subtle glow halos on active nomination card

## Constraints

- No full-page backgrounds or decorative gradients — focus on content clarity
- Glow effects only on interactive/live elements (buttons, timer, active bid, selected avatar style)
- High contrast maintained for readability (foreground ~0.95 on background ~0.13)
- Mobile-first responsive: sidebar drawer, full-width nomination, stacked bid history, 3-col avatar grid

## Signature Detail

Countdown timer at <10 seconds pulses with neon cyan glow (pulse-neon class) and audible notification toggle in header — tension and immediacy in one interaction. DiceBear avatar picker offers 6 distinctly-styled avatars (Cartoon, Robot, Illustrated, Pattern, Icon, Shapes) with clean circle previews, cyan highlight on selected style, and fallback to colored initials.

## New Component Specs

### Unified Bidding Panel
- **Input**: `.bid-panel-input` — cyan border/glow-cyan on focus, monospace placeholder, always visible
- **Status badge**: `.bid-status-badge` — "Current: $X | Proxy Max: $Y" in monospace, primary cyan on muted background

### User Profile Modal
- **Structure**: `.profile-modal-overlay` (fixed backdrop blur) + `.profile-modal-card` (centered card)
- **Inputs**: `.profile-input` (display name, full-width, cyan focus), `.avatar-preview-frame` (24×24 preview, cyan border on hover)
- **Avatar Picker**: `.avatar-style-picker` (grid container) + `.avatar-style-option` (flex column, label + circle) + `.avatar-style-circle` (48×48, muted border, cyan on hover) + `.avatar-style-circle.selected` (cyan border + glow) + `.avatar-style-label` (text-xs, muted-foreground)
- **Animation**: Fade + scale, 300ms ease-out

### Nomination Timer Banner
- **Banner**: `.nomination-timer-banner` (full-width, muted gradient, primary bottom border)
- **Timer**: `.nomination-timer-text` (Space Grotesk, "Nomination Turn: [Name]") + `.nomination-timer-countdown` (Geist Mono, XX-large)
- **States**: Cyan → amber (<30s) → red (<10s via timer-urgent class); backend-synced 1s updates

### Utility Classes
`bid-panel-input`, `bid-status-badge`, `nomination-timer-banner`, `nomination-timer-text`, `nomination-timer-countdown`, `avatar-preview-frame`, `avatar-style-picker`, `avatar-style-option`, `avatar-style-circle`, `avatar-style-label`, `profile-modal-overlay`, `profile-modal-card`, `profile-input` — all token-based, no new colors
