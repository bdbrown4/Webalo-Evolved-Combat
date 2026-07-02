// NetSession routing over a fake transport — the typed-message layer the whole
// multiplayer stack rides on, exercised without any WebRTC.
import { describe, it, expect, vi } from 'vitest';
import { NetSession, makeRoomCode } from '../src/net/Net.js';

// A loopback transport pair: everything sent on A arrives on B (with A's peer id)
// and vice versa. Mirrors the multi-peer surface TrysteroTransport exposes.
function fakePair() {
  const mk = () => ({
    _msg: null, _open: [], _close: [], _peer: [], _gone: [], _peers: ['peer-remote'],
    onOpen(f) { this._open.push(f); }, onClose(f) { this._close.push(f); },
    onMessage(f) { this._msg = f; }, onPeer(f) { this._peer.push(f); }, onPeerGone(f) { this._gone.push(f); },
    peers() { return this._peers; },
    sendRaw(obj, peerId) { this._out && this._out(obj, peerId); },
    close() { this._close.forEach((f) => f()); },
  });
  const a = mk(), b = mk();
  a._out = (obj, peerId) => { a._lastTarget = peerId; b._msg && b._msg(obj, 'peer-a'); };
  b._out = (obj, peerId) => { b._lastTarget = peerId; a._msg && a._msg(obj, 'peer-b'); };
  return [a, b];
}

describe('NetSession', () => {
  it('routes typed messages with the sender peer id', () => {
    const [ta, tb] = fakePair();
    const host = new NetSession(ta, 'host');
    const guest = new NetSession(tb, 'guest');
    const got = vi.fn();
    guest.on('hello', got);
    host.send('hello', { n: 1 });
    expect(got).toHaveBeenCalledWith({ n: 1 }, 'peer-a');
  });
  it('ignores unknown message types and malformed frames', () => {
    const [ta, tb] = fakePair();
    new NetSession(ta, 'host');
    const guest = new NetSession(tb, 'guest');
    const got = vi.fn();
    guest.on('only-this', got);
    ta._out({ t: 'other', d: 1 });
    ta._out(null);
    ta._out({ noType: true });
    expect(got).not.toHaveBeenCalled();
  });
  it('unicast passes the target peer id to the transport', () => {
    const [ta] = fakePair();
    const host = new NetSession(ta, 'host');
    host.send('start', { seed: 1 }, 'peer-x');
    expect(ta._lastTarget).toBe('peer-x');
    host.send('snap', {});
    expect(ta._lastTarget).toBeUndefined();  // broadcast
  });
  it('emits connected/closed exactly once around transport state', () => {
    const [ta] = fakePair();
    const host = new NetSession(ta, 'host');
    const states = [];
    host.onState((s) => states.push(s));
    ta._open.forEach((f) => f());
    ta._close.forEach((f) => f());
    ta._close.forEach((f) => f());   // double-close must not re-emit
    expect(states).toEqual(['connected', 'closed']);
  });
  it('surfaces per-peer join/leave and the roster', () => {
    const [ta] = fakePair();
    const host = new NetSession(ta, 'host');
    const joined = [], left = [];
    host.onPeer((id) => joined.push(id));
    host.onPeerGone((id) => left.push(id));
    ta._peer.forEach((f) => f('p1'));
    ta._gone.forEach((f) => f('p1'));
    expect(joined).toEqual(['p1']);
    expect(left).toEqual(['p1']);
    expect(host.peers()).toEqual(['peer-remote']);
  });
});

describe('makeRoomCode', () => {
  it('is WBL- plus 5 unambiguous chars', () => {
    for (let i = 0; i < 50; i++) {
      const c = makeRoomCode();
      expect(c).toMatch(/^WBL-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });
  it('is deterministic under an injected RNG', () => {
    let s = 42;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    let s2 = 42;
    const rng2 = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; };
    expect(makeRoomCode(rng)).toBe(makeRoomCode(rng2));
  });
});
