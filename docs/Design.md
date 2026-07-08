# Golemine Design System ("Lode")

The design language for Golemine. Like Material or Apple's HIG, this document exists so
that independently-built features look and feel like one product. **If a visual or
interaction decision isn't covered here, extend this document — don't improvise.**

Design intent in one line: **a calm, precise, modern instrument** — the feel of a
high-end developer tool (Linear, Arc, Vercel) applied to forensic data, not a playful
consumer app. Rich comes from depth, materials, and motion discipline — never from
decoration.

Naming: **Golemine = Golem + Mine** — a **mechanical** golem in the vein of Talos, the
bronze automaton (not a clay golem), that mines through backup data and extracts the
interesting bits. The design system is "Lode" (a vein of ore): the backup is the mine,
the app is the golem working it, and the warm gold/bronze accent is both the
automaton's metal and the ore it surfaces — selections, search hits, active work. The
overall feel of a precise, tireless machine (calm chrome, visible mechanical progress,
exact counts) is the golem made visual. Earthy clay/terracotta styling is explicitly
off-theme. The golem's concrete visual identity (steampunk automaton, character sheet,
asset rules) is specified in §12.

## 0. Non-negotiables

1. **Every color, font size, spacing, radius, shadow, and duration comes from a token.**
   No hardcoded hex/px values in components. Tokens are CSS custom properties defined in
   `src/styles/tokens.css` and mapped into Tailwind; components consume Tailwind
   utilities or `var(--token)`.
2. **Both themes always.** Every screen and component must be built and verified in
   light and dark. There is no "light-only for now."
3. **AA contrast minimum** (4.5:1 body text, 3:1 large text/UI icons) in both themes.
4. **Backup content is sacred, chrome is quiet.** The user's data (messages, media)
   gets the visual energy; app chrome stays neutral and recedes.
5. **`prefers-reduced-motion` disables all non-essential animation.**

## 1. Color

All colors are defined in **OKLCH** (Chrome-only app; perceptually uniform, easy to
derive theme variants by shifting L). Components never reference primitives — only
**semantic tokens**.

### 1.1 Neutrals & surfaces

Cool-tinted neutrals (hue ≈ 255, chroma ≤ 0.015). Dark mode is charcoal, not pure
black — depth comes from stepped surfaces.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `oklch(0.98 0.003 255)` | `oklch(0.16 0.010 255)` | App background |
| `--surface` | `oklch(1 0 0)` | `oklch(0.20 0.012 255)` | Panes, cards, list rows |
| `--surface-raised` | `oklch(1 0 0)` + shadow | `oklch(0.24 0.012 255)` | Popovers, dialogs, hover states |
| `--surface-sunken` | `oklch(0.955 0.004 255)` | `oklch(0.13 0.010 255)` | Wells, input backgrounds, code/data blocks |
| `--border` | `oklch(0.90 0.006 255)` | `oklch(0.30 0.012 255)` | Hairline borders (1px) |
| `--border-strong` | `oklch(0.82 0.008 255)` | `oklch(0.38 0.014 255)` | Inputs, focused-adjacent borders |
| `--text` | `oklch(0.21 0.012 255)` | `oklch(0.93 0.006 255)` | Primary text |
| `--text-secondary` | `oklch(0.45 0.012 255)` | `oklch(0.72 0.010 255)` | Labels, timestamps, metadata |
| `--text-tertiary` | `oklch(0.58 0.010 255)` | `oklch(0.56 0.010 255)` | Placeholders, disabled, hints |

### 1.2 Accent — Lode Gold

The brand accent is a warm gold — the ore the golem brings up from the mine. It marks
**what has been found or chosen**, and is therefore **rare by design**: primary
actions, active navigation, selection, focus, and search-hit highlights. If a screen
has gold in more than ~3 places, something is wrong.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `oklch(0.72 0.13 78)` | `oklch(0.80 0.13 82)` | Primary buttons, active states |
| `--accent-foreground` | `oklch(0.22 0.02 78)` | `oklch(0.20 0.02 78)` | Text/icons ON accent (always dark — gold never carries white text) |
| `--accent-subtle` | `oklch(0.95 0.04 85)` | `oklch(0.28 0.045 80)` | Selected rows, search-hit highlight bg, badges |
| `--accent-text` | `oklch(0.52 0.12 70)` | `oklch(0.82 0.12 82)` | Links, accent-colored text on normal surfaces (AA-checked) |
| `--focus-ring` | = `--accent` | = `--accent` | 2px ring, 2px offset, on every focusable element |

### 1.3 Functional colors

