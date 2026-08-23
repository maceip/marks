# Ribbon core: protected interface boundary

The ribbon core stream is based on `origin/main@bddaec4` and intentionally has
no net changes to the Rust crates, Cargo files, deployment surface, ESBT
artifacts or profile, collaboration engine, or server/database/protocol code.
The client command layer consumes the existing `CollabSession.capabilities()`
getter and the existing editor extension; it does not widen those interfaces.

## Deferred capability-change notification

Immediate ribbon reprojection after an asynchronous role change would require
one narrow, read-only subscription on `CollabSession`, such as:

```ts
onCapabilitiesChange(listener: (capabilities: DocumentCapabilities) => void): () => void;
```

That subscription should report the already-authoritative client capability
state. It should not alter the collaboration wire protocol, database schema, or
authorization decisions. Until that interface is reviewed separately, the
ribbon reads `capabilities()` during normal application renders and the command
runtime reauthorizes every invocation immediately before execution.

## Deferred ribbon Undo and Redo

The ESBT editor extension already owns the established keyboard history path.
Reliable ribbon buttons would additionally need a public, per-replica session
surface such as `canUndo()`, `canRedo()`, `undo()`, and `redo()`, with explicit
boolean results and change notifications for availability. Until those
semantics are reviewed separately, core does not advertise Undo or Redo as
ribbon, quick-access, palette, or agent commands; the existing editor keyboard
bindings remain unchanged.
