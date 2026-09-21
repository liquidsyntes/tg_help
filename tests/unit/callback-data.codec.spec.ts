import {
  CallbackCodec,
  PostCallbackAction,
} from '../../src/modules/telegram/utils/callback-data.codec';

describe('CallbackCodec', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';

  it('should encode all PostCallbackAction enum values strictly within 64 bytes', () => {
    const actions = Object.values(PostCallbackAction);
    expect(actions.length).toBeGreaterThan(10);

    for (const action of actions) {
      const encoded = CallbackCodec.encode(action, uuid, 9999);
      const byteLength = Buffer.byteLength(encoded, 'utf8');
      expect(byteLength).toBeLessThanOrEqual(64);
      expect(byteLength).toBeLessThanOrEqual(52); // Headroom guaranteed
    }
  });

  it('should correctly encode and decode round-trip', () => {
    const action = PostCallbackAction.APPROVE;
    const version = 3;

    const encoded = CallbackCodec.encode(action, uuid, version);
    expect(encoded).toBe(`r:app:${uuid}:3`);

    const decoded = CallbackCodec.decode(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.action).toBe(PostCallbackAction.APPROVE);
    expect(decoded?.postId).toBe(uuid);
    expect(decoded?.expectedVersion).toBe(3);
  });

  it('should encode and decode view post without version', () => {
    const encoded = CallbackCodec.encodeView(uuid);
    expect(encoded).toBe(`p:view:${uuid}`);
  });

  it('should return null for malformed callback strings', () => {
    expect(CallbackCodec.decode('')).toBeNull();
    expect(CallbackCodec.decode('invalid')).toBeNull();
    expect(CallbackCodec.decode('r:app')).toBeNull();
    expect(CallbackCodec.decode(`unknown_action:${uuid}:1`)).toBeNull();
    expect(CallbackCodec.decode(`r:app:${uuid}:not_a_number`)).toBeNull();
    expect(CallbackCodec.decode(`r:app:${uuid}:-1`)).toBeNull();
  });

  it('should throw an error if encoded data exceeds 64 bytes', () => {
    const veryLongId = 'a'.repeat(60);
    expect(() =>
      CallbackCodec.encode(PostCallbackAction.APPROVE, veryLongId, 1),
    ).toThrow(/Callback data exceeds 64-byte limit/);
  });
});
