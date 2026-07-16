#!/usr/bin/env python3
"""One-command security setup for a fresh clone of this repo.

Does two things a clone needs before its FIRST push, and that git will NOT do
for you automatically (hooks ship dormant by design — a clone must opt in):

  1. ARM the pre-push gate:   git config core.hooksPath scripts/hooks
  2. SEED your PII terms:      ~/.config/ringer/pii-scan-terms.txt

The terms file is PER-MACHINE and SHARED across every repo that uses this gate
(ringer, feeder, ...): all of them read ~/.config/ringer/pii-scan-terms.txt, so
you seed it ONCE and every clone on this machine is protected. It is never
committed — it holds your personal terms (email, name, employer, username).

Run it from the repo root:   python3 scripts/setup-security.py
Idempotent + safe to re-run. Non-interactive (CI/tests): set SETUP_NONINTERACTIVE=1
and provide terms via SETUP_TERMS="a,b,c" (skips prompts; still arms the hook).
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

TERMS_PATH = Path(os.environ.get("RINGER_PII_TERMS")
                  or (Path.home() / ".config" / "ringer" / "pii-scan-terms.txt"))
NONINTERACTIVE = os.environ.get("SETUP_NONINTERACTIVE") == "1"


def sh(*args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def git_cfg(key):
    r = sh("git", "config", key)
    return r.stdout.strip() if r.returncode == 0 else ""


def ask(prompt, default=""):
    if NONINTERACTIVE:
        return default
    d = f" [{default}]" if default else ""
    try:
        v = input(f"  {prompt}{d}: ").strip()
    except EOFError:
        v = ""
    return v or default


def repo_root():
    r = sh("git", "rev-parse", "--show-toplevel")
    if r.returncode != 0:
        sys.exit("Not inside a git repo — run this from the repo root.")
    return Path(r.stdout.strip())


def arm_hook(root):
    hooks_dir = root / "scripts" / "hooks"
    if not (hooks_dir / "pre-push").exists():
        print("!! scripts/hooks/pre-push not found — is this the right repo? Skipping arm.")
        return
    current = git_cfg("core.hooksPath")
    if current == "scripts/hooks":
        print("✓ pre-push gate already armed (core.hooksPath=scripts/hooks)")
        return
    if NONINTERACTIVE or ask("Arm the pre-push gate now? (y/n)", "y").lower().startswith("y"):
        sh("git", "config", "core.hooksPath", "scripts/hooks", cwd=str(root))
        print("✓ armed: core.hooksPath=scripts/hooks (fires on every git push)")
    else:
        print("· skipped arming — run later: git config core.hooksPath scripts/hooks")


def load_existing():
    if not TERMS_PATH.exists():
        return []
    out = []
    for ln in TERMS_PATH.read_text().splitlines():
        s = ln.strip()
        if s and not s.startswith("#"):
            out.append(s)
    return out


def collect_terms(existing):
    if existing:
        print(f"\nA terms file already exists with {len(existing)} term(s): {TERMS_PATH}")
        if not NONINTERACTIVE and not ask("Add/replace terms? (y/n)", "n").lower().startswith("y"):
            return existing, False

    if NONINTERACTIVE:
        env_terms = [t.strip() for t in os.environ.get("SETUP_TERMS", "").split(",") if t.strip()]
        merged = sorted(set(existing) | set(env_terms))
        return merged, bool(env_terms)

    print("\nSeed the terms to protect (leave blank to skip any). These are matched")
    print("case-insensitively as substrings and NEVER printed by the scanner.\n")
    gide = git_cfg("user.email")
    email_default = "" if ("noreply" in gide or not gide) else gide
    candidates = []
    candidates += [ask("Personal email(s), comma-separated", email_default)]
    candidates += [ask("Full name / surname", git_cfg("user.name"))]
    candidates += [ask("Employer / org name", "")]
    candidates += [ask("This machine's username", _whoami())]
    candidates += [ask("Machine hostname", _hostname())]
    extra = ask("Any other terms (comma-separated)", "")
    candidates.append(extra)

    fresh = []
    for c in candidates:
        for t in c.split(","):
            t = t.strip()
            if t:
                fresh.append(t)
    merged = sorted(set(existing) | set(fresh))
    return merged, bool(fresh)


def _whoami():
    try:
        import getpass
        return getpass.getuser()
    except Exception:
        return ""


def _hostname():
    try:
        import socket
        return socket.gethostname()
    except Exception:
        return ""


def write_terms(terms):
    TERMS_PATH.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# PII scan terms — operator token-set. OFF-REPO, never committed.\n"
        "# One literal term per line (case-insensitive substring match). '#' comments ok.\n"
        "# SHARED across every repo using the ringer pre-push gate on this machine.\n\n")
    TERMS_PATH.write_text(header + "\n".join(terms) + "\n")
    try:
        os.chmod(TERMS_PATH, 0o600)   # personal data — owner-only
    except Exception:
        pass


def verify(root):
    scan = root / "scripts" / "pii_secret_scan.py"
    py = shutil.which("python3") or shutil.which("python") or "python3"
    r = sh(py, str(scan), "terms-status")
    ok = r.returncode == 0
    print(f"\n{'✓' if ok else '!!'} gate self-check: {(r.stdout or r.stderr).strip()[:200]}")
    return ok


def main():
    root = repo_root()
    print(f"Security setup for: {root}\n" + "-" * 48)
    arm_hook(root)
    existing = load_existing()
    terms, changed = collect_terms(existing)
    if not terms:
        print("\n!! No terms seeded. The PII gate FAIL-CLOSES (blocks pushes) until you seed at")
        print("   least your personal email + username. Re-run this script to add them.")
        sys.exit(1)
    if changed or not TERMS_PATH.exists():
        write_terms(terms)
        print(f"\n✓ wrote {len(terms)} term(s) -> {TERMS_PATH} (chmod 600, shared by all gate repos)")
    else:
        print(f"\n✓ keeping existing {len(terms)} term(s) at {TERMS_PATH}")
    verify(root)
    print("\nDone. The gate now scans every push; nothing runs between pushes (it's a")
    print("checkpoint, not a daemon), so there's no service to keep alive or restart.")


if __name__ == "__main__":
    main()
