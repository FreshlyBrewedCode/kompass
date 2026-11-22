#!/usr/bin/env bash
set -u
cd /tmp/spike60
B=/data/src/kompass/data/build/region
for pers in P N; do
  for m in today groups soft groups_soft norm min03; do
    extra=(); [ $pers = P ] && extra=(--personal explored.json)
    if [ $m = min03 ]; then export KOMPASS_SPIKE_MIN=0.3; unset KOMPASS_SPIKE_MODEL; else unset KOMPASS_SPIKE_MIN; export KOMPASS_SPIKE_MODEL=$m; fi
    ./kompass spike60 --build $B --pairs 30 --km 15-35 --sliders "${extra[@]}" --dump routes-$m-$pers.json > s-$m-$pers.txt 2>&1
    echo "$m $pers done: $(tail -1 s-$m-$pers.txt)"
  done
done
