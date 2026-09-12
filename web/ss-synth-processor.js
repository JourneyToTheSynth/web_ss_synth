// AudioWorklet processor hosting the core_ss_synth WASM module.
// The compiled WebAssembly.Module is handed over via processorOptions and
// instantiated synchronously here (the module has zero imports).

class SsSynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { module } = options.processorOptions;
    this.exports = new WebAssembly.Instance(module, {}).exports;
    this.exports.init(sampleRate);

    // Messages are [exportName, ...args], e.g. ['note_on', 60, 0.8]
    this.port.onmessage = (e) => {
      const [fn, ...args] = e.data;
      if (fn === '__ping') {
        this.port.postMessage('__pong');
        return;
      }
      const f = this.exports[fn];
      if (f) f(...args);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const e = this.exports;
    e.render(frames);
    out[0].set(new Float32Array(e.memory.buffer, e.buf_l_ptr(), frames));
    if (out.length > 1) {
      out[1].set(new Float32Array(e.memory.buffer, e.buf_r_ptr(), frames));
    }
    return true;
  }
}

registerProcessor('ss-synth', SsSynthProcessor);
