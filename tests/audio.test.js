const {
  muLawBufferToPcm16,
  pcm16ToMuLawBuffer,
  pcm16BufferToInt16Array,
  int16ArrayToPcm16Buffer,
  resamplePcm16,
} = require('../src/audio');

describe('audio', () => {
  it('round-trips mu-law <-> PCM16 within G.711 quantization tolerance', () => {
    const originalSamples = new Int16Array([0, 1000, -1000, 16000, -16000, 32000, -32000]);
    const muLaw = pcm16ToMuLawBuffer(originalSamples);
    expect(muLaw).toHaveLength(originalSamples.length);

    const decoded = muLawBufferToPcm16(muLaw);
    decoded.forEach((sample, i) => {
      const tolerance = Math.max(200, Math.abs(originalSamples[i]) * 0.05);
      expect(Math.abs(sample - originalSamples[i])).toBeLessThanOrEqual(tolerance);
    });
  });

  it('round-trips a little-endian PCM16 buffer through the Int16Array helpers', () => {
    const original = new Int16Array([0, 32767, -32768, 12345, -12345]);
    const buffer = int16ArrayToPcm16Buffer(original);
    const roundTripped = pcm16BufferToInt16Array(buffer);

    expect(Array.from(roundTripped)).toEqual(Array.from(original));
  });

  it('resamples 8kHz to 24kHz tripling the sample count', () => {
    const input = new Int16Array(80).fill(100);
    const output = resamplePcm16(input, 8000, 24000);
    expect(output.length).toBe(240);
  });

  it('resamples 24kHz to 8kHz reducing the sample count to a third', () => {
    const input = new Int16Array(240).fill(1000);
    const output = resamplePcm16(input, 24000, 8000);
    expect(output.length).toBe(80);
  });

  it('is a no-op when source and target sample rates match', () => {
    const input = new Int16Array([1, 2, 3]);
    expect(resamplePcm16(input, 8000, 8000)).toBe(input);
  });
});
