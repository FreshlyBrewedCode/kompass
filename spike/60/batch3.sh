#!/usr/bin/env bash
set -u
cd /tmp/spike60
B=/data/src/kompass/data/build/region
R=/data/src/kompass/data/compare/rides
export KOMPASS_SPIKE_PERSONAL=/tmp/spike60/explored-others.json
for m in today groups soft groups_soft norm min03; do
  if [ $m = min03 ]; then export KOMPASS_SPIKE_MIN=0.3; unset KOMPASS_SPIKE_MODEL; else unset KOMPASS_SPIKE_MIN; export KOMPASS_SPIKE_MODEL=$m; fi
  ./kompass2 replay --build $B --profiles gravel_explorer,paved_quiet,river_valley --leg-km 14 --min-straight 0.55 $R > rp-$m.txt 2>&1
  echo "$m done"
done
echo all done
