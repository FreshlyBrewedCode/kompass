#!/usr/bin/env bash
set -u
cd /tmp/spike60
B=/data/src/kompass/data/build/region
R=/data/src/kompass/data/compare/rides
for m in today groups soft groups_soft norm min03; do
  if [ $m = min03 ]; then export KOMPASS_SPIKE_MIN=0.3; unset KOMPASS_SPIKE_MODEL; else unset KOMPASS_SPIKE_MIN; export KOMPASS_SPIKE_MODEL=$m; fi
  ./kompass replay --build $B --profiles gravel_explorer,paved_quiet,river_valley --leg-km 14 --min-straight 0.55 $R > r-$m.txt 2>&1
  echo "$m done"
done
unset KOMPASS_SPIKE_MIN KOMPASS_SPIKE_MODEL
./kompass replay --build $B --profiles paved_quiet,gravel_explorer --leg-km 14 --min-straight 0.55 $R > r-judge-pq.txt 2>&1
./kompass replay --build $B --profiles river_valley,gravel_explorer --leg-km 14 --min-straight 0.55 $R > r-judge-rv.txt 2>&1
./kompass replay --build $B --profiles gravel_explorer --ref brouter-gravel=/data/src/kompass/data/compare/run-lk14/brouter-gravel --leg-km 14 --min-straight 0.55 $R > r-today-brouter.txt 2>&1
echo all done
