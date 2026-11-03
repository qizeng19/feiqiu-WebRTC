import {
  appState,
  setBlockedDeviceIds,
  setPeerDisplayName,
  setRoomMembers,
  setRoomOwnerSocketId,
  setSocket
} from './state.js';
import {
  checkAllPeersHealth,
  cleanupAllPeers,
  cleanupPeer,
  createPeerConnection,
  startNegotiation
} from './webrtc.js';
import { appendSystemMessage, leaveCurrentRoomState, renderRoomManagementPanel, showToast, updateConnectionUI } from './ui.js';

// 缓冲在 setRemoteDescription 之前到达的 ICE Candidates
const pendingCandidates = new WeakMap();

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

    // 信令恢复后，检测各个 peer 的健康状态并按需自愈
    setTimeout(() => {
      checkAllPeersHealth();
    }, 500);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from signaling server (keeping P2P channels alive)');
    // 注意：信令连接短暂断开时，绝不主动销毁正在运行的局域网 P2P 直连通道
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
    const peerIds = new Set(peers.map(peer => peer.socketId));
    Object.keys(appState.peerConnections).forEach(peerId => {
      if (!peerIds.has(peerId)) cleanupPeer(peerId);
    });
    peers.forEach(peer => {
      setPeerDisplayName(peer.socketId, peer.deviceId);
      const currentChannel = appState.dataChannels[peer.socketId];
      // 仅在当前未建立健康连接时发起握手协商
      if (!currentChannel || currentChannel.readyState !== 'open') {
        startNegotiation(peer.socketId);
      }
    });
  });

  socket.on('peer-joined', ({ peerId, deviceId }) => {
    console.log(`Peer joined: ${peerId} (${deviceId})`);
    setPeerDisplayName(peerId, deviceId);
    if (!appState.peerConnections[peerId]) {
      createPeerConnection(peerId, false);
    }
  });

  socket.on('signal', async ({ senderId, signal }) => {
    // 收到对端的重连邀请信令
    if (signal && signal.type === '__reconnect_request__') {
      console.log(`[Signal] 收到来自 ${senderId} 的重连请求，作为 Initiator 发起重新握手`);
      startNegotiation(senderId);
      return;
    }

    let peerConnection = appState.peerConnections[senderId];
    if (!peerConnection) {
      peerConnection = createPeerConnection(senderId, false);
    }

    try {
      if (signal.sdp) {
        // 对端重建连接后，新 offer 需要新的本地连接；不要复用旧的已连接通道。
        if (signal.sdp.type === 'offer' &&
            ['connected', 'disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
          peerConnection = createPeerConnection(senderId, false);
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (appState.peerConnections[senderId] !== peerConnection) return;

        // remoteDescription 就绪后，将所有排队等待的 Candidate 批量追加
        if (pendingCandidates.get(peerConnection) && pendingCandidates.get(peerConnection).length > 0) {
          for (const cand of pendingCandidates.get(peerConnection)) {
            try {
              await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
            } catch (candErr) {
              console.warn('[Signal] 追加排队候选失败:', candErr);
            }
          }
          pendingCandidates.set(peerConnection, []);
        }

        if (signal.sdp.type === 'offer') {
          const answer = await peerConnection.createAnswer();
          if (appState.peerConnections[senderId] !== peerConnection) return;
          await peerConnection.setLocalDescription(answer);
          if (appState.peerConnections[senderId] !== peerConnection) return;
          socket.emit('signal', {
            targetId: senderId,
            signal: { sdp: peerConnection.localDescription }
          });
        }
      } else if (signal.candidate) {
        // 如果远端 SDP 尚未完成设置，先存入队列防止抛错丢弃
        if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
          if (!pendingCandidates.get(peerConnection)) {
            pendingCandidates.set(peerConnection, []);
          }
          pendingCandidates.get(peerConnection).push(signal.candidate);
        } else {
          await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
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
