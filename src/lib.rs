//! WASM wrapper around `core_ss_synth`, exposed as a plain C ABI so the
//! module can be instantiated inside an AudioWorklet with zero JS glue.
//!
//! Mirrors the parameter surface of `nih_plug_ss_synth`: master gain, three
//! oscillators (waveform / gain / detune), ladder LPF, and an ADSR. The core's
//! `Synth::render` has its LPF and envelope bypassed, so those stages are
//! applied here using the core's own `SimpleLadder` and `Adsr`.

#![allow(static_mut_refs)]

use core_ss_synth::adsr::Adsr;
use core_ss_synth::lpf::SimpleLadder;
use core_ss_synth::parameters::Waveform;
use core_ss_synth::synth::Synth;
use core_ss_synth::util;

const MAX_FRAMES: usize = 2048;

struct WebSynth {
    synth: Synth,
    ladder_l: SimpleLadder,
    ladder_r: SimpleLadder,
    env: Adsr,
    master_gain_lin: f32,
    held: [bool; 128],
    silenced: bool,
}

static mut STATE: Option<WebSynth> = None;
static mut BUF_L: [f32; MAX_FRAMES] = [0.0; MAX_FRAMES];
static mut BUF_R: [f32; MAX_FRAMES] = [0.0; MAX_FRAMES];

fn state() -> &'static mut WebSynth {
    unsafe { STATE.as_mut().expect("init() not called") }
}

fn waveform_from_u32(wf: u32) -> Waveform {
    match wf {
        0 => Waveform::Sine,
        1 => Waveform::Square,
        2 => Waveform::Saw,
        _ => Waveform::Triangle,
    }
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let mut synth = Synth::new();
    synth.set_sample_rate(sample_rate);
    let params = *synth.get_current_params();
    unsafe {
        STATE = Some(WebSynth {
            synth,
            ladder_l: SimpleLadder::new(sample_rate, params.lpf_cutoff_hz, params.lpf_resonance, 1.0),
            ladder_r: SimpleLadder::new(sample_rate, params.lpf_cutoff_hz, params.lpf_resonance, 1.0),
            env: Adsr::new(
                sample_rate,
                params.env_attack_s,
                params.env_decay_s,
                params.env_sustain,
                params.env_release_s,
            ),
            master_gain_lin: util::db_to_gain_fast(-10.0),
            held: [false; 128],
            silenced: true,
        });
    }
}

#[no_mangle]
pub extern "C" fn note_on(note: u32, velocity: f32) {
    let s = state();
    if note >= 128 {
        return;
    }
    s.held[note as usize] = true;
    s.silenced = false;
    s.synth.note_on(note as usize, velocity);
    s.env.note_on();
}

#[no_mangle]
pub extern "C" fn note_off(note: u32) {
    let s = state();
    if note >= 128 {
        return;
    }
    s.held[note as usize] = false;
    if s.held.iter().any(|&h| h) {
        // Other notes still held: stop this voice immediately (core voices
        // have no per-voice envelope).
        s.synth.note_off(note as usize);
    } else {
        // Last note released: keep the oscillators running and let the
        // envelope's release stage fade them out; render() silences the
        // synth once the envelope goes idle.
        s.env.note_off();
    }
}

#[no_mangle]
pub extern "C" fn panic() {
    let s = state();
    s.held = [false; 128];
    s.synth.panic();
    s.env.note_off();
    s.silenced = true;
}

#[no_mangle]
pub extern "C" fn set_osc_waveform(osc: u32, wf: u32) {
    state().synth.set_osc_waveform(osc as usize, waveform_from_u32(wf));
}

#[no_mangle]
pub extern "C" fn set_osc_gain(osc: u32, gain: f32) {
    state().synth.set_osc_gain(osc as usize, gain);
}

#[no_mangle]
pub extern "C" fn set_osc_detune_cents(osc: u32, cents: f32) {
    state().synth.set_osc_detune_cents(osc as usize, cents);
}

#[no_mangle]
pub extern "C" fn set_lpf_cutoff_hz(hz: f32) {
    let s = state();
    s.ladder_l.set_cutoff(hz);
    s.ladder_r.set_cutoff(hz);
    s.synth.set_lpf_cutoff_hz(hz);
}

#[no_mangle]
pub extern "C" fn set_lpf_resonance(r: f32) {
    let s = state();
    s.ladder_l.set_resonance(r);
    s.ladder_r.set_resonance(r);
    s.synth.set_lpf_resonance(r);
}

#[no_mangle]
pub extern "C" fn set_env_attack_s(v: f32) {
    let s = state();
    s.env.set_attack(v);
    s.synth.set_env_attack_s(v);
}

#[no_mangle]
pub extern "C" fn set_env_decay_s(v: f32) {
    let s = state();
    s.env.set_decay(v);
    s.synth.set_env_decay_s(v);
}

#[no_mangle]
pub extern "C" fn set_env_sustain(v: f32) {
    let s = state();
    s.env.set_sustain(v);
    s.synth.set_env_sustain(v);
}

#[no_mangle]
pub extern "C" fn set_env_release_s(v: f32) {
    let s = state();
    s.env.set_release(v);
    s.synth.set_env_release_s(v);
}

#[no_mangle]
pub extern "C" fn set_master_gain_db(db: f32) {
    state().master_gain_lin = util::db_to_gain_fast(db);
}

#[no_mangle]
pub extern "C" fn buf_l_ptr() -> *const f32 {
    unsafe { BUF_L.as_ptr() }
}

#[no_mangle]
pub extern "C" fn buf_r_ptr() -> *const f32 {
    unsafe { BUF_R.as_ptr() }
}

#[no_mangle]
pub extern "C" fn render(frames: u32) {
    let frames = (frames as usize).min(MAX_FRAMES);
    let s = state();

    if s.silenced {
        unsafe {
            BUF_L[..frames].fill(0.0);
            BUF_R[..frames].fill(0.0);
        }
        return;
    }

    for i in 0..frames {
        let (l, r) = s.synth.render();
        let l = s.ladder_l.process_sample(l);
        let r = s.ladder_r.process_sample(r);
        let env = s.env.next();
        unsafe {
            BUF_L[i] = l * env * s.master_gain_lin;
            BUF_R[i] = r * env * s.master_gain_lin;
        }
    }

    // Envelope fully released with nothing held: kill the (still-gated)
    // voices so they don't burn CPU forever.
    if s.env.is_idle() && !s.held.iter().any(|&h| h) {
        s.synth.panic();
        s.silenced = true;
    }
}
