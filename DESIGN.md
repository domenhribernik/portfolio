---
name: Domen Hribernik Portfolio
description: A warm paper-and-ink house system set in poster type, quiet at rest and decisive on state.
colors:
  paper: "#f6f2ea"
  paper-2: "#efe9dd"
  card: "#fffdf8"
  ink: "#1c1a17"
  stone: "#6b6256"
  faint: "#a49a8a"
  hairline: "rgba(28, 26, 23, 0.12)"
  clay: "#d4451f"
  clay-dk: "#b8371a"
  cobalt: "#1f35e0"
  cobalt-dk: "#1226c0"
  pine: "#2f5b53"
  marigold: "#f2b705"
  danger: "#b3261e"
typography:
  display:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "clamp(2.5rem, 9vw, 6.5rem)"
    fontWeight: 800
    lineHeight: 0.84
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "clamp(1.7rem, 4.2vw, 3.3rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "clamp(1rem, 1.6vw, 1.25rem)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "0.02em"
  body:
    fontFamily: "IBM Plex Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "Space Mono, monospace"
    fontSize: "0.72rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.24em"
rounded:
  none: "0"
  sm: "2px"
  md: "3px"
  lg: "4px"
  pill: "999px"
spacing:
  xs: "0.6rem"
  sm: "1rem"
  md: "1.6rem"
  lg: "3rem"
  xl: "6rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0.85rem 1.6rem"
  button-primary-hover:
    backgroundColor: "{colors.clay}"
    textColor: "{colors.paper}"
  button-clay:
    backgroundColor: "{colors.clay}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "11px 22px"
  button-clay-hover:
    backgroundColor: "{colors.clay-dk}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.stone}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-ghost-hover:
    textColor: "{colors.clay}"
  input-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  input-field-focus:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
  card-project:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "1.5rem"
  nav-link:
    textColor: "{colors.stone}"
    typography: "{typography.label}"
    padding: "0"
  nav-link-hover:
    textColor: "{colors.ink}"
---

# Design System: Domen Hribernik Portfolio

## Overview

**Creative North Star: "The Poster Press"**

This is a print shop, not a website theme. The stock is warm paper, the setting is broadsheet grammar (hairline rules, mono eyebrows, numbered index rows, a thick-over-thin double rule at the foot), and the boldness comes off a silkscreen press: oversized uppercase display type, offset hard-shadows in a single ink, a grain overlay on the largest surfaces. The two halves are not in tension, they are the same shop. The paper is quiet and precisely ruled so the ink can be loud in the few places it lands.

The components are refined and restrained. Hairline borders, small radii (2 to 4px, never more), color held back to focus and hover, nothing elevated at rest. The system spends its entire boldness budget on two things: the display type, and what happens when you touch something. A button sits flat as a solid ink slab until hover, when it lifts three pixels off a hard accent shadow. A headline sits flat until hover, when the same offset appears behind it as a text-shadow. That single gesture, repeated at every scale, is the system's signature.

The confirmed anti-reference is the site's own retired layer. The `:root` block in [base-style.css](base-style.css) still carries the previous dark theme: navy gradients (`#0f172a`, `#1a202c`), a 16px radius, `Inter` on `body`, gradient-filled hero text, and traces of the generic AI indigo `#667eea` in the contact card border and the globe icon's drop-shadow. That layer is legacy, kept alive only for views not yet converted. It is evidence of where this design came from, and it is explicitly not where new work goes.

**Key Characteristics:**
- Warm paper ground (`#f6f2ea`), never white, never a gradient
- Uppercase Bricolage Grotesque at 800 for display, tracked negative
- Space Mono in uppercase for every label, eyebrow, button, and status line
- One accent per section, carried through a `--acc` variable
- Flat at rest; hard offset shadows only as a response to state
- Radius 2 to 4px, and 0 where a rule reads better than a box

## Colors

A warm neutral ground with four saturated inks that are used as punctuation, never as surface.

