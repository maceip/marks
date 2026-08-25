#!/usr/bin/env python3
"""Behavioral security tests for the unprivileged upload ingress helper."""

import io
import os
import tarfile
import tempfile
import threading
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[2]
SCRIPT = REPOSITORY / "deploy" / "host" / "marks-upload"
LOADER = SourceFileLoader("marks_upload_under_test", str(SCRIPT))
SPEC = spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
marks_upload = module_from_spec(SPEC)
LOADER.exec_module(marks_upload)


def sha(number: int) -> str:
    return f"{number:040x}"


def archive(extra=None) -> io.BytesIO:
    entries = [
        ("Cargo.lock", b"lock", tarfile.REGTYPE, ""),
        ("package-lock.json", b"{}", tarfile.REGTYPE, ""),
        ("package.json", b"{}", tarfile.REGTYPE, ""),
        ("deploy/systemd/marks.service", b"[Service]\n", tarfile.REGTYPE, ""),
    ]
    entries.extend(extra or [])
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w") as output:
        for name, payload, kind, linkname in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.mode = 0o644
            member.linkname = linkname
            member.size = len(payload) if kind == tarfile.REGTYPE else 0
            output.addfile(member, io.BytesIO(payload) if kind == tarfile.REGTYPE else None)
    result.seek(0)
    return result


class MarksUploadTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.state = Path(self.temporary.name) / "state"
        self.state.mkdir(mode=0o755)
        os.chmod(self.state, 0o755)
        self.incoming = self.state / "incoming"
        self.incoming.mkdir(mode=0o700)
        os.chmod(self.incoming, 0o700)
        self.lock = self.incoming / ".marks-upload.lock"
        self.lock.touch(mode=0o600)
        os.chmod(self.lock, 0o600)

        self.saved = {
            "ROOT": marks_upload.ROOT,
            "STATE_OWNER_UID": marks_upload.STATE_OWNER_UID,
            "STATE_OWNER_GID": marks_upload.STATE_OWNER_GID,
            "MAX_ARCHIVE_BYTES": marks_upload.MAX_ARCHIVE_BYTES,
            "MAX_EXPANDED_BYTES": marks_upload.MAX_EXPANDED_BYTES,
            "MAX_INCOMING_BYTES": marks_upload.MAX_INCOMING_BYTES,
            "MAX_MEMBERS": marks_upload.MAX_MEMBERS,
            "MAX_TREES": marks_upload.MAX_TREES,
            "MAX_PATH_DEPTH": marks_upload.MAX_PATH_DEPTH,
            "ENTRY_STORAGE_RESERVE": marks_upload.ENTRY_STORAGE_RESERVE,
        }
        marks_upload.ROOT = self.incoming
        marks_upload.STATE_OWNER_UID = os.geteuid()
        marks_upload.STATE_OWNER_GID = os.getegid()

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(marks_upload, name, value)
        self.temporary.cleanup()

    def perform(self, action: str, revision: str, stream=None):
        marks_upload.perform(action, revision, stream, io.StringIO())

    def staging_names(self):
        return [path.name for path in self.incoming.iterdir() if marks_upload.STAGING_RE.fullmatch(path.name)]

    def test_upload_and_cleanup_publish_only_a_complete_tree(self):
        revision = sha(1)
        self.perform("upload", revision, archive())
        published = self.incoming / revision
        self.assertTrue((published / "Cargo.lock").is_file())
        self.assertTrue((published / "deploy/systemd/marks.service").is_file())
        self.assertEqual(self.staging_names(), [])

        self.perform("cleanup", revision)
        self.assertFalse(published.exists())

    def test_abandoned_staging_is_removed_before_upload_and_cleanup(self):
        abandoned = self.incoming / f".{sha(8)}.upload.crashed"
        abandoned.mkdir()
        (abandoned / "partial").write_bytes(b"partial")

        self.perform("upload", sha(2), archive())
        self.assertFalse(abandoned.exists())

        second = self.incoming / f".{sha(9)}.upload.crashed"
        second.mkdir()
        self.perform("cleanup", sha(99))
        self.assertFalse(second.exists())

    def test_lock_fails_competing_operations_fast_and_allows_retry(self):
        first_has_lock = threading.Event()
        release_first = threading.Event()
        second_finished = threading.Event()
        errors = []

        def first():
            with marks_upload.locked_incoming():
                first_has_lock.set()
                release_first.wait(2)

        def second():
            first_has_lock.wait(2)
            try:
                with marks_upload.locked_incoming():
                    pass
            except ValueError as error:
                errors.append(str(error))
            finally:
                second_finished.set()

        one = threading.Thread(target=first)
        two = threading.Thread(target=second)
        one.start()
        two.start()
        self.assertTrue(first_has_lock.wait(1))
        self.assertTrue(second_finished.wait(1), "a competing command must not queue on the lock")
        self.assertEqual(errors, ["another upload or cleanup is active; retry later"])
        release_first.set()
        one.join(2)
        two.join(2)
        self.assertFalse(one.is_alive())
        self.assertFalse(two.is_alive())
        self.perform("cleanup", sha(99))

    def test_two_uploads_of_one_revision_cannot_replace_each_other(self):
        start = threading.Barrier(2)
        outcomes = []

        def contender(payload: bytes):
            candidate = archive([("winner", payload, tarfile.REGTYPE, "")])
            start.wait()
            try:
                self.perform("upload", sha(3), candidate)
                outcomes.append("published")
            except ValueError as error:
                outcomes.append(str(error))

        threads = [threading.Thread(target=contender, args=(value,)) for value in (b"one", b"two")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(3)
        self.assertEqual(outcomes.count("published"), 1)
        self.assertEqual(
            sum("already exists" in result or "retry later" in result for result in outcomes),
            1,
        )
        self.assertIn((self.incoming / sha(3) / "winner").read_bytes(), (b"one", b"two"))
        self.assertEqual(self.staging_names(), [])

    def test_lock_and_directory_integrity_fail_closed(self):
        os.chmod(self.lock, 0o644)
        with self.assertRaisesRegex(ValueError, "lock must have mode 0600"):
            self.perform("cleanup", sha(1))

        os.chmod(self.lock, 0o600)
        os.chmod(self.incoming, 0o770)
        with self.assertRaisesRegex(ValueError, "incoming root must have mode 0700"):
            self.perform("cleanup", sha(1))

    def test_symlink_lock_is_never_followed(self):
        outside = Path(self.temporary.name) / "outside"
        outside.write_bytes(b"unchanged")
        self.lock.unlink()
        (self.incoming / marks_upload.LOCK_NAME).symlink_to(outside)
        with self.assertRaises(OSError):
            self.perform("cleanup", sha(1))
        self.assertEqual(outside.read_bytes(), b"unchanged")

    def test_missing_lock_is_not_created_by_the_deployment_account(self):
        self.lock.unlink()
        with self.assertRaisesRegex(ValueError, "must be provisioned by an administrator"):
            self.perform("cleanup", sha(1))
        self.assertFalse(self.lock.exists())

    def test_fourth_tree_is_allowed_but_fifth_is_rejected_until_cleanup(self):
        for number in range(1, 4):
            (self.incoming / sha(number)).mkdir()
        self.perform("upload", sha(4), archive())
        self.assertTrue((self.incoming / sha(4)).is_dir())

        with self.assertRaisesRegex(ValueError, "maximum of 4 upload trees"):
            self.perform("upload", sha(5), archive())
        self.assertEqual(self.staging_names(), [])

        self.perform("cleanup", sha(1))
        self.perform("upload", sha(5), archive())
        self.assertTrue((self.incoming / sha(5)).is_dir())

    def test_aggregate_storage_limit_counts_existing_and_inflight_trees(self):
        existing = self.incoming / sha(1)
        existing.mkdir()
        (existing / "payload").write_bytes(b"x" * 64)
        existing_bytes, _ = marks_upload.tree_usage(existing)
        marks_upload.MAX_INCOMING_BYTES = existing_bytes + 4 * marks_upload.ENTRY_STORAGE_RESERVE

        with self.assertRaisesRegex(ValueError, "aggregate incoming limit"):
            self.perform("upload", sha(2), archive())
        self.assertTrue(existing.is_dir())
        self.assertFalse((self.incoming / sha(2)).exists())
        self.assertEqual(self.staging_names(), [])

    def test_implicit_parent_directories_are_charged_before_creation(self):
        marks_upload.MAX_MEMBERS = 8
        deep_files = [
            (f"a{number}/b{number}/value", b"x", tarfile.REGTYPE, "")
            for number in range(2)
        ]
        with self.assertRaisesRegex(ValueError, "materializes more than 50000 filesystem objects"):
            self.perform("upload", sha(2), archive(deep_files))
        self.assertEqual(self.staging_names(), [])

    def test_links_and_special_archive_members_are_rejected(self):
        for kind, linkname in ((tarfile.SYMTYPE, "Cargo.lock"), (tarfile.LNKTYPE, "Cargo.lock")):
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ValueError, "not a regular file or directory"):
                    self.perform("upload", sha(kind[0]), archive([("linked", b"", kind, linkname)]))
                self.assertEqual(self.staging_names(), [])

    def test_hard_linked_existing_content_is_rejected(self):
        existing = self.incoming / sha(1)
        existing.mkdir()
        first = existing / "one"
        first.write_bytes(b"value")
        os.link(first, existing / "two")
        with self.assertRaisesRegex(ValueError, "hard-linked incoming file rejected"):
            self.perform("upload", sha(2), archive())

    def test_path_depth_expanded_size_and_member_limits_are_enforced(self):
        deep = "/".join(["deep"] * 33)
        with self.assertRaisesRegex(ValueError, "exceeds 32 components"):
            self.perform("upload", sha(1), archive([(deep, b"x", tarfile.REGTYPE, "")]))

        marks_upload.MAX_EXPANDED_BYTES = 8
        with self.assertRaisesRegex(ValueError, "expands beyond 1 GiB"):
            self.perform("upload", sha(2), archive([("large", b"123456789", tarfile.REGTYPE, "")]))

        marks_upload.MAX_EXPANDED_BYTES = self.saved["MAX_EXPANDED_BYTES"]
        marks_upload.MAX_MEMBERS = 3
        with self.assertRaisesRegex(ValueError, "archive exceeds 50000 entries"):
            self.perform("upload", sha(3), archive())

    def test_compressed_reader_never_requests_more_than_remaining_plus_one(self):
        class RecordingStream:
            requested = None

            def read(self, size=-1):
                self.requested = size
                return b"x" * size

        marks_upload.MAX_ARCHIVE_BYTES = 8
        stream = RecordingStream()
        reader = marks_upload.LimitedReader(stream)
        with self.assertRaisesRegex(ValueError, "compressed archive exceeds 512 MiB"):
            reader.read(-1)
        self.assertEqual(stream.requested, 9)


class DispatcherBoundsTest(unittest.TestCase):
    def test_forced_command_bounds_upload_and_cleanup(self):
        dispatcher = (REPOSITORY / "deploy/host/marks-deploy-ssh").read_text(encoding="utf-8")
        arm = dispatcher.split("  upload|cleanup)", 1)[1].split("    ;;") [0]
        for contract in (
            "/usr/bin/timeout --signal=TERM --kill-after=15s 2700s",
            "/usr/bin/prlimit",
            "--as=1610612736",
            "--cpu=1200",
            "--fsize=1073741824",
            "--nofile=128",
            "--nproc=64",
            "--core=0",
        ):
            self.assertIn(contract, arm)


if __name__ == "__main__":
    unittest.main()
