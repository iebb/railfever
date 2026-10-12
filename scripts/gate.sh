#!/bin/bash
# Full headless gate: typecheck, build and every test script in scripts/ on a git ref, in an isolated worktree.
# Pass = exit code 0. Two lanes run in parallel; timing-sensitive scripts run alone at the end (a timing-only
# failure of `ai` is rerun once and, if it repeats, reported without blocking).
# usage: scripts/gate.sh <ref> [output dir, default .gate]   -> one line per run, then GATE: PASS|FAIL
# Libraries, browser-only scripts and benchmarks are skipped; storage and switches need the test-only packages
# fake-indexeddb and jsdom (see scripts/storage.ts), so they are skipped unless those resolve.
if [ -z "$GATE_COPY" ]; then T=$(mktemp "${TMPDIR:-/tmp}/rf-gate.XXXXXX"); cp "$0" "$T"; GATE_COPY=1 exec bash "$T" "$@"; fi
REF=${1:-HEAD}
ROOT=$(git rev-parse --show-toplevel) || { echo "run from inside the repository"; exit 1; }
cd "$ROOT" || exit 1
G=$(cd "$ROOT" && mkdir -p "${2:-.gate}" && cd "${2:-.gate}" && pwd); W=$ROOT/.worktrees/gate
git worktree remove --force "$W" >/dev/null 2>&1; git worktree prune
git worktree add --detach "$W" "$REF" >/dev/null 2>&1 || { echo "worktree failed"; exit 1; }
ln -s "$ROOT/node_modules" "$W/node_modules"
cd "$W"
echo "ref $(git log --oneline -1)  load: $(uptime | sed 's/.*load averages*: //')"
fail=0
if npx tsc --noEmit > "$G/tsc.log" 2>&1; then echo "typecheck: ok"; else echo "typecheck: FAILED"; head -5 "$G/tsc.log"; fail=1; fi
if npm run build > "$G/build.log" 2>&1; then echo "build: ok ($(grep -o 'railfever.html ([0-9]* KB)' "$G/build.log"))"; else echo "build: FAILED"; tail -8 "$G/build.log"; fail=1; fi
EXCLUDE=" lib stationlib saves-harness linegrow-fixtures sectionlib section-structurelib saves-ui perf perfbench scale huge-displays "
node -e "require.resolve('fake-indexeddb'); require.resolve('jsdom')" >/dev/null 2>&1 || EXCLUDE="$EXCLUDE storage switches "
SOLO=" ai catchperf "
jobs=()
for f in scripts/*.ts; do
  t=$(basename "$f" .ts)
  case "$EXCLUDE" in *" $t "*) continue;; esac
  case "$SOLO" in *" $t "*) continue;; esac
  case $t in
    smoke) jobs+=("smoke7|smoke|7" "smoke11|smoke|11" "smoke23|smoke|23");;
    replay) jobs+=("replay7|replay|7" "replay23|replay|23");;
    ainet) jobs+=("ainet|ainet|scenarios");;
    migrate) jobs+=("migrate|migrate|$W/scripts/fixtures/saves");;
    *) jobs+=("$t|$t|");;
  esac
done
run1() { # name script args
  local name=$1 t=$2 a=$3
  mkdir -p "$G/$name"
  npx esbuild "scripts/$t.ts" --bundle --platform=node --format=esm --outfile="$G/$name/$t.mjs" --log-level=error > "$G/$name.bundle.log" 2>&1 || { echo "$name: BUNDLE FAILED" > "$G/$name.res"; return; }
  local t0=$(date +%s)
  (cd "$G/$name" && timeout 1800 node "$t.mjs" $a > "$G/$name.log" 2>&1); local rc=$?
  local v=$(grep -E "ALL CHECKS PASSED|ALL INVARIANTS HELD|ALL PASSED|ALL [0-9]+ .*PASSED|^PASS|PURITY PASSED|checks passed|[0-9]+ FAILURES?|FAIL" "$G/$name.log" | tail -1 | cut -c1-140)
  if [ $rc = 0 ]; then echo "$name: ok ($(( $(date +%s) - t0 ))s) $v" > "$G/$name.res"; else echo "$name: FAILED rc=$rc ($(( $(date +%s) - t0 ))s) $v" > "$G/$name.res"; fi
}
lane() { local start=$1 i; for ((i=start; i<${#jobs[@]}; i+=2)); do IFS='|' read -r n s a <<< "${jobs[$i]}"; run1 "$n" "$s" "$a"; done; }
rm -f "$G"/*.res 2>/dev/null
lane 0 & lane 1 & wait
for j in "${jobs[@]}"; do IFS='|' read -r n s a <<< "$j"; cat "$G/$n.res"; grep -q FAILED "$G/$n.res" && fail=1; done
run1 ai ai "23 3 512 3"; cat "$G/ai.res"
if grep -q FAILED "$G/ai.res"; then
  if grep -q "FAIL:" "$G/ai.log" && ! grep "FAIL:" "$G/ai.log" | grep -qv "stays sliced"; then
    echo "  ai: timing-only failures; rerunning once"; run1 ai ai "23 3 512 3"; cat "$G/ai.res"
    grep -q FAILED "$G/ai.res" && { grep "FAIL:" "$G/ai.log" | grep -qv "stays sliced" && fail=1 || echo "  ai: timing-only failures again at load $(uptime | sed 's/.*load averages*: //') -> reported, not blocking"; }
  else fail=1; fi
fi
run1 catchperf catchperf ""; cat "$G/catchperf.res"; grep -q FAILED "$G/catchperf.res" && fail=1
cd "$ROOT"; git worktree remove --force "$W" >/dev/null 2>&1; git worktree prune
[ $fail = 0 ] && echo "GATE: PASS" || echo "GATE: FAIL"