### Primary
- **Kiln Clay** (`#d4451f`): The site's voice. Eyebrows, section labels, the logo dot, active link underlines, focus rings, error text, and the default `--acc` on the first section of a page. Present on nearly every surface but never covering one.
- **Fired Clay** (`#b8371a`): Two roles. The pressed and hovered state of any clay fill, and the resting colour of **small clay text**. Clay on paper measures 4.03:1, under the 4.5:1 AA bar, so any clay type below 18.66px uses fired clay instead (5.23:1). Clay keeps the rules, borders, underlines, fills and large display type, where the bar is 3:1.

### Secondary
- **Poster Cobalt** (`#1f35e0`): The second-position accent. Marks the shift into deeper territory: the featured project rows, the edition banner, the wordmark's hover shadow on the homepage. An electric blue against a warm ground, deliberately jarring at small sizes and only ever at small sizes.
- **Deep Cobalt** (`#1226c0`): Pressed state for cobalt fills.

### Tertiary
- **Deep Pine** (`#2f5b53`): Semantic success and calm. Confirmation status lines, positive states. Never decorative.
- **Marigold** (`#f2b705`): The rarest ink. Highlight and emphasis only, in small quantities, on the homepage and dashboard.
- **Signal Red** (`#b3261e`): Destructive actions and hard errors on tool surfaces. Distinct from clay on purpose: clay is voice, signal red is consequence.

### Neutral
- **Gallery Paper** (`#f6f2ea`): The page ground everywhere.
- **Shadowed Paper** (`#efe9dd`): Recessed areas, image wells, hover fills on quiet rows.
- **Card Stock** (`#fffdf8`): Raised surfaces. Cards, panels, input fields on focus. The one color lighter than the page.
- **Press Ink** (`#1c1a17`): All primary text, all rules, all solid button fills. A warm near-black, never `#000`.
- **Stone Grey** (`#6b6256`): Secondary text, decks, labels, nav links at rest.
- **Faint Stone** (`#a49a8a`): Placeholder text and disabled labels only.
- **Hairline** (`rgba(28, 26, 23, 0.12)`): Every divider, card border, and quiet rule. Tinted from ink, never a neutral grey.

### Named Rules

**The One Accent Per Section Rule.** Each section commits to exactly one accent and declares it once as `--acc`. Every hover, rule, number, and arrow inside that section reads from `--acc`. Two accents never appear within one section. The professional band runs clay; the featured index runs cobalt. Precedent: `.pindex__band` and `.pindex__featured` in [views/homepage/kinetic.css](views/homepage/kinetic.css).

**The Warm Neutral Rule.** No neutral in this system is achromatic. Paper is warm, ink is warm, stone is warm, and every hairline and shadow is tinted from `rgba(28, 26, 23, ...)`. A pure grey or a `rgba(0,0,0,...)` shadow reads as a foreign object on this stock.

## Typography

**Display Font:** Bricolage Grotesque (with sans-serif)
**Body Font:** IBM Plex Sans (with sans-serif)
**Label / Mono Font:** Space Mono (with monospace)

**Character:** A wide, slightly eccentric grotesque set enormous and tight against a calm humanist body face, with a typewriter mono doing all the labelling. Bricolage runs variable from 300 to 800 but is used almost entirely at 800; IBM Plex Sans covers 300 to 700; Space Mono is 400 and 700 plus italics. The display face carries the poster; the body face carries the reading; the mono carries the machinery. Each has one job and never takes another's.

