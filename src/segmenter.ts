const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = SAMPLE_RATE * 30 / 1_000;
const PRE_ROLL_SAMPLES = SAMPLE_RATE * 240 / 1_000;
const END_SILENCE_SAMPLES = SAMPLE_RATE * 600 / 1_000;
const MIN_SPEECH_SAMPLES = SAMPLE_RATE * 200 / 1_000;
const MAX_SEGMENT_SAMPLES = SAMPLE_RATE * 12;
const MIN_RMS = 0.008;
const NOISE_RATIO = 2.5;
const NOISE_WEIGHT = 0.05;

export interface PcmSegmenter {
  push(pcm: Uint8Array): void;
  finish(): void;
  cancel(): void;
}

export function createSegmenter(onSegment: (pcm: Uint8Array) => void): PcmSegmenter {
  const frame = new Uint8Array(FRAME_SAMPLES * 2);
  const preRoll = new Uint8Array(PRE_ROLL_SAMPLES * 2);
  const segment = new Uint8Array(MAX_SEGMENT_SAMPLES * 2);
  let frameBytes = 0;
  let preRollBytes = 0;
  let preRollOffset = 0;
  let segmentBytes = 0;
  let speechSamples = 0;
  let segmentSpeechSamples = 0;
  let silenceSamples = 0;
  let noiseFloor = MIN_RMS / NOISE_RATIO;
  let active = false;
  let closed = false;

  function retainPreRoll(pcm: Uint8Array): void {
    const first = Math.min(pcm.byteLength, preRoll.byteLength - preRollOffset);
    preRoll.set(pcm.subarray(0, first), preRollOffset);
    preRoll.set(pcm.subarray(first), 0);
    preRollOffset = (preRollOffset + pcm.byteLength) % preRoll.byteLength;
    preRollBytes = Math.min(preRoll.byteLength, preRollBytes + pcm.byteLength);
  }

  function beginSegment(): void {
    const start = (preRollOffset + preRoll.byteLength - preRollBytes) % preRoll.byteLength;
    const first = Math.min(preRollBytes, preRoll.byteLength - start);
    segment.set(preRoll.subarray(start, start + first));
    segment.set(preRoll.subarray(0, preRollBytes - first), first);
    segmentBytes = preRollBytes;
    preRollBytes = 0;
    preRollOffset = 0;
    active = true;
  }

  function emitSegment(): void {
    if (speechSamples >= MIN_SPEECH_SAMPLES && segmentSpeechSamples > 0) {
      onSegment(segment.slice(0, segmentBytes));
    }
    segmentBytes = 0;
    segmentSpeechSamples = 0;
  }

  function processFrame(pcm: Uint8Array): void {
    let energy = 0;
    for (let offset = 0; offset < pcm.byteLength; offset += 2) {
      const unsigned = pcm[offset]! | pcm[offset + 1]! << 8;
      const sample = (unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned) / 0x8000;
      energy += sample * sample;
    }
    const samples = pcm.byteLength / 2;
    const rms = Math.sqrt(energy / samples);
    const speech = rms >= Math.max(MIN_RMS, noiseFloor * NOISE_RATIO);
    if (!speech) noiseFloor += (rms - noiseFloor) * NOISE_WEIGHT;
    if (!active) {
      if (!speech) {
        retainPreRoll(pcm);
        return;
      }
      beginSegment();
    }

    segment.set(pcm, segmentBytes);
    segmentBytes += pcm.byteLength;
    if (speech) {
      speechSamples += samples;
      segmentSpeechSamples += samples;
      silenceSamples = 0;
    } else {
      silenceSamples += samples;
    }

    if (silenceSamples >= END_SILENCE_SAMPLES) {
      emitSegment();
      active = false;
      speechSamples = 0;
      silenceSamples = 0;
    } else if (segmentBytes === segment.byteLength) {
      emitSegment();
    }
  }

  return {
    push(pcm): void {
      if (closed) return;
      let offset = 0;
      while (offset < pcm.byteLength && !closed) {
        const bytes = Math.min(frame.byteLength - frameBytes, pcm.byteLength - offset);
        frame.set(pcm.subarray(offset, offset + bytes), frameBytes);
        frameBytes += bytes;
        offset += bytes;
        if (frameBytes === frame.byteLength) {
          frameBytes = 0;
          processFrame(frame);
        }
      }
    },
    finish(): void {
      if (closed) return;
      closed = true;
      if (frameBytes % 2 !== 0) {
        throw new Error("Recorded PCM ends with an incomplete 16-bit sample.");
      }
      if (frameBytes > 0) processFrame(frame.subarray(0, frameBytes));
      frameBytes = 0;
      if (active) emitSegment();
      active = false;
    },
    cancel(): void {
      closed = true;
      frameBytes = 0;
      preRollBytes = 0;
      segmentBytes = 0;
    },
  };
}
