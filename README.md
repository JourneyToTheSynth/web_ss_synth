# web_ss_synth

`core_ss_synth` compiled to WebAssembly and playable in the browser — the same
parameter surface as `nih_plug_ss_synth` (master gain, 3 oscillators with
waveform/gain/detune, ladder LPF, ADSR), with an on-screen + computer keyboard.

## How it works

- `src/lib.rs` wraps the core `Synth` behind a plain C ABI (`init`, `note_on`,
  `note_off`, `render`, `set_*` parameter setters). No wasm-bindgen — the
  module has zero imports, so it can be instantiated directly inside an
  AudioWorklet.
- The core depends on `nih_plug` only through its `std` feature, so this crate
  builds it with `default-features = false, features = ["no_std_core"]`.
- The core's `Synth::render` currently bypasses its LPF and envelope, so the
  wrapper applies them itself using the core's own `SimpleLadder` and `Adsr`
  (including a working release tail: the last note's voices keep running until
  the envelope goes idle, then the synth is silenced).
- `web/main.js` compiles the wasm on the main thread, passes the
  `WebAssembly.Module` to the worklet (`web/ss-synth-processor.js`) via
  `processorOptions`, and drives it with `['export_name', ...args]` messages
  over the worklet port.

## Build & run

```sh
./build.sh                 # cargo build --target wasm32-unknown-unknown + copy into web/
cd web && python3 -m http.server 8080
```

Then open http://localhost:8080 (a server is required — AudioWorklets don't
load from `file://`). Audio starts on the first key press or click.

Keyboard mapping: `A W S E D F T G Y H U J K O L P ;` = C4 upward, plus a
clickable two-octave keyboard (drag for glissando).