| Token | Hue | Use |
|---|---|---|
| `--success` | green `oklch(0.60 0.13 155)` / dark `oklch(0.72 0.14 155)` | Completed ingest, verified hashes |
| `--warning` | orange `oklch(0.68 0.15 55)` / dark `oklch(0.76 0.14 60)` | Partial results, skipped items |
| `--danger` | red `oklch(0.55 0.19 25)` / dark `oklch(0.68 0.17 25)` | Destructive actions, failures |
| `--info` | blue `oklch(0.55 0.14 250)` / dark `oklch(0.70 0.12 250)` | Neutral notices |

Each has a `-subtle` background variant and a `-foreground` pair. Functional colors are
for **status**, never decoration; warning-orange is visually distinct from accent-gold
(more red, more chroma) — do not substitute one for the other.

### 1.4 Message semantics (fixed, theme-independent meaning)

Message bubbles follow the color language users already know from their phone — this
aids recognition and courtroom presentation:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bubble-imessage` | `oklch(0.58 0.19 258)` | `oklch(0.56 0.17 258)` | Sent iMessage (white text) |
| `--bubble-sms` | `oklch(0.62 0.17 150)` | `oklch(0.60 0.15 150)` | Sent SMS/MMS (white text) |
| `--bubble-received` | `--surface-sunken` | `--surface-raised` | Received messages (normal text) |

These hues are reserved: nothing else in the app may use saturated blue-258 or
green-150 fills, so a screenshot of a thread is unambiguous.

### 1.5 Data visualization / avatars

Participant avatar fallbacks use a fixed 8-color categorical ramp (defined in
`tokens.css`, hues evenly spaced, L/C normalized per theme), selected by stable hash of
the handle — the same person is always the same color.

## 2. Typography

Self-hosted only (offline app — never load fonts from a CDN). Both faces are SIL
OFL-1.1 (fonts are assets, not linked code; record in NOTICE).

- **UI/content:** Inter (variable). `font-feature-settings: 'cv05', 'tnum'` where
  tabular numbers matter (timestamps, counts).
- **Data:** JetBrains Mono — hashes, GUIDs, raw timestamps, file paths, SQL. Forensic
  values are *always* mono; it signals "verbatim from source."

Scale (rem; base 14px — this is a data-dense app):

| Token | Size/line | Weight | Use |
|---|---|---|---|
| `--type-display` | 32/38 | 600 | Landing title only |
| `--type-title` | 22/28 | 600 | Page titles |
| `--type-heading` | 16/22 | 600 | Section/pane headers |
| `--type-body` | 14/21 | 400 | Default UI + message text |
| `--type-body-strong` | 14/21 | 550 | Emphasis, sender names |
| `--type-caption` | 12.5/17 | 400 | Timestamps, metadata, helper text |
| `--type-micro` | 11/14 | 500, +0.02em tracking, uppercase optional | Badges, column headers |

Rules: max two weights per component; never letter-space body text; message body text
may be user-scaled later — build with rem, not px.

## 3. Space, size, radius

- **4px base grid.** Spacing tokens: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64.
  Components use the scale — no 13px anything.
- **Radii:** `--radius-sm: 6px` (inputs, badges), `--radius-md: 10px` (buttons, cards),
  `--radius-lg: 14px` (panes, dialogs), `--radius-bubble: 18px` (message bubbles),
  `--radius-full` (avatars, pills). Nested radii: inner = outer − padding, min 4px.
- **Hit targets:** ≥ 32px pointer, ≥ 40px for primary actions.
- **Control heights:** sm 28, md 32 (default), lg 40.

## 4. Elevation & materials

Depth model (lowest → highest): `bg` → `surface` → `surface-raised` → overlay.

- **Light mode:** elevation = layered soft shadows (`--shadow-1` subtle card,
  `--shadow-2` popover, `--shadow-3` dialog) + hairline border. Shadows are cool-tinted
  (`oklch(0.2 0.02 255 / …)`), never pure black.
- **Dark mode:** elevation = **lighter surface + 1px inside-top highlight**
  (`inset 0 1px 0 oklch(1 0 0 / 0.06)`); shadows only on overlays. Do not reuse light
  shadows in dark — they read as dirt.
- **Glass (backdrop-blur) is allowed exactly here:** the app top bar, the command
  palette, floating toolbars over content (e.g. selection action bar), and media
  viewer chrome. Recipe: translucent `--surface` at 70–80% alpha + `blur(16px)
  saturate(1.4)` + hairline border. Never for content panes, cards, or dialogs.
- **Gradients:** one brand gradient (`--gradient-lode`: gold → deep amber, ~35°) used
  only as a restrained accent on the landing screen and in empty-state illustrations —
  the landing is an operational open-backup screen, not a marketing hero (Plan.md M1).
  Primary buttons get an imperceptible top-light gradient (≤4% L shift) for richness;
  no other gradients.

## 5. Motion

Motion confirms causality; it never entertains. Animate **opacity and transform only**
(compositor-safe); never animate layout in virtualized lists.

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | Hover/pressed states, toggles |
| `--dur-base` | 200ms | Popovers, dropdowns, selection |
| `--dur-slow` | 320ms | Dialogs, pane transitions, theme cross-fade |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Anything entering / responding to user |
| `--ease-in-out` | `cubic-bezier(0.45, 0, 0.15, 1)` | Anything moving position |

Choreography rules: enter = fade + 4–8px translate or 0.97→1 scale; exit = fade only at
~60% of enter duration; stagger list-item entrances max 20ms apart, cap total 150ms.
Long-running pipelines (ingest) use determinate progress bars with live counts — motion
there is the numbers changing, not spinners. Skeletons for content loads > 150ms;
spinners only for sub-second indeterminate waits. `prefers-reduced-motion: reduce` →
all durations 0 except opacity fades ≤ 100ms.

## 6. Theming: light/dark, auto + manual

Three-state preference: **System (default) / Light / Dark**, persisted in
`localStorage['golemine-theme']`, exposed in the top bar (sun/moon/monitor toggle).

Implementation contract:

- Tokens defined on `:root` (light) and overridden under
  `@media (prefers-color-scheme: dark)` scoped to `:root:not([data-theme='light'])`,
  plus explicit `[data-theme='dark']` overrides. Manual choice sets `data-theme` on
  `<html>`; "System" removes the attribute.
- An inline `<script>` in `index.html` applies the stored preference **before first
  paint** (no flash of wrong theme).
- `color-scheme: light dark` on `:root` so native scrollbars/form controls match.
- Theme changes cross-fade via a `--dur-slow` transition on background/color at the
  root only — individual components must not add their own theme transitions.
- Components must be theme-blind: consume semantic tokens only, never query the theme
  in JS for styling. (JS may read it for things like which syntax-highlight palette a
  canvas renderer uses.)

## 7. Component rules (shadcn/ui base)

shadcn/ui components are vendored then restyled with our tokens — the shadcn CSS
variables (`--background`, `--primary`, …) are mapped to Lode tokens in one place
(`tokens.css`), never redefined per component.

Which components are vendored vs. hand-rolled is decided in Decisions.md D-014:
vendor Radix-backed interaction primitives (dialogs, tooltips, menus, resizable
panes, toasts); hand-roll domain-specific and virtualized content (§7.1, thread
rows, detail panel). Never use portal-based primitives inside virtualized rows —
hover affordances there are CSS-driven.

- **Buttons:** variants `primary` (accent fill, dark text), `secondary` (surface +
  border), `ghost` (text only, hover surface), `destructive` (danger fill). One primary
  per view region. Icons 16px, gap 6px.
- **Inputs:** `--surface-sunken` background, `--border-strong`, focus = ring token (no
  border-color change alone). Labels above, `--type-caption` secondary; errors in
  `--danger` text + icon, never color alone.
- **Cards/panes:** `--surface`, hairline border, `--radius-lg`, internal padding 16
  or 20. Pane headers: 48px tall, `--type-heading`, actions right.
- **Selection:** selected list rows/messages get `--accent-subtle` background + 2px
  accent left bar (not just a tint — must survive screenshots/printing in grayscale).
- **Badges:** `--type-micro`, `--radius-full`, subtle backgrounds (`*-subtle` +
  `*-text`); filled badges reserved for counts on accent elements.
- **Dialogs:** max-width 480 (confirm) / 720 (forms); scrim `oklch(0.1 0.01 255/0.5)`;
  destructive confirms restate the object name and use a destructive primary.
- **Toasts:** bottom-right, auto-dismiss 5s, max 3 stacked; never for errors that
  require action (those get inline or dialog treatment).
- **Tooltips:** delay 400ms, `--surface-raised`, caption type; every icon-only button
  has one.
- **Empty states:** icon (24px, tertiary) + one-line explanation + one action. No
  illustrations except landing/guides.
- **Icons:** `lucide-react` (ISC) only, sizes 16/20/24, stroke-width 1.75, color
  inherits text token. No emoji as UI icons; emoji in message content renders at
  1.3em.

### 7.1 Message rendering (the centerpiece — get this right)

- Bubbles: `--radius-bubble`, max-width 72% of pane (min 220px), padding 10×14,
  `--type-body`. Sent right-aligned (`--bubble-imessage`/`--bubble-sms` per service),
  received left with avatar (28px) shown on first message of a sender run.
- Runs: consecutive same-sender messages ≤ 60s apart group with 2px gaps and only the
  last bubble gets a tail-corner (larger radius break); 8px between runs; day separators
  (`--type-micro`, centered) between days.
- Timestamps: caption type, tertiary; shown on hover/selection and always on the run's
  last message. Full provenance lives in the detail panel, not the bubble.
- Reactions: 16px chips overlapping the bubble corner, `--surface-raised` + border.
- Edited/unsent: caption-level annotation under the bubble ("Edited", "Unsent") in
  `--warning` text — forensically important, never hidden.
- Search hits: `--accent-subtle` text highlight (gold) with `--accent-text` underline;
  the active hit gets the full selection treatment.
- Attachments: images/video in rounded (12px) frames, max 320×320 thumb, click →
  full-screen viewer (glass chrome); non-previewable files get a file card (icon,
  name, size, extract button).

## 8. Layout

- App frame: 48px glass top bar (app name, backup switcher, search, theme toggle) +
  content region. No footer.
- Messages view: three panes — threads 320px (min 280, resizable), timeline flexible
  (min 480), detail panel 360px (collapsible). Panes separated by hairline borders,
  not gaps.
- Landing/guides: single column, max-width 720px text / 960px content, generous
  (48–64) vertical rhythm.
- Responsive floor: 1024px width; below that, the detail panel overlays instead of
  docking. No mobile layout (desktop Chrome tool).

## 9. Print (reports)

Print is a first-class theme, not an afterthought:

- Forced light: pure white background, near-black text, `print-color-adjust: exact`
  so bubble colors (iMessage blue / SMS green) reproduce accurately.
- Serif is not used; Inter throughout, body 11pt, provenance/mono 9.5pt.
- No shadows, no glass, no accent decoration; selection bars and UI chrome stripped.
- Every page: header (report title) + footer (page N of M, export timestamp UTC,
  displayed-timezone label).
- Page breaks never split a message bubble or separate a bubble from its annotations.

## 10. Voice & microcopy

- Calm, precise, factual. No exclamation marks, no "Oops!", no humor — this tool is
  used for court cases.
- State counts exactly: "Extracted 4,213 messages from 87 conversations" not "All
  done!". Always disclose partiality: "12 attachments could not be read (skipped)."
- Errors: what happened + what the user can do, in that order. Never blame the user.
- Buttons are verb-first ("Open backup", "Add to report"); destructive buttons name
  the object ("Remove 'Dad's iPhone'").
- Sentence case everywhere, including titles and buttons. Dates in prose use the
  report/browse timezone and say so when it matters.

## 11. Definition of done (UI work)

A UI change is complete only when: both themes verified (including the manual/system
toggle states) · AA contrast checked for new color pairs · keyboard path works and
focus is visible · reduced-motion honored · loading, empty, and error states exist ·
long content (10k-message thread, 400-char message, 60-char name) doesn't break
layout · no hardcoded style values (tokens only) · print view unaffected or updated.

## 12. Illustration & brand imagery

Generated artwork is the one place raster images and non-token colors are permitted.
Everything else in this section is binding.

### 12.1 The golem's identity (D-018)

A **steampunk mechanical automaton**: articulated brass-gold plates, cogs/gears at the
joints and chest, rivets, exposed copper pipes/pistons, and a dome head with a single
circular optical gear lens centered in the face. Never a clay golem, never a sleek
sci-fi robot or superhero silhouette. Approximate palette for generation prompts:
brass-gold `#C9973D`, deep amber `#8F6224`, cool charcoal `#1E2127`, near-white
`#F9FAFB` (these approximate the Lode tokens; raster art is exempt from the
tokens-only rule but must sit on token-colored backgrounds without halos).

