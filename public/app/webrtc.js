import { CHUNK_SIZE, DISCONNECT_GRACE_PERIOD, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, rtcConfig } from './config.js';
import { appState, setPeerDisplayName } from './state.js';
import {
  appendFileBubble,
  appendMessage,
  appendSystemMessage,
  showNotification,
  updateConnectionUI
} from './ui.js';
import {
  handleFileCancelMessage,
  sendControlMessage,
  setupFileChannel,
  startFileSendingLoop,
  triggerFileCompletion
} from './file-transfer.js';

// 心跳与重连管理状态
const heartbeatIntervals = {};
const peerHeartbeats = {};
const disconnectTimers = {};
const connectionTimers = {};
const establishedPeers = new Set();

function startHeartbeat(peerId) {
  stopHeartbeat(peerId);
  peerHeartbeats[peerId] = Date.now();

  let lastTick = Date.now();
  heartbeatIntervals[peerId] = setInterval(() => {
    const channel = appState.dataChannels[peerId];
    if (!channel || channel.readyState !== 'open') {
      stopHeartbeat(peerId);
      return;
    }

    const now = Date.now();
    // 后台定时器会暂停。恢复后先给对端一个完整的响应窗口。
    if (document.hidden || now - lastTick > HEARTBEAT_INTERVAL * 2) {
      peerHeartbeats[peerId] = now;
    }
    lastTick = now;
    if (!document.hidden && now - peerHeartbeats[peerId] > HEARTBEAT_TIMEOUT) {
      handlePeerDisconnection(peerId);
      return;
    }
    try {
      channel.send(JSON.stringify({ type: '__ping__' }));
    } catch (error) {
      console.warn(`发送心跳给 ${peerId} 失败:`, error);
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(peerId) {
  if (heartbeatIntervals[peerId]) {
    clearInterval(heartbeatIntervals[peerId]);
    delete heartbeatIntervals[peerId];
  }
}

export function createPeerConnection(peerId, isInitiator) {
  console.log(`Creating RTCPeerConnection for ${peerId}, initiator: ${isInitiator}`);

  // 如果已有未完全关闭的连接句柄，先释放
  closePeerConnectionOnly(peerId);

  const peerConnection = new RTCPeerConnection(rtcConfig);
  appState.peerConnections[peerId] = peerConnection;
  // 给正常的 ICE / DTLS 握手留出时间，健康检查不能提前拆掉它。
  connectionTimers[peerId] = setTimeout(() => {
    delete connectionTimers[peerId];
    if (appState.peerConnections[peerId] === peerConnection &&
        appState.dataChannels[peerId]?.readyState !== 'open') {
      handlePeerDisconnection(peerId);
    }
  }, 20000);

  if (!appState.peerNames[peerId]) {
    setPeerDisplayName(peerId);
  }

  peerConnection.onicecandidate = event => {
    if (appState.peerConnections[peerId] !== peerConnection) return;
    if (event.candidate && appState.socket && appState.socket.connected) {
      appState.socket.emit('signal', {
        targetId: peerId,
        signal: { candidate: event.candidate }
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (appState.peerConnections[peerId] !== peerConnection) return;
    const state = peerConnection.connectionState;
    console.log(`Connection state for ${peerId}: ${state}`);

    if (state === 'connected') {
      // 连接就绪，清除断开容忍计时器
      if (disconnectTimers[peerId]) {
        clearTimeout(disconnectTimers[peerId]);
        delete disconnectTimers[peerId];
        console.log(`Peer ${peerId} connection self-healed successfully`);
      }
      updateConnectionUI();
    } else if (state === 'disconnected') {
      // 临时丢包或网络抖动：不立即销毁，给予容忍宽限期让 ICE 自行探测恢复
      console.log(`Peer ${peerId} is disconnected, waiting ${DISCONNECT_GRACE_PERIOD}ms for self-healing...`);
      if (!disconnectTimers[peerId]) {
        disconnectTimers[peerId] = setTimeout(() => {
          delete disconnectTimers[peerId];
          if (peerConnection.connectionState === 'disconnected') {
            console.log(`Peer ${peerId} did not recover in time, triggering auto-reconnect...`);
            handlePeerDisconnection(peerId);
          }
        }, DISCONNECT_GRACE_PERIOD);
      }
    } else if (state === 'failed') {
      // 确定连接失败，立即触发自动重连
      console.log(`Peer ${peerId} connection failed, triggering auto-reconnect...`);
      if (disconnectTimers[peerId]) {
        clearTimeout(disconnectTimers[peerId]);
        delete disconnectTimers[peerId];
      }
      handlePeerDisconnection(peerId);
    } else if (state === 'closed') {
      stopHeartbeat(peerId);
    }
  };

  if (isInitiator) {
    setupDataChannel(peerId, peerConnection.createDataChannel('text-channel', { ordered: true }));
    setupFileChannel(peerId, peerConnection.createDataChannel('file-channel', { ordered: true }));
  } else {
    peerConnection.ondatachannel = event => {
      const channel = event.channel;
      if (channel.label === 'text-channel') {
        setupDataChannel(peerId, channel);
      } else if (channel.label === 'file-channel') {
        setupFileChannel(peerId, channel);
      }
    };
  }

  return peerConnection;
}

function setupDataChannel(peerId, dataChannel) {
  appState.dataChannels[peerId] = dataChannel;

  dataChannel.onopen = () => {
    console.log(`Data Channel open with ${peerId}`);
    if (!establishedPeers.has(peerId)) {
      appendSystemMessage(`与【${appState.peerNames[peerId] || `设备 ${peerId.substring(0, 4)}`}】成功建立 P2P 加密通道`);
      establishedPeers.add(peerId);
    }
    clearTimeout(connectionTimers[peerId]);
    delete connectionTimers[peerId];
    // 启动保活心跳
    startHeartbeat(peerId);
    updateConnectionUI();
  };

  dataChannel.onclose = () => {
    console.log(`Data Channel closed with ${peerId}`);
    stopHeartbeat(peerId);
    // 通道关闭时，尝试通过信令自动重连
    handlePeerDisconnection(peerId);
  };

  dataChannel.onmessage = event => {
    try {
      const data = JSON.parse(event.data);
      peerHeartbeats[peerId] = Date.now();

      // 处理心跳 ping / pong，静默响应，不进入聊天界面
      if (data.type === '__ping__') {
        if (dataChannel.readyState === 'open') {
          try {
            dataChannel.send(JSON.stringify({ type: '__pong__' }));
          } catch (e) {}
        }
        return;
      }
      if (data.type === '__pong__') {
        peerHeartbeats[peerId] = Date.now();
        return;
      }

      if (data.type === 'text') {
        appendMessage(data.text, false, appState.peerNames[peerId]);
        if (document.hidden) {
          showNotification(appState.peerNames[peerId], data.text);
        }
        return;
      }

      if (data.type === 'file-metadata') {
        const { fileId, fileName, fileSize, fileType, totalChunks } = data;
        appState.incomingFiles[peerId] = {
          fileId,
          name: fileName,
          size: fileSize,
          type: fileType,
          totalChunks,
          receivedChunksCount: 0,
          chunks: []
        };

        appendFileBubble(
          false,
          appState.peerNames[peerId] || `设备 ${peerId.substring(0, 4)}`,
          fileId,
          fileName,
          fileSize,
          fileType
        );

        if (totalChunks === 0) {
          triggerFileCompletion(peerId);
        }

        sendControlMessage(peerId, {
          type: 'file-ready',
          fileId
        });
        return;
      }

      if (data.type === 'file-ready') {
        const transfer = appState.outgoingTransfers[data.fileId];
        if (transfer && !transfer.cancelled) {
          if (!transfer.peers[peerId]) {
            transfer.peers[peerId] = {
              currentChunk: 0,
              totalChunks: Math.ceil(transfer.file.size / CHUNK_SIZE)
            };
          }
          startFileSendingLoop(peerId, data.fileId, transfer.file);
        }
        return;
      }

      if (data.type === 'file-cancel') {
        handleFileCancelMessage(peerId, data.fileId);
      }
    } catch (error) {
      console.error('Error receiving message:', error);
    }
  };
}

/**
 * 仅关闭底层的连接句柄与心跳，不清除显示名和业务状态（供自动重连时使用）
 */
export function closePeerConnectionOnly(peerId) {
  stopHeartbeat(peerId);
  clearTimeout(connectionTimers[peerId]);
  delete connectionTimers[peerId];
  delete peerHeartbeats[peerId];

  if (disconnectTimers[peerId]) {
    clearTimeout(disconnectTimers[peerId]);
    delete disconnectTimers[peerId];
  }

  if (appState.dataChannels[peerId]) {
    try {
      appState.dataChannels[peerId].onclose = null;
      appState.dataChannels[peerId].close();
    } catch (error) {}
    delete appState.dataChannels[peerId];
  }

  if (appState.fileChannels[peerId]) {
    try {
      appState.fileChannels[peerId].onclose = null;
      appState.fileChannels[peerId].close();
    } catch (error) {}
    delete appState.fileChannels[peerId];
  }

  if (appState.peerConnections[peerId]) {
    try {
      appState.peerConnections[peerId].onconnectionstatechange = null;
      appState.peerConnections[peerId].close();
    } catch (error) {}
    delete appState.peerConnections[peerId];
  }

  updateConnectionUI();
}

/**
 * 当网络断开或假死时触发自动重连协商
 */
export function handlePeerDisconnection(peerId) {
  stopHeartbeat(peerId);

  if (disconnectTimers[peerId]) {
    clearTimeout(disconnectTimers[peerId]);
    delete disconnectTimers[peerId];
  }

  // 如果当前设备已被屏蔽、移出或信令未连接，则直接清理
  if (!appState.socket || !appState.socket.connected || appState.roomAccessMessage) {
    cleanupPeer(peerId);
    return;
  }

  // 如果 peer 已经不在当前房间，直接清理
  const isStillMember = appState.roomMembers.some(member => member.socketId === peerId);
  if (!isStillMember) {
    cleanupPeer(peerId);
    return;
  }

  closePeerConnectionOnly(peerId);
  // 两端同时发现断线时，只允许固定的一端发 offer。
  if (appState.socket.id > peerId) {
    startNegotiation(peerId);
  } else {
    // 等待邀请的响应期间也保留握手窗口，防止健康检查重复邀请。
    createPeerConnection(peerId, false);
    appState.socket.emit('signal', {
      targetId: peerId,
      signal: { type: '__reconnect_request__' }
    });
  }
}

/**
 * 彻底移除某个 Peer（例如离开房间或被移出）
 */
export function cleanupPeer(peerId) {
  closePeerConnectionOnly(peerId);
  establishedPeers.delete(peerId);
  delete appState.peerNames[peerId];
  delete appState.incomingFiles[peerId];
  updateConnectionUI();
}

export async function startNegotiation(peerId) {
  const current = appState.peerConnections[peerId];
  if (current && ['new', 'connecting'].includes(current.connectionState) &&
      appState.dataChannels[peerId]?.readyState === 'connecting') return;
  const peerConnection = createPeerConnection(peerId, true);

  try {
    const offer = await peerConnection.createOffer();
    if (appState.peerConnections[peerId] !== peerConnection) return;
    await peerConnection.setLocalDescription(offer);
    if (appState.peerConnections[peerId] !== peerConnection) return;
    if (appState.socket && appState.socket.connected) {
      appState.socket.emit('signal', {
        targetId: peerId,
        signal: { sdp: peerConnection.localDescription }
      });
    }
  } catch (error) {
    console.error(`Error creating offer for ${peerId}:`, error);
  }
}

export function cleanupAllPeers() {
  Object.keys(appState.peerConnections).forEach(cleanupPeer);
}

/**
 * 检查当前房间中所有成员的连接健康状况，用于切回前台或信令恢复时唤醒
 */
export function checkAllPeersHealth() {
  if (!appState.socket || !appState.socket.connected || appState.roomAccessMessage) {
    return;
  }

  appState.roomMembers.forEach(member => {
    const peerId = member.socketId;
    if (peerId === appState.socket.id) return;

    const channel = appState.dataChannels[peerId];
    const pc = appState.peerConnections[peerId];

    if (channel?.readyState === 'open' && pc?.connectionState === 'connected') {
      // 切回前台先探测，不能用后台暂停前的时间立即判死。
      peerHeartbeats[peerId] = Date.now();
      try { channel.send(JSON.stringify({ type: '__ping__' })); } catch (error) {
        console.warn('健康探测发送失败:', error);
      }
      return;
    }
    if (connectionTimers[peerId] || disconnectTimers[peerId]) return;
    if (!channel || channel.readyState !== 'open' || !pc || pc.connectionState !== 'connected') {
      console.log(`[Health-Check] 检测到设备 ${member.deviceId || peerId} 连接异常，触发静默恢复...`);
      handlePeerDisconnection(peerId);
    }
  });
}
