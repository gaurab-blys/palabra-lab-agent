const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockCalls = Object.assign(
  jest.fn(() => ({ update: mockUpdate })),
  {
    create: (...args) => mockCreate(...args),
  }
);

jest.mock('../src/voice/twilioClient', () => ({
  twilioClient: { calls: mockCalls },
}));

const { startOutboundPair, streamTwiml } = require('../src/voice/outboundCall');
const { registry } = require('../src/stream/sessionStore');

describe('outboundCall', () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({ sid: 'CA_CLIENT' });
    mockUpdate.mockReset().mockResolvedValue({});
    mockCalls.mockClear();
    ['pair-1', 'PAIR1'].forEach((id) => registry.removePair(id));
    ['CA_AGENT', 'CA_CLIENT'].forEach((sid) => registry.remove(sid));
  });

  it('streamTwiml returns Connect/Stream with pairId, peerCallSid, and browser playback for agent', () => {
    const twiml = streamTwiml('test-pair', 'agent', 'CA_PEER');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('<Stream');
    expect(twiml).toContain('pairId');
    expect(twiml).toContain('test-pair');
    expect(twiml).toContain('peerCallSid');
    expect(twiml).toContain('CA_PEER');
    expect(twiml).toContain('playback');
    expect(twiml).toContain('browser');
  });

  it('startOutboundPair links callSids as peers and returns agent TwiML', async () => {
    const twiml = await startOutboundPair({
      from: '+19189194048',
      to: '+9779702005057',
      agentCallSid: 'CA_AGENT',
    });

    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('playback');
    expect(twiml).toContain('browser');
    expect(twiml).toContain('CA_CLIENT');
    expect(twiml).not.toContain('<Conference');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '+19189194048',
        to: '+9779702005057',
        twiml: expect.stringContaining('twilio'),
      })
    );
    expect(registry.get('CA_AGENT')).toMatchObject({
      callSid: 'CA_AGENT',
      peerCallSid: 'CA_CLIENT',
      playback: 'browser',
    });
    expect(registry.get('CA_CLIENT')).toMatchObject({
      callSid: 'CA_CLIENT',
      peerCallSid: 'CA_AGENT',
      playback: 'twilio',
    });
  });

  it('startOutboundPair returns null when client dial throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Twilio outage'));
    const twiml = await startOutboundPair({
      from: '+1',
      to: '+2',
      agentCallSid: 'CA_AGENT',
    });
    expect(twiml).toBeNull();
  });

  it('startOutboundPair returns null when required fields are missing', async () => {
    expect(await startOutboundPair({ from: '+1', agentCallSid: 'CA_AGENT' })).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
