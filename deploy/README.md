# Deploy marks.secure.build

Production host is `devuser@secure.build` (`vectorheart`). Caddy terminates
TLS for the subdomain; Knot is authoritative for `secure.build.`; systemd
runs the one Rust process.

| Piece | Location |
| --- | --- |
| Binary + static UI | `/opt/marks` |
| SQLite | `/var/lib/marks/marks.db3` |
| Unit | `/etc/systemd/system/marks.service` |
| Reverse proxy | `/etc/caddy/Caddyfile` site `marks.secure.build` |
| DNS | Knot zone `secure.build.` → `marks` A `142.248.222.1` |
| Listen | `127.0.0.1:5192` |
| Origin | `https://marks.secure.build` |

## Build

```bash
cargo build -p marks-server --release --locked
VITE_MARKS_DATA_MODE=service npm run build
```

## Install (already applied on the host)

```bash
sudo install -d -o devuser -g devuser /opt/marks /opt/marks/static /var/lib/marks
sudo install -o devuser -g devuser -m 0755 target/release/marks-server /opt/marks/marks-server
sudo rsync -a --delete client/dist/ /opt/marks/static/
sudo install -m 0644 deploy/systemd/marks.service /etc/systemd/system/marks.service
# append deploy/caddy/marks.Caddyfile to /etc/caddy/Caddyfile if missing
sudo systemctl daemon-reload
sudo systemctl enable --now marks.service
sudo caddy reload --config /etc/caddy/Caddyfile
```

The unit restarts on failure with systemd backoff (`RestartSec=2s`,
`RestartSteps=5`, `RestartMaxDelaySec=60s`). Caddy drops scanner paths,
rejects `Content-Length` over 8 MiB with 413, and wraps remaining bodies
with `request_body`; CrowdSec already parses Caddy logs for HTTP floods.

DNSSEC is on for this zone. Add or update the name with `knotc`, not by
editing the zone dump:

```bash
sudo knotc zone-begin secure.build.
sudo knotc zone-set secure.build. marks 3600 A 142.248.222.1
sudo knotc zone-commit secure.build.
```
