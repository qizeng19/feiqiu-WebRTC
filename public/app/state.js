function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem('feiqiu_device_id');
  if (deviceId) {
    return deviceId;
  }

  const chars = 'ABCDEF0123456789';
  deviceId = '';
  for (let i = 0; i < 4; i++) {
    deviceId += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  localStorage.setItem('feiqiu_device_id', deviceId);
  return deviceId;
}

export const appState = {
  socket: null,
  roomId: null,
  localIp: 'localhost',
  port: 3000,
  peerConnections: {},
  dataChannels: {},
  fileChannels: {},
  outgoingTransfers: {},
  incomingFiles: {},
  peerNames: {},
  roomMembers: [],
  blockedDeviceIds: [],
  roomOwnerSocketId: null,
  roomAccessMessage: '',
  myDeviceId: getOrCreateDeviceId()
};

export function setSocket(socket) {
  appState.socket = socket;
}

export function setRoomId(roomId) {
  appState.roomId = roomId;
}

export function setLocalIp(localIp) {
  appState.localIp = localIp;
}

export function setPort(port) {
  appState.port = port;
}

export function setRoomMembers(roomMembers) {
  appState.roomMembers = roomMembers;
}

export function setBlockedDeviceIds(blockedDeviceIds) {
  appState.blockedDeviceIds = blockedDeviceIds;
}

export function setRoomOwnerSocketId(roomOwnerSocketId) {
  appState.roomOwnerSocketId = roomOwnerSocketId;
}

export function setRoomAccessMessage(roomAccessMessage) {
  appState.roomAccessMessage = roomAccessMessage;
}

export function setPeerDisplayName(peerId, deviceId) {
  if (!peerId) {
    return;
  }
  appState.peerNames[peerId] = `设备 ${deviceId || peerId.substring(0, 4)}`;
}

export function isRoomOwner() {
  return Boolean(appState.socket && appState.socket.id && appState.roomOwnerSocketId === appState.socket.id);
}
