#!/usr/bin/env bash
set -u
cd /tmp/spike60
B=/data/src/kompass/data/build/region
R=/data/src/kompass/data/compare/rides
for pers in N P; do
for m in min01 groups_min01; do
  unset KOMPASS_SPIKE_MODEL KOMPASS_SPIKE_MIN KOMPASS_SPIKE_PERSONAL
  export KOMPASS_SPIKE_MIN=0.1
  [ $m = groups_min01 ] && export KOMPASS_SPIKE_MODEL=groups
  [ $pers = P ] && export KOMPASS_SPIKE_PERSONAL=/tmp/spike60/explored-others.json
  pre=r; [ $pers = P ] && pre=rp
  ./kompass5 replay --build $B --profiles gravel_explorer,paved_quiet,river_valley --leg-km 14 --min-straight 0.55 $R > $pre-$m.txt 2>&1
  echo "$pre $m done"
done
done
echo all done
