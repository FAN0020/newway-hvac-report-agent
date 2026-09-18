export class MicrophoneTimeoutError extends Error {
  constructor() {
    super('Microphone access timed out after 15 seconds.');
    this.name = 'MicrophoneTimeoutError';
  }
}

export function requestMicrophone(getUserMedia, constraints, { timeoutMs = 15_000 } = {}) {
  let settled = false;
  const acquisition = Promise.resolve().then(() => getUserMedia(constraints));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new MicrophoneTimeoutError());
    }, timeoutMs);
    acquisition.then((stream) => {
      if (settled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(stream);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function resample(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

export function encodeMonoPcmWav(chunks, sourceRate, targetRate = 16_000) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const samples = resample(joined, sourceRate, targetRate);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (at, text) => [...text].forEach((character, index) => view.setUint8(at + index, character.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return new Blob([buffer], { type: 'audio/wav' });
}

function flushWorklet(node, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.port.removeEventListener('message', onMessage);
      reject(new Error('Audio capture did not return its final samples.'));
    }, timeoutMs);
    const onMessage = (event) => {
      if (event.data?.type !== 'flushed') return;
      clearTimeout(timer);
      node.port.removeEventListener('message', onMessage);
      resolve();
    };
    node.port.addEventListener('message', onMessage);
    node.port.postMessage({ type: 'flush' });
  });
}

export class PcmWavRecorder {
  constructor() {
    this.stream = null;
    this.context = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.chunks = [];
  }

  async start() {
    this.stream = await requestMicrophone(
      (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false },
    );
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule('/pcm-capture-worklet.js');
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'hvac-pcm-capture');
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.node.port.onmessage = (event) => {
      if (event.data?.type === 'samples') this.chunks.push(event.data.samples);
    };
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.context.destination);
    return { sampleRate: this.context.sampleRate };
  }

  async stop() {
    if (!this.node || !this.context) throw new Error('Recorder is not active.');
    await flushWorklet(this.node);
    const wav = encodeMonoPcmWav(this.chunks, this.context.sampleRate);
    this.stream.getTracks().forEach((track) => track.stop());
    this.source.disconnect();
    this.node.disconnect();
    this.sink.disconnect();
    await this.context.close();
    this.stream = null;
    this.context = null;
    return wav;
  }
}
