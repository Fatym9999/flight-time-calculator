"""Build only public website files; support source and published repository layouts."""
import argparse
import hashlib
import json
from pathlib import Path
import re

APP_FILES = (
    "auth-config.js", "auth-client.js", "registration.js", "cloud-store.js",
    "guest-store.js", "cloud.js", "account.js",
)
VENDOR_FILES = ("supabase-2.117.3.js", "supabase-LICENSE")
PUBLIC_FILES = frozenset(("index.html", "local.html", "registration.html", *APP_FILES,
                          *("vendor/" + name for name in VENDOR_FILES)))


def build(source, output, environment, revision, release_id):
    source, output = Path(source).resolve(), Path(output).resolve()
    if output == source or output in source.parents:
        raise ValueError("Output must not replace the source repository")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output must be empty; use a new directory")
    output.mkdir(parents=True, exist_ok=True)
    source_layout = (source / "cloud.html").is_file()
    pages = {
        "index.html": "cloud.html" if source_layout else "index.html",
        "local.html": "index.html" if source_layout else "local.html",
        "registration.html": "registration.html",
    }
    texts = {name: (source / original).read_text() for name, original in pages.items()}
    for name in APP_FILES:
        texts[name] = (source / name).read_text()
    for name, value in texts.items():
        if name.endswith(".html"):
            value = value.replace('href="cloud.html"', 'href="index.html"')
            value = value.replace('src="supabase-2.117.3.js"', 'src="vendor/supabase-2.117.3.js"')
            value = re.sub(r'\s*<a class="account-link" href="index.html">Журнал в аккаунте · тест</a>', '', value)
            if environment == "dev":
                value = value.replace("<title>", "<title>[DEV] ", 1)
            else:
                value = value.replace('<span class="badge">Тестовая версия</span>', '')
        if name in ("guest-store.js", "cloud.js"):
            # Change the executable storage key, never the explanatory comments.
            key = "flight-time-test-guest-v1" if environment == "dev" else "flight-time-entries-v2"
            value = re.sub(r'(["\'])(?:flight-time-test-guest-v1|flight-time-entries-v2)\1',
                           lambda match: match[1] + key + match[1], value)
        (output / name).write_text(value)
    (output / "vendor").mkdir()
    for name in VENDOR_FILES:
        candidate = source / "vendor" / name
        if not candidate.is_file():
            candidate = source / name
        (output / "vendor" / name).write_bytes(candidate.read_bytes())
    for page in output.glob("*.html"):
        for target in re.findall(r'(?:href|src)="([^"]+)"', page.read_text()):
            if ":" not in target and not target.startswith("#"):
                if not (page.parent / target.split("?")[0]).is_file():
                    raise ValueError(f"Missing asset: {page.name}: {target}")
    manifest = {name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                for name in sorted(PUBLIC_FILES)}
    (output / "release.json").write_text(json.dumps({
        "commit": revision, "release_id": release_id,
        "environment": environment, "files": manifest,
    }, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--environment", choices=("dev", "production"), required=True)
    parser.add_argument("--revision", default="local")
    parser.add_argument("--release-id", default="local")
    args = parser.parse_args()
    build(args.source, args.output, args.environment, args.revision, args.release_id)
    print(f"Prepared {args.environment}: {args.output}; nothing published")