### Hierarchy
- **Display** (Bricolage Grotesque, 800, line-height 0.84, tracking -0.035em, uppercase): Page heroes, at `clamp(2.5rem, 9vw, 6.5rem)`. The homepage hero alone escalates to `clamp(3.4rem, 14vw, 13rem)` via `.leaf.kinetic-hero`; no other surface gets that size.
- **Headline** (Bricolage Grotesque, 800, line-height 0.98, tracking -0.02em, uppercase): Featured index rows and major section headings, at `clamp(1.7rem, 4.2vw, 3.3rem)`. Set with `text-wrap: balance`.
- **Title** (Bricolage Grotesque, 800, line-height 1.1, tracking 0.02em, uppercase): Section head bars and card titles, at `clamp(1rem, 1.6vw, 1.25rem)`.
- **Body** (IBM Plex Sans, 400, 0.85 to 1rem, line-height 1.5 to 1.6): All prose. Measure capped at 62ch on decks, 65 to 75ch on long reads.
- **Label** (Space Mono, 700, 0.62 to 0.82rem, tracking 0.12 to 0.28em, uppercase): Eyebrows, nav links, buttons, field labels, counts, status lines, corner tags. Always uppercase, always tracked wide.

### Named Rules

**The Mono Labels Everything Rule.** If it names, counts, tags, or commands rather than reads, it is Space Mono, uppercase, tracked 0.12em or wider. Buttons, eyebrows, field labels, status lines, breadcrumbs, and counts all speak this one grammar. Prose never does.

**The Tight Display Rule.** Display and headline type is set tighter than it looks comfortable: line-height under 1.0, tracking negative to -0.035em. The size does the shouting, the spacing keeps it from sprawling.

