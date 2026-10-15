#!/bin/sh
# Sum revenue per monthly CSV in a folder: summarize.sh <dir>
set -eu
dir=${1:?usage: summarize.sh <dir>}
total=0
for f in "$dir"/*.csv; do
  head -n 1 "$f" | grep -qx 'region,revenue' || { echo "error: $f: unexpected header" >&2; exit 1; }
  sum=$(tail -n +2 "$f" | awk -F, '{s+=$2} END {print s+0}')
  echo "$(basename "$f" .csv) $sum"
  total=$((total + sum))
done
echo "total $total"
