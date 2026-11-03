#!/bin/zsh
# usage: build.sh <variant>   builds /tmp/cef-osr-memory/src and packages it to /tmp/cef-osr-memory/apps/<variant>/ButlerCefSpike.app
set -eu
B=/tmp/cef-osr-memory; v=$1
export PATH=$HOME/.cargo/bin:$B/py/bin:$PATH PYTHONPATH=$B/py CEF_PATH=$B/src/cef CARGO_TARGET_DIR=$B/src/target
[ -x $B/py/bin/cmake ] || python3 -m pip install -q --target $B/py cmake ninja
cd $B/src && zsh tools/setup.sh
nice -n 10 ~/bin/heavy cargo build --release -j 6
python3 tools/package.py >/dev/null
mkdir -p $B/apps/$v && rm -rf $B/apps/$v/ButlerCefSpike.app && mv dist/ButlerCefSpike.app $B/apps/$v/
echo BUILT $v
