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
import stat
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "deploy" / "host" / "marks-release-root"
SQLITE_WORKER_HELPER = REPO / "deploy" / "host" / "marks-sqlite-worker"
TEMPLATE_BYTES = (REPO / "deploy" / "systemd" / "marks.service").read_bytes()

_counter = 0


def load_helper(root: Path):
    global _counter
    _counter += 1
    os.environ["MARKS_TEST_ROOT"] = str(root / "opt")
    os.environ["MARKS_TEST_STATE"] = str(root / "state")
    os.environ["MARKS_TEST_INCOMING"] = str(root / "state" / "incoming")
    os.environ["MARKS_TEST_CLAIMED"] = str(root / "state" / "claimed")
    os.environ["MARKS_TEST_CANARY"] = str(root / "state" / "canary")
    os.environ["MARKS_TEST_SQLITE_STAGING"] = str(root / "state" / "sqlite-staging")
    os.environ["MARKS_TEST_SQLITE_ARCHIVE"] = str(root / "state" / "sqlite-snapshots")
    os.environ["MARKS_TEST_BUILD_ROOT"] = str(root / "state" / "build")
    os.environ["MARKS_TEST_CACHE"] = str(root / "state" / "build" / "cache")
    os.environ["MARKS_TEST_WORKSPACES"] = str(
        root / "state" / "build" / "workspaces"
    )
    os.environ["MARKS_TEST_VERIFIED_GIT"] = str(
        root / "state" / "build" / "verified-git"
    )
    os.environ["MARKS_TEST_TEMPLATE"] = str(root / "marks.service.template")
    os.environ["MARKS_TEST_NODE"] = shutil.which("node") or "/usr/bin/node"
    os.environ["MARKS_TEST_SQLITE_WORKER"] = str(
        REPO / "deploy" / "host" / "marks-sqlite-worker"
    )
    os.environ["MARKS_TEST_LIVE_DB"] = str(root / "live" / "marks.db3")
    os.environ["MARKS_TEST_BACKUPS"] = str(root / "backups")
    os.environ["MARKS_TEST_FETCH_EGRESS_POLICY"] = str(
        root / "build-fetch-egress-policy.v1"
    )
    (root / "marks.service.template").write_bytes(TEMPLATE_BYTES)
    name = f"marks_release_root_{_counter}"
    spec = importlib.util.spec_from_loader(name, SourceFileLoader(name, str(HELPER)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seal_fake_release(
    mod, name, revision, *, unit=None, assets=(), receipt_extra=None, extra_files=None
):
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
    files.update(extra_files or {})
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


def seal_stable_release(
    mod, revision, *, unit=None, assets=(), receipt_extra=None, extra_files=None
):
    """Seal one coherent v2 stable fixture with an integrity-bound build plan."""
    plan = {
        "schema": mod.BUILD_PLAN_SCHEMA,
        "productVariant": "stable",
        "deployable": True,
        "features": {"agent-chat": False, "ribbon-wild": False},
        "client": {"dataMode": "service"},
        "server": {"cargoFeatures": []},
    }
    digest = hashlib.sha256(mod.canonical_json(plan).encode()).hexdigest()
    identifier = mod.release_identity(revision, "stable", digest)
    build_receipt = {
        "schema": mod.BUILD_PLAN_RECEIPT_SCHEMA,
        "buildPlan": plan,
        "buildPlanSha256": digest,
    }
    receipt = {
        "schema": mod.RELEASE_SCHEMA,
        "releaseId": identifier,
        "productVariant": "stable",
        "buildPlanSha256": digest,
        "buildPlan": plan,
        "features": plan["features"],
        "serverCargoFeatures": [],
    }
    receipt.update(receipt_extra or {})
    files = {
        "static/marks-product-build.json": (
            __import__("json").dumps(build_receipt, indent=2, sort_keys=True) + "\n"
        ).encode(),
    }
    files.update(extra_files or {})
    return seal_fake_release(
        mod,
        identifier,
        revision,
        unit=unit,
        assets=assets,
        receipt_extra=receipt,
        extra_files=files,
    )


def silence_system_effects(mod, failing_revision=None):
    calls = []

    def fake_run(argv, **_kwargs):
        calls.append([str(item) for item in argv])
        return SimpleNamespace(returncode=0, stdout="")

    def fake_wait_ready(
        origin,
        revision,
        *,
        legacy=False,
        build_plan=None,
        timeout=60,
        fetch_json=None,
    ):
        if failing_revision is not None and revision == failing_revision:
            raise RuntimeError("canary readiness failed for the failing revision")

    mod.run = fake_run
    mod.wait_ready = fake_wait_ready
    mod.install_stable_unit = lambda: None
    return calls


def load_sqlite_worker():
    name = f"marks_sqlite_worker_test_{os.getpid()}_{id(object())}"
    spec = importlib.util.spec_from_loader(
        name, SourceFileLoader(name, str(SQLITE_WORKER_HELPER))
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install_fixture_sqlite_worker(mod):
    """Run the installed worker code directly with fixture-only paths."""
    worker = load_sqlite_worker()

    def invoke(operation, *, stage=None, publication=None):
        if operation == "inspect":
            receipt = worker.inspect(Path(mod.LIVE_DB))
        elif operation == "snapshot":
            receipt = worker.snapshot(
                Path(mod.LIVE_DB), Path(stage) / "snapshot.db3"
            )
        elif operation == "publish":
            receipt = worker.publish(
                publication,
                Path(stage) / "snapshot.db3",
                Path(mod.BACKUPS),
            )
        else:
            raise AssertionError(operation)
        return mod.validate_sqlite_receipt(receipt, operation)

    mod.run_sqlite_worker = invoke
    return worker


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

    def test_v2_release_identity_allows_two_variants_of_one_revision(self):
        mod = self.mod
        revision = "e" * 40

        def seal_variant(name, agent_chat, ribbon_wild, cargo_features):
            plan = {
                "schema": mod.BUILD_PLAN_SCHEMA,
                "productVariant": name,
                "deployable": True,
                "features": {
                    "agent-chat": agent_chat,
                    "ribbon-wild": ribbon_wild,
                },
                "client": {"dataMode": "service"},
                "server": {"cargoFeatures": cargo_features},
            }
            digest = hashlib.sha256(mod.canonical_json(plan).encode()).hexdigest()
            identifier = mod.release_identity(revision, name, digest)
            build_receipt = {
                "schema": mod.BUILD_PLAN_RECEIPT_SCHEMA,
                "buildPlan": plan,
                "buildPlanSha256": digest,
            }
            return seal_fake_release(
                mod,
                identifier,
                revision,
                receipt_extra={
                    "schema": mod.RELEASE_SCHEMA,
                    "releaseId": identifier,
                    "productVariant": name,
                    "buildPlanSha256": digest,
                    "buildPlan": plan,
                    "features": plan["features"],
                    "serverCargoFeatures": cargo_features,
                },
                extra_files={
                    "static/marks-product-build.json": (
                        __import__("json").dumps(build_receipt, indent=2, sort_keys=True) + "\n"
                    ).encode(),
                },
            )

        stable = seal_variant("stable", False, False, [])
        beta = seal_variant("beta", True, True, ["agent-chat"])
        self.assertNotEqual(stable, beta)
        self.assertEqual(mod.validate_release(stable), stable)
        self.assertEqual(mod.validate_release(beta), beta)
        self.assertEqual(len(list(Path(mod.RELEASES).iterdir())), 2)
        silence_system_effects(mod)
        with self.assertRaisesRegex(RuntimeError, "only stable"):
            mod.activate(beta, observe=False)
        mod.atomic_link(beta, mod.PREVIOUS)
        with self.assertRaisesRegex(RuntimeError, "only stable"):
            mod.rollback()

        receipt_path = beta / "release.json"
        import json

        receipt = json.loads(receipt_path.read_text())
        receipt["buildPlan"]["features"]["agent-chat"] = False
        receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        os.chmod(receipt_path, 0o644)
        with self.assertRaisesRegex(RuntimeError, "incoherent|digest"):
            mod.validate_release(beta)

    def test_normal_rollback_rejects_unknown_plan_and_break_glass_is_local_only(self):
        mod = self.mod
        mod.ensure_layout()
        legacy = seal_fake_release(
            mod, "legacy-20260825T010203Z", "0" * 40,
            receipt_extra={"legacy": True},
        )
        silence_system_effects(mod)
        mod.canary = lambda *args, **kwargs: None
        mod.atomic_link(legacy, mod.PREVIOUS)

        with self.assertRaisesRegex(RuntimeError, "v2 stable product-build receipt"):
            mod.rollback()
        mod.rollback(legacy.name, allow_legacy=True)
        self.assertEqual(mod.link_target(mod.CURRENT), legacy)

        stable = seal_stable_release(mod, "f" * 40)
        with self.assertRaisesRegex(RuntimeError, "only legacy or v1"):
            mod.rollback(stable.name, allow_legacy=True)

        with (
            patch.object(os, "geteuid", return_value=0),
            patch.dict(os.environ, {"SUDO_USER": "marks-deploy"}, clear=False),
        ):
            with self.assertRaisesRegex(RuntimeError, "local administrator root"):
                mod.require_local_break_glass()

    def test_current_production_target_rejects_beta_before_build(self):
        with self.assertRaisesRegex(RuntimeError, "fixed to stable"):
            self.mod.build_deploy("a" * 40, "beta", "b" * 64)

    def test_deploy_prunes_crash_left_final_candidates_before_claiming_source(self):
        mod = self.mod
        calls = []

        def record(name, result=None, error=None):
            def invoke(*_args, **_kwargs):
                calls.append(name)
                if error is not None:
                    raise error
                return result
            return invoke

        with (
            patch.object(mod, "ensure_layout", side_effect=record("layout")),
            patch.object(mod, "prune_releases", side_effect=record("prune")),
            patch.object(mod, "purge_stale_build_state", side_effect=record("build-clean")),
            patch.object(mod, "purge_stale_claims", side_effect=record("claim-clean")),
            patch.object(
                mod,
                "claim_uploaded_source",
                side_effect=record("claim", error=RuntimeError("stop after claim boundary")),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "stop after claim boundary"):
                mod.build_deploy("a" * 40, "stable", "b" * 64)
        self.assertEqual(
            calls,
            ["layout", "prune", "build-clean", "claim-clean", "claim"],
        )

    def test_root_builder_re_resolves_the_checked_in_plan_and_digest(self):
        import json

        receipt = json.loads(
            subprocess.check_output(
                [
                    "node",
                    "--experimental-strip-types",
                    "scripts/product-variant.ts",
                    "resolve",
                    "--variant",
                    "stable",
                    "--data-mode",
                    "service",
                    "--format",
                    "json",
                    "--require-deployable",
                ],
                cwd=REPO,
                text=True,
            )
        )
        build = self.mod.resolve_build_plan(
            REPO, "stable", receipt["buildPlanSha256"]
        )
        self.assertEqual(build["plan"], receipt["buildPlan"])
        self.assertEqual(
            build["clientOutput"],
            REPO
            / "client"
            / "dist-variants"
            / "stable"
            / f"service-{receipt['buildPlanSha256'][:16]}",
        )
        with self.assertRaisesRegex(RuntimeError, "differs from the checked-in"):
            self.mod.resolve_build_plan(REPO, "stable", "0" * 64)

    def test_root_plan_resolution_sheds_privilege_in_a_read_only_sandbox(self):
        import json

        receipt = json.loads(
            subprocess.check_output(
                [
                    "node",
                    "--experimental-strip-types",
                    "scripts/product-variant.ts",
                    "resolve",
                    "--variant",
                    "stable",
                    "--data-mode",
                    "service",
                    "--format",
                    "json",
                ],
                cwd=REPO,
                text=True,
            )
        )
        calls = []

        run_options = []

        def fake_run(argv, **kwargs):
            calls.append([str(item) for item in argv])
            run_options.append(kwargs)
            return SimpleNamespace(returncode=0, stdout=json.dumps(receipt))

        with (
            patch.object(self.mod.os, "geteuid", return_value=0),
            patch.object(self.mod, "build_identity", return_value=(42002, 42002)),
            patch.object(self.mod, "run", side_effect=fake_run),
        ):
            build = self.mod.resolve_build_plan(
                REPO, "stable", receipt["buildPlanSha256"]
            )

        self.assertEqual(build["plan"], receipt["buildPlan"])
        self.assertEqual(len(calls), 1)
        command = calls[0]
        self.assertEqual(command[0], "/usr/bin/systemd-run")
        self.assertNotEqual(command[0], str(self.mod.NODE))
        self.assertIn("--uid=42002", command)
        self.assertIn("--gid=42002", command)
        self.assertIn("--property=ProtectSystem=strict", command)
        self.assertIn("--property=PrivateNetwork=yes", command)
        self.assertIn(f"--property=BindReadOnlyPaths={REPO}:/marks-input", command)
        self.assertIn("--property=WorkingDirectory=/marks-input", command)
        self.assertIn("--property=CapabilityBoundingSet=", command)
        self.assertIn("--property=ProtectProc=invisible", command)
        self.assertIn("--property=ProcSubset=pid", command)
        self.assertGreater(command.index(str(self.mod.NODE)), 0)
        self.assertEqual(run_options[0]["capture_limit"], 128 * 1024)

    def test_root_schema_probe_runs_only_as_a_bounded_sandbox_payload(self):
        import json

        stage = self.root / "schema-stage"
        stage.mkdir()
        (stage / "marks-admin").write_bytes(b"not executed by this regression")
        calls = []
        run_options = []

        def fake_run(argv, **kwargs):
            calls.append([str(item) for item in argv])
            run_options.append(kwargs)
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"schemaVersion": 3, "maxCompatibleSchema": 5}),
            )

        with (
            patch.object(self.mod.os, "geteuid", return_value=0),
            patch.object(self.mod, "build_identity", return_value=(42002, 42002)),
            patch.object(self.mod, "run", side_effect=fake_run),
        ):
            receipt = self.mod.built_schema_receipt(stage)

        self.assertEqual(receipt, {"schemaVersion": 3, "maxCompatibleSchema": 5})
        self.assertEqual(len(calls), 1)
        command = calls[0]
        self.assertEqual(command[0], "/usr/bin/systemd-run")
        self.assertNotEqual(command[0], str(stage / "marks-admin"))
        self.assertIn("--uid=42002", command)
        self.assertIn("--gid=42002", command)
        self.assertIn(f"--property=BindReadOnlyPaths={stage}:/marks-input", command)
        self.assertIn("--property=PrivateNetwork=yes", command)
        self.assertIn("--property=RuntimeMaxSec=30", command)
        self.assertIn("--property=MemoryMax=128M", command)
        self.assertIn("--property=TasksMax=32", command)
        self.assertIn("--property=NoNewPrivileges=yes", command)
        self.assertIn("--property=CapabilityBoundingSet=", command)
        self.assertEqual(command[-4:], ["/usr/bin/env", "--", "/marks-input/marks-admin", "schema"])
        self.assertGreater(command.index("/marks-input/marks-admin"), 0)
        self.assertEqual(run_options[0]["capture_limit"], 64 * 1024)

    def test_claimed_source_survives_uploader_replacement_and_cleanup(self):
        mod = self.mod
        mod.ensure_layout()
        revision = "9" * 40
        incoming = Path(mod.INCOMING) / revision
        incoming.mkdir()
        (incoming / "identity.txt").write_text("original", encoding="utf-8")

        claimed = mod.claim_uploaded_source(revision)
        replacement = Path(mod.INCOMING) / revision
        replacement.mkdir()
        (replacement / "identity.txt").write_text("replacement", encoding="utf-8")
        shutil.rmtree(replacement)

        self.assertFalse((Path(mod.INCOMING) / revision).exists())
        self.assertEqual((claimed / "identity.txt").read_text(), "original")
        mod.freeze_claimed_source(claimed)
        workspace = mod.copy_claimed_workspace(claimed, revision)
        self.assertEqual((workspace / "identity.txt").read_text(), "original")
        self.assertEqual(claimed.parent, Path(mod.CLAIMED))
        self.assertEqual(workspace.parent, Path(mod.WORKSPACES))

    def test_legacy_cache_cleanup_removes_every_unexpected_object_without_following(self):
        self.mod.ensure_layout()
        cache = Path(self.mod.CACHE)
        target = self.root / "symlink-target"
        target.mkdir()
        (target / "preserved").write_bytes(b"outside")
        (cache / "npm").symlink_to(target, target_is_directory=True)
        (cache / "unexpected-file").write_bytes(b"stale")
        (cache / "unexpected-directory").mkdir()
        self.mod.purge_stale_build_state()
        self.assertEqual(list(cache.iterdir()), [])
        self.assertEqual((target / "preserved").read_bytes(), b"outside")

    def test_stale_release_stages_are_exact_root_owned_directories_only(self):
        mod = self.mod
        revision = "a" * 40
        digest = "b" * 64
        v2 = Path(mod.RELEASES) / f".{revision}.stable.{digest}.staging.123"
        legacy = Path(mod.RELEASES) / ".legacy-20260825T010203Z.staging.456"
        v2.mkdir()
        legacy.mkdir()
        (v2 / "partial").write_bytes(b"bounded abandoned release")
        mod.purge_stale_release_staging()
        self.assertFalse(v2.exists())
        self.assertFalse(legacy.exists())

        outside = self.root / "outside-release-stage"
        outside.mkdir()
        unsafe = Path(mod.RELEASES) / f".{revision}.staging.789"
        unsafe.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe hidden object"):
            mod.purge_stale_release_staging()
        self.assertTrue(outside.is_dir())
        self.assertTrue(unsafe.is_symlink())

        unsafe.unlink()
        (Path(mod.RELEASES) / ".unexpected").write_bytes(b"do not silently ignore")
        with self.assertRaisesRegex(RuntimeError, "unsafe hidden object"):
            mod.purge_stale_release_staging()

    def test_dependency_locks_and_fetch_network_are_fail_closed(self):
        import json

        mod = self.mod
        mod.validate_node_dependency_policy(REPO)
        mod.validate_cargo_dependency_policy(REPO)

        unsafe_node = self.root / "unsafe-node-lock"
        unsafe_node.mkdir()
        lock = json.loads((REPO / "package-lock.json").read_text(encoding="utf-8"))
        lock["packages"]["node_modules/unresolved-escape"] = {
            "name": "unresolved-escape",
            "version": "1.0.0",
        }
        (unsafe_node / "package-lock.json").write_text(
            json.dumps(lock), encoding="utf-8"
        )
        with self.assertRaisesRegex(RuntimeError, "exact workspace root"):
            mod.validate_node_dependency_policy(unsafe_node)

        marker = Path(mod.FETCH_EGRESS_POLICY)
        marker.write_text(mod.FETCH_EGRESS_POLICY_TEXT, encoding="utf-8")
        os.chmod(marker, 0o644)
        network = {
            "Name": mod.CARGO_FETCH_NETWORK,
            "Driver": "bridge",
            "Scope": "local",
            "EnableIPv4": True,
            "EnableIPv6": False,
            "Internal": False,
            "Attachable": False,
            "Ingress": False,
            "Labels": {
                "build.marks.secure/fetch-egress-policy": "marks.fetch-egress.v1"
            },
            "Options": {"com.docker.network.bridge.enable_icc": "false"},
            "IPAM": {"Config": [{"Subnet": "172.30.0.0/24"}]},
        }
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(([str(item) for item in argv], kwargs))
            return SimpleNamespace(returncode=0, stdout=json.dumps(network))

        with patch.object(mod, "run", side_effect=fake_run):
            self.assertEqual(
                mod.validate_fetch_egress_policy(),
                {
                    "schema": "marks.fetch-egress.v1",
                    "network": "marks-build-fetch",
                    "subnet": "172.30.0.0/24",
                },
            )
        self.assertEqual(calls[0][0][:4], [
            "/usr/bin/timeout", "--signal=KILL", "15s", "/usr/bin/docker"
        ])

        for field, unsafe in (("EnableIPv4", False), ("EnableIPv6", True)):
            expected = network[field]
            network[field] = unsafe
            with (
                self.subTest(field=field),
                patch.object(mod, "run", side_effect=fake_run),
                self.assertRaisesRegex(RuntimeError, "fixed egress policy"),
            ):
                mod.validate_fetch_egress_policy()
            network[field] = expected

        marker.write_text("unattested\n", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "unsupported"):
            mod.validate_fetch_egress_policy()

    def test_state_root_is_hardened_before_any_deploy_owned_child(self):
        state = Path(self.mod.STATE)
        state.mkdir(mode=0o777, parents=True)
        os.chmod(state, 0o777)
        attempted = []

        def refuse_chown(descriptor, uid, gid):
            attempted.append((descriptor, uid, gid))
            raise PermissionError("simulated root hardening refusal")

        with (
            patch.object(self.mod.os, "geteuid", return_value=0),
            patch.object(
                self.mod,
                "deploy_identity",
                return_value=(os.getuid(), os.getgid()),
            ),
            patch.object(self.mod.os, "fchown", side_effect=refuse_chown),
        ):
            with self.assertRaisesRegex(PermissionError, "hardening refusal"):
                self.mod.ensure_layout()

        self.assertEqual([(uid, gid) for _fd, uid, gid in attempted], [(0, 0)])
        self.assertFalse(Path(self.mod.INCOMING).exists())
        self.assertFalse(Path(self.mod.CACHE).exists())

    def test_build_filesystem_contract_is_distinct_bounded_and_hardened(self):
        mod = self.mod
        build_device = os.makedev(7, 41)
        state_device = os.makedev(8, 1)
        capacity = 22 * 1024**3
        build_info = SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o755,
            st_uid=0,
            st_gid=0,
            st_dev=build_device,
        )
        state_info = SimpleNamespace(st_dev=state_device)
        filesystem = SimpleNamespace(
            f_frsize=4096,
            f_bsize=4096,
            f_blocks=capacity // 4096,
        )
        mount = {
            "device": (os.major(build_device), os.minor(build_device)),
            "root": "/",
            "fileSystem": "ext4",
            "options": {"rw", "nodev", "nosuid"},
        }
        self.assertEqual(
            mod.validate_build_filesystem_contract(
                build_info, state_info, filesystem, mount
            ),
            capacity,
        )

        with self.subTest("same-device"):
            with self.assertRaisesRegex(RuntimeError, "distinct filesystem"):
                mod.validate_build_filesystem_contract(
                    build_info,
                    SimpleNamespace(st_dev=build_device),
                    filesystem,
                    mount,
                )
        with self.subTest("oversized"):
            too_large = SimpleNamespace(
                f_frsize=4096,
                f_bsize=4096,
                f_blocks=(mod.MAX_BUILD_FILESYSTEM_BYTES // 4096) + 1,
            )
            with self.assertRaisesRegex(RuntimeError, "capacity"):
                mod.validate_build_filesystem_contract(
                    build_info, state_info, too_large, mount
                )
        with self.subTest("unsafe-mount-options"):
            unsafe = dict(mount, options={"rw", "nodev"})
            with self.assertRaisesRegex(RuntimeError, "nodev,nosuid"):
                mod.validate_build_filesystem_contract(
                    build_info, state_info, filesystem, unsafe
                )
        with self.subTest("wrong-record-device"):
            wrong = dict(mount, device=(1, 2))
            with self.assertRaisesRegex(RuntimeError, "mount record"):
                mod.validate_build_filesystem_contract(
                    build_info, state_info, filesystem, wrong
                )

    def test_build_mount_record_requires_one_exact_mountpoint(self):
        mod = self.mod
        mountinfo = self.root / "mountinfo"
        record = (
            f"36 25 7:41 / {mod.BUILD_ROOT} rw,nosuid,nodev - "
            "ext4 /dev/loop41 rw\n"
        )
        mountinfo.write_text(record, encoding="utf-8")
        parsed = mod.build_mount_record(Path(mod.BUILD_ROOT), mountinfo)
        self.assertEqual(parsed["device"], (7, 41))
        self.assertEqual(parsed["fileSystem"], "ext4")
        self.assertEqual(parsed["source"], "/dev/loop41")

        mountinfo.write_text(record + record, encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            mod.build_mount_record(Path(mod.BUILD_ROOT), mountinfo)

    def test_loop_backing_must_be_fully_allocated(self):
        mod = self.mod
        size = 22 * 1024**3
        allocated = SimpleNamespace(
            st_mode=stat.S_IFREG | 0o600,
            st_uid=0,
            st_gid=0,
            st_size=size,
            st_blocks=size // 512,
            st_dev=os.makedev(8, 1),
        )
        mod.validate_loop_backing_contract(allocated, os.makedev(7, 41))
        sparse = SimpleNamespace(**vars(allocated))
        sparse.st_blocks = 1
        with self.assertRaisesRegex(RuntimeError, "sparse"):
            mod.validate_loop_backing_contract(sparse, os.makedev(7, 41))

    def test_build_and_canary_processes_have_hard_resource_deadlines(self):
        mod = self.mod
        workspace = self.root / "workspace"
        workspace.mkdir()
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(([str(item) for item in argv], kwargs))
            return SimpleNamespace(returncode=0, stdout="")

        with patch.object(mod, "run", side_effect=fake_run):
            mod.sandboxed_npm(workspace, "ci", "ci")
        npm = calls.pop()[0]
        for policy in (
            f"--property=RuntimeMaxSec={mod.NPM_RUNTIME_SECONDS}",
            "--property=MemoryMax=4G",
            "--property=TasksMax=512",
            "--property=CPUQuota=600%",
            "--property=LimitFSIZE=2147483648",
        ):
            self.assertIn(policy, npm)
        self.assertIn(
            "--property=ReadWritePaths=/work",
            npm,
        )
        self.assertIn("--setenv=HOME=/work/.marks-npm-home", npm)
        self.assertIn("--setenv=npm_config_cache=/work/.marks-npm-cache", npm)
        self.assertIn(
            "--property=TemporaryFileSystem=/marks-npm-config:ro,nodev,nosuid,noexec,size=1M",
            npm,
        )
        self.assertIn(
            "--setenv=npm_config_userconfig=/marks-npm-config/user",
            npm,
        )
        self.assertIn(
            "--setenv=npm_config_globalconfig=/marks-npm-config/global",
            npm,
        )
        self.assertNotIn("--setenv=npm_config_userconfig=/dev/null", npm)
        self.assertNotIn("--setenv=npm_config_globalconfig=/dev/null", npm)
        self.assertIn("--property=PrivateNetwork=yes", npm)
        self.assertIn("--property=ProtectProc=invisible", npm)
        self.assertIn("--property=ProcSubset=pid", npm)
        self.assertTrue((workspace / ".marks-npm-home").is_dir())
        self.assertTrue((workspace / ".marks-npm-cache").is_dir())

        calls.clear()
        with patch.object(mod, "run", side_effect=fake_run):
            mod.sandboxed_npm(
                workspace,
                "fetch",
                "ci",
                "--ignore-scripts",
                allow_network=True,
            )
        npm_fetch = calls.pop()[0]
        self.assertIn("--ignore-scripts", npm_fetch)
        self.assertNotIn("--property=PrivateNetwork=yes", npm_fetch)
        self.assertIn("--property=IPAddressDeny=10.0.0.0/8", npm_fetch)
        self.assertIn("--property=IPAddressDeny=127.0.0.0/8", npm_fetch)
        self.assertIn("--property=IPAddressDeny=169.254.0.0/16", npm_fetch)

        build = {
            "cargoFeatures": [],
            "variant": "stable",
            "digest": "b" * 64,
            "canonical": "{}",
        }
        cargo = self.root / "cargo-fresh"
        (cargo / "home").mkdir(parents=True)
        (cargo / "target").mkdir()
        calls.clear()
        with (
            patch.object(mod, "run", side_effect=fake_run),
            patch.object(mod, "validate_fetch_egress_policy", return_value={}),
        ):
            mod.docker_fetch(workspace, cargo, "a" * 40)
        self.assertEqual(len(calls), 2)
        fetch, fetch_options = calls[0]
        self.assertIn("--network=marks-build-fetch", fetch)
        self.assertTrue(any("cargo fetch --locked" in item for item in fetch))
        self.assertEqual(fetch_options["timeout"], mod.CARGO_FETCH_RUNTIME_SECONDS)
        self.assertEqual(calls[1][0][:3], ["/usr/bin/docker", "rm", "--force"])

        calls.clear()
        with patch.object(mod, "run", side_effect=fake_run):
            mod.docker_build(workspace, cargo, "a" * 40, build)
        self.assertEqual(len(calls), 2)
        docker, docker_options = calls[0]
        cleanup, cleanup_options = calls[1]
        self.assertEqual(docker[:2], ["/usr/bin/docker", "run"])
        self.assertIn("--pull=never", docker)
        self.assertIn("--log-driver=none", docker)
        self.assertIn("--network=none", docker)
        self.assertTrue(any("--offline" in item for item in docker))
        build_script = next(item for item in docker if "cargo build" in item)
        self.assertIn(
            "/usr/bin/mkdir -m 0700 /target/marks-export",
            build_script,
        )
        self.assertIn(
            "/usr/bin/install -m 0500 /target/release/marks-server "
            "/target/marks-export/marks-server",
            build_script,
        )
        self.assertIn(
            "/usr/bin/install -m 0500 /target/release/marks-admin "
            "/target/marks-export/marks-admin",
            build_script,
        )
        self.assertIn("--name", docker)
        self.assertIn(f"--volume={cargo / 'home'}:/cargo", docker)
        self.assertIn(f"--volume={cargo / 'target'}:/target", docker)
        self.assertEqual(docker_options["timeout"], mod.DOCKER_RUNTIME_SECONDS)
        self.assertEqual(cleanup[:3], ["/usr/bin/docker", "rm", "--force"])
        self.assertEqual(cleanup_options["timeout"], 30)

        release = self.root / "canary-release"
        (release / "static").mkdir(parents=True)
        (release / "marks-server").write_bytes(b"not executed")
        Path(mod.CANARY).mkdir(parents=True)
        calls.clear()
        with (
            patch.object(mod, "run", side_effect=fake_run),
            patch.object(mod, "wait_ready", return_value=None),
        ):
            mod.canary(release, {"revision": "c" * 40})
        transient = calls[0][0]
        self.assertEqual(transient[0], "/usr/bin/systemd-run")
        for policy in (
            f"--property=RuntimeMaxSec={mod.CANARY_RUNTIME_SECONDS}",
            "--property=MemoryMax=3G",
            "--property=TasksMax=512",
            "--property=CPUQuota=400%",
            "--property=LimitFSIZE=1073741824",
            "--property=StandardOutput=null",
            "--property=StandardError=null",
            f"--property=TemporaryFileSystem=/marks-canary:rw,nodev,nosuid,noexec,size={mod.CANARY_TMPFS_BYTES},mode=1777",
            "--property=TemporaryFileSystem=/tmp:rw,nodev,nosuid,noexec,size=64M",
            "--property=DynamicUser=yes",
            "--property=PrivateNetwork=yes",
            "--property=ProtectProc=invisible",
            "--property=ProcSubset=pid",
        ):
            self.assertIn(policy, transient)
        self.assertFalse(any(item.startswith("--uid=") for item in transient))
        self.assertFalse(any(item.startswith("--gid=") for item in transient))
        self.assertNotIn("/bin/sh", transient)
        self.assertEqual(transient[-2:], [str(mod.SQLITE_WORKER), "launch-canary"])

        calls.clear()
        with patch.object(mod, "run", side_effect=lambda argv, **kwargs: (
            calls.append(([str(item) for item in argv], kwargs))
            or SimpleNamespace(returncode=0, stdout='{"ok":true}')
        )):
            self.assertEqual(
                mod.canary_url_json(
                    "marks-canary-deadbeef-1",
                    "http://127.0.0.1:5192/readyz",
                    3,
                ),
                {"ok": True},
            )
        probe, probe_options = calls[0]
        self.assertIn(
            "--property=JoinsNamespaceOf=marks-canary-deadbeef-1.service",
            probe,
        )
        self.assertIn("--property=PrivateNetwork=yes", probe)
        self.assertIn("--property=DynamicUser=yes", probe)
        self.assertEqual(probe_options["capture_limit"], mod.MAX_HTTP_JSON_BYTES)

    def test_built_binary_import_rejects_unsafe_sources(self):
        mod = self.mod

        def prepare(name):
            workspaces = Path(mod.WORKSPACES)
            workspaces.mkdir(parents=True, exist_ok=True)
            os.chmod(workspaces, 0o700)
            cargo = workspaces / f".cargo-{name}"
            export = cargo / "target" / "marks-export"
            export.mkdir(parents=True, exist_ok=True)
            os.chmod(cargo, 0o700)
            os.chmod(cargo / "target", 0o700)
            os.chmod(export, 0o700)
            source = export / "marks-server"
            destination = self.root / f"imported-{name}"
            return cargo, source, destination

        with self.subTest("symlink"):
            cargo, source, destination = prepare("symlink")
            backing = self.root / "binary-backing"
            backing.write_bytes(b"binary")
            source.symlink_to(backing)
            with self.assertRaisesRegex(RuntimeError, "opened safely"):
                mod.copy_built_binary(cargo, "marks-server", destination)
            source.unlink()

        with self.subTest("nonregular"):
            cargo, source, destination = prepare("fifo")
            os.mkfifo(source)
            with self.assertRaisesRegex(RuntimeError, "not a regular file"):
                mod.copy_built_binary(cargo, "marks-server", destination)
            source.unlink()

        with self.subTest("oversized"):
            cargo, source, destination = prepare("oversized")
            with source.open("wb") as handle:
                handle.truncate(mod.MAX_BUILT_BINARY_BYTES + 1)
            with self.assertRaisesRegex(RuntimeError, "invalid size"):
                mod.copy_built_binary(cargo, "marks-server", destination)
            source.unlink()

        with self.subTest("hardlink"):
            cargo, source, destination = prepare("hardlink")
            source.write_bytes(b"binary")
            os.link(source, source.with_name("second-link"))
            with self.assertRaisesRegex(RuntimeError, "multiple filesystem links"):
                mod.copy_built_binary(cargo, "marks-server", destination)

        with self.subTest("wrong-owner"):
            _cargo, source, _destination = prepare("owner")
            source.write_bytes(b"binary")
            descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                impossible_owner = (os.getuid() + 1, os.getgid() + 1)
                with self.assertRaisesRegex(RuntimeError, "unexpected owner"):
                    mod.validate_built_binary_descriptor(
                        descriptor, impossible_owner, "marks-server"
                    )
            finally:
                os.close(descriptor)

    def test_sqlite_worker_is_only_a_bounded_systemd_payload_for_root(self):
        mod = self.mod
        mod.ensure_layout()
        live = Path(mod.LIVE_DB)
        live.parent.mkdir(parents=True, exist_ok=True)
        live.write_bytes(b"untrusted SQLite bytes are not parsed in this root test")
        stage = Path(mod.SQLITE_STAGING) / "snapshot-test"
        stage.mkdir()
        calls = []
        receipt = {
            "schema": "marks.sqlite-worker.v1",
            "sourceBytes": live.stat().st_size,
            "schemaVersion": 2,
            "snapshotBytes": 4096,
            "sha256": "a" * 64,
        }

        def fake_run(argv, **kwargs):
            calls.append(([str(item) for item in argv], kwargs))
            return SimpleNamespace(returncode=0, stdout=__import__("json").dumps(receipt))

        with (
            patch.object(mod.os, "geteuid", return_value=0),
            patch.object(mod, "service_identity", return_value=(os.getuid(), os.getgid())),
            patch.object(mod, "run", side_effect=fake_run),
        ):
            self.assertEqual(mod.run_sqlite_worker("snapshot", stage=stage), receipt)

        command, options = calls[0]
        self.assertEqual(command[0], "/usr/bin/systemd-run")
        self.assertIn(f"--uid={os.getuid()}", command)
        self.assertIn(f"--gid={os.getgid()}", command)
        self.assertIn(f"--property=BindReadOnlyPaths={live.parent}:/marks-live", command)
        self.assertIn(f"--property=BindPaths={stage}:/marks-output", command)
        self.assertIn(
            f"--property=RuntimeMaxSec={mod.SQLITE_WORKER_RUNTIME_SECONDS}", command
        )
        self.assertIn("--property=MemoryMax=768M", command)
        self.assertIn("--property=PrivateNetwork=yes", command)
        self.assertEqual(command[-2:], [str(mod.SQLITE_WORKER), "snapshot"])
        self.assertEqual(options["capture_limit"], mod.MAX_SQLITE_RECEIPT_BYTES)

    def test_authoritative_snapshot_publication_is_atomic_bounded_and_crash_safe(self):
        mod = self.mod
        mod.ensure_layout()
        stage = Path(mod.SQLITE_STAGING) / "snapshot-fixture"
        stage.mkdir()
        snapshot = stage / "snapshot.db3"
        snapshot.write_bytes(b"SQLite snapshot fixture")
        receipt = {
            "schema": "marks.sqlite-worker.v1",
            "sourceBytes": len(snapshot.read_bytes()),
            "schemaVersion": 1,
            "snapshotBytes": snapshot.stat().st_size,
            "sha256": hashlib.sha256(snapshot.read_bytes()).hexdigest(),
        }
        name = "pre-activation-20260825T010203Z-deadbeef-123.db3"
        published = mod.archive_sqlite_snapshot(snapshot, receipt, name)
        self.assertEqual(published.read_bytes(), snapshot.read_bytes())
        original = published.read_bytes()
        with self.assertRaises(FileExistsError):
            mod.archive_sqlite_snapshot(snapshot, receipt, name)
        self.assertEqual(published.read_bytes(), original)

        # Model SIGKILL after link(temp, final), before unlink(temp). The
        # cleanup pass must remove the hidden link before validating nlink=1.
        crash_name = "pre-activation-20260825T010204Z-deadbeef-124.db3"
        crash_final = Path(mod.SQLITE_ARCHIVE) / crash_name
        crash_final.write_bytes(b"complete crash-safe copy")
        crash_temp = Path(mod.SQLITE_ARCHIVE) / f".{crash_name}.tmp.124.{'b' * 32}"
        os.link(crash_final, crash_temp)
        self.assertEqual(crash_final.stat().st_nlink, 2)
        mod.prune_authoritative_snapshots()
        self.assertFalse(crash_temp.exists())
        self.assertEqual(crash_final.stat().st_nlink, 1)

        self.assertLessEqual(
            len(list(Path(mod.SQLITE_ARCHIVE).glob("pre-activation-*.db3"))),
            mod.KEEP_AUTHORITATIVE_SNAPSHOTS,
        )

    def test_locked_deploy_purges_stale_fresh_tool_state(self):
        mod = self.mod
        mod.ensure_layout()
        stale_workspace = Path(mod.WORKSPACES) / f"{'a' * 40}.123"
        stale_cargo = Path(mod.WORKSPACES) / f".cargo-{'b' * 40}.124"
        stale_git = Path(mod.VERIFIED_GIT) / f"{'c' * 40}.git"
        for path in (stale_workspace, stale_cargo, stale_git):
            path.mkdir(parents=True)
            (path / "stale").write_bytes(b"stale")
        for name in ("cargo", "target", "home"):
            legacy = Path(mod.CACHE) / name
            legacy.mkdir()
            (legacy / "poison").write_bytes(b"prior-build state")
        mod.purge_stale_build_state()
        self.assertEqual(list(Path(mod.WORKSPACES).iterdir()), [])
        self.assertEqual(list(Path(mod.VERIFIED_GIT).iterdir()), [])
        self.assertEqual(list(Path(mod.CACHE).iterdir()), [])

    def test_http_receipts_reject_oversized_and_slow_responses(self):
        import http.server
        import threading
        import time

        mod = self.mod

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                if self.path == "/oversized":
                    body = b"{" + b"x" * mod.MAX_HTTP_JSON_BYTES + b"}"
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    try:
                        self.wfile.write(body)
                    except BrokenPipeError:
                        pass
                    return
                time.sleep(1.0)
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except BrokenPipeError:
                    pass

            def log_message(self, _format, *_args):
                return

        class QuietServer(http.server.ThreadingHTTPServer):
            def handle_error(self, _request, _client_address):
                return

        server = QuietServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            with self.assertRaisesRegex(RuntimeError, "command (?:failed|output exceeded)"):
                mod.url_json(f"{origin}/oversized", timeout=1)

            started = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "timed out waiting"):
                mod.wait_ready(origin, "a" * 40, timeout=0.25)
            self.assertLess(time.monotonic() - started, 0.9)
        finally:
            server.shutdown()
            server.server_close()

    def test_generated_product_receipt_has_a_small_root_read_limit(self):
        receipt = self.root / "marks-product-build.json"
        with receipt.open("wb") as handle:
            handle.truncate(self.mod.MAX_BUILD_RECEIPT_BYTES + 1)
        with self.assertRaisesRegex(RuntimeError, "exceeds its .*byte limit"):
            self.mod.read_bounded_json_file(
                receipt,
                "generated static product build receipt",
                self.mod.MAX_BUILD_RECEIPT_BYTES,
            )

    def test_activation_swaps_and_failed_activation_restores(self):
        mod = self.mod
        mod.ensure_layout()
        release_a = seal_stable_release(mod, "a" * 40)
        release_b = seal_stable_release(mod, "b" * 40)
        release_c = seal_stable_release(mod, "c" * 40)
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
        mod.ensure_layout()
        install_fixture_sqlite_worker(mod)
        release = seal_stable_release(
            mod, "d" * 40, receipt_extra={"maxCompatibleSchema": 1}
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
        mod.ensure_layout()
        install_fixture_sqlite_worker(mod)
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
        authoritative = list(Path(mod.SQLITE_ARCHIVE).glob("pre-activation-*.db3"))
        self.assertEqual(len(authoritative), 1)
        self.assertEqual(
            hashlib.sha256(authoritative[0].read_bytes()).hexdigest(),
            hashlib.sha256(backups[0].read_bytes()).hexdigest(),
        )

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


class SQLiteWorkerContract(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="marks-sqlite-worker-test.")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.worker = load_sqlite_worker()
        self.live = self.root / "live.db3"
        connection = sqlite3.connect(self.live)
        connection.execute(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
        )
        connection.execute("INSERT INTO schema_migrations VALUES (7, 0)")
        connection.execute("CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO example(value) VALUES ('verified')")
        connection.commit()
        connection.close()

    def test_inspect_snapshot_publish_and_retention(self):
        worker = self.worker
        inspected = worker.inspect(self.live)
        self.assertEqual(inspected["schemaVersion"], 7)
        self.assertEqual(inspected["schema"], worker.SCHEMA)

        snapshot = self.root / "snapshot.db3"
        receipt = worker.snapshot(self.live, snapshot)
        self.assertEqual(receipt["snapshotBytes"], snapshot.stat().st_size)
        self.assertEqual(receipt["sha256"], hashlib.sha256(snapshot.read_bytes()).hexdigest())
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o444)

        backups = self.root / "backups"
        stale_name = "pre-activation-20260825T010200Z-deadbeef-1.db3"
        stale_temp = backups / f".{stale_name}.tmp.{'a' * 32}"
        backups.mkdir()
        stale_temp.write_bytes(b"crash partial")
        for index in range(6):
            name = f"pre-activation-20260825T0102{index + 1:02d}Z-deadbeef-{index}.db3"
            published = worker.publish(name, snapshot, backups)
            self.assertEqual(published["sha256"], receipt["sha256"])
        self.assertFalse(stale_temp.exists())
        retained = sorted(backups.glob("pre-activation-*.db3"))
        self.assertEqual(len(retained), worker.KEEP_PUBLISHED_BACKUPS)

    def test_worker_rejects_links_oversize_and_publication_collision(self):
        worker = self.worker
        link = self.root / "linked.db3"
        link.symlink_to(self.live)
        with self.assertRaisesRegex(RuntimeError, "regular no-follow"):
            worker.inspect(link)

        oversized = self.root / "oversized.db3"
        with oversized.open("wb") as handle:
            handle.truncate(worker.MAX_DATABASE_BYTES + 1)
        with self.assertRaisesRegex(RuntimeError, "bound"):
            worker.inspect(oversized)

        snapshot = self.root / "snapshot.db3"
        worker.snapshot(self.live, snapshot)
        backups = self.root / "backups"
        name = "pre-activation-20260825T010203Z-deadbeef-1.db3"
        worker.publish(name, snapshot, backups)
        before = (backups / name).read_bytes()
        with self.assertRaises(FileExistsError):
            worker.publish(name, snapshot, backups)
        self.assertEqual((backups / name).read_bytes(), before)
        self.assertEqual(list(backups.glob(".*.tmp.*")), [])

    def test_fixed_canary_launcher_copies_seed_then_execs_fixed_binary(self):
        worker = self.worker
        seed = self.root / "seed.db3"
        seed.write_bytes(b"bounded seed")
        state = self.root / "canary"
        state.mkdir()
        destination = state / "marks.db3"
        server = self.root / "marks-server"
        server.write_bytes(b"#!/bin/sh\nexit 0\n")
        os.chmod(server, 0o700)
        with patch.object(worker.os, "execv", side_effect=RuntimeError("exec called")) as execute:
            with self.assertRaisesRegex(RuntimeError, "exec called"):
                worker.launch_canary(seed, destination, server)
        self.assertEqual(destination.read_bytes(), seed.read_bytes())
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        execute.assert_called_once_with(server, [str(server)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
