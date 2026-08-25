"""Contract tests for the installed release implementation.

These drive deploy/host/marks-release-root — the exact program production
executes — through its unprivileged test seams (MARKS_TEST_* path
redirection plus monkeypatched systemd/network effects). The security
boundary is untouched: running as root ignores every override.
"""

import hashlib
import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "deploy" / "host" / "marks-release-root"
TEMPLATE_BYTES = (REPO / "deploy" / "systemd" / "marks.service").read_bytes()

_counter = 0


def load_helper(root: Path):
    global _counter
    _counter += 1
    os.environ["MARKS_TEST_ROOT"] = str(root / "opt")
    os.environ["MARKS_TEST_INCOMING"] = str(root / "incoming")
    os.environ["MARKS_TEST_CACHE"] = str(root / "cache")
    os.environ["MARKS_TEST_CANARY"] = str(root / "canary")
    os.environ["MARKS_TEST_VERIFIED_GIT"] = str(root / "verified-git")
    os.environ["MARKS_TEST_TEMPLATE"] = str(root / "marks.service.template")
    os.environ["MARKS_TEST_LIVE_DB"] = str(root / "live" / "marks.db3")
    os.environ["MARKS_TEST_BACKUPS"] = str(root / "backups")
    (root / "marks.service.template").write_bytes(TEMPLATE_BYTES)
    name = f"marks_release_root_{_counter}"
    spec = importlib.util.spec_from_loader(name, SourceFileLoader(name, str(HELPER)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seal_fake_release(mod, name, revision, *, unit=None, assets=(), receipt_extra=None):
    release = Path(mod.RELEASES) / name
    (release / "static" / "assets").mkdir(parents=True)
    files = {
        "marks-server": b"#!/usr/bin/env bash\nexit 0\n",
        "marks-admin": b"#!/usr/bin/env bash\nexit 0\n",
        "static/index.html": b"<!doctype html>\n",
        "marks.service": unit if unit is not None else TEMPLATE_BYTES,
    }
    for asset in assets:
        files[f"static/assets/{asset}"] = f"asset {asset}".encode()
    receipt = {"schema": "marks-release.v1", "revision": revision}
    receipt.update(receipt_extra or {})
    import json

    files["release.json"] = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
    for relative, content in files.items():
        target = release / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        os.chmod(target, 0o755 if target.name in ("marks-server", "marks-admin") else 0o644)
    for directory in [release, *[p for p in release.rglob("*") if p.is_dir()]]:
        os.chmod(directory, 0o755)
    manifest = "".join(
        f"{hashlib.sha256((release / rel).read_bytes()).hexdigest()}  {rel}\n"
        for rel in sorted(files)
    )
    (release / "SHA256SUMS").write_bytes(manifest.encode())
    os.chmod(release / "SHA256SUMS", 0o644)
    return release


def silence_system_effects(mod, failing_revision=None):
    calls = []

    def fake_run(argv, *, check=True, capture=False, env=None):
        calls.append([str(item) for item in argv])
        return SimpleNamespace(returncode=0, stdout="")

    def fake_wait_ready(origin, revision, *, legacy=False, timeout=60):
        if failing_revision is not None and revision == failing_revision:
            raise RuntimeError("canary readiness failed for the failing revision")

    mod.run = fake_run
    mod.wait_ready = fake_wait_ready
    mod.install_stable_unit = lambda: None
    return calls


class ReleaseRootContract(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="marks-release-root-test.")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.mod = load_helper(self.root)
        Path(self.mod.RELEASES).mkdir(parents=True)

    def test_validation_rejects_tampered_release_bytes(self):
        release = seal_fake_release(self.mod, "release-a", "a" * 40)
        self.mod.validate_release(release)
        (release / "marks-server").write_bytes(b"#!/usr/bin/env bash\nexit 99\n")
        os.chmod(release / "marks-server", 0o755)
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            self.mod.validate_release(release)

    def test_historical_unit_is_valid_only_for_rollback(self):
        release = seal_fake_release(
            self.mod, "release-old-unit", "b" * 40, unit=TEMPLATE_BYTES + b"# older\n"
        )
        with self.assertRaisesRegex(RuntimeError, "unit template"):
            self.mod.validate_release(release)
        self.mod.validate_release(release, require_current_template=False)

    def test_activation_swaps_and_failed_activation_restores(self):
        mod = self.mod
        release_a = seal_fake_release(mod, "release-a", "a" * 40)
        release_b = seal_fake_release(mod, "release-b", "b" * 40)
        release_c = seal_fake_release(mod, "release-c", "c" * 40)
        silence_system_effects(mod, failing_revision="c" * 40)
        mod.canary = lambda *args, **kwargs: None

        mod.atomic_link(release_a, mod.CURRENT)
        mod.activate(release_b, observe=False)
        self.assertEqual(mod.link_target(mod.CURRENT), release_b)
        self.assertEqual(mod.link_target(mod.PREVIOUS), release_a)

        mod.rollback()
        self.assertEqual(mod.link_target(mod.CURRENT), release_a)
        self.assertEqual(mod.link_target(mod.PREVIOUS), release_b)

        with self.assertRaises(RuntimeError):
            mod.activate(release_c, observe=False)
        self.assertEqual(mod.link_target(mod.CURRENT), release_a)
        self.assertEqual(mod.link_target(mod.PREVIOUS), release_b)

    def test_rollback_refuses_a_live_schema_newer_than_the_target(self):
        mod = self.mod
        release = seal_fake_release(
            mod, "release-old-schema", "d" * 40, receipt_extra={"maxCompatibleSchema": 1}
        )
        silence_system_effects(mod)
        mod.canary = lambda *args, **kwargs: None
        live = Path(mod.LIVE_DB)
        live.parent.mkdir(parents=True)
        connection = sqlite3.connect(live)
        connection.execute(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
        )
        connection.execute("INSERT INTO schema_migrations VALUES (2, 0)")
        connection.commit()
        connection.close()
        mod.atomic_link(release, mod.PREVIOUS)
        with self.assertRaisesRegex(RuntimeError, "roll forward"):
            mod.rollback()

    def test_activation_takes_a_verified_pre_activation_backup(self):
        mod = self.mod
        release_a = seal_fake_release(mod, "release-a", "a" * 40)
        release_b = seal_fake_release(mod, "release-b", "b" * 40)
        silence_system_effects(mod)
        live = Path(mod.LIVE_DB)
        live.parent.mkdir(parents=True)
        connection = sqlite3.connect(live)
        connection.execute("CREATE TABLE example (id INTEGER PRIMARY KEY)")
        connection.commit()
        connection.close()
        mod.atomic_link(release_a, mod.CURRENT)
        mod.activate(release_b, observe=False)
        backups = list(Path(mod.BACKUPS).glob("pre-activation-*.db3"))
        self.assertEqual(len(backups), 1)
        copy = sqlite3.connect(backups[0])
        self.assertEqual(copy.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        copy.close()

    def test_retention_prunes_and_pool_holds_exactly_the_retained_union(self):
        mod = self.mod
        releases = []
        for index in range(1, 11):
            release = seal_fake_release(
                mod,
                f"release-{index:02d}",
                f"{index:02d}" * 20,
                assets=(f"unique-{index:02d}.js", "shared.js"),
            )
            os.utime(release, (1_000_000 + index, 1_000_000 + index))
            releases.append(release)
        mod.atomic_link(releases[9], mod.CURRENT)
        mod.atomic_link(releases[1], mod.PREVIOUS)
        pool = Path(mod.ASSET_POOL)
        pool.mkdir(parents=True)
        (pool / "orphan.js").write_bytes(b"stale")

        mod.prune_releases()

        names = sorted(p.name for p in Path(mod.RELEASES).iterdir())
        self.assertNotIn("release-01", names, "oldest unprotected release is pruned")
        self.assertIn("release-02", names, "previous is protected beyond the retention budget")
        self.assertEqual(len(names), 9)
        pooled = sorted(p.name for p in pool.iterdir())
        self.assertNotIn("orphan.js", pooled)
        self.assertNotIn("unique-01.js", pooled)
        self.assertIn("unique-02.js", pooled)
        self.assertIn("unique-10.js", pooled)
        self.assertIn("shared.js", pooled)

    def test_caches_over_their_caps_are_cleared_and_repopulate(self):
        mod = self.mod
        cache = Path(mod.CACHE) / "npm"
        cache.mkdir(parents=True)
        (cache / "kept-small").write_bytes(b"x" * 10)
        mod.CACHE_LIMIT_BYTES = {"npm": 1024}
        mod.bound_caches()
        self.assertTrue((cache / "kept-small").exists(), "under-cap caches are untouched")
        (cache / "bloat").write_bytes(b"x" * 4096)
        mod.bound_caches()
        self.assertEqual(list(cache.iterdir()), [], "over-cap caches are cleared entirely")
        self.assertTrue(cache.is_dir(), "the cache root survives for the next build")

    def test_legacy_direct_installation_is_captured_as_a_sealed_release(self):
        mod = self.mod
        marks_root = Path(mod.MARKS_ROOT)
        (marks_root / "static").mkdir(parents=True)
        (marks_root / "marks-server").write_bytes(b"#!/usr/bin/env bash\nexit 0\n")
        os.chmod(marks_root / "marks-server", 0o755)
        (marks_root / "static" / "index.html").write_bytes(b"<!doctype html>legacy\n")
        captured = mod.snapshot_legacy()
        self.assertTrue(captured.name.startswith("legacy-"))
        self.assertEqual(mod.link_target(mod.CURRENT), captured)
        self.assertEqual((captured / "marks.service").read_bytes(), TEMPLATE_BYTES)
        import json

        receipt = json.loads((captured / "release.json").read_text())
        self.assertTrue(receipt["legacy"])
        mod.validate_release(captured)


if __name__ == "__main__":
    unittest.main(verbosity=2)
