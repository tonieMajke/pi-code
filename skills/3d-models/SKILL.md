---
name: 3d-models
description: Workflow for building or editing 3D models in Blockbench (low-poly, Minecraft / Vintage Story) and Blender through their MCP servers. Load before any modelling, texturing or scene work.
---

# 3D models (Blockbench, Blender)

Both editors are reached through the `mcp` tool (load it with `enable_tools` if needed):
- `mcp({ search: "blockbench" })` / `mcp({ search: "blender" })` to list their tools, then `mcp({ tool: "<name>", args: {...} })`.
- Blockbench must be running with its MCP plugin (http://localhost:3000/bb-mcp); Blender with the "MCP for Blender" add-on connected (sidebar → MCP → Connect). If a call fails to connect, tell the user which app to open — don't retry in a loop.

## The loop (mandatory)
1. Plan the model as a list of parts with sizes in the editor's units BEFORE creating anything (e.g. "handle 2×10×2 at y=0, head 6×4×2 at y=10").
2. Build a few parts.
3. Take a screenshot (the editor's viewport screenshot tool) from at least two angles (front + three-quarter). Look at proportions, gaps, parts floating or intersecting, pivot placement.
4. Fix, screenshot again. Never finish a modelling step without a screenshot after the last change.

## Blockbench / Vintage Story
- For Vintage Story shapes, first read the project's `MODELE-VINTAGE-STORY.md` notes if present (search the workspace for it) — measured skeleton sizes, coordinate conventions (blocks vs clothing differ), rotation signs and known traps. Measure from the game's assets, don't assume Minecraft conventions.
- Cube sizes on the 1/16 grid; keep the element count low; name every element and group meaningfully.
- Pivots at real joints (hinge of a lid, base of a handle) so rotation/animation works.
- Textures: consistent texel density across parts (same pixels per unit), limited palette (4–8 colors per material), shading by hand: light top-left, darker bottom-right, 1-pixel outline only where the style uses it.

## Blender
- Prefer `execute_blender_code` with small, readable bpy scripts; one logical step per call; print what was created.
- Apply scale before exporting; origin where it makes sense; real-world units (1 unit = 1 m) unless the target engine says otherwise.
- Low-poly: bevel only where light catches edges, flat or smooth shading chosen on purpose, triangulate only on export.
- Materials: a small set, named; check them in Material Preview in the screenshot, not only the solid view.

## Taste
Silhouette first: a model must read from its outline alone. Exaggerate the one defining feature, keep the rest simple, and avoid uniform sizes — vary proportions (big/medium/small).
