import os
from pathlib import Path

content = Path('scripts/harness/marks-release-root.test.py').read_text()

# Fix for test_node_toolchain_is_fixed_root_owned_single_link_content
search1 = """        node.parent.mkdir(parents=True)
        npm_cli.parent.mkdir(parents=True)
        node.write_bytes(b"pinned node binary")"""
replace1 = """        node.parent.mkdir(parents=True)
        npm_cli.parent.mkdir(parents=True)
        for d in [root] + list(root.rglob("*")):
            if d.is_dir():
                os.chmod(d, 0o755)
        node.write_bytes(b"pinned node binary")"""

content = content.replace(search1, replace1)

# Fix for test_stale_release_stages_are_exact_root_owned_directories_only
search2 = """        legacy = Path(mod.RELEASES) / ".legacy-20260825T010203Z.staging.456"
        v2.mkdir()
        legacy.mkdir()
        (v2 / "partial").write_bytes(b"bounded abandoned release")"""
replace2 = """        legacy = Path(mod.RELEASES) / ".legacy-20260825T010203Z.staging.456"
        v2.mkdir()
        os.chmod(v2, 0o755)
        legacy.mkdir()
        os.chmod(legacy, 0o755)
        (v2 / "partial").write_bytes(b"bounded abandoned release")"""

content = content.replace(search2, replace2)

Path('scripts/harness/marks-release-root.test.py').write_text(content)
