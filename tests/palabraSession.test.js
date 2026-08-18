jest.mock('ws', () => {
  const MockWebSocket = jest.fn().mockImplementation(() => {
    const handlers = {};
    const sock = {
      readyState: 0,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      send: jest.fn(),
      close: jest.fn(() => {
        sock.readyState = 3;
        if (handlers.close) handlers.close();
      }),
      emit(event, ...args) {
        if (handlers[event]) handlers[event](...args);
      },
    };
    MockWebSocket.instances.push(sock);
    return sock;
  });
  MockWebSocket.OPEN = 1;
  MockWebSocket.instances = [];
  return MockWebSocket;
});

const WebSocket = require('ws');
const { buildSetTaskMessage, createSession } = require('../src/palabraSession');

describe('palabraSession', () => {
  const originalApiKey = process.env.PALABRA_API_KEY;

  beforeEach(() => {
    process.env.PALABRA_API_KEY = 'test-key';
    WebSocket.instances = [];
    WebSocket.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    process.env.PALABRA_API_KEY = originalApiKey;
    jest.useRealTimers();
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

  it('reconnects after unexpected WebSocket close', () => {
    const session = createSession({ sourceLanguage: 'en', targetLanguage: 'hi' });
    expect(WebSocket).toHaveBeenCalledTimes(1);

    const first = WebSocket.instances[0];
    first.readyState = 1;
    first.emit('open');
    first.emit('message', JSON.stringify({ message_type: 'current_task', data: {} }));

    session.forceClose();
    expect(WebSocket).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(500);
    expect(WebSocket).toHaveBeenCalledTimes(2);

    const second = WebSocket.instances[1];
    second.readyState = 1;
    second.emit('open');
    second.emit('message', JSON.stringify({ message_type: 'current_task', data: {} }));

    session.end();
  });

  it('does not reconnect after end()', () => {
    const session = createSession({ sourceLanguage: 'en', targetLanguage: 'hi' });
    expect(WebSocket).toHaveBeenCalledTimes(1);

    session.end();
    jest.advanceTimersByTime(10000);
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });

  it('fails open after max reconnect attempts', () => {
    const onError = jest.fn();
    createSession({ sourceLanguage: 'en', targetLanguage: 'hi', onError });

    const closeAndWait = (delayMs) => {
      const sock = WebSocket.instances[WebSocket.instances.length - 1];
      sock.close();
      jest.advanceTimersByTime(delayMs);
    };

    closeAndWait(500);
    closeAndWait(1500);
    closeAndWait(4000);
    expect(onError).not.toHaveBeenCalled();

    WebSocket.instances[WebSocket.instances.length - 1].close();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/retries exhausted/) })
    );
  });
});
