# BEV design system

BEV is a voice assistant that lives on the desktop. Its identity is the light of the orb: a cool cyan on near-black that changes colour with what BEV is doing. The interface is an instrument panel. It should feel calm and precise, show only real data, and say things in plain words.

Tokens in code: `tailwind.config.js` (palette, fonts, shadows) and `src/ui/design.ts` (state colours and words). Change them there, not inline.

## Colour

| Token | Hex | Use |
|---|---|---|
| void | `#05070d` | Window background (with the radial lift in `styles.css`) |
| carbon | `#0a0e17` | Raised surfaces |
| cyan | `#22d3ee` | BEV itself: idle, listening, focus rings, primary actions |
| violet | `#8b5cf6` | Thinking |
| blue | `#3b82f6` | Speaking |
| ok | `#34d399` | Working, done, healthy |
| warn | `#fbbf24` (amber-300/400 in Tailwind) | Needs attention, not broken |
| danger | `#f43f5e` | Errors, destructive actions |

Text: slate-100 for primary, slate-300/400 for secondary, slate-500 for metadata. Never put information in colour alone; pair it with words (a state dot always sits next to its label).

### State colours

One mapping, used by the orb, the sidebar dot and the Dashboard status line (`stateMeta`):

| State | Colour | Words |
|---|---|---|
| idle | cyan | Ready |
| activating | glow `#38e8ff` | Waking up |
| listening | cyan | Listening |
| thinking | violet | Thinking |
| speaking | blue | Speaking |
| executing | ok | Working |
| completed | ok | Done |
| error | danger | Something went wrong |

## Type

- **Inter** (Segoe UI fallback) for everything. **JetBrains Mono** only for things that are code: paths, tool names, model ids in technical views.
- Numbers that change live use `tabular-nums` so they don't jitter.
- Scale: page title 24/600, status headline 20/500, section title 16/500, body 14/400, metadata 12–11/400.
- Sentence case everywhere. No all-caps tracked labels, no eyebrow text above headings.

## Layout and surfaces

- The `glass` panel (translucent slate, faint cyan hairline, blur) is the one container. Use it for groups of related controls, not to box every item.
- The Dashboard status line sits unboxed at the top: it's the most important thing on the page, so it gets space, not a frame.
- Radius: 12px panels, 8px controls and inner blocks, full for dots and pills.
- Spacing on a 4px grid; sections are 24px apart.

## Motion

- Motion answers something: the orb reacts to voice, the level trace moves only while listening or speaking, progress bars move when a step finishes.
- No entrance animations or hover flourishes on content.
- `prefers-reduced-motion` turns animations and transitions off (global rule in `styles.css`), and the level trace shows a still line.

## Writing

- Say what BEV is doing or what happened, in the present tense: "Waiting for the wake word", "Step 2 of 4: Open Spotify".
- Buttons name the action: Start, Cancel, Delete note, Make it the Windows default.
- Errors say what went wrong and what to do next, and never apologise.
- Empty states say how to get started ("Try: BEV, save a note about…").
- Never show a number BEV didn't measure. If a sensor isn't available, say so ("no sensor bridge").

## Accessibility

- Visible keyboard focus everywhere (2px cyan outline).
- Live regions for BEV's status (`aria-live="polite"`).
- Icon-only controls get an `aria-label`; state dots are `aria-hidden` because their label is beside them.
