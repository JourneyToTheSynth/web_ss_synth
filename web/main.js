// Main-thread glue: boots the AudioWorklet, wires the UI controls to the
// WASM synth, and handles the on-screen / computer keyboard.

let node = null;
let booting = null;

async function ensureAudio() {
  if (node) return node;
  if (booting) return booting;
  booting = (async () => {
    const ctx = new AudioContext();
    const [module] = await Promise.all([
      WebAssembly.compileStreaming(fetch('web_ss_synth.wasm')),
      ctx.audioWorklet.addModule('ss-synth-processor.js'),
    ]);
    node = new AudioWorkletNode(ctx, 'ss-synth', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { module },
    });
    node.connect(ctx.destination);
    await ctx.resume();
    // Replay current UI state so the synth matches the controls.
    for (const send of paramSenders) send();
    return node;
  })();
  return booting;
}

function send(...msg) {
  if (node) node.port.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Parameter controls
// ---------------------------------------------------------------------------

const paramSenders = [];

// Generic slider hookup. `toValue` maps the raw slider position to the synth
// value, `format` renders the readout.
function bindSlider(id, fn, { toValue = (v) => v, format = (v) => v.toFixed(2), extraArgs = [] } = {}) {
  const el = document.getElementById(id);
  const readout = document.getElementById(id + '-value');
  const update = () => {
    const value = toValue(parseFloat(el.value));
    readout.textContent = format(value);
    send(fn, ...extraArgs, value);
  };
  el.addEventListener('input', update);
  paramSenders.push(update);
  // Show the initial readout without needing audio to be running.
  readout.textContent = format(toValue(parseFloat(el.value)));
}

function bindSelect(id, fn, extraArgs = []) {
  const el = document.getElementById(id);
  const update = () => send(fn, ...extraArgs, parseInt(el.value, 10));
  el.addEventListener('change', update);
  paramSenders.push(update);
}

// Log-scale mapping for sliders whose raw range is 0..1.
const logMap = (min, max) => (v) => min * Math.pow(max / min, v);

bindSlider('gain', 'set_master_gain_db', { format: (v) => v.toFixed(1) + ' dB' });

for (let i = 0; i < 3; i++) {
  bindSelect(`osc${i}-wave`, 'set_osc_waveform', [i]);
  bindSlider(`osc${i}-gain`, 'set_osc_gain', { extraArgs: [i] });
  bindSlider(`osc${i}-detune`, 'set_osc_detune_cents', {
    extraArgs: [i],
    format: (v) => v.toFixed(1) + ' ct',
  });
}

bindSlider('cutoff', 'set_lpf_cutoff_hz', {
  toValue: logMap(20, 20000),
  format: (v) => (v >= 1000 ? (v / 1000).toFixed(2) + ' kHz' : v.toFixed(0) + ' Hz'),
});
bindSlider('resonance', 'set_lpf_resonance');

const fmtSecs = (v) => (v < 1 ? (v * 1000).toFixed(0) + ' ms' : v.toFixed(2) + ' s');
bindSlider('attack', 'set_env_attack_s', { toValue: logMap(0.001, 5), format: fmtSecs });
bindSlider('decay', 'set_env_decay_s', { toValue: logMap(0.001, 5), format: fmtSecs });
bindSlider('sustain', 'set_env_sustain');
bindSlider('release', 'set_env_release_s', { toValue: logMap(0.001, 5), format: fmtSecs });

// Demo sequence: C2-E2-G2-B2-C3 and back down to E2, looped until stopped.
const SEQUENCE = [36, 40, 43, 47, 48, 47, 43, 40];
const seqButton = document.getElementById('play-seq');
const stopButton = document.getElementById('stop-seq');
let seqPlaying = false;

seqButton.addEventListener('click', async () => {
  seqButton.disabled = true;
  stopButton.disabled = false;
  seqPlaying = true;
  await ensureAudio();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (seqPlaying) {
    for (const note of SEQUENCE) {
      if (!seqPlaying) break;
      noteOn(note);
      await sleep(200);
      noteOff(note);
      await sleep(50);
    }
  }
  seqButton.disabled = false;
  stopButton.disabled = true;
});

stopButton.addEventListener('click', () => {
  seqPlaying = false;
});

document.getElementById('panic').addEventListener('click', async () => {
  await ensureAudio();
  send('panic');
  for (const el of document.querySelectorAll('.key.active')) el.classList.remove('active');
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const VELOCITY = 0.8;
const activeNotes = new Set();

async function noteOn(note) {
  if (activeNotes.has(note)) return;
  activeNotes.add(note);
  await ensureAudio();
  send('note_on', note, VELOCITY);
  keyEl(note)?.classList.add('active');
}

function noteOff(note) {
  if (!activeNotes.delete(note)) return;
  send('note_off', note);
  keyEl(note)?.classList.remove('active');
}

function keyEl(note) {
  return document.querySelector(`.key[data-note="${note}"]`);
}

// On-screen keyboard: C3 (48) .. C5 (72)
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const kb = document.getElementById('keyboard');
for (let note = 48; note <= 72; note++) {
  const name = NOTE_NAMES[note % 12];
  const key = document.createElement('div');
  key.className = 'key' + (name.includes('#') ? ' black' : ' white');
  key.dataset.note = note;
  if (name === 'C') key.textContent = 'C' + (Math.floor(note / 12) - 1);
  kb.appendChild(key);
}

let pointerDown = false;
kb.addEventListener('pointerdown', (e) => {
  const note = e.target.dataset.note;
  if (note === undefined) return;
  pointerDown = true;
  noteOn(parseInt(note, 10));
});
kb.addEventListener('pointerover', (e) => {
  const note = e.target.dataset.note;
  if (pointerDown && note !== undefined) noteOn(parseInt(note, 10));
});
kb.addEventListener('pointerout', (e) => {
  const note = e.target.dataset.note;
  if (pointerDown && note !== undefined) noteOff(parseInt(note, 10));
});
window.addEventListener('pointerup', () => {
  pointerDown = false;
  // Release anything the pointer left hanging (keys held via keyboard stay).
  for (const note of [...activeNotes]) {
    if (!heldByComputerKey.has(note)) noteOff(note);
  }
});

// Computer keyboard: home row = white keys from C4 (60), number/qwerty row = black keys.
const KEYMAP = {
  a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67,
  y: 68, h: 69, u: 70, j: 71, k: 72, o: 73, l: 74, p: 75, ';': 76,
};
const heldByComputerKey = new Set();

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey) return;
  const note = KEYMAP[e.key.toLowerCase()];
  if (note !== undefined) {
    heldByComputerKey.add(note);
    noteOn(note);
  }
});
window.addEventListener('keyup', (e) => {
  const note = KEYMAP[e.key.toLowerCase()];
  if (note !== undefined) {
    heldByComputerKey.delete(note);
    noteOff(note);
  }
});
