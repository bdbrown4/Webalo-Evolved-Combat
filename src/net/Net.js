// Net.js — peer-to-peer transport for 2-player co-op. There is no game server:
// the two browsers talk directly over a WebRTC DataChannel. Two ways to open
// that channel, behind one shared interface:
//
//   • Trystero (primary): free, serverless signaling over public Nostr relays
//     (Trystero's default strategy). The host shares a short room code; the
//     guest enters it; the library brokers the WebRTC handshake. Nothing of ours
//     runs on a server, so it still ships from static GitHub Pages.
//   • Manual copy-paste (fallback): a raw RTCPeerConnection whose SDP offer/
//     answer is pasted between players out-of-band (Discord/text) — for when
//     trackers are blocked or a peer sits behind an awkward NAT.
//
// Both expose the same low-level Transport surface (onOpen/onMessage/onClose/
// sendRaw); NetSession layers typed message routing on top. The game is
// host-authoritative, so this layer only moves bytes and reports peer presence.

import { joinRoom } from 'trystero';

export const NET_APP_ID = 'webalo_evolved_combat_v1';

// Public STUN for NAT traversal (free). Symmetric-NAT pairs that STUN can't
// punch would need a TURN relay; we surface a clear failure instead.
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ---- Trystero backend ------------------------------------------------------
// One action channel ('m') carries all our typed messages. The 0.25+ API: a room
// exposes assignable onPeerJoin/onPeerLeave, and makeAction() returns a
// { send, onMessage } object (no longer a [send, get] tuple).
class TrysteroTransport {
  constructor(code) {
    this._room = joinRoom({ appId: NET_APP_ID, rtcConfig: ICE }, code);
    this._action = this._room.makeAction('m');
    this._peers = new Set();
    this._openCbs = []; this._closeCbs = []; this._msgCb = null;
    this._action.onMessage = (data) => { this._msgCb && this._msgCb(data); };
    this._room.onPeerJoin = (id) => {
      const first = this._peers.size === 0;
      this._peers.add(id);
      if (first) this._openCbs.forEach((f) => f());
    };
    this._room.onPeerLeave = (id) => {
      this._peers.delete(id);
      if (this._peers.size === 0) this._closeCbs.forEach((f) => f());
    };
  }
  onOpen(fn) { this._openCbs.push(fn); }
  onMessage(fn) { this._msgCb = fn; }
  onClose(fn) { this._closeCbs.push(fn); }
  sendRaw(obj) { try { this._action.send(obj); } catch (e) { /* peer gone mid-send */ } }
  close() { try { this._room.leave(); } catch (e) { /* already gone */ } }
}

// ---- Manual copy-paste backend --------------------------------------------
// Non-trickle ICE: gather candidates, then hand the whole SDP blob over for the
// human to paste. Messages ride a single JSON DataChannel.
class ManualTransport {
  constructor(role) {
    this.role = role; // 'host' | 'guest'
    this._pc = new RTCPeerConnection(ICE);
    this._dc = null;
    this._openCbs = []; this._closeCbs = []; this._msgCb = null;
    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      if (s === 'disconnected' || s === 'failed' || s === 'closed') this._closeCbs.forEach((f) => f());
    };
    if (role === 'host') {
      this._bindDc(this._pc.createDataChannel('webalo', { ordered: true }));
    } else {
      this._pc.ondatachannel = (e) => this._bindDc(e.channel);
    }
  }
  _bindDc(dc) {
    this._dc = dc;
    dc.onopen = () => this._openCbs.forEach((f) => f());
    dc.onclose = () => this._closeCbs.forEach((f) => f());
    dc.onmessage = (e) => { if (!this._msgCb) return; try { this._msgCb(JSON.parse(e.data)); } catch (_) { /* drop garbage */ } };
  }
  // Host step 1: produce an offer blob to send the guest.
  async createOffer() {
    await this._pc.setLocalDescription(await this._pc.createOffer());
    await this._gather();
    return encodeSig(this._pc.localDescription);
  }
  // Guest: consume the host's offer, produce an answer blob to send back.
  async acceptOffer(blob) {
    await this._pc.setRemoteDescription(decodeSig(blob));
    await this._pc.setLocalDescription(await this._pc.createAnswer());
    await this._gather();
    return encodeSig(this._pc.localDescription);
  }
  // Host step 2: consume the guest's answer — the channel opens shortly after.
  async acceptAnswer(blob) { await this._pc.setRemoteDescription(decodeSig(blob)); }
  _gather() {
    return new Promise((res) => {
      if (this._pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 2500); // ship partial candidates rather than hang forever
      this._pc.addEventListener('icegatheringstatechange', () => {
        if (this._pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
      });
    });
  }
  onOpen(fn) { this._openCbs.push(fn); }
  onMessage(fn) { this._msgCb = fn; }
  onClose(fn) { this._closeCbs.push(fn); }
  sendRaw(obj) { if (this._dc && this._dc.readyState === 'open') this._dc.send(JSON.stringify(obj)); }
  close() { try { this._dc && this._dc.close(); } catch (_) {} try { this._pc.close(); } catch (_) {} }
}