**Character sheet:** `docs/assets/golem-reference-sheet.png` is the canonical
reference. Any new golem artwork must be generated with the character sheet supplied
as image context — never from a text prompt alone.

### 12.2 Where imagery is allowed

Illustrations appear only on the landing screen, backup guides, the capability-gate
block screen, and the drag-drop overlay (§7 empty-state rule stands: ordinary empty
states get a lucide icon, not an illustration). Print output carries no illustrations
(§9). Illustrations are decorative: `alt=""` / `aria-hidden="true"`, and they never
carry information that isn't also in text.

### 12.3 Asset inventory & rules

| Location | Contents |
|---|---|
| `src/assets/illustrations/` | In-app spot illustrations (WebP, transparent), imported by components |
| `src/assets/brand/icon-master.png` | 1024×1024 icon master — source for favicon retrace and PWA manifest icons |
| `public/og-image.png` | 1200×630 social card, referenced absolutely from `index.html` (`https://golemine.com/og-image.png`) |
| `docs/assets/` | Repo-facing images: README banner, golem character sheet |

- Every in-app illustration ships **both** `-light.webp` and `-dark.webp` variants.
  Components stay theme-blind: render both and gate visibility with CSS theme
  selectors (or use `<picture>` + `prefers-color-scheme` where the manual override
  is also handled) — do not query the theme in JS to pick an image source.
- Illustrations are generated against the target background color and keyed to
  transparency (D-018); verify edges on both themes before shipping.
- New generated assets follow the same pipeline: character sheet as context, target
  background color, transparency keying, WebP for in-app use.
