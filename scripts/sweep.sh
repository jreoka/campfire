#!/bin/sh
# Run every test script in scripts/ once, serially, and summarise.
#
# Serially on purpose: the browser half spawns a real Chromium per script, and
# running these in parallel exhausts the process table (this cgroup caps pids
# at 256 and "Cannot fork" is the symptom). One at a time is slower but it
# always finishes, and it finishes with numbers you can trust.
#
# A SKIP line is a FAILURE, not a pass. skip() now exits 1, so a suite that
# could not get a browser or a database shows up here as a failure instead of
# quietly going green. When that happens, read the FAIL detail: it says what
# was missing.
#
# Usage:  scripts/sweep.sh [outfile]
# Exit:   always 0. The summary is the output; read the outfile.

OUT="${1:-/tmp/sweep.txt}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

pass=0; fail=0; skipped=0; failed_list=""
: > "$OUT"

# A crashed or killed Chromium leaves its whole process tree behind (crashpad
# plus a dozen renderers). The cgroup here caps pids at 256, so a sweep leaks
# its way to "Cannot fork" partway through -- and every suite after that point
# fails for a reason that has nothing to do with the code. Reap between scripts.
reap() {
  for p in $(ps -e -o pid=,comm= 2>/dev/null | grep -iE 'chrome|chromium|headless_shell' | awk '{print $1}'); do
    kill -9 "$p" 2>/dev/null
  done
  sleep 1
}

reap
for f in scripts/test-*.js; do
  name=$(basename "$f" .js)
  tmp="/tmp/sweep-$name.out"
  timeout 300 node "$f" > "$tmp" 2>&1
  rc=$?
  reap
  # grep -c prints 0 AND exits 1 when there is no match, so `|| echo 0`
  # would count twice. Keep the printed 0 and swallow only the exit status.
  ok=$(grep -c '^  ok' "$tmp" 2>/dev/null || true)
  bad=$(grep -c '^  FAIL' "$tmp" 2>/dev/null || true)
  sk=$(grep -c '\[test\] SKIP' "$tmp" 2>/dev/null || true)
  : "${ok:=0}"; : "${bad:=0}"; : "${sk:=0}"

  if [ "$rc" -ne 0 ] || [ "$bad" -ne 0 ]; then
    fail=$((fail+1)); failed_list="$failed_list $name"
    printf 'FAIL %s rc=%s ok=%s FAIL=%s skip=%s\n' "$name" "$rc" "$ok" "$bad" "$sk" >> "$OUT"
    grep '^  FAIL' "$tmp" | head -6 | sed "s|^|    $name: |" >> "$OUT"
  else
    pass=$((pass+1))
    [ "$sk" -ne 0 ] && skipped=$((skipped+1))
    printf 'pass %s rc=0 ok=%s FAIL=0 skip=%s\n' "$name" "$ok" "$sk" >> "$OUT"
  fi
  rm -f "$tmp"
done
reap

{
  echo ""
  echo "=== $pass passed, $fail failed ==="
  [ "$fail" -ne 0 ] && echo "failing:$failed_list"
  echo "(of the passing scripts, $skipped printed at least one SKIP line)"
} >> "$OUT"

cat "$OUT"