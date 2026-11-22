#!/usr/bin/env bash
set -u
cd /tmp/spike60
B=/data/src/kompass/data/build/region
export KOMPASS_SPIKE_FLOOR100=1
run() { # name model min pers
  unset KOMPASS_SPIKE_MODEL KOMPASS_SPIKE_MIN
  [ "$2" != today ] && export KOMPASS_SPIKE_MODEL=$2
  [ "$3" != - ] && export KOMPASS_SPIKE_MIN=$3
  extra=(); [ $4 = P ] && extra=(--personal explored.json)
  ./kompass3 spike60 --build $B --pairs 30 --km 15-35 --sliders "${extra[@]}" --dump routes-$1-$4.json > s4-$1-$4.txt 2>&1
  echo "$1 $4 done"
}
run today today - P
run min01 today 0.1 P
run groups_min01 groups 0.1 P
run norm norm - P
run min01 today 0.1 N
run groups_min01 groups 0.1 N
run norm norm - N
echo all done
