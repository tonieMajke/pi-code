---
name: ui-design
description: Rules for building good-looking UI, web pages, dashboards and components (HTML/CSS/React/Tailwind). Load before creating or restyling anything a person will look at in a browser or app window.
---

# UI design

Taste is mostly constraints plus looking at the result. Follow the rules, then render and fix.

## The loop (mandatory)
1. Build the smallest complete version.
2. `look` at it: dev-server URL (e.g. `http://localhost:5173`) or the `.html` file. Also look at a narrow width (`width: 390`).
3. Name 3 concrete problems (e.g. "card padding 12px vs 24px elsewhere", "grey text on grey fails contrast"). Fix them. Look again.
4. Stop when a second look finds nothing specific. Never finish without having looked.

## Hard rules
- **Spacing**: only 4, 8, 12, 16, 24, 32, 48, 64 px. Related things closer than unrelated things. Generous outer padding (24–32 px on cards and pages).
- **Type**: one sans-serif family (system-ui or Inter). At most 3 sizes on a screen (e.g. 13/15/20, one larger for the page title). Weights 400 and 600 only. Line height 1.4–1.6 for text. Max text width about 70 characters.
- **Color**: neutrals (backgrounds, borders, text) plus ONE accent color, used for the primary action and active states only. Define colors once as CSS variables. Text contrast at least 4.5:1; never light grey on white for body text. Status colors (red/green/amber) only for status.
- **Hierarchy**: one obvious primary element per screen. One primary button per area; others are secondary/ghost. Headings describe, they don't shout.
- **Alignment**: everything sits on a shared left edge or grid. Equal gaps between siblings. Icons vertically centered with their labels.
- **Surfaces**: corner radius from one scale (6/10/14). Borders 1px at low contrast, or shadow — rarely both. No gradients or glows unless asked.
- **Icons**: from one library (lucide / heroicons), same stroke width and size (16 or 20). Never draw icons by hand.
- **States**: hover, focus-visible, disabled, empty and loading states exist for interactive parts.
- **Responsive**: works at 390 px wide without horizontal scroll; flex/grid, not fixed widths.
- **Dark mode** (if present): separate token values, not inverted colors; check it with `look` too.

## Common small-model mistakes to check for
Default browser styles left in (Times, blue underlined links, 8px body margin) · inconsistent paddings between cards · too many colors · centered body text · text touching borders · buttons of different heights in one row · emoji instead of icons · placeholder "Lorem ipsum" left behind · repeated cards whose inner rows (titles, prices, buttons) don't line up across the row because one description is shorter — give variable-length blocks a min-height or use a subgrid.

## When the user gives a reference
Match it: measure spacing, sizes and colors from the reference image and state them before building.
