# Orion OS design system

This is the shared visual language of the shell: the Phase 1 foundation. All values live as CSS custom properties in [`static/css/system/tokens.css`](../static/css/system/tokens.css). Components use tokens, never hard-coded colours, shadows, radii or durations. `tests/design-tokens.test.mjs` fails if a component references a token that doesn't exist.

## Layers

| Layer | Used for | Tokens |
|---|---|---|
| **Wallpaper** | The full-bleed video, image or canvas, plus one static depth layer: dim, vignette and top/bottom gradients | `--bg-0/1/2`, `--wallpaper-dim`, `--wallpaper-vignette` |
| **Float glass** | Dock, launcher and flyouts, context menus, widgets, toasts | `--glass-float`, `--blur` (widgets), `--blur-lg` (dock, flyouts, menus, toasts), `--elev-2..4` |
| **Window (mica)** | App windows: near-solid (about 0.97 alpha) so content stays readable, with only a small blur | `--glass-window`, `--blur-sm`, `--elev-2` (unfocused) / `--elev-4` (focused) |

Glass is used selectively:
- Never put blurred glass on top of blurred glass over a large area.
- New large surfaces start from the window tier, not float glass.

## Colour

| Group | Tokens | Details |
|---|---|---|
| Accent | `--accent-color`, `--accent-color-2`, `--accent-gradient`, `--accent-color-soft`, `--accent-color-faint`, `--accent-color-strong` | The accent is the user's setting (default Orion blue `#4c8dff`). The violet companion `--accent-color-2` is derived from it at runtime by `theme.js`. |
| Text | `--text` (primary), `--text-2` (secondary), `--text-3` (muted); `--text-on-wallpaper` with `--text-shadow-wallpaper` for labels drawn on the wallpaper | |
| Surfaces | `--surface-1..3`, `--surface-hover`, `--surface-active`, `--surface-selected` | Translucent fills on top of glass |
| Borders | `--border`, `--border-strong`, `--border-accent`; `--highlight` for the 1px inner top light | |
| Status | `--success`, `--warning`, `--danger`, `--info` | |

Light theme: `:root[data-theme="light"]` overrides the same names, so components never branch on the theme.

## Shape, space and type

- **Radius:**
  - `--radius-xs` 4, `--radius-sm` 6 for controls;
  - `--radius` 10 for cards and rows;
  - `--radius-lg` 14 for windows and menus;
  - `--radius-xl` 20 for the dock, flyouts and widgets;
  - `--radius-2xl` 28, `--radius-pill`.
- **Spacing:** a 4px grid, `--space-1` (4) to `--space-10` (40).
- **Type:**
  - fonts: the system stack `--font`, `--font-display` for large numerals and titles, `--font-mono`;
  - sizes: `--fs-2xs` 10 up to `--fs-display` 56;
  - weights `--fw-*`;
  - uppercase captions use `--tracking-caps`;
  - clocks and stats use tabular numbers.
- **App icons:** one tile shape everywhere (`.app-icon`): a rounded square with a top highlight and a soft shadow. Artwork tiles (`.app-icon.art`) get the same highlight.

## Elevation and layering

- **Shadows:** `--elev-1` (subtle) to `--elev-4` (focused window, flyouts). `--shadow-sm`, `--shadow` and `--shadow-lg` remain as aliases.
- **Z-index:** `--z-desktop` < `--z-widgets` < windows < `--z-snap` < `--z-taskbar` < `--z-flyout` < `--z-preview` < `--z-toast` < `--z-menu` < `--z-drag` < `--z-boot` < `--z-lock` < `--z-power`.

## Interaction states

- **Hover:** `--surface-hover`; icons lift about 2px.
- **Pressed:** `--surface-active`, scale 0.94–0.97.
- **Selected:** `--surface-selected`, `--border-accent`.
- **Keyboard focus:** `--focus-outline` (2px, `--accent-color-strong`) with `--focus-offset`. It appears only on `:focus-visible`, so it shows for the keyboard and not after a mouse click. A zero-specificity base rule in `base.css` covers every button, link and `[tabindex]`, and components may refine it.
- **Disabled:** 45% opacity.

## Motion

- **Durations:** `--dur-instant` 80ms, `--dur-fast` 120 (hover), `--dur` 200 (panels), `--dur-slow` 280 (windows, flyouts), `--dur-slower` 420.
- **Easing:** `--ease-out` for entrances, `--ease` as standard, `--ease-spring` only for small icon lifts.
- **What animates:** transform and opacity only, never layout-heavy properties in loops.
- **No continuous animation** without a purpose. The only loops are loading spinners, and the wallpaper video, which already pauses when hidden or covered.
- **Reduced motion:** `prefers-reduced-motion: reduce` makes every animation and transition instant and stops loops.
- **Reduced transparency:** turning transparency off in Settings, or the OS "reduce transparency" preference, removes all blur (`--blur*` set to 0px).

## Responsive targets

| Viewport | Behaviour |
|---|---|
| 1920×1080, 1366×768, 1280×720 | Full layout. Below 760px of height the widget cards tighten. |
| Narrower than 900px | The widget column narrows to 232px. |
| Narrower than 640px | Smaller dock and icon cells (existing rule) |

`tests/browser/visual.browser.mjs` checks the following:
- keyboard focus visibility;
- focused vs unfocused windows, and that controls and resize handles aren't covered;
- reduced motion, transparency off and the light theme;
- no page overflow;
- widgets clear of the dock and icons at 1280×720 and 900px.
