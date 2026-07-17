# Design System: Yakit Browser Agent
**Project ID:** yakit-chrome-client (derived from codebase design tokens, `src/styles/tokens.css` — no Stitch project)

## 1. Visual Theme & Atmosphere

A **focused security instrument panel**: utilitarian, information-dense, and calm. The aesthetic philosophy is "console first, chrome second" — content surfaces stay quiet and neutral so that state (connection, capture, risk) can carry all the visual signal. The mood is airy-but-dense: compact 13px typography and tight 8px-rhythm spacing, balanced by generous card padding and breathing room between functional groups.

The brand presence is deliberately restrained: a light, continuous surface carries every view, signed by the bare orange yak mark and a single ember-orange accent reserved for moments of genuine emphasis. Nothing glows, nothing gradients, no black slabs; depth comes from whisper-soft shadows and hairline separators, not borders. The system ships in twin themes — a cool light canvas and a true-dark console — with identical geometry and hierarchy, switched by a user preference (`system` / `light` / `dark`).

## 2. Color Palette & Roles

### Light theme (default)

- **Canvas Mist (#f3f4f6)** — application background; lets white cards float without borders.
- **Card White (#ffffff)** — primary content surfaces: cards, tables, panels, inputs.
- **Inset Pebble (#eceef1)** — recessed fills: stat tiles, code-free inset areas, toggle-off track.
- **Ink (#1d232a)** — primary text and strong values.
- **Slate Note (#68727d)** — secondary text, descriptions, timestamps.
- **Label Slate (#474f59)** — field labels, section labels, ghost-button text.
- **Hairline (#e1e4e8)** — non-structural separators (table rows, list dividers); used sparingly.
- **Frame Line (#c8cfd6)** — input strokes and secondary-button outlines.
- **Yak Orange (#ee7815)** — brand accent for *non-text* signal only: toggle-on tracks, active nav indicator, icon highlights, focus halo. Never carries text.
- **Ember (#b54f08)** — the accessible action orange: filled primary buttons (white text, 5.1:1 AA) and text links on light surfaces.
- **Ember Deep (#9e4607)** — hover state for filled primary buttons.
- **Ember Wash (#fdf0e1)** — soft selection tint: active list rows, selected table lines.
- **Pine (#1e7f52)** on **Mint Mist (#e4f3eb)** — connected, captured, success states.
- **Umber (#94650d)** on **Parchment (#fcf2d9)** — warning states and the human-handoff surface.
- **Brick (#bf3d3d)** on **Blush (#fbeaea)** — destructive actions, errors, failed states.
- **Bare Yak (the orange brand mark, #f97a04 family)** — shown directly on the surface with no backing tile; it is the only persistent brand signature.

### Dark theme (`[data-theme='dark']`)

- **Deep Space (#0e1116)** — application background; true console dark, not navy.
- **Panel Slate (#161b21)** — cards and surfaces.
- **Raised Slate (#1e242c)** — inset fills and hover states.
- **Fog Text (#e2e7ec)** — primary text; **Ash (#8a949f)** secondary; **Mist Strong (#b2bcc5)** labels.
- **Ember Glow (#f5832a)** — filled primary buttons with **Roasted Ink (#201205)** text (7.5:1 AA); brighter than light theme to hold contrast on dark.
- **Ember Light (#f7a15c)** — text links and code accents on dark surfaces.
- Semantic tints deepen to translucent darkness: **Pine Glow (#45b981 / #122a1f)**, **Amber Glow (#d9a441 / #2c2311)**, **Coral Glow (#e06e6e / #2f1b1b)**.

## 3. Typography Rules

- **Family:** A system-native sans stack (Inter falling back to ui-sans-serif, system-ui, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC) — chosen for crisp CJK rendering at small sizes without bundling font files. Code and packets use a mono stack (ui-monospace, SF Mono, Consolas).
- **Scale (six steps, no more):** 11px for uppercase micro-labels only, 12px secondary/description, **13px as the reading base**, 14px emphasized values, 16px section titles, 20px page titles.
- **Weight hierarchy:** 500 for navigation, 600 for interactive text and labels, 650 for card titles and strong values, 700 reserved for page titles and hero numerals.
- **Micro-labels:** 11px, weight 650, letter-spacing .04em, uppercase, Slate Note color — the "eyebrow" voice used above data.
- **Rhythm:** line-heights stay tight (16–18px for body); Chinese text is never set below 12px except uppercase micro-labels.

## 4. Component Stylings

* **Buttons:** 36px tall with gently squared corners (6px radius) and 13px semibold labels. The *filled primary* is Ember (light) / Ember Glow (dark) with contrasting text — strictly one per view. *Secondary* buttons are Card White with a Frame Line stroke. *Ghost* buttons are transparent until hovered. *Danger* is a Brick outline that fills with Blush on hover. Small (30px) and icon (34px square) variants share the same geometry.
* **Cards/Containers:** Generously rounded corners (12px radius), Card White fill, and a whisper-soft two-layer shadow (a 1px key line of shade plus a faint 4px lift) — no borders. Recessed stat tiles inside cards use Inset Pebble with softly rounded corners (8px). Nothing nests a shadowed card inside another.
* **Inputs/Forms:** 36px tall, 6px corner radius, 1px Frame Line stroke on Card White; textareas keep the same stroke. Focus never shows a hard outline — instead a soft ember halo (3px of translucent Yak Orange). Field labels are 12px semibold Label Slate; hints in 12px Slate Note.
* **Toggles:** Pill-shaped switches (40×22px), Pebble track when off, Yak Orange track when on, white 16px thumb gliding on a short ease.
* **Navigation rail:** A 238px rail in the same surface as the workspace, separated by a single hairline. Items are 40px rows with softly rounded corners (8px); the active item shows a subtle raised fill plus a 3px inset Yak Orange indicator bar on its leading edge, with its icon tinted orange.
* **Status pills:** Fully rounded (pill-shaped, 999px) badges pairing each semantic color with its soft wash — connected/capturing in Pine-on-Mint, waiting/warning in Umber-on-Parchment, error in Brick-on-Blush.
* **Code & packets:** Deep slate panels (#171b20, light mono text) with 8px rounded corners; they remain dark in both themes as "terminal territory."
* **Handoff surface:** A Parchment card with a 3px Umber leading edge and the warning icon — the single interruptive pattern in the system, reserved for QR/MFA/CAPTCHA human takeover.

## 5. Layout Principles

- **Shell:** A fixed 238px dark rail plus a fluid workspace. The workspace column is capped at a comfortable 1440px reading width and **horizontally centered**, so ultra-wide monitors frame the console instead of stretching tables into unreadability.
- **Grid alignment:** The 60px sticky topbar shares the exact content grid — its padding is computed from the same 1440px cap (`max(28px, (100% − 1440px)/2 + 28px)`), keeping the target-tab chip and the page content on one vertical line.
- **Spacing rhythm:** An 8px base unit; 16px gaps between cards, 16–20px inner card padding, 22–28px page padding. Groups are separated by space and shadow, not rules.
- **Two-column workbenches:** Data pages (network, cookies, context, engine) use a fluid primary column with a 320–440px inspector column that sticks below the topbar; below 1080px they stack to a single column.
- **Grid discipline:** Every single-column vertical grid declares an explicit `minmax(0, 1fr)` track, so long URLs and code strings truncate with ellipses instead of overflowing narrow (320–390px) viewports.
- **Popup:** A fixed 390px single-sheet column — sections divided by hairlines, not floating cards — designed to a strict 600px height budget, keeping every action including the bottom primary capture button visible without scrolling.
- **Floating panel:** A 46px edge launcher — a white stadium orb with the bare yak mark (dark in dark theme, theme-aware in-page) — that expands to a 326px rounded workbench over the page; its header shares the panel surface with a single hairline seam.
- **Motion:** Short (140–180ms) ease transitions on color and slide only; `prefers-reduced-motion` collapses all animation.
