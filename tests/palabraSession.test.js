jest.mock('ws', () => {
  const MockWebSocket = jest.fn().mockImplementation(() => ({
    readyState: 0,
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
  }));
  MockWebSocket.OPEN = 1;
  return MockWebSocket;
});

const { buildSetTaskMessage, createSession } = require('../src/palabraSession');

describe('palabraSession', () => {
  const originalApiKey = process.env.PALABRA_API_KEY;

  afterEach(() => {
    process.env.PALABRA_API_KEY = originalApiKey;
  });

  it('buildSetTaskMessage includes language pair and audio format', () => {
    const msg = buildSetTaskMessage({ sourceLanguage: 'en', targetLanguage: 'hi' });

    expect(msg.message_type).toBe('set_task');
    expect(msg.data.pipeline.transcription.source_language).toBe('en');
    expect(msg.data.pipeline.translations[0].target_language).toBe('hi');
    expect(msg.data.input_stream.source.sample_rate).toBe(24000);
    expect(msg.data.input_stream.source.format).toBe('pcm_s16le');
  });

  it('returns noop session when PALABRA_API_KEY is empty', () => {
    process.env.PALABRA_API_KEY = '';
    const onError = jest.fn();

    jest.isolateModules(() => {
      jest.doMock('../src/config', () => {
        const actual = jest.requireActual('../src/config');
        return {
          ...actual,
          PALABRA_WS: { ...actual.PALABRA_WS, apiKey: '' },
        };
      });

      const { createSession: createSessionWithoutKey } = require('../src/palabraSession');
      const session = createSessionWithoutKey({
        sourceLanguage: 'en',
        targetLanguage: 'hi',
        onError,
      });

      expect(typeof session.sendAudio).toBe('function');
      expect(() => session.sendAudio('abc')).not.toThrow();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'PALABRA_API_KEY is empty' })
      );
    });
  });
});
