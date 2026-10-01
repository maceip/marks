<p align="center">
  <a href="https://marks.secure.build">
    <img width="256" src="https://github.com/user-attachments/assets/f66e8cde-a9af-479c-91d1-df2c68107087" alt="Marks" />
  </a>
</p>

# Marks

Marks is a collaborative Markdown workspace built for responsive editing of
large documents. It combines a CodeMirror editor, an incrementally rendered
preview, offline storage, and real-time collaboration in one browser client.

![Marks split editor and preview](docs/screenshots/split-light.png)

## Architecture

The browser applies each edit to a local ESBT sequence CRDT before doing any
network work. The same Rust engine runs as a WebAssembly Component in the
browser and natively in `marks-server`, so the client and server exchange one
canonical set of snapshot and update formats rather than maintaining separate
document engines.

Preview work runs outside the input path. Exact edit ranges are sent to a Web
Worker, which reparses affected Markdown blocks and returns only changed HTML.
The main thread sanitizes and reconciles those blocks by stable keys, preserving
unchanged DOM nodes, rendered diagrams, and selections. Document-wide features
such as link references and footnotes deliberately trigger a full parse.

The repository is organized around explicit boundaries:

```text
client/                 React, TypeScript, CodeMirror, workers, and Wasm adapter
crates/marks-auth/      identity and authorization validation
crates/marks-server/    HTTP, WebSocket rooms, persistence, and native ESBT
config/                 product variants and feature contracts
scripts/                build, verification, benchmark, and browser harnesses
docs/                   architecture, protocol, UI, and operations references
deploy/                 Caddy, systemd, backup, and release configuration
```

The server owns sessions, access control, durable rooms, and SQLite commits.
Presence remains transient and separate from document state. Local work is
journaled in IndexedDB, while committed mutations use stable retry identifiers
so reconnects do not duplicate edits. See the [documentation index](docs/README.md)
for the detailed contracts.

## Performance

Marks keeps typing independent of parsing, rendering, persistence, and network
latency. Incremental parsing limits ordinary edits to dirty source blocks;
content hashes prevent unchanged preview blocks from repainting; and
`content-visibility` avoids layout and paint work for off-screen content.

The in-app performance panel reports edit-to-paint latency, dirty blocks, DOM
operations, parsing and rendering time, encoded bytes, and journal state. The
engine benchmark runs the checked-in Wasm artifact in a worker and produces a
downloadable receipt containing median and p95 samples, artifact hashes, seed,
browser, memory, and encoded size. These receipts are intended to make results
reproducible rather than serve as cross-engine claims.

## Development

Requirements are Node.js 24 or newer and the pinned Rust toolchain.

```bash
npm install
npm run dev                 # client at http://localhost:5173
cargo run -p marks-server   # API and room server at http://localhost:3000

npm run build
npm run typecheck
npm run test:markdown
npm run test:component
cargo test --workspace
```

The default client runs in local workspace mode. Set
`VITE_MARKS_DATA_MODE=service` to build against the Rust document service; the
Vite development server proxies `/v1` and `/collab` to `MARKS_SERVER`. Server
configuration is documented in
[`crates/marks-server/README.md`](crates/marks-server/README.md), and deployment
operations are documented in [`deploy/README.md`](deploy/README.md).

## Built with

[ESBT](https://github.com/maceip/ESBT-web) ·
[CodeMirror](https://codemirror.net/) ·
[React](https://react.dev/) ·
[markdown-it](https://github.com/markdown-it/markdown-it) ·
[WebAssembly Components](https://component-model.bytecodealliance.org/) ·
[Rust](https://www.rust-lang.org/)

more coming soon
