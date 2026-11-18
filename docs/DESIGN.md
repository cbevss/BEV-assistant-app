# BEV design system

BEV is a voice assistant that lives on the desktop. The interface is an instrument: calm, precise and quiet until something happens. One element carries BEV's personality, the **Core**. Everything around it is disciplined graphite with a single signal colour.

Tokens live in `src/styles.css` (CSS variables) and `tailwind.config.js` (names). Change them there, never inline. Preview any screen in a browser with `npm run ui:preview` (it uses a mocked Tauri runtime from `src/dev/`, never shipped).

## Principles

1. **Real, or not at all.** Every number, state and animation reflects something real. No decorative graphs, no fake activity.
2. **One accent, used sparingly.** The signal colour marks what's active or the main action on a screen. Most of the interface is neutral.
3. **Flat surfaces.** No gradients, glows, glass blur or floating blobs. Hierarchy comes from surface steps and hairlines.
4. **Lists, not card walls.** Related settings sit in one panel separated by hairlines. Cards only where content is genuinely separate.
5. **Words over chrome.** Plain, present-tense sentences in sentence case. Upper-case mono is reserved for the HUD layer (below).

## Colour

| Token | Value | Use |
|---|---|---|
| `rail` | `#0A0B0E` | Navigation rail |
| `canvas` | `#0E1014` | Window background |
| `surface-1` | `#14171C` | Panels, the composer |
| `surface-2` | `#1B1F26` | Inputs, hover, user messages |
| `surface-3` | `#242931` | Pressed, selected, meters |
| `line-subtle` / `line` / `line-strong` | `#1E2229` / `#2A3039` / `#3E4652` | Hairlines, control borders, hover borders |
| `ink` | `#E8ECF1` | Primary text |
| `ink-2` | `#A0A9B6` | Secondary text |
| `ink-3` | `#6D7786` | Hints, metadata |
| `ink-4` | `#4C5461` | Placeholders, disabled, idle marks |
| `accent` | `#4ECDDE` (user-selectable) | Active state, primary action, focus ring |
| `ok` / `warn` / `danger` | `#3DC98A` / `#E8B04B` / `#EF5B5B` | Status only |

The accent picker offers restrained presets (Signal cyan, Ice blue, Mint, Amber, Coral, Graphite white). `applyAppearance` writes `--accent`, a lighter `--accent-strong` and a readable `--accent-ink`.

## Type

- **IBM Plex Sans** (400/500/600) for the interface; **IBM Plex Mono** only for genuinely technical values (tool output, shortcuts, model ids, figures in tables). Latin subsets are bundled, so nothing loads from the network.
- Scale: 11 metadata · 12 hints and labels · 13 interface default · 14 conversation · 16 large · 20 page title (600) · 26 welcome.
- `tnum` for any number that updates live.

## Spacing, radius, elevation

- 4px grid. Rows are 12px × 16px; sections are 32px apart; pages use 28–32px gutters with a readable maximum width.
- Radius by role: 3–4px for small chips and Kbd, 6px for controls, 8px for panels, 10–14px for dialogs and the composer.
- Shadow only for things that float above the page (menus, dialogs, the command palette): `shadow-pop`.

## The Core

`src/ui/components/Core.tsx`: a bezel of 24 ticks, an inner ring and a centre point. It is both BEV's logo and its live state.

