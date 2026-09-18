class HvacPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.length = 0;
    this.accepting = true;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return;
      this.accepting = false;
      this.flush();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  flush() {
    if (!this.length) return;
    const samples = this.buffer.slice(0, this.length);
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
    this.buffer = new Float32Array(2048);
    this.length = 0;
  }

  process(inputs) {
    if (!this.accepting) return true;
    const channels = inputs[0] || [];
    const frameCount = channels[0]?.length || 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] || 0;
      mono /= Math.max(1, channels.length);
      this.buffer[this.length] = mono;
      this.length += 1;
      if (this.length === this.buffer.length) this.flush();
    }
    return true;
  }
}

registerProcessor('hvac-pcm-capture', HvacPcmCaptureProcessor);
