const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockCalls = Object.assign(
  jest.fn(() => ({ update: mockUpdate })),
  {
    create: (...args) => mockCreate(...args),
  }
);

jest.mock('../src/twilioClient', () => ({
  twilioClient: { calls: mockCalls },
}));

const { startOutboundPair, streamTwiml } = require('../src/outboundCall');
const { registry } = require('../src/pairRegistry');

describe('outboundCall', () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({ sid: 'CA_CLIENT' });
    mockUpdate.mockReset().mockResolvedValue({});
    mockCalls.mockClear();
    ['pair-1', 'PAIR1'].forEach((id) => registry.removePair(id));
    ['CA_AGENT', 'CA_CLIENT'].forEach((sid) => registry.remove(sid));
  });

  it('streamTwiml returns Connect/Stream with pairId and role parameters', () => {
    const twiml = streamTwiml('test-pair', 'agent');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('<Stream');
    expect(twiml).toContain('pairId');
    expect(twiml).toContain('test-pair');
    expect(twiml).toContain('agent');
  });

  it('startOutboundPair returns agent Connect/Stream TwiML and dials the client', async () => {
    const twiml = await startOutboundPair({
      from: '+19189194048',
      to: '+9779702005057',
      agentCallSid: 'CA_AGENT',
    });

    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('<Stream');
    expect(twiml).not.toContain('<Conference');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '+19189194048',
        to: '+9779702005057',
        twiml: expect.stringContaining('<Connect>'),
      })
    );
    expect(registry.get('CA_AGENT')).toMatchObject({ role: 'agent' });
    expect(registry.get('CA_CLIENT')).toMatchObject({ role: 'client' });
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