// Compact, paste-safe encoding of an SDP description. base64 of a tiny JSON,
// tagged so we can reject pasted junk early.
function encodeSig(desc) {
  const json = JSON.stringify({ t: desc.type, s: desc.sdp });
  return 'WBL1:' + btoa(unescape(encodeURIComponent(json)));
}
function decodeSig(blob) {
  const b = String(blob).trim().replace(/^WBL1:/, '');
  const json = decodeURIComponent(escape(atob(b)));
  const o = JSON.parse(json);
  return { type: o.t, sdp: o.s };
}

// ---- Session: typed messages over a transport ------------------------------
export class NetSession {
  constructor(transport, role) {
    this.role = role;
    this.isHost = role === 'host';
    this.connected = false;
    this._t = transport;
    this._handlers = {};
    this._stateCbs = [];
    transport.onOpen(() => { this.connected = true; this._emit('connected'); });
    transport.onClose(() => { const was = this.connected; this.connected = false; if (was) this._emit('closed'); });
    transport.onMessage((obj) => { const h = obj && this._handlers[obj.t]; if (h) h(obj.d); });
  }
  on(type, fn) { this._handlers[type] = fn; return this; }
  send(type, payload) { this._t.sendRaw({ t: type, d: payload }); }
  onState(cb) { this._stateCbs.push(cb); return this; }
  _emit(s) { this._stateCbs.forEach((f) => f(s)); }
  close() { try { this._t.close(); } catch (_) {} }
}

// ---- Factories -------------------------------------------------------------
export function hostTrystero(code) { return new NetSession(new TrysteroTransport(code), 'host'); }
export function joinTrystero(code) { return new NetSession(new TrysteroTransport(code), 'guest'); }
// Manual: the caller drives the copy-paste exchange via session.manual.*
export function createManual(role) {
  const session = new NetSession(new ManualTransport(role), role);
  session.manual = session._t;
  return session;
}

// A short, friendly room code (no ambiguous chars), e.g. "WOBBLE-7K2Q".
export function makeRoomCode(rand = Math.random) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(rand() * A.length)];
  return 'WBL-' + s;
}

// ---- Loopback self-test ----------------------------------------------------
// Wires two manual transports together IN ONE PAGE (no trackers, no second tab)
// and round-trips a typed message — verifies the WebRTC data path, the SDP
// encode/decode, and the typed routing. Returns the echoed payload.
export async function loopbackTest() {
  const host = createManual('host');
  const guest = createManual('guest');
  const echoed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('loopback timeout')), 6000);
    guest.on('ping', (d) => guest.send('pong', { echo: d.n + 1 }));
    host.on('pong', (d) => { clearTimeout(timer); resolve(d); });
  });
  const offer = await host.manual.createOffer();
  const answer = await guest.manual.acceptOffer(offer);
  await host.manual.acceptAnswer(answer);
  await new Promise((res) => {
    if (host.connected) return res();
    host._t.onOpen(res);
  });
  host.send('ping', { n: 41 });
  const result = await echoed;
  host.close(); guest.close();
  return result; // expect { echo: 42 }
}
