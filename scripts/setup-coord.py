#!/usr/bin/env python3
"""Set up THIS clone to 'twin' with other clones/agents over the coord board.

Twinning = two or more repos/agents coordinating through one shared, server-less
board (an append-only JSONL folder). Run this once per clone you want on the board.

  python3 scripts/setup-coord.py

It (1) picks the board location, (2) sets this clone's agent identity, (3) writes
scripts/coord/coord.config.json (gitignored), and (4) optionally installs a
peer-watch hook so each Claude Code turn shows the peers' latest state.

SAME MACHINE (several repos, one user): accept the default board dir — every
clone resolves to the same path, so they see each other with no other step.
DIFFERENT MACHINES / OSes: give all clones the SAME shared path — a shared mount
(/mnt/c, NFS) or a synced folder (Syncthing/Dropbox). Board is sync-safe JSONL.

Non-interactive (tests): SETUP_NONINTERACTIVE=1, optional COORD_BOARD_DIR / COORD_AGENT.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

NONINTERACTIVE = os.environ.get("SETUP_NONINTERACTIVE") == "1"


def sh(*a, **kw):
    return subprocess.run(a, capture_output=True, text=True, **kw)


def ask(prompt, default=""):
    if NONINTERACTIVE:
        return default
    d = f" [{default}]" if default else ""
    try:
        return input(f"  {prompt}{d}: ").strip() or default
    except EOFError:
        return default


def repo_root():
    r = sh("git", "rev-parse", "--show-toplevel")
    if r.returncode != 0:
        sys.exit("Not inside a git repo — run from the repo root.")
    return Path(r.stdout.strip())


def default_board_dir():
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return str(Path(xdg) / "coord" / "board")


def derive_agent(root):
    host = (os.uname().nodename if hasattr(os, "uname") else os.environ.get("COMPUTERNAME", "host")).split(".")[0]
    return f"{root.name}@{host}"


def install_peer_watch(root, coord_rel):
    """Offer to add a UserPromptSubmit hook to <repo>/.claude/settings.json so
    each turn prints the board. Idempotent; backs up before writing."""
    settings = root / ".claude" / "settings.json"
    cmd = f"node {coord_rel} show --compact"
    if not NONINTERACTIVE and not ask("Install the per-turn peer-watch hook? (y/n)", "y").lower().startswith("y"):
        print(f"· skipped. To watch manually, run any time: node {coord_rel} show")
        return
    data = {}
    if settings.exists():
        try:
            data = json.loads(settings.read_text())
        except Exception:
            print(f"!! {settings} isn't valid JSON — not touching it. Add this hook yourself:")
            print(f"   UserPromptSubmit -> command: {cmd}")
            return
        shutil.copy2(settings, str(settings) + ".bak")
    hooks = data.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
    # idempotent: skip if our command is already wired
    already = any(cmd in json.dumps(h) for h in hooks)
    if already:
        print("✓ peer-watch hook already installed")
        return
    hooks.append({"hooks": [{"type": "command", "command": cmd}]})
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps(data, indent=2) + "\n")
    print(f"✓ peer-watch hook added to {settings} (backup: settings.json.bak)")


def main():
    root = repo_root()
    coord_js = root / "scripts" / "coord" / "coord.js"
    if not coord_js.exists():
        sys.exit(f"scripts/coord/coord.js not found under {root} — wrong repo?")
    coord_rel = "scripts/coord/coord.js"
    print(f"Twinning setup for: {root}\n" + "-" * 48)

    board = os.environ.get("COORD_BOARD_DIR") or ask(
        "Board directory (same machine: accept default; cross-machine: a shared/synced path)",
        default_board_dir())
    agent = os.environ.get("COORD_AGENT") or ask("This clone's agent name", derive_agent(root))

    cfg_path = coord_js.parent / "coord.config.json"
    cfg_path.write_text(json.dumps({"boardDir": board, "agent": agent}, indent=2) + "\n")
    print(f"✓ wrote {cfg_path.relative_to(root)}  (agent={agent})")
    print(f"  board dir: {board}")

    install_peer_watch(root, coord_rel)

    # confirm + show how a peer joins
    node = shutil.which("node")
    if node:
        r = sh(node, str(coord_js), "whoami")
        print("\n" + (r.stdout or r.stderr).strip())
    print("\nDone. To put ANOTHER clone on the same board, run this there and give it the")
    print(f"  SAME board dir: {board}")
    print("  (same machine → the default already matches; different machine → point it at")
    print("   the same shared/synced path). Then `node scripts/coord/coord.js show`.")


if __name__ == "__main__":
    main()
