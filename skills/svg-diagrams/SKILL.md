---
name: svg-diagrams
description: Rules for SVG graphics, icons, logos and diagrams (architecture, flow, sequence, graphs) as SVG, Graphviz or Mermaid. Load before drawing anything vector or any diagram.
---

# SVG and diagrams

## Pick the right tool
- **Boxes and arrows, trees, dependency graphs** → Graphviz `.dot` (layout is automatic and never overlaps). Use `rankdir=LR` for pipelines.
- **Flowcharts, sequence diagrams, state machines** → Mermaid `.mmd`.
- **Precise illustration, icon, logo, chart with custom styling** → hand-written SVG.
Don't hand-place diagram boxes in raw SVG when Graphviz/Mermaid can lay them out.

## The loop (mandatory)
Write the file → `look` at it → list what's wrong (overlaps, cut-off text, lines crossing labels, uneven spacing) → fix → look again. Never finish without looking.

## SVG rules
- Always a `viewBox` (e.g. `0 0 800 450`); design on a grid of 8 units; round coordinates.
- Leave a 16–24 unit margin inside the viewBox; nothing touches the edge.
- Text: set `font-family="system-ui, sans-serif"`, 2–3 sizes max, `text-anchor` + `dominant-baseline` for centering. Estimate text width (≈0.6 × font-size per character) and make boxes fit it plus padding.
- Colors: 1 accent + neutrals, defined once (`<style>` with classes or CSS variables). Strokes 1.5–2 at this scale, same width everywhere.
- Group related parts in `<g>` with transforms instead of repeating absolute coordinates.
- Icons: 24×24 viewBox, 2px stroke, `stroke-linecap="round"`, `fill="none"` — or better, take one from lucide.
- Charts: axes and labels readable, zero baseline for bars, no 3D, no more than 5–6 series colors.
- Complex organic shapes (people, animals, scenery) are beyond reliable hand-written paths: say so and propose a simpler stylised version or an image instead.

## Diagram rules
- One idea per diagram; 5–12 nodes is readable, 30 is not — split it.
- Labels are short nouns; edges get verbs only when needed.
- Consistent direction (left→right or top→bottom), consistent shapes per kind of thing, a legend if color means something.
