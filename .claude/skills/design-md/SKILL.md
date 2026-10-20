---
name: design-md
description: Build UI (pages, components, styles) in the visual style of a known brand using ready-made DESIGN.md design systems (Stripe, Linear, Vercel, Apple, Notion, Spotify, Claude, etc.). Use when the user asks to make something "look like <site>", pick a design style, or keep UI consistent with a reference design language.
---

# DESIGN.md design systems

`designs/<slug>.md` holds 84 design-system documents extracted from real websites (colors, typography, spacing, components, do/don't rules). Source: https://github.com/VoltAgent/awesome-design-md (MIT).

## Workflow

1. Find the requested brand or the closest style in `INDEX.md` (grep it by mood keywords if the user did not name a brand).
2. Read the matching `designs/<slug>.md` fully before writing any UI code.
3. Use its tokens (colors, fonts, radii, spacing) and component rules directly, for example as CSS variables or Tailwind config. Do not invent values it defines.
4. If the user wants it permanent, copy the chosen file to the project root as `DESIGN.md`.
5. If the user gives no brand and the project has a `DESIGN.md`, follow that one.

The files are inspired interpretations, not official brand assets. Do not copy logos or trademarked imagery.
