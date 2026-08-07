import { CHUNK_SIZE, rtcConfig } from './config.js';
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

export function createPeerConnection(peerId, isInitiator) {
  console.log(`Creating RTCPeerConnection for ${peerId}, initiator: ${isInitiator}`);

  const peerConnection = new RTCPeerConnection(rtcConfig);
  appState.peerConnections[peerId] = peerConnection;

  if (!appState.peerNames[peerId]) {
    setPeerDisplayName(peerId);
  }

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      appState.socket.emit('signal', {
        targetId: peerId,
        signal: { candidate: event.candidate }
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log(`Connection state for ${peerId}: ${peerConnection.connectionState}`);
    if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
      cleanupPeer(peerId);
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
    appendSystemMessage(`与【${appState.peerNames[peerId]}】成功建立 P2P 加密通道`);
    updateConnectionUI();
  };

  dataChannel.onclose = () => {
    console.log(`Data Channel closed with ${peerId}`);
    appendSystemMessage(`与【${appState.peerNames[peerId]}】连接断开`);
    cleanupPeer(peerId);
  };

  dataChannel.onmessage = event => {
    try {
      const data = JSON.parse(event.data);
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

export function cleanupPeer(peerId) {
  if (appState.dataChannels[peerId]) {
    try {
      appState.dataChannels[peerId].close();
    } catch (error) {
      console.error('Failed to close data channel:', error);
    }
    delete appState.dataChannels[peerId];
  }

  if (appState.fileChannels[peerId]) {
    try {
      appState.fileChannels[peerId].close();
    } catch (error) {
      console.error('Failed to close file channel:', error);
    }
    delete appState.fileChannels[peerId];
  }

  if (appState.peerConnections[peerId]) {
    try {
      appState.peerConnections[peerId].close();
    } catch (error) {
      console.error('Failed to close peer connection:', error);
    }
    delete appState.peerConnections[peerId];
  }

  delete appState.peerNames[peerId];
  delete appState.incomingFiles[peerId];
  updateConnectionUI();
}

export async function startNegotiation(peerId) {
  const peerConnection = createPeerConnection(peerId, true);

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    appState.socket.emit('signal', {
      targetId: peerId,
      signal: { sdp: peerConnection.localDescription }
    });
  } catch (error) {
    console.error(`Error creating offer for ${peerId}:`, error);
  }
}

export function cleanupAllPeers() {
  Object.keys(appState.peerConnections).forEach(cleanupPeer);
}
