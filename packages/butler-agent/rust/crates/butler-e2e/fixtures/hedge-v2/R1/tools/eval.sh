#!/bin/sh
# Score each prediction file against labels: eval.sh <bench-dir>
set -eu
dir=${1:?usage: eval.sh <bench-dir>}
for p in "$dir"/pred_*.csv; do
  name=$(basename "$p" .csv | sed 's/^pred_//')
  paste -d, "$dir/labels.csv" "$p" | awk -F, -v n="$name" -v lat="$(cat "$dir/latency_$name.txt")" '
    NR>1 { if ($2==1 && $4==1) tp++; else if ($2==0 && $4==1) fp++; else if ($2==1 && $4==0) fn++ }
    END { p=tp/(tp+fp); r=tp/(tp+fn); printf "%s precision=%.3f recall=%.3f f1=%.3f p50_ms=%s cases=%d\n", n, p, r, 2*p*r/(p+r), lat, NR-1 }'
done
