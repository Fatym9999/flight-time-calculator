"""Restricted SSH receiver. Install root-owned; invoke as flight-deploy, never root."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile
import uuid

PUBLIC_FILES = frozenset((
    "index.html", "local.html", "registration.html", "auth-config.js", "auth-client.js",
    "registration.js", "cloud-store.js", "guest-store.js", "cloud.js", "account.js",
    "vendor/supabase-2.117.3.js", "vendor/supabase-LICENSE",
))
RELEASE_ID = re.compile(r"[0-9a-f]{40}-[0-9]+-[0-9]+\Z")
MAX_ARCHIVE = 20 * 1024 * 1024


def atomic_link(path, target):
    temporary = path.with_name(".link-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def link_target(path, releases):
    if not path.is_symlink():
        if path.exists():
            raise ValueError(f"{path} must be a symlink, not an existing directory")
        return None
    resolved = path.resolve(strict=True)
    if resolved.parent != releases.resolve() or not RELEASE_ID.fullmatch(resolved.name):
        raise ValueError("Release symlink points outside the managed release directory")
    return resolved


def unpack(stream, stage, environment, release_id):
    with tempfile.TemporaryFile() as archive:
        total = 0
        while chunk := stream.read(65536):
            total += len(chunk)
            if total > MAX_ARCHIVE:
                raise ValueError("Archive is too large")
            archive.write(chunk)
        archive.seek(0)
        seen, hashes = set(), {}
        with tarfile.open(fileobj=archive, mode="r:") as bundle:
            for member in bundle:
                path = PurePosixPath(member.name)
                name = str(path)
                if path.is_absolute() or ".." in path.parts:
                    raise ValueError("Unsafe archive path")
                if member.isdir() and name in (".", "vendor"):
                    continue
                if not member.isfile() or name not in PUBLIC_FILES | {"release.json"} or name in seen:
                    raise ValueError(f"Unexpected archive member: {name}")
                if member.size > MAX_ARCHIVE or (name == "release.json" and member.size > 65536):
                    raise ValueError("File is too large")
                seen.add(name)
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                digest = hashlib.sha256()
                with bundle.extractfile(member) as incoming, destination.open("xb") as outgoing:
                    while chunk := incoming.read(65536):
                        digest.update(chunk)
                        outgoing.write(chunk)
                destination.chmod(0o644)
                hashes[name] = digest.hexdigest()
        if seen != PUBLIC_FILES | {"release.json"}:
            raise ValueError("Incomplete website")
        metadata = json.loads((stage / "release.json").read_text())
        if (not isinstance(metadata, dict)
                or metadata.get("environment") != environment or metadata.get("release_id") != release_id
                or metadata.get("commit") != release_id[:40]
                or metadata.get("files") != {name: hashes[name] for name in PUBLIC_FILES}):
            raise ValueError("Release metadata or file hashes do not match")


def receive(base, environment, command, stream):
    if environment not in ("dev", "production"):
        raise ValueError("Invalid environment")
    parts = command.split()
    if len(parts) != 2 or parts[0] not in ("deploy", "rollback") or not RELEASE_ID.fullmatch(parts[1]):
        raise ValueError("Only deploy/rollback with a valid release ID is allowed")
    action, release_id = parts
    home = Path(base) / environment
    releases = home / "releases"
    releases.mkdir(parents=True, exist_ok=True, mode=0o755)
    home.chmod(0o755)
    releases.chmod(0o755)
    with (home / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = link_target(home / "current", releases)
        if action == "rollback":
            if current is None or current.name != release_id:
                raise ValueError("Current release changed; refusing stale rollback")
            previous = link_target(home / "previous", releases)
            if previous is None:
                raise ValueError("No previous release; manual recovery required")
            atomic_link(home / "current", previous)
            atomic_link(home / "previous", current)
            return f"Rolled back {environment} to {previous.name}"
        destination = releases / release_id
        if destination.exists():
            raise ValueError("Release ID already exists; rerun with a new attempt")
        stage = Path(tempfile.mkdtemp(prefix=".incoming-", dir=releases))
        try:
            unpack(stream, stage, environment, release_id)
            stage.chmod(0o755)
            (stage / "vendor").chmod(0o755)
            stage.rename(destination)
            if current is not None:
                atomic_link(home / "previous", current)
            atomic_link(home / "current", destination)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
        return f"Published {environment}: {release_id}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("dev", "production"), required=True)
    parser.add_argument("--base", type=Path, default=Path("/srv/flight-time"))
    args = parser.parse_args()
    try:
        print(receive(args.base, args.environment, os.environ.get("SSH_ORIGINAL_COMMAND", ""), sys.stdin.buffer))
    except (ValueError, OSError, tarfile.TarError) as error:
        print(f"Deployment refused: {error}", file=sys.stderr)
        sys.exit(1)
