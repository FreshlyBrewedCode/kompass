# Source me: puts the ad-hoc nix tools on PATH and the C++ runtime for PyPI wheels on NixOS.
# Tools are linked under $KOMPASS_DATA/tools (see README.md for the nix build commands).
KOMPASS_DATA=${KOMPASS_DATA:-/data/src/kompass/data}
T=$KOMPASS_DATA/tools
export PATH=$T/uv/bin:$T/osmium-tool/bin:$T/tippecanoe/bin:$T/pmtiles/bin:$T/gdal/bin:$T/duckdb/bin:$T/gnutime/bin:$PATH
export LD_LIBRARY_PATH=$T/gcclib-lib/lib:$T/zlib/lib:$T/expat/lib:$T/bzip2/lib:$T/lz4/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
export KOMPASS_DATA
