#!/bin/zsh
# External BeginFrame pacing vs GPU copy and plain zero-copy, one build (apps/bf). Logs to raw/pipeline-bf.log.
cd /tmp/cef-osr-memory; L=raw/pipeline-bf.log
typeset -A X; X=(gpu "" zc "--zero-copy" tick "--begin-frames tick" chg "--begin-frames change" chgp "--begin-frames change-pump")
V=(gpu zc tick chg chgp)
r() { python3 -I src/tools/memory/run.py bf "$@" >> $L 2>&1; }
for v in $V; do r delayed --label $v --extra "$X[$v]"; done
for rep in 1 2; do
  for v in $V; do r orig --perf --cpu --modes idle --label $v-cpu --extra "$X[$v]"; done
  for v in gpu chg; do r orig --perf --cpu --modes idle --label $v-cpu-pump1000 --extra "$X[$v] --pump-max-ms 1000"; done
done
for v in $V; do r orig --perf --modes scroll,animate --label $v --extra "$X[$v]"; done
for rep in 1 2; do
  for s in orig tab1 artifact; do for v in $V; do r $s --label $v --extra "$X[$v]"; done; done
  for n in 4 8; do for v in gpu tick chg; do r orig --label $v-tabs$n --extra "$X[$v] --tabs $n"; done; done
done
echo MATRIX-DONE >> $L
