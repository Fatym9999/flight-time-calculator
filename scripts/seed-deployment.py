"""Seed a managed environment from existing public files, without changing Nginx."""
import argparse
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile


def load(filename):
    spec = importlib.util.spec_from_file_location(filename, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seed(source, base, environment):
    builder, receiver = load("build-deploy-site.py"), load("deploy-receiver.py")
    home = Path(base) / environment
    if (home / "current").exists() or (home / "current").is_symlink():
        raise ValueError("Environment already initialized; refusing to replace it")
    commit = "0" * 40
    release_id = commit + "-0-0"
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary) / "public"
        builder.build(source, output, environment, commit, release_id)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as bundle:
            for name in sorted(builder.PUBLIC_FILES | {"release.json"}):
                bundle.add(output / name, arcname=name)
        archive.seek(0)
        print(receiver.receive(base, environment, "deploy " + release_id, archive))
    print("Prepared current release. Nginx and the original directory are unchanged.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--base", type=Path, default=Path("/srv/flight-time"))
    parser.add_argument("--environment", choices=("dev", "production"), required=True)
    args = parser.parse_args()
    seed(args.source, args.base, args.environment)
