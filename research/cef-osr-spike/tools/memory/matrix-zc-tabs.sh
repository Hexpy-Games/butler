#!/bin/zsh
# Zero-copy + multi-tab matrix on one build (apps/all2). Logs to raw/pipeline3.log.
cd /tmp/cef-osr-memory; L=raw/pipeline3.log
r() { python3 -I src/tools/memory/run.py all2 "$@" >> $L 2>&1; tail -1 raw/runs.jsonl | cut -c1-200 >> $L; }
for rep in 1 2; do
  for s in orig blank chat tab1 artifact hidden; do
    r $s --label gpu
    r $s --label zc --extra "--zero-copy"
  done
done
for rep in 1 2; do
  for n in 2 4 8; do r orig --label tabs$n --extra "--tabs $n"; done
  for n in 4 8; do r orig --label tabs$n-keep --extra "--tabs $n --keep-hidden-frames"; done
  r orig --label zc-tabs4 --extra "--zero-copy --tabs 4"
done
r orig --perf --label gpu
r orig --perf --label zc --extra "--zero-copy"
echo MATRIX-DONE >> $L
