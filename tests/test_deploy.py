"""Exercise builds and deployment using temporary directories, never real servers."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(filename):
    spec = importlib.util.spec_from_file_location(filename, ROOT / "scripts" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


builder = module("build-deploy-site.py")
receiver = module("deploy-receiver.py")
seeder = module("seed-deployment.py")
COMMIT = "a" * 40


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.server = self.root / "server"
        for name in builder.APP_FILES:
            (self.source / name).write_text('var KEY = "flight-time-entries-v2";\n')
        (self.source / "auth-config.js").write_text("// shared public configuration\n")
        (self.source / "index.html").write_text('<title>Main</title><script src="supabase-2.117.3.js"></script>')
        (self.source / "local.html").write_text('<title>Local</title>')
        (self.source / "registration.html").write_text('<title>Login</title><a href="index.html">Calculator</a>')
        for name in builder.VENDOR_FILES:
            (self.source / name).write_text("vendor fixture")
        self.count = 0

    def release(self, environment="production"):
        self.count += 1
        release_id = f"{COMMIT}-1-{self.count}"
        output = self.root / f"build-{self.count}"
        builder.build(self.source, output, environment, COMMIT, release_id)
        return release_id, output

    def archive(self, output, extra=None, omit=None, tamper=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as bundle:
            for name in sorted(receiver.PUBLIC_FILES | {"release.json"}):
                if name == omit:
                    continue
                content = (output / name).read_bytes()
                if name == tamper:
                    content += b"changed after building"
                item = tarfile.TarInfo("./" + name)
                item.size = len(content)
                bundle.addfile(item, io.BytesIO(content))
            if extra is not None:
                bundle.addfile(extra, io.BytesIO(b"x") if extra.isfile() else None)
        buffer.seek(0)
        return buffer

    def publish(self, environment="production"):
        release_id, output = self.release(environment)
        receiver.receive(self.server, environment, "deploy " + release_id, self.archive(output))
        return release_id, output

    def test_published_layout_and_flat_vendor_are_supported(self):
        _, output = self.release()
        self.assertIn('src="vendor/supabase-2.117.3.js"', (output / "index.html").read_text())
        self.assertEqual({str(p.relative_to(output)) for p in output.rglob("*") if p.is_file()},
                         receiver.PUBLIC_FILES | {"release.json"})

    def test_source_layout_selects_unified_calculator(self):
        (self.source / "cloud.html").write_text('<title>Unified</title><a href="cloud.html">Home</a>')
        _, output = self.release()
        self.assertIn("Unified", (output / "index.html").read_text())
        self.assertIn('href="index.html"', (output / "index.html").read_text())
        self.assertIn("Main", (output / "local.html").read_text())

    def test_environment_keys_and_shared_auth_configuration(self):
        _, dev = self.release("dev")
        _, production = self.release()
        self.assertIn('"flight-time-test-guest-v1"', (dev / "guest-store.js").read_text())
        self.assertIn('"flight-time-entries-v2"', (production / "guest-store.js").read_text())
        self.assertEqual((dev / "auth-config.js").read_bytes(), (production / "auth-config.js").read_bytes())
        self.assertIn("[DEV]", (dev / "index.html").read_text())

    def test_missing_asset_stops_build(self):
        (self.source / "index.html").write_text('<script src="missing.js"></script>')
        with self.assertRaisesRegex(ValueError, "Missing asset"):
            self.release()

    def test_build_never_overwrites_source_or_nonempty_output(self):
        with self.assertRaises(ValueError):
            builder.build(self.source, self.source, "dev", COMMIT, "local")
        _, output = self.release()
        before = (output / "index.html").read_bytes()
        with self.assertRaises(ValueError):
            builder.build(self.source, output, "dev", COMMIT, "local")
        self.assertEqual((output / "index.html").read_bytes(), before)

    def test_manifest_hashes_cover_only_public_files(self):
        (self.source / ".env").write_text("SECRET=do-not-publish")
        _, output = self.release()
        metadata = json.loads((output / "release.json").read_text())
        self.assertEqual(set(metadata["files"]), receiver.PUBLIC_FILES)
        self.assertFalse((output / ".env").exists())
        self.assertEqual(metadata["files"]["index.html"], hashlib.sha256((output / "index.html").read_bytes()).hexdigest())

    def test_publish_previous_version_and_conditional_rollback(self):
        first, _ = self.publish()
        second, _ = self.publish()
        home = self.server / "production"
        self.assertEqual((home / "current").resolve().name, second)
        self.assertEqual((home / "previous").resolve().name, first)
        receiver.receive(self.server, "production", "rollback " + second, io.BytesIO())
        self.assertEqual((home / "current").resolve().name, first)
        with self.assertRaisesRegex(ValueError, "stale rollback"):
            receiver.receive(self.server, "production", "rollback " + second, io.BytesIO())

    def test_development_deployment_cannot_change_production(self):
        first, _ = self.publish()
        dev, _ = self.publish("dev")
        self.assertEqual((self.server / "production/current").resolve().name, first)
        self.assertEqual((self.server / "dev/current").resolve().name, dev)
        release_id, output = self.release("dev")
        with self.assertRaisesRegex(ValueError, "metadata"):
            receiver.receive(self.server, "production", "deploy " + release_id, self.archive(output))
        self.assertEqual((self.server / "production/current").resolve().name, first)

    def test_bad_archive_never_replaces_live_site(self):
        first, _ = self.publish()
        release_id, output = self.release()
        with self.assertRaisesRegex(ValueError, "hashes"):
            receiver.receive(self.server, "production", "deploy " + release_id,
                             self.archive(output, tamper="index.html"))
        self.assertEqual((self.server / "production/current").resolve().name, first)
        self.assertFalse(list((self.server / "production/releases").glob(".incoming-*")))

    def test_incomplete_archive_is_rejected(self):
        release_id, output = self.release()
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            receiver.receive(self.server, "production", "deploy " + release_id,
                             self.archive(output, omit="auth-client.js"))

    def test_traversal_links_unexpected_and_duplicate_files_are_rejected(self):
        for name, kind in (("../outside", tarfile.REGTYPE), ("/outside", tarfile.REGTYPE),
                           ("link", tarfile.SYMTYPE), ("hard", tarfile.LNKTYPE),
                           (".env", tarfile.REGTYPE), ("index.html", tarfile.REGTYPE)):
            with self.subTest(name=name):
                release_id, output = self.release()
                extra = tarfile.TarInfo(name)
                extra.type, extra.size, extra.linkname = kind, 1 if kind == tarfile.REGTYPE else 0, "/tmp/outside"
                with self.assertRaises(ValueError):
                    receiver.receive(self.server, "production", "deploy " + release_id,
                                     self.archive(output, extra=extra))
        self.assertFalse((self.server / "production/current").exists())

    def test_arbitrary_commands_and_existing_web_directory_are_rejected(self):
        for command in ("bash", "deploy ../../outside", "deploy " + COMMIT + "-1-1;id", "", "rollback local"):
            with self.assertRaises(ValueError):
                receiver.receive(self.server, "production", command, io.BytesIO())
        (self.server / "production/current").mkdir(parents=True)
        release_id, output = self.release()
        with self.assertRaisesRegex(ValueError, "symlink"):
            receiver.receive(self.server, "production", "deploy " + release_id, self.archive(output))

    def test_archive_size_is_bounded(self):
        old = receiver.MAX_ARCHIVE
        receiver.MAX_ARCHIVE = 100
        self.addCleanup(setattr, receiver, "MAX_ARCHIVE", old)
        release_id, output = self.release()
        with self.assertRaisesRegex(ValueError, "too large"):
            receiver.receive(self.server, "production", "deploy " + release_id, self.archive(output))

    def test_web_server_can_read_release_with_restrictive_umask(self):
        previous = os.umask(0o077)
        try:
            release_id, _ = self.publish()
        finally:
            os.umask(previous)
        home = self.server / "production"
        release = home / "releases" / release_id
        for directory in (home, home / "releases", release, release / "vendor"):
            self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
        for path in release.rglob("*"):
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o777, 0o644)

    def test_seed_preserves_original_and_refuses_reinitialization(self):
        before = (self.source / "index.html").read_bytes()
        seeder.seed(self.source, self.server, "production")
        current = self.server / "production/current"
        self.assertTrue(current.is_symlink())
        self.assertEqual((self.source / "index.html").read_bytes(), before)
        with self.assertRaisesRegex(ValueError, "already initialized"):
            seeder.seed(self.source, self.server, "production")

    def test_first_automated_release_can_roll_back_to_seed(self):
        seeder.seed(self.source, self.server, "dev")
        seeded = (self.server / "dev/current").resolve()
        release_id, _ = self.publish("dev")
        receiver.receive(self.server, "dev", "rollback " + release_id, io.BytesIO())
        self.assertEqual((self.server / "dev/current").resolve(), seeded)


if __name__ == "__main__":
    unittest.main()
