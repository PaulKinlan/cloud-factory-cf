# House style — agent canvas (`apps/web`)

Decided 2026-10-19 by des-canvas (designer lane), bead `cloud-factory-cf-dsq`, from Paul's directive:
Isocan & Stitch visual language on the canvas. Tokens live in `apps/web/src/styles.css` `:root`;
this file records what they mean so a landing that contradicts them is visibly wrong.

## Tokens

| Token | Value | Meaning |
|---|---|---|
| `--bg` | `#070a12` | Obsidian ground under everything |
| `--panel-solid` | `#121a2e` | Opaque fallback/base for contrast math |
| `--panel` / `--panel-strong` | `rgb(18 26 46 / 72%)` / `rgb(26 35 62 / 85%)` | Glass surfaces (always with `backdrop-filter: blur + saturate`) |
| `--ink` / `--muted` | `#e6eaf6` / `#9aa7c7` | Text. 16.0:1 / 8.0:1 on `--bg` |
| `--line` / `--line-strong` | 22% / 45% slate | Hairline borders / control borders |
| `--focus` | `#a5b4fc` | Focus ring only. 9.7:1 on `--bg`, 8.7:1 on `--panel-solid` |
| `--agent` (+`--agent-2`) | `#818cf8` (→`#a78bfa`) | Agent nodes: indigo→violet |
| `--source` | `#34d399` | Event sources: emerald (10.0:1 on `--bg`) |
| `--memory` | `#fbbf24` | Memory hubs: amber (11.5:1) |
| `--sink` | `#22d3ee` | Action sinks: cyan (10.7:1). Was pink `#ff7a9c` before 2026-10-19 |
| `--danger` | `#fb7185` | Destructive actions only (7.2:1) |
| `--radius` | `16px` | Node cards. Panels 18px, viewport 20px, pills 999px |

Spacing on a 4/8px scale. Type: system stack; node labels 1rem/650, kind chips 0.66rem uppercase,
mono for config summaries, tabular numerals for the zoom readout.

## Rules

- Kind is never carried by colour alone: every node and add-button also names its kind in text.
- Selection is a solid kind-coloured ring; the pending end of a connection is a **dashed** outline.
- Motion is ≤180ms, uses the independent `scale` property on nodes (their `transform` is position),
  and is removed under `prefers-reduced-motion`. The cursor spotlight is decorative and off there too.
- Glass must survive `forced-colors: active`: real borders/outlines carry every surface and state.
- Colour mixes use `color-mix(in oklab, …)`, not `srgb`, so tints stay in gamut.
- Tap targets: 36px minimum with a fine pointer, 44px under `(pointer: coarse)`.

## Components that exist

Floating command bar (`.topbar`), canvas viewport with dot grid + cursor spotlight, glass node cards
with in/out ports, gradient glowing edges (`#edge-gradient`), inspector card, glass dialogs,
empty-canvas zero state (`#empty-state`).
