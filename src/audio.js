/* eslint-disable no-bitwise -- G.711 mu-law encode/decode is bit-level. */

const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

const decodeMuLawByte = (muByte) => {
  const inverted = ~muByte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let magnitude = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
  magnitude -= MU_LAW_BIAS;
  return sign ? -magnitude : magnitude;
};

const encodeMuLawByte = (sample) => {
  let pcm = sample;
  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > MU_LAW_CLIP) pcm = MU_LAW_CLIP;
  pcm += MU_LAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
};

const muLawBufferToPcm16 = (muLawBuffer) => {
  const output = new Int16Array(muLawBuffer.length);
  for (let i = 0; i < muLawBuffer.length; i += 1) {
    output[i] = decodeMuLawByte(muLawBuffer[i]);
  }
  return output;
};

const pcm16ToMuLawBuffer = (pcm16) => {
  const output = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    output[i] = encodeMuLawByte(pcm16[i]);
  }
  return output;
};

const pcm16BufferToInt16Array = (buffer) => {
  const sampleCount = Math.floor(buffer.length / 2);
  const output = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    output[i] = buffer.readInt16LE(i * 2);
  }
  return output;
};

const int16ArrayToPcm16Buffer = (int16Array) => {
  const output = Buffer.alloc(int16Array.length * 2);
  for (let i = 0; i < int16Array.length; i += 1) {
    output.writeInt16LE(int16Array[i], i * 2);
  }
  return output;
};

const resamplePcm16 = (input, fromRate, toRate) => {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i / ratio;
    const lowerIndex = Math.floor(sourceIndex);
    const upperIndex = Math.min(lowerIndex + 1, input.length - 1);
    const weight = sourceIndex - lowerIndex;
    output[i] = Math.round(input[lowerIndex] * (1 - weight) + input[upperIndex] * weight);
  }
  return output;
};

module.exports = {
  muLawBufferToPcm16,
  pcm16ToMuLawBuffer,
  pcm16BufferToInt16Array,
  int16ArrayToPcm16Buffer,
  resamplePcm16,
};
