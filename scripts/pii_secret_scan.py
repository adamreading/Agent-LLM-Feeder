#!/usr/bin/env python3
"""PII + secret scanner — the enforcement behind the fleet security baseline
(#8 "scan CONTENT not just filenames" + #9 pre-push gate).

Design constraints (so this file is itself a safe, copyable fleet drop-in):
  * stdlib only, no network, no third-party deps (gitleaks/trufflehog are an
    OPTIONAL bonus layer the hook adds if present — never required here).
  * This committed file contains ZERO real PII. The operator's personal
    token-set (personal email, surname, employer, machine username) lives in a
    GITIGNORED local file, loaded at runtime:
        $RINGER_PII_TERMS  ->  ~/.config/ringer/pii-scan-terms.txt  ->  ./.pii-scan-terms.txt
    one term per line, '#' comments allowed, matched case-insensitively.
  * Output NEVER echoes a matched secret value (feeder rule: secrets must not
    land in logs/telemetry). Findings print path:line + rule + a masked snippet.

Subcommands (all exit non-zero if anything is found, 0 if clean):
  scan-tree                      scan every tracked file at HEAD (audit / CI)
  scan-diff <baseSha> <headSha>  scan lines ADDED between two commits
                                 (baseSha may be the literal EMPTY = empty tree)
  scan-emails <revspec...>       fail if any commit author/committer email
                                 matches an operator PII term (recurrence guard)

Self-exclusion: this scanner, the hook, the gate check, and tests/fixtures are
skipped by the content scan — they legitimately contain patterns/fixtures.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"  # git's canonical empty tree

# Paths exempt from CONTENT scanning (they carry patterns/fixtures by design).
EXCLUDE_PREFIXES = (
    "scripts/pii_secret_scan.py",
    "scripts/hooks/",
    "scripts/checks/prepush_gate_check.sh",
    "tests/fixtures/",
)

# High-confidence secret patterns (prefix + entropy tail → very low false-positive).
# Written so a bare env-var NAME or a placeholder does not match.
SECRET_RULES = [
    ("aws-access-key-id", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("openai-key",        re.compile(r"sk-(?:proj-)?[A-Za-z0-9]{20,}")),
    ("anthropic-key",     re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("tavily-key",        re.compile(r"tvly-[A-Za-z0-9]{16,}")),
    ("github-pat",        re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("github-fine-pat",   re.compile(r"github_pat_[A-Za-z0-9_]{60,}")),
    ("slack-token",       re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("google-api-key",    re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

# Generic "secret = <literal value>" — excludes env refs / placeholders.
# Absorb identifier prefixes so db_password / apiKey / my_secret / authToken all
# match (a leading \b on the bare word missed underscore-prefixed names).
_ASSIGN = re.compile(
    r"""(?ix)
    \b[a-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key)
    \s*[:=]\s*
    (?P<q>['"])(?P<val>[^'"]{12,})(?P=q)
    """
)
_PLACEHOLDER = re.compile(
    r"(?i)(os\.environ|getenv|process\.env|<[^>]+>|\$\{|\byour[_-]|example|"
    r"placeholder|changeme|xxxx|redacted|dummy|sample)"
)
# The VALUE itself looks like a test/dummy token (feeder FP class 2026-07-16:
# `const token = 'lunk-test-token'`). Value-based (not test-dir-based) on purpose:
# a REAL high-entropy key hardcoded in a test file must still fire.
_TESTVAL = re.compile(
    r"(?i)(^|[-_.: ])(test|fake|dummy|mock|stub|sample|example|placeholder|"
    r"changeme|foo|bar|baz|lorem|noop)([-_.: ]|$)"
)
# Escape hatch for the rare legitimate flag: a line carrying this marker is skipped.
_ALLOW_MARKER = "pii-scan: allow"


def _sh(*args: str) -> str:
    # errors="replace" so binary blobs (PNGs etc.) never crash the decode; the
    # null-byte heuristic in scan_tree then skips them from scanning.
    return subprocess.run(["git", *args], capture_output=True, text=True,
                          errors="replace").stdout


def load_terms() -> list[str]:
    # An explicitly-set RINGER_PII_TERMS is AUTHORITATIVE (no fallback) — so a
    # test/CI can force "no terms" with a nonexistent path, and an operator can
    # point at a specific file. Unset → search the default locations.
    env = os.environ.get("RINGER_PII_TERMS")
    if env:
        candidates = [env]
    else:
        candidates = [
            os.path.expanduser("~/.config/ringer/pii-scan-terms.txt"),
            ".pii-scan-terms.txt",
        ]
    for path in candidates:
        if path and os.path.isfile(path):
            out = []
            for raw in open(path, encoding="utf-8", errors="replace"):
                t = raw.strip()
                if t and not t.startswith("#"):
                    out.append(t)
            return out
    return []


TERMS = [t.lower() for t in load_terms()]


def _mask(s: str) -> str:
    s = s.strip()
    return (s[:4] + "…") if len(s) > 4 else "…"


def _excluded(path: str) -> bool:
    return any(path == p or path.startswith(p) for p in EXCLUDE_PREFIXES)


def scan_text(path: str, lineno: int, line: str, findings: list[str]) -> None:
    """Append a finding line for every rule/term that hits `line`."""
    if _ALLOW_MARKER in line:            # explicit per-line opt-out
        return
    low = line.lower()
    for term in TERMS:
        if term in low:
            # never echo the term value itself
            findings.append(f"{path}:{lineno}: [operator-pii] matched a private term")
    for name, rx in SECRET_RULES:
        m = rx.search(line)
        if m:
            findings.append(f"{path}:{lineno}: [{name}] {_mask(m.group(0))}")
    a = _ASSIGN.search(line)
    if a and not _PLACEHOLDER.search(line) and not _TESTVAL.search(a.group("val")):
        findings.append(f"{path}:{lineno}: [hardcoded-secret-assignment] {_mask(a.group('val'))}")


def scan_tree() -> int:
    findings: list[str] = []
    files = [f for f in _sh("ls-files").splitlines() if f and not _excluded(f)]
    for path in files:
        blob = _sh("show", f"HEAD:{path}")
        if "\x00" in blob[:4096]:  # skip binaries
            continue
        for i, line in enumerate(blob.splitlines(), 1):
            scan_text(path, i, line, findings)
    return _report(findings)


def scan_diff(base: str, head: str) -> int:
    findings: list[str] = []
    base = EMPTY_TREE if base.upper() == "EMPTY" else base
    diff = _sh("diff", "--unified=0", "--no-color", base, head)
    cur = "?"
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            cur = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            if not _excluded(cur):
                scan_text(cur, 0, line[1:], findings)  # added line (line# not tracked in -U0 cheaply)
    return _report(findings)


def scan_emails(revspec: list[str]) -> int:
    if not revspec:
        return 0
    out = _sh("log", "--format=%ae%n%ce", *revspec)
    emails = {e.strip().lower() for e in out.splitlines() if e.strip()}
    bad = [e for e in emails if any(t in e for t in TERMS)]
    if bad:
        print("PII GATE: commit author/committer email matches a private term "
              f"({len(bad)} distinct) — re-author under your GitHub noreply before pushing.",
              file=sys.stderr)
        return 1
    return 0


def _report(findings: list[str]) -> int:
    if findings:
        print("PII/secret gate: %d finding(s):" % len(findings), file=sys.stderr)
        for f in findings:
            print("  " + f, file=sys.stderr)
        return 1
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "scan-tree":
        return scan_tree()
    if cmd == "scan-diff" and len(rest) == 2:
        return scan_diff(rest[0], rest[1])
    if cmd == "scan-emails":
        return scan_emails(rest)
    if cmd == "terms-status":
        # Fail-CLOSED signal for the hook: an empty/missing terms file means the
        # PII scan would silently pass everything (OB, 2026-07-16). Exit 3 so the
        # gate refuses rather than giving false assurance. (scan-tree/secret rules
        # still work without terms — only PII detection needs them.)
        if not TERMS:
            print("no PII terms loaded — seed ~/.config/ringer/pii-scan-terms.txt "
                  "(gate fails closed without it)", file=sys.stderr)
            return 3
        print(f"{len(TERMS)} PII term(s) loaded")
        return 0
    print(f"usage error: unknown/short command {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