**The Fraunces Migration Rule.** Bricolage Grotesque is the display face. Fraunces is the previous one and now survives only on the signed-in tools: `views/account`, `views/admin`, `views/stocks`, `views/compass`, `views/ip`, `views/download`, `views/masaza`, plus the costume views `views/recipes` and `views/nebo`, which own their palettes. `views/projects` was converted, and the `body.editorial` fallbacks in [base-style.css](base-style.css) now ask for Bricolage (they used to name a face those pages never loaded, so every project card title on `views/about` rendered in the browser's default serif). That is documented drift, not a second option. New surfaces use Bricolage; convert a Fraunces surface when you are already working in it, not as a separate errand.

## Layout

Centered containers at 1200px (`.container`) and 1280px (`.kinetic-hero__inner`), with 1.5rem of gutter on phones widening to 2.5rem from 768px. Sections breathe at `6rem 0`.

Breakpoints are the Tailwind defaults where Tailwind is in play (640 / 768 / 1024px), and hand-written CSS mirrors them at 480, 767, 768, and 1024px. The main navigation collapses at 768px into a full-width stacked panel.

Rhythm is asymmetric on purpose: more space above a heading than below it, tight groups with generous separation between them. The recurring rem steps are 0.6, 1, 1.6, 3, and 6rem. The homepage hero lays a poster grid over the page, faint vertical rules every 1/6 of the width, pixel-snapped with `round(calc(100% / 6), 1px)` so the hairlines stay crisp on high-DPI screens.

**The Rule Over Box Rule.** Structure is drawn with rules, not containers. A section head is a label plus a 2 or 3px accent rule running to the edge; a list is rows separated by hairlines; the foot of a section is a thick-over-thin double rule. Reach for a bordered box only when the content genuinely needs enclosing, and never nest one inside another.

## Elevation & Depth

Flat at rest, hard on state. Nothing in this system is elevated by default. Depth is drawn, not simulated: hairline borders, tonal steps between paper, shadowed paper, and card stock, and the poster grid's vertical rules.

Shadows appear only as a response to interaction, and when they do they are hard-edged offsets with zero blur in the section accent. The element moves toward the viewer (`translate(-3px, -3px)`) as the shadow appears behind it, so the offset reads as the object lifting off the page rather than as a glow around it.

The single exception is the shared project card, which carries a soft ambient shadow on hover (`0 12px 30px rgba(28, 26, 23, 0.08)`). It is a card in a grid of cards, and a hard offset on twelve of them at once would be noise.

### Shadow Vocabulary
- **Hard offset, small** (`box-shadow: 3px 3px 0 var(--acc)`): Wordmark monogram, ghost and secondary buttons.
- **Hard offset, standard** (`box-shadow: 6px 6px 0 var(--acc)`): Primary buttons and the colophon submit. Declared as `--hard: 6px 6px 0` on `.kinetic`.
- **Hard offset, hover escalation** (`box-shadow: 9px 9px 0 var(--acc)`): The hero button on hover, where the shadow grows as the button lifts.
- **Hard offset, ink** (`box-shadow: 3px 3px 0 rgba(28, 26, 23, 0.85)`): The tool-surface variant, where the offset is ink rather than accent.
- **Ambient lift** (`box-shadow: 0 12px 30px rgba(28, 26, 23, 0.08)`): Project cards only.
- **Focus ring** (`box-shadow: 0 0 0 3px rgba(212, 69, 31, 0.18)`): A soft clay halo on focused inputs, paired with the border inking to full ink. Tool surfaces use the same ring at 0.12 alpha.

The one offset that is not a `box-shadow` is the featured headline's, which is drawn as `text-shadow: 0.08em 0.08em 0 var(--acc)`. It is scaled in `em` so the offset stays proportional across the headline's clamp range.

### Named Rules

**The Flat-At-Rest Rule.** If an element has a shadow before the user touches it, that shadow is wrong. The one licensed exception is the project card's ambient hover lift.

**The Ink-Or-Accent Rule.** A hard shadow is either the section accent (`var(--acc)`, on poster surfaces) or ink at high alpha (`rgba(28, 26, 23, 0.85)`, on tool surfaces). It is never a soft neutral drop shadow.

## Shapes

Nearly rectangular. The radius scale tops out at 4px and most of the system sits at 2 or 3px: enough to soften a printed edge, never enough to read as a rounded card. Full rectangles (radius 0) are correct wherever the element is behaving like a printed block rather than a control.

Borders carry the form language. Tool surfaces use 1px hairlines at `rgba(28, 26, 23, 0.12–0.18)`; poster surfaces step up to 2px solid ink on buttons, boxed inputs, and the edition banner, and 3px on accent section rules. The pill radius (999px) exists only on the navbar language picker, a legacy shape from the dark theme.

Recurring silhouettes: the ruled section head (label, then a rule flexing to fill), the thick-over-thin double rule, the vertical corner tag set in `writing-mode: vertical-rl`, and the stroked outline numeral (`-webkit-text-stroke: 2px`, transparent fill) that inks in on hover.

## Components

### Buttons
- **Shape:** Effectively square (2 to 3px radius), 2px solid border on poster surfaces and borderless on tool surfaces.
- **Primary (poster):** Solid ink fill, paper text, Space Mono 700 uppercase at 0.78 to 0.8rem tracked 0.06 to 0.14em, padding `0.85rem 1.6rem`. Rests flat with a `6px 6px 0` accent shadow already declared; on hover it translates `-3px, -3px` and the shadow grows to `9px 9px 0` in clay while the fill flips to clay.
- **Primary (tool):** Clay fill, paper text, 3px radius, padding `11px 22px`. Hover darkens to fired clay and lifts `-1px, -1px` onto a `3px 3px 0 rgba(28,26,23,0.85)` ink shadow. Active returns to `0,0` with the shadow shrinking to 1px, so the press reads as a real press.
- **Ghost:** Transparent fill, stone text, 1px hairline border, smaller type (11px) tracked wider (0.12em). Hover inks both text and border to clay. No movement, no shadow.
- **Text link:** Ink text with a 2px clay bottom border. Hover flips both text and border to cobalt.
- **Disabled:** `opacity: 0.55`, cursor default, all hover transforms suppressed.

### Inputs / Fields
- **Style:** Label above field, never beside it. The label is Space Mono uppercase at 0.62 to 0.64rem tracked 0.12 to 0.22em in stone. The field is a ruled box: paper or card fill, 1px hairline on tool surfaces or 2px `rgba(28,26,23,0.35)` on the colophon, 3px radius.
- **Focus:** The border inks to full `#1c1a17` (or clay on tool surfaces), the background lifts from paper to card stock, and a 3px soft clay ring appears. Never an outline, never a movement.
- **Error:** Border flips to clay, with the message set in Space Mono at 0.68rem in clay directly beneath.
- **Placeholder:** Faint stone (`#a49a8a`) or `rgba(28, 26, 23, 0.32)`. Never a full-contrast grey.
- **Dates:** Always a text input with `inputmode="numeric"`, `maxlength="10"`, and a `dd.mm.yyyy` placeholder. Never `<input type="date">`, which renders in the browser's locale and swaps day and month for European visitors. Parsing lives in the view's `logic.js`; ISO stays the wire format. See [views/stocks/logic.js](views/stocks/logic.js).

### Cards / Containers
- **Corner Style:** 4px radius (`--border-radius` under `body.editorial`).
- **Background:** Card stock (`#fffdf8`) on paper, with the image well in shadowed paper (`#efe9dd`).
- **Border:** 1px hairline, flipping to clay on hover.
- **Shadow Strategy:** Flat at rest; the ambient lift on hover, paired with `translateY(-4px)`. See Elevation.
- **Internal Padding:** 1.5rem.
- **Badge:** Ink fill, paper text, 2px radius, 0.65rem at tracking 0.08em uppercase, pinned top-right.

### Navigation
Fixed bar over a translucent paper wash (`rgba(246, 242, 234, 0.8)`, deepening to 0.95 on scroll) with a `backdrop-filter: blur(10px)` and a hairline bottom border. This is the **default** skin, and the bar carries its own `--nav-*` tokens with fallbacks so it renders the same on a page that loads neither `theme.css` nor `body.editorial`. A page whose ground is genuinely dark opts into the retired navy skin with `<main-navbar theme="dark">`. Links are Space Mono 700 uppercase at 0.82rem tracked 0.14em in stone, inking to full ink on hover with a clay underline growing from the left. Below 768px the menu becomes a full-width stacked panel sliding down from the bar, each row a full-bleed 1.25rem tap target divided by hairlines.

The wordmark is a square monogram tile (2.15rem, 3px radius, ink-on-paper inverted) beside the name in Space Mono 700 with a clay dot. On hover the tile shifts `-1px, -1px` onto a 3px hard shadow, cobalt on the homepage and clay elsewhere.

### The Numbered Index Row
The system's signature component. A three-column grid: a Space Mono ordinal in stone, the content block, and a mono arrow in clay, separated from its neighbours by a hairline. The headline sits flat with a transparent `text-shadow` declared; on hover, focus-within, or active it pops onto `0.08em 0.08em 0 var(--acc)` while the ordinal and arrow take the accent and the arrow nudges `4px, -4px`. The whole row is one stretched-link tap target (`.pindex__cover`), so nothing depends on hover being available. Precedent: `.pindex__row` in [views/homepage/kinetic.css](views/homepage/kinetic.css).

### Section Head
A label, a rule, and a count. The ordinal is set in outline (`-webkit-text-stroke: 2px var(--ink)` over `color: transparent`) and fills with the accent on hover; the label is Space Mono uppercase tracked 0.24em in the accent; the rule is a 2 or 3px ink or accent bar flexing to fill the remaining width. On the projects index the count trails as `/ 4` in mono stone.

## Do's and Don'ts

### Do:
- **Do** set every label, eyebrow, button, count, and status line in Space Mono, uppercase, tracked 0.12em or wider.
- **Do** declare one `--acc` per section and read every hover, rule, ordinal, and arrow inside it from that variable.
- **Do** give interactive elements a hard offset on state: `translate(-3px, -3px)` paired with `Npx Npx 0 var(--acc)`, zero blur.
- **Do** tint every shadow, border, and divider from `rgba(28, 26, 23, ...)`.
- **Do** cap body measure at 62ch on decks and 75ch on long reads.
- **Do** reassert `body { background: <color>; }` in a view's own `style.css`. `base-style.css` paints `body` with a navy gradient via the `background` shorthand, and a gradient is a background-image, so it visually beats any Tailwind `bg-*` utility.
- **Do** append `transform: translateZ(0)` and `backface-visibility: hidden` to stacked gradient or `clip-path` layers to stop hairline seams on high-DPI displays. Append, never replace an existing transform, and skip `backface-visibility` on anything rotating past 90deg.
- **Do** ship a `prefers-reduced-motion` override with any new animation. 32 stylesheets already carry one.
- **Do** give every hover affordance a `:focus-visible` equivalent, and make row-level targets a stretched link rather than a hover-only region.

### Don't:
- **Don't** reach for Fraunces on a new surface. Bricolage Grotesque is the display face; Fraunces is drift being migrated out.
- **Don't** use Inter, Roboto, Arial, or a system stack. The `font-family: 'Inter'` on `body` in [base-style.css](base-style.css) belongs to the retired dark theme.
- **Don't** reintroduce the legacy indigo `#667eea`, the navy gradients (`#0f172a`, `#1a202c`, `#2d3748`), the 16px radius, or gradient-filled text. All four are the confirmed anti-reference, still visible in `base-style.css` `:root` and `.hero h1`.
- **Don't** mix two accents inside one section.
- **Don't** put a shadow on anything at rest, or use a soft blurred drop shadow anywhere except the project card's hover lift.
- **Don't** exceed a 4px radius on any editorial surface. The 999px pill and 16px `--border-radius` in the `:root` block are legacy.
- **Don't** use a pure grey, a pure black, or a pure white. Every neutral in this system is warm.
- **Don't** ship a native `<input type="date">`.
- **Don't** apply the house palette to a showcase project that has committed to its own world.

### Where the system lives

The palette and type scale are declared **once**, in
[components/editorial/theme.js](components/editorial/theme.js) (hex, so Tailwind's
slash-opacity utilities like `text-stone/80` can compute an alpha) and mirrored as CSS
custom properties in [theme.css](components/editorial/theme.css), which also carries the
motion scale, the radius scale and the focus ring. They used to be retyped in 22 inline
`tailwind.config` blocks; `tests/editorial-theme.test.mjs` fails if the two halves drift
or if a 23rd page starts declaring its own.

The poster hero (grid, grain, hero shell, the rise/blink/fade keyframes and the scroll
reveal) lives in [components/editorial/poster.css](components/editorial/poster.css). It
was previously copy-pasted into `views/thesis` as `.vr-*` and `views/on-this-day` as
`.otd-*`. Per-page differences that survived the merge (grid alpha, mask stop, reveal
distance) are custom properties each page sets on a scope it already owns, so
deduplicating it moved nothing on screen.

A page joins the system with three tags in the head:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="../../components/editorial/theme.js"></script>   <!-- classic, not module -->
<link rel="stylesheet" href="../../components/editorial/theme.css">
```

### Scope

This system is normative for the portfolio chrome and the private tools: `index.html`, `views/about`, `views/projects`, `views/blog`, `views/seo`, `views/account`, `views/admin`, `views/dashboard`, `views/stocks`, `views/compass`, `views/list`, `views/download`, `views/ip`, `views/music`, `views/masaza`, `views/thesis`, `views/on-this-day`, and the shared `components/`.

Showcase projects are licensed to commit to their own visual world, and several already have: `views/flowers` and `views/wildflowers` (night, moss, cream, Instrument Serif), `views/workout` (iron, ember, Big Shoulders), `views/spy` (blood, amber, Black Ops One), `views/sourdough` (crust, crumb, Special Elite, hard stamp shadows), `views/jeger` (gold on night, UnifrakturMaguntia), `views/nebo` (night blue, brass), `views/recipes` (linen, ember, Karla), `views/trails` (night aeronautical chart: slate ground, sectional magenta, chart cyan, caution amber, B612), and `views/store`. That independence is the rule, not the exception: a project surface earns its own world when the subject calls for one. What it inherits regardless is the craft floor: warm neutrals over pure ones, a real focus state, a reduced-motion override, hairline discipline, and one committed direction rather than a blend.
