#!/bin/bash
# Run every smoke suite (or the ones named) against a fresh `vite preview` on :4173, or the live site.
#   npm run build && scripts/run-suites.sh                 all suites, local build
#   scripts/run-suites.sh smoke-test-charts                one suite
#   LIVE=1 scripts/run-suites.sh                           all suites against https://shubhamm73.github.io/upsc-notes/
# On macOS, scripts/linux-shim makes Chromium behave like the Linux container / Android tablet the suites
# were written for (Ctrl is "Mod", Home/End go to the line). Logs: $LOGS (default /tmp/upsc-suites).
# Python: playwright 1.56.0, pypdf, Pillow; `pdftotext` / `pdftoppm` (poppler) on PATH.
cd "$(dirname "$0")/.."
[ "$(uname)" = Darwin ] && export PYTHONPATH="$PWD/scripts/linux-shim${PYTHONPATH:+:$PYTHONPATH}" UPSC_LINUX_SHIM=1
OUT=${LOGS:-/tmp/upsc-suites}; mkdir -p "$OUT"
SUITES=${@:-smoke-test smoke-test-m2 smoke-test-m3 smoke-test-m4 smoke-test-m5 smoke-test-ui1 smoke-test-ui2 smoke-test-ui3 smoke-test-paste smoke-test-canvas2 smoke-test-sketch smoke-test-share smoke-test-folders smoke-test-drive smoke-test-inline smoke-test-tables smoke-test-looks smoke-test-charts smoke-test-diagrams smoke-test-mindmap smoke-test-themes smoke-test-templates smoke-test-penmark}
if [ -z "$LIVE" ]; then
  # never `pkill -f "vite preview"`: the pattern matches this shell
  lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 0.5
  (npx vite preview --port 4173 --strictPort >/dev/null 2>&1 &)
  for i in $(seq 1 50); do curl -s localhost:4173/upsc-notes/ >/dev/null && break; sleep 0.2; done
fi
tp=0; tf=0; bad=0
for t in $SUITES; do
  f=scripts/$t.py
  if [ -n "$LIVE" ]; then sed 's#http://localhost:4173/upsc-notes/#https://shubhamm73.github.io/upsc-notes/#' "$f" > "$OUT/live-$t.py"; f=$OUT/live-$t.py; fi
  python3 "$f" > "$OUT/$t.log" 2>&1; rc=$?
  p=$(grep -c '^PASS' "$OUT/$t.log"); fl=$(grep -c '^FAIL' "$OUT/$t.log")
  tp=$((tp+p)); tf=$((tf+fl)); [ $rc -ne 0 ] && bad=1
  echo "$t: $p pass, $fl fail, exit $rc"
  [ $fl -gt 0 -o $rc -ne 0 ] && grep -E '^FAIL|Error|Traceback' "$OUT/$t.log"
done
[ -z "$LIVE" ] && lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill 2>/dev/null
echo "TOTAL: $tp pass, $tf fail"
[ $tf -eq 0 -a $bad -eq 0 ]
