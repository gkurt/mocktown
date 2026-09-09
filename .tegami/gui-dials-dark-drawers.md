---
packages:
  mocktown: minor
---

### Added

- **A dark scheme in the GUI.** `theme` in the shell's header picks `system`, `light` or
  `dark`; `system` is the default and follows the OS. The choice is remembered and applies
  before the first paint. Panels follow the shell — the scheme is passed in their query
  string alongside the project.
- **Real dials for scenario knobs.** A knob whose schema declares a range is now a slider,
  a boolean is a switch, and one with a fixed set of values is a select — picked from the
  knob's own schema, so a mock gains a proper control by declaring one. Project settings
  are a form with each setting's description under its control, instead of a table with an
  input in one column.

### Changed

- **Clicking a row in Issues or Services opens a drawer** rather than unfolding the detail
  underneath the table, so the list stays where it was while you read.
- **Dashboard widgets have a fixed height and scroll inside themselves**, so one busy
  service no longer decides the height of the page.
- **Scrollable areas fade at the edge you can still scroll toward**, and their scrollbar
  stays out of the way until you reach for it.
