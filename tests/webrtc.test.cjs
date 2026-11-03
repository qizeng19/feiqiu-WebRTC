const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');

async function setup() {
  let now = 1000;
  let timerId = 0;
  const timers = new Map();
  const sent = [];
  const handlers = {};
  const messages = [];
  const socket = { id: 'z', connected: true, on: (name, fn) => { handlers[name] = fn; }, emit: (...args) => sent.push(args) };
  const appState = { socket, peerConnections: {}, dataChannels: {}, fileChannels: {}, peerNames: {}, incomingFiles: {}, outgoingTransfers: {}, roomMembers: [{ socketId: 'a' }], roomAccessMessage: '' };
  class Channel {
    constructor(label) { this.label = label; this.readyState = 'connecting'; this.sent = []; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 'closed'; this.onclose?.(); }
  }
  class Peer {
    constructor() { this.connectionState = 'new'; this.channels = []; this.candidates = []; }
    createDataChannel(label) { const channel = new Channel(label); this.channels.push(channel); return channel; }
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(sdp) { this.localDescription = sdp; }
    async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    async addIceCandidate(candidate) { this.candidates.push(candidate); }
    close() { this.connectionState = 'closed'; }
  }
  const document = { hidden: false };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ console, document, Date: Clock, RTCPeerConnection: Peer,
    RTCSessionDescription: class { constructor(data) { Object.assign(this, data); } },
    RTCIceCandidate: class { constructor(data) { Object.assign(this, data); } }, io: () => socket,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay, interval: false }); return timerId; },
    setInterval: (fn, delay) => { timers.set(++timerId, { fn, delay, interval: true }); return timerId; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id)
  });
  const noop = () => {};
  const mocks = {
    'state.js': { appState, setPeerDisplayName: noop, setSocket: noop, setBlockedDeviceIds: noop, setRoomMembers: members => { appState.roomMembers = members; }, setRoomOwnerSocketId: noop },
    'ui.js': Object.fromEntries(['appendFileBubble', 'appendSystemMessage', 'showNotification', 'updateConnectionUI', 'leaveCurrentRoomState', 'renderRoomManagementPanel', 'showToast'].map(name => [name, noop]).concat([['appendMessage', (...args) => messages.push(args)]])),
    'file-transfer.js': { handleFileCancelMessage: noop, sendControlMessage: noop, setupFileChannel: (id, channel) => { appState.fileChannels[id] = channel; }, startFileSendingLoop: noop, triggerFileCompletion: noop }
  };
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    let module;
    if (mocks[name]) {
      module = new vm.SyntheticModule(Object.keys(mocks[name]), function () {
        for (const [key, value] of Object.entries(mocks[name])) this.setExport(key, value);
      }, { context });
    } else {
      module = new vm.SourceTextModule(await fs.readFile(path.join(__dirname, '../public/app', name), 'utf8'), { context });
    }
    modules.set(name, module);
    await module.link(specifier => load(path.basename(specifier)));
    return module;
  }
  const signaling = await load('signaling.js');
  await signaling.evaluate();
  signaling.namespace.connectSignaling();
  const rtc = modules.get('webrtc.js').namespace;
  function open(id = 'a') {
    const pc = rtc.createPeerConnection(id, true);
    pc.connectionState = 'connected';
    const channel = appState.dataChannels[id];
    channel.readyState = 'open'; channel.onopen();
    return { pc, channel };
  }
  async function runTimer(delay, interval = false) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay && timer.interval === interval);
    assert.ok(entry, `missing timer ${delay}`);
    if (!interval) timers.delete(entry[0]);
    await entry[1].fn();
  }
  return { rtc, appState, sent, handlers, timers, document, open, messages, runTimer, setNow: value => { now = value; } };
}

