# Dark Mode — Design Spec

Date: 2026-10-09
Status: Approved (design sections 1 & 2)

## Goal

Add a dark mode to the portfolio site that follows the OS preference by default, can be overridden by a manual toggle, and persists across visits — without a white flash on load.

## Decisions (confirmed with user)

| Question | Decision |
| --- | --- |
| Behavior | Follow `prefers-color-scheme` + manual toggle, persisted in `localStorage` |
| Toggle location | Header, immediately left of the "Available" CTA |
| Toggle appearance | Sun/moon SVG icon, no text |
| Dark palette | Full inversion (`#000` bg / `#fff` text, stone tokens inverted) |
| `.inverted` sections in dark | Stay black bg / white text, separated by a border |
| Approach | Class `.dark` on `<html>` + CSS variable overrides (Approach A) |

## Architecture

### Theming mechanism

A single switch: `class="dark"` on `<html>`. All color tokens are redefined under that scope in `src/styles/global.css`:

```css
.dark {
  --color-ink: #ffffff;
  --color-paper: #000000;
  --color-stone-light: #1c1c1c;
  --color-stone-mid: #2a2a2a;
  --color-stone-dark: #a3a3a3;
}
```

Because every Tailwind v4 utility (`bg-paper`, `text-ink`, `border-ink`, …) resolves through `var(--color-*)`, the whole site — including the 699-line `index.astro` — switches with zero HTML edits.

Stone tokens are shifted (not simply negated) so light/mid/dark keep three distinguishable levels on a dark background.

### What changes automatically (no HTML edits)

- `body` (`bg-paper text-ink`), all sections, `border-ink`
- `.hover-invert` → hover becomes white bg / black text in dark
- `::selection`, `:focus-visible` outline, `.skip-link`
- `header-bg` — base stays `rgba(255,255,255,0.92)`; `.dark` scope overrides to `rgba(0,0,0,0.92)`

### Pinned manually

- `.inverted` (the `#contact` section, `src/pages/index.astro:695`) stays `#000` bg / `#fff` text in dark mode. Its existing `border-t border-paper` would become black-on-black, so a `.dark .inverted` override pins the border to white so the section remains visibly separated from the black page background.

### Native UI

`color-scheme: light` on `html`, `color-scheme: dark` on `html.dark`, so scrollbars and form controls match the theme.

### Theme transition

`background-color`, `color`, `border-color` transition 250ms ease on `html`, so a toggle flips the whole site in one synchronized motion. The existing `prefers-reduced-motion` block already disables it for users who opt out.

## Behavior & data flow

1. **Anti-flash script** — `<script is:inline>` in `<head>` of `src/layouts/BaseLayout.astro`, executed before first paint (must be inline, not a bundled module, because modules are deferred and would flash):
   - Read `localStorage.getItem('theme')` inside `try/catch` (private-mode safe; on failure fall back to system).
   - If absent, resolve from `matchMedia('(prefers-color-scheme: dark)').matches`.
   - Toggle the `.dark` class on `document.documentElement`.
2. **Toggle button** — `<button>` in the header, left of the CTA:
   - Classes match the CTA style (`label border border-ink px-3 py-2 hover-invert`), plus centering.
   - Contains both sun and moon SVGs (16px, `stroke: currentColor`); icon swap is pure CSS (`.dark .icon-sun { display: none }` and the inverse) — no JS for the icon.
   - `aria-label="Toggle color theme"`; the 44px touch target is already guaranteed by the existing `pointer: coarse` media query.
3. **Click handler** — `<script is:inline>` at end of body:
   - Flip `.dark` on `document.documentElement`.
   - Persist `localStorage.setItem('theme', 'dark' | 'light')`.
   - No live `matchMedia` listener (once the user chooses manually, their choice wins permanently).

## Error handling

- `localStorage` unavailable → caught, silently falls back to system preference.
- No theme value stored → system preference (first visit).
- 404 page uses the same `BaseLayout`, so it inherits identical behavior.

## Out of scope

- Live reaction to OS theme changes while the page is open.
- Per-section or per-image theming beyond token inversion.
- Theme-aware `favicon` or `og:image`.

## Testing / verification

- `npm run build` succeeds; `dist/index.html` and `dist/404.html` contain the inline anti-flash script and the toggle button.
- `npm run dev` manual checks:
  - OS set to dark → first visit renders dark with no white flash.
  - Toggle → state persists across reload.
  - `#contact` section stays black with a visible white border in dark mode.
  - Header background is translucent black in dark, translucent white in light.
  - Reduced-motion setting disables the theme transition.
