#!/bin/sh
# Executed proof for the pre-push security gate (scripts/pii_secret_scan.py + scripts/hooks/pre-push).
# Ringer discipline: the executed check is the only truth. Asserts:
#   1. the CURRENT tracked tree is clean (0 findings) — no false-positives on real code
#   2. a planted SECRET value is caught
#   3. a planted OPERATOR-PII term is caught (via a temp terms file)
#   4. a commit authored under a private email is caught by scan-emails
#   5. a placeholder / env-ref is NOT flagged (false-positive guard)
set -u
ROOT=$(git rev-parse --show-toplevel)
SCAN="$ROOT/scripts/pii_secret_scan.py"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1"; exit 1; }

# 1. current tree clean (no terms file → only built-in secret rules apply)
RINGER_PII_TERMS=/nonexistent python3 "$SCAN" scan-tree || fail "current tracked tree has findings (should be clean)"
echo "  ok: current tree clean"

# Build a tiny throwaway git repo to exercise scan-diff / scan-emails deterministically.
cd "$TMP" || fail "cd temp"
git init -q; git config user.email "clean@users.noreply.github.com"; git config user.name t
mkdir -p scripts
cp "$SCAN" scripts/pii_secret_scan.py
: > .keep; git add .keep scripts/pii_secret_scan.py; git commit -qm base
BASE=$(git rev-parse HEAD)

# 2. planted secret is caught (fake AWS-style key)
printf 'aws_key = "AKIA%s"\n' "IOSFODNN7EXAMPLE1" > leak.txt   # 16 upper/num after AKIA
git add leak.txt; git commit -qm leak
if RINGER_PII_TERMS=/nonexistent python3 scripts/pii_secret_scan.py scan-diff "$BASE" HEAD; then
    fail "planted secret NOT caught by scan-diff"
fi
echo "  ok: planted secret caught"

# 3. planted operator-PII term is caught (terms supplied via temp file)
printf 'contact: privateuser@example.invalid\n' > pii.txt
git add pii.txt; git commit -qm pii
printf 'privateuser@example.invalid\n' > "$TMP/terms.txt"
if RINGER_PII_TERMS="$TMP/terms.txt" python3 scripts/pii_secret_scan.py scan-diff HEAD~1 HEAD; then
    fail "planted PII term NOT caught by scan-diff"
fi
echo "  ok: planted PII term caught"

# 4. commit under a private email is caught by scan-emails
git config user.email "privateuser@example.invalid"
printf 'x\n' >> .keep; git add .keep; git commit -qm "under private email"
if RINGER_PII_TERMS="$TMP/terms.txt" python3 scripts/pii_secret_scan.py scan-emails HEAD~1..HEAD; then
    fail "commit under private email NOT caught by scan-emails"
fi
echo "  ok: private-email commit caught"

# 5. placeholder / env-ref is NOT a false positive
git config user.email "clean@users.noreply.github.com"
printf 'password = os.environ["DB_PASSWORD"]\napi_key = "<your-key-here>"\n' > ok.py
git add ok.py; git commit -qm okfile
if ! RINGER_PII_TERMS=/nonexistent python3 scripts/pii_secret_scan.py scan-diff HEAD~1 HEAD; then
    fail "placeholder/env-ref wrongly flagged (false positive)"
fi
echo "  ok: placeholder/env-ref not flagged"

# 5b. TEST/DUMMY values are NOT flagged (feeder FP class: `const token = 'lunk-test-token'`)
{ printf "const token = 'lunk-test-token'\n"; printf 'api_key = "fake-key-for-tests"\n'; } > testvals.js
git add testvals.js; git commit -qm testvals
if ! RINGER_PII_TERMS=/nonexistent python3 scripts/pii_secret_scan.py scan-diff HEAD~1 HEAD; then
    fail "test/dummy token values wrongly flagged (feeder FP class not fixed)"
fi
echo "  ok: test/dummy token values not flagged"

# 5c. a REAL high-entropy hardcoded secret STILL fires (didn't over-exempt)
printf 'db_password = "Xk9mQ2vLp8wZr4tYn6Bc3Df"\n' > realsecret.py
git add realsecret.py; git commit -qm realsecret
if RINGER_PII_TERMS=/nonexistent python3 scripts/pii_secret_scan.py scan-diff HEAD~1 HEAD; then
    fail "real hardcoded secret NOT caught (over-exempted)"
fi
echo "  ok: real hardcoded secret still caught"

# 5d. inline allow-marker suppresses a finding on that line
printf 'db_password = "Xk9mQ2vLp8wZr4tYn6Bc3Df"  # pii-scan: allow\n' > allowed.py
git add allowed.py; git commit -qm allowed
if ! RINGER_PII_TERMS=/nonexistent python3 scripts/pii_secret_scan.py scan-diff HEAD~1 HEAD; then
    fail "allow-marker did not suppress the finding"
fi
echo "  ok: inline allow-marker works"

# 6. FAIL-CLOSED when the operator terms file is empty/missing (no silent PII pass)
if RINGER_PII_TERMS=/nonexistent python3 scripts/pii_secret_scan.py terms-status 2>/dev/null; then
    fail "terms-status must FAIL-CLOSED (non-zero) when no terms file is present"
fi
echo "  ok: fail-closed on missing/empty terms file"

echo "PASS: pre-push security gate works (catches secrets + PII + private-email; fail-closed on unseeded terms; no FP on clean tree/placeholders)"
