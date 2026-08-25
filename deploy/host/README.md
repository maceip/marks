# Authoritative secure.build deployment boundary

These are the exact programs and policy files installed on `secure.build`
(`vectorheart`) that implement the restricted Marks deployment protocol.
They are the production implementation, not documentation: the `probe`
operation reports the SHA-256 of every installed program plus the
root-owned service template, and `scripts/deploy-secure-build.sh` refuses
to deploy unless those hashes equal these checked-in files.

| File | Installed path | Owner/mode |
| --- | --- | --- |
| `marks-deploy-ssh` | `/usr/local/libexec/marks-deploy-ssh` | root:root 0755 |
| `marks-upload` | `/usr/local/libexec/marks-upload` | root:root 0755 |
| `marks-release-root` | `/usr/local/sbin/marks-release-root` | root:root 0755 |
| `marks.service.template` | `/etc/marks/marks.service.template` | root:root 0644 |
| `90-marks-deploy.sshd.conf` | `/etc/ssh/sshd_config.d/90-marks-deploy.conf` | root:root 0644 |
| `sudoers-marks-deploy` | `/etc/sudoers.d/marks-deploy` | root:root 0440 |

`marks.service.template` must stay byte-identical to
`deploy/systemd/marks.service`; a harness test enforces it, and
`marks-release-root` additionally fails a deployment whose uploaded
repository unit differs from the installed template, so a unit change can
never pass CI while production silently keeps an older template.

## Changing a helper

Installation is deliberately not reachable through the `marks-deploy`
account — the deployment key must never be able to rewrite its own
security boundary. To change a helper:

1. Edit the file here and validate it (`python3 -m py_compile`, `bash -n`).
2. From an administrative session, back up the installed file under
   `/root/`, install the new one root-owned with the mode above
   (`sshd -t` / `visudo -cf` for the policy files), and run
   `sudo /usr/local/sbin/marks-release-root probe` to confirm.
3. Commit the matching repository copy and deploy. Deployment fails closed
   until the installed and checked-in hashes agree, in either direction.

Provisioning history, the acceptance evidence for this boundary, and the
administrative recovery procedure are recorded on the host in
`/etc/marks/deploy-protocol.md` (pre-change backups under
`/root/marks-boundary-backup-*`).

The activation, retention, rollback-preflight, and backup contracts are
tested directly against `marks-release-root` by
`scripts/harness/marks-release-root.test.py`: running unprivileged, the
helper accepts `MARKS_TEST_*` path overrides so tests drive the exact
installed code inside a fixture tree; running as root it ignores every
override and uses only the fixed production paths.
