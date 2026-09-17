# Documentation

The root [README](../README.md) is the concise project overview. This directory
contains the detailed design and operating contracts used to build and review
Marks.

## Start here

- [V1 scope](V1-SCOPE.md) — product boundary, physical architecture, and release gates.
- [Client plumbing](CLIENT-PLUMBING.md) — browser ownership, persistence, and reconnect behavior.
- [ESBT integration](ESBT-INTEGRATION.md) — native/Wasm engine boundary and wire formats.
- [UI service contract](UI-SERVICE-CONTRACT.md) — browser-to-server HTTP and room interfaces.
- [Authentication and authorization](AUTHN-AUTHZ-PROTOCOL.md) — identity states, sessions, tickets, and ACLs.

## Product and interface

- [UI surface](UI-SURFACE.md) and [design system](DESIGN-SYSTEM.md)
- [Browser surface](BROWSER-SURFACE.md) and [test harness](TEST-HARNESS.md)
- [Presence](PRESENCE.md) and its [verification matrix](PRESENCE-TEST-MATRIX.md)
- [Product variants](PRODUCT-VARIANTS.md)

## Engineering reference

- [CRDT research](RESEARCH.md)
- [Design tokens](design-tokens.md) and [motion](MOTION-DESIGN-SYSTEM.md)
- [Ribbon core](RIBBON-CORE-PROTECTED-INTERFACES.md),
  [practical](RIBBON-PRACTICAL-INTERFACES.md), and
  [possibility-layer](RIBBON-WILD-INTERFACES.md) interfaces

Deployment and server-specific instructions live beside the components they
describe: [`deploy/README.md`](../deploy/README.md) and
[`crates/marks-server/README.md`](../crates/marks-server/README.md).
