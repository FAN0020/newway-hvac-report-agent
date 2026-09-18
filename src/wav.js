const PCM_FORMAT = 1;

export function inspectPcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw Object.assign(new Error('Audio must be a complete WAV file.'), { code: 'INVALID_WAV', status: 400 });
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw Object.assign(new Error('Audio must use the RIFF/WAVE container.'), { code: 'INVALID_WAV', status: 400 });
  }

  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const contentStart = offset + 8;
    const contentEnd = contentStart + chunkSize;
    if (contentEnd > buffer.length) {
      throw Object.assign(new Error('WAV contains a truncated chunk.'), { code: 'INVALID_WAV', status: 400 });
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(contentStart),
        channels: buffer.readUInt16LE(contentStart + 2),
        sampleRate: buffer.readUInt32LE(contentStart + 4),
        byteRate: buffer.readUInt32LE(contentStart + 8),
        blockAlign: buffer.readUInt16LE(contentStart + 12),
        bitsPerSample: buffer.readUInt16LE(contentStart + 14),
      };
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    offset = contentEnd + (chunkSize % 2);
  }

  if (!format || dataBytes === null) {
    throw Object.assign(new Error('WAV is missing a format or data chunk.'), { code: 'INVALID_WAV', status: 400 });
  }
  if (format.audioFormat !== PCM_FORMAT || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw Object.assign(new Error('WAV must be mono 16-bit PCM.'), { code: 'UNSUPPORTED_WAV_FORMAT', status: 415 });
  }
  if (format.sampleRate < 8_000 || format.sampleRate > 48_000) {
    throw Object.assign(new Error('WAV sample rate must be between 8 kHz and 48 kHz.'), { code: 'UNSUPPORTED_SAMPLE_RATE', status: 415 });
  }
  const expectedByteRate = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  if (format.byteRate !== expectedByteRate || format.blockAlign !== 2) {
    throw Object.assign(new Error('WAV header has inconsistent PCM dimensions.'), { code: 'INVALID_WAV', status: 400 });
  }
  return Object.freeze({ ...format, dataBytes, durationMs: Math.round((dataBytes / expectedByteRate) * 1000) });
}