test('500ms health check preserves an initial handshake', async () => {
  const env = await setup();
  env.handlers.connect();
  await env.rtc.startNegotiation('a');
  const pc = env.appState.peerConnections.a;
  await env.runTimer(500);
  assert.equal(env.appState.peerConnections.a, pc);
  assert.equal(pc.connectionState, 'new');
});

test('simultaneous reconnect invitation does not replace an in-flight offer', async () => {
  const env = await setup();
  env.open();
  env.rtc.handlePeerDisconnection('a');
  const pc = env.appState.peerConnections.a;
  await env.handlers.signal({ senderId: 'a', signal: { type: '__reconnect_request__' } });
  assert.equal(env.appState.peerConnections.a, pc);
  assert.notEqual(pc.connectionState, 'closed');
});

test('background timer suspension does not tear down an open channel', async () => {
  const env = await setup();
  const { pc, channel } = env.open();
  env.setNow(60000);
  await env.runTimer(3000, true);
  assert.equal(env.appState.peerConnections.a, pc);
  assert.equal(channel.sent.at(-1).type, '__ping__');
  env.rtc.checkAllPeersHealth();
  channel.onmessage({ data: JSON.stringify({ type: 'text', text: '局域网消息' }) });
  assert.equal(env.messages[0][0], '局域网消息');
});

test('a genuinely unresponsive foreground peer is reconnected', async () => {
  const env = await setup();
  const { pc } = env.open();
  for (const time of [4000, 7000, 10000, 13000, 16000]) {
    env.setNow(time);
    await env.runTimer(3000, true);
  }
  assert.equal(pc.connectionState, 'closed');
  assert.notEqual(env.appState.peerConnections.a, pc);
});

test('leaving cancels handshake recovery so a departed peer is not resurrected', async () => {
  const env = await setup();
  await env.rtc.startNegotiation('a');
  env.rtc.cleanupPeer('a');
  assert.equal(env.timers.size, 0);
  assert.equal(env.appState.peerConnections.a, undefined);
});

test('a new remote offer replaces the old connected peer and answers immediately', async () => {
  const env = await setup();
  const { pc } = env.open();
  await env.handlers.signal({ senderId: 'a', signal: { sdp: { type: 'offer', sdp: 'new' } } });
  assert.equal(pc.connectionState, 'closed');
  assert.notEqual(env.appState.peerConnections.a, pc);
  assert.equal(env.sent.at(-1)[1].signal.sdp.type, 'answer');
});

test('ICE candidates queued before SDP are drained into that connection', async () => {
  const env = await setup();
  await env.handlers.signal({ senderId: 'a', signal: { candidate: { candidate: 'host' } } });
  await env.handlers.signal({ senderId: 'a', signal: { sdp: { type: 'offer', sdp: 'new' } } });
  assert.equal(env.appState.peerConnections.a.candidates[0].candidate, 'host');
});

test('lower ID invites once and health checks wait for its answer', async () => {
  const env = await setup();
  env.appState.socket.id = '0';
  env.rtc.handlePeerDisconnection('a');
  const pc = env.appState.peerConnections.a;
  env.rtc.checkAllPeersHealth();
  assert.equal(env.appState.peerConnections.a, pc);
  assert.equal(env.sent.filter(([, payload]) => payload.signal?.type === '__reconnect_request__').length, 1);
});

test('a stalled handshake eventually retries without a fixed one-second delay', async () => {
  const env = await setup();
  await env.rtc.startNegotiation('a');
  const pc = env.appState.peerConnections.a;
  await env.runTimer(20000);
  assert.equal(pc.connectionState, 'closed');
  assert.notEqual(env.appState.peerConnections.a, pc);
  assert.equal([...env.timers.values()].some(timer => timer.delay === 1000), false);
});

test('an offer finishing after cleanup cannot send stale signaling', async () => {
  const env = await setup();
  const pending = env.rtc.startNegotiation('a');
  env.rtc.cleanupPeer('a');
  await pending;
  assert.equal(env.sent.length, 0);
});
