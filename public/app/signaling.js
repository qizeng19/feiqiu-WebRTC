import {
  appState,
  setBlockedDeviceIds,
  setPeerDisplayName,
  setRoomMembers,
  setRoomOwnerSocketId,
  setSocket
} from './state.js';
import { cleanupAllPeers, cleanupPeer, createPeerConnection, startNegotiation } from './webrtc.js';
import { appendSystemMessage, leaveCurrentRoomState, renderRoomManagementPanel, showToast, updateConnectionUI } from './ui.js';

export function connectSignaling() {
  const socket = io();
  setSocket(socket);

  socket.on('connect', () => {
    console.log('Connected to signaling server');
    if (!appState.roomAccessMessage) {
      socket.emit('join', { roomId: appState.roomId, deviceId: appState.myDeviceId });
    }
    renderRoomManagementPanel();
    updateConnectionUI();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from signaling server');
    cleanupAllPeers();
    renderRoomManagementPanel();
    updateConnectionUI();
  });

  socket.on('join-denied', ({ reason }) => {
    if (reason === 'blocked') {
      leaveCurrentRoomState('你已被房主屏蔽', cleanupAllPeers);
      appendSystemMessage('你已被房主屏蔽，当前无法加入该房间');
      showToast('你已被房主屏蔽', 'error');
      return;
    }

    leaveCurrentRoomState('无法加入当前房间', cleanupAllPeers);
    appendSystemMessage('无法加入当前房间');
  });

  socket.on('peers', ({ peers }) => {
    console.log('Received list of existing peers:', peers);
    peers.forEach(peer => {
      setPeerDisplayName(peer.socketId, peer.deviceId);
      startNegotiation(peer.socketId);
    });
  });

  socket.on('peer-joined', ({ peerId, deviceId }) => {
    console.log(`Peer joined: ${peerId} (${deviceId})`);
    setPeerDisplayName(peerId, deviceId);
    createPeerConnection(peerId, false);
  });

  socket.on('signal', async ({ senderId, signal }) => {
    let peerConnection = appState.peerConnections[senderId];
    if (!peerConnection) {
      peerConnection = createPeerConnection(senderId, false);
    }

    try {
      if (signal.sdp) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          socket.emit('signal', {
            targetId: senderId,
            signal: { sdp: peerConnection.localDescription }
          });
        }
      } else if (signal.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (error) {
      console.error('Error handling signaling message:', error);
    }
  });

  socket.on('peer-left', ({ peerId }) => {
    console.log(`Peer left: ${peerId}`);
    cleanupPeer(peerId);
  });

  socket.on('room-state', ({ ownerSocketId, members, blockedDeviceIds }) => {
    const previousOwnerSocketId = appState.roomOwnerSocketId;
    setRoomOwnerSocketId(ownerSocketId);
    setRoomMembers(members || []);
    setBlockedDeviceIds(blockedDeviceIds || []);
    appState.roomMembers.forEach(member => {
      setPeerDisplayName(member.socketId, member.deviceId);
    });
    renderRoomManagementPanel();

    if (previousOwnerSocketId && previousOwnerSocketId !== ownerSocketId) {
      const nextOwner = appState.roomMembers.find(member => member.socketId === ownerSocketId);
      if (socket && ownerSocketId === socket.id) {
        appendSystemMessage('你现在是当前房间的房主');
      } else if (nextOwner) {
        appendSystemMessage(`当前房主已切换为设备 ${nextOwner.deviceId}`);
      }
    }
  });

  socket.on('removed-from-room', ({ reason }) => {
    if (reason === 'blocked') {
      leaveCurrentRoomState('你已被房主屏蔽', cleanupAllPeers);
      appendSystemMessage('你已被房主屏蔽，并移出了当前房间');
      showToast('你已被房主屏蔽', 'error');
      return;
    }

    leaveCurrentRoomState('你已被房主移出', cleanupAllPeers);
    appendSystemMessage('你已被房主移出当前房间，可刷新后重新加入');
    showToast('你已被房主移出当前房间', 'info');
  });

  socket.on('room-action-error', ({ message }) => {
    showToast(message || '房间操作失败', 'error');
  });
}
