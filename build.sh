#!/bin/sh
# Build the WASM module and copy it into web/.
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/web_ss_synth.wasm web/
echo "Built web/web_ss_synth.wasm ($(wc -c < web/web_ss_synth.wasm | tr -d ' ') bytes)"
echo "Serve it with:  cd web && python3 -m http.server 8080"