| State | What it does |
|---|---|
| off | Dim bezel, grey centre |
| idle | Dim bezel, quiet centre |
| listening | Ticks light outward from 12 o'clock with the microphone level |
| thinking / waking | A short arc orbits the bezel |
| speaking | The centre swells with BEV's voice level |
| working | Ticks fill clockwise with plan progress (orbit if there's no plan) |
| done | Full bezel in green |
| error | Red ticks at the bottom |

It appears in the rail (22px), the assistant bar (30px), the welcome screen (84px), beside BEV's replies (22px) and in the overlay (124px on a solid plate so it reads over any wallpaper or game).

## Structure

- **Rail** (212px, collapses to 60px under 1080px): Assistant, Activity, Memory, Automations; then the microphone toggle and Settings at the bottom.
- **Title bar**: page and section name, *Search or run a command* (Ctrl K), and Windows-sized (46px) window controls.
- **Assistant**: live status bar, the conversation (user right in a surface bubble; BEV left with no bubble; tool activity as a compact, expandable timeline; live plan; a working row with elapsed time), and the composer (auto-growing, talk button, send/stop, Esc stops).
- **Settings**: one area with its own category list: General, Voice & microphone, AI & models, Connected services, Apps, Appearance, Privacy & security, Advanced. Old addresses redirect.
- **Command palette** (Ctrl K): pages, settings categories and actions (start or stop listening, talk now, privacy mode, quiet mode, new conversation, PC health check).

## The HUD layer

What makes BEV feel like an instrument rather than a website. All of it is flat linework and real readouts, never glow or gradients (`src/ui/components/Hud.tsx`, `src/ui/shell/SystemBar.tsx`).

- **System bar**: a 24px strip along the bottom showing BEV's state (STANDBY, LISTENING, THINKING, FAULT…), CPU, memory, GPU when available, running background tasks and the time. It's live and measured, and kept short on purpose.
- **Readouts**: `HudLabel` (10px mono, upper case, tracked) above a mono value, used for live figures such as the Activity stats.
- **Section markers**: section titles are mono upper-case labels led by a short accent rule.
- **Measurement scales**: meters are drawn as rulers with ticks every 10%, not filled bars.
- **Timestamps**: messages show their HH:MM:SS time on hover, so the thread stays clean.
- **The emblem** (`Emblem.tsx`): the popup symbol. The hero Core (120px and up: concentric rings, a degree scale, a segmented ring that turns only while BEV works) seated in a solid plate inside a hairline collar with cardinal marks. The overlay popup and the welcome screen, the first screen BEV opens on, both render this one component, so they always match. Only the overlay copy gets a drop shadow, because it floats over wallpapers and games.
- No background grid and no frame brackets: the emblem is the one instrument on the welcome screen, and everything around it stays quiet.

## Components (`src/ui/components/Form.tsx`)

`PageHeader`, `Section` (title + hairline-divided panel; `flush` for custom lists), `Field` (setting row), `Card`, `EmptyState`, `TextInput`, `TextArea`, `Select` (native for keyboard and accessibility, styled), `Toggle`, `Slider`, `Segmented`, `Button` (primary / secondary / ghost / danger, sm / md, icon, loading), `IconButton` (always labelled), `StatusPill`, `Badge`, `Kbd`, `Notice`. Dialogs use `Dialog.tsx` (focus trap, Esc, focus return). Icons come from `lucide-react` only, at 16px with a 1.8 stroke.

## Motion

- 120ms for hovers and colour changes, 160–260ms for panels, pages, dialogs and the palette; ease-out curves, no springs or bounce.
- **Boot**: when the emblem first appears, the collar draws itself in, the plate settles and the Core's rings draw in (about a second, once).
- **Ambient scan**: a resting Core with `ambient` (the rail logo and the emblem) runs one short scan every 7s: a sweep round the bezel, a centre blip and one turn of the hero ring. It stops whenever BEV has real work to show, so it never competes with a state. Avatars and small status Cores stay still.
- **Navigation**: the rail, the settings list and tab bars have one highlight (or underline) that glides to the selected item (`Motion.tsx`: `useActiveRect`, `SlidingHighlight`, `SlidingUnderline`). The rail and settings highlight carry a 2px accent tick at the leading edge.
- **Pages**: switching area, settings section or tab fades the new content in with a 6px rise. New messages, tool runs and the working row enter the same way; welcome suggestions follow the emblem in a short stagger.
- **Feedback**: buttons press in slightly (scale 0.97); meters fill from zero when they first appear.
- Every keyframe ends in its resting state, so Windows' reduced-motion setting and BEV's own Motion setting (which cut animations to 0.01ms) leave everything fully drawn and still.

## Writing

- Say what's happening or what happened: "Listening for the wake word", "Opened an app".
- Buttons name the action: "Allow", "Don't allow", "New routine", "Reset settings".
- Errors say what went wrong and what to do next; they don't apologise.
- Empty states say how to start.

## Accessibility

- Visible 2px accent focus ring everywhere; logical tab order; dialogs trap focus and return it.
- Icon-only buttons have labels (also shown as tooltips); state is never colour-only.
- Live regions for BEV's status and the conversation.
- Text contrast: `ink` and `ink-2` meet WCAG AA on every surface; `ink-3` is for supplementary text only.
