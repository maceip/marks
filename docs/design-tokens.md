# Design token policy

`client/src/styles/tokens.css` is the single CSS entry point for design values.
It separates implementation-only primitive palettes from semantic tokens and
contains all light/dark theme overrides. Components must use semantic tokens;
they must never depend directly on `--primitive-*` values.

## Global token or local property?

Add a **global token** when a value expresses a reusable design decision. This
includes color roles (primary, secondary, tertiary, destructive, success,
warning, info), type, spacing, shared control or icon dimensions, shape,
borders, opacity, elevation, layering, motion, interactivity, and material
treatment. Repeated values are a strong signal that the decision belongs in
`tokens.css`.

A **local custom property** is acceptable when it names component-owned
geometry or runtime state, such as a responsive split position, list item
index, avatar color supplied by data, or pointer tilt. Its name
must describe that local purpose, it should be declared near its consumer, and
it must not be used to alias a palette value or evade a global semantic token.

TypeScript and canvas code should read CSS through the typed property names in
`client/src/design-system/tokens.ts`. Numeric values should only live in that
module when browser code cannot practically obtain them from computed styles;
do not mirror CSS values merely for convenience.

## Enforcement

Run `npm run test:tokens`. The static contract scans shared and route CSS for
retired variable names, primitive consumption, and common raw literals that
have semantic equivalents. Extend the check when a newly retired spelling or
frequently repeated literal is discovered.
