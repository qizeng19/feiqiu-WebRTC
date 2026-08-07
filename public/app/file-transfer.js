import { CHUNK_SIZE } from './config.js';
import { appState } from './state.js';
import { appendFileBubble, showNotification, showToast } from './ui.js';
import { formatBytes } from './utils.js';

export function sendControlMessage(peerId, payload) {
  const dataChannel = appState.dataChannels[peerId];
  if (dataChannel && dataChannel.readyState === 'open') {
    try {
      dataChannel.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.error(`Error sending control message to peer ${peerId}:`, error);
    }
  }
  return false;
}

export function setupFileChannel(peerId, fileChannel) {
  appState.fileChannels[peerId] = fileChannel;
  fileChannel.binaryType = 'arraybuffer';

  fileChannel.onopen = () => {
    console.log(`File Channel open with ${peerId}`);
  };

  fileChannel.onclose = () => {
    console.log(`File Channel closed with ${peerId}`);
    delete appState.fileChannels[peerId];
  };

  fileChannel.onmessage = event => {
    handleIncomingFileChunk(peerId, event.data);
  };
}

export function handleFileSelect(file) {
  if (!file) return;

  const availablePeerIds = Object.keys(appState.dataChannels)
    .filter(peerId => appState.dataChannels[peerId].readyState === 'open');

  if (availablePeerIds.length === 0) {
    showToast('无可用连接，无法发送文件', 'error');
    return;
  }

  const fileId = `file-${Math.random().toString(36).substring(2, 9)}`;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const peers = {};

  availablePeerIds.forEach(peerId => {
    peers[peerId] = { currentChunk: 0, totalChunks };
  });

  appState.outgoingTransfers[fileId] = {
    file,
    cancelled: false,
    readers: {},
    peers
  };

  appendFileBubble(true, '我', fileId, file.name, file.size, file.type, null, true, false, () => {
    cancelOutgoingTransfer(fileId);
  });

  const metadata = {
    type: 'file-metadata',
    fileId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    totalChunks
  };

  availablePeerIds.forEach(peerId => {
    sendControlMessage(peerId, metadata);
  });
}

export function startFileSendingLoop(peerId, fileId, file) {
  const fileChannel = appState.fileChannels[peerId];
  if (!fileChannel || fileChannel.readyState !== 'open') return;

  const transfer = appState.outgoingTransfers[fileId];
  if (!transfer || transfer.cancelled) return;

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let currentChunk = transfer.peers[peerId]?.currentChunk || 0;
  const threshold = 65536;
  fileChannel.bufferedAmountLowThreshold = threshold;

  function sendNext() {
    const latestTransfer = appState.outgoingTransfers[fileId];
    if (!latestTransfer || latestTransfer.cancelled) return;

    if (!appState.fileChannels[peerId] || appState.fileChannels[peerId].readyState !== 'open') {
      return;
    }

    while (currentChunk < totalChunks) {
      if (fileChannel.bufferedAmount > threshold) {
        fileChannel.onbufferedamountlow = () => {
          fileChannel.onbufferedamountlow = null;
          const nextTransfer = appState.outgoingTransfers[fileId];
          if (!nextTransfer || nextTransfer.cancelled) return;
          sendNext();
        };
        return;
      }

      const start = currentChunk * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      const reader = new FileReader();
      transfer.readers[peerId] = reader;
      reader.onload = event => {
        const latest = appState.outgoingTransfers[fileId];
        if (!latest || latest.cancelled) return;

        try {
          fileChannel.send(event.target.result);
          currentChunk += 1;
          updateOutgoingProgress(fileId, peerId, currentChunk, totalChunks);
          sendNext();
        } catch (error) {
          console.error(`Error sending file chunk to ${peerId}:`, error);
        } finally {
          const activeTransfer = appState.outgoingTransfers[fileId];
          if (activeTransfer?.readers[peerId] === reader) {
            delete activeTransfer.readers[peerId];
          }
        }
      };
      reader.onerror = () => {
        const activeTransfer = appState.outgoingTransfers[fileId];
        if (activeTransfer?.readers[peerId] === reader) {
          delete activeTransfer.readers[peerId];
        }
        if (!appState.outgoingTransfers[fileId]?.cancelled) {
          console.error(`Error reading file chunk for ${peerId}:`, reader.error);
        }
      };
      reader.onabort = () => {
        const activeTransfer = appState.outgoingTransfers[fileId];
        if (activeTransfer?.readers[peerId] === reader) {
          delete activeTransfer.readers[peerId];
        }
      };
      reader.readAsArrayBuffer(blob);
      return;
    }

    console.log(`Finished sending file ${fileId} to peer ${peerId}`);
    updateOutgoingProgress(fileId, peerId, totalChunks, totalChunks);
  }

  sendNext();
}

function updateOutgoingProgress(fileId, peerId, currentChunk, totalChunks) {
  const transfer = appState.outgoingTransfers[fileId];
  if (!transfer) return;

  if (!transfer.peers[peerId]) {
    transfer.peers[peerId] = { currentChunk, totalChunks };
  } else {
    transfer.peers[peerId].currentChunk = currentChunk;
  }

  let totalPeerChunks = 0;
  let sentPeerChunks = 0;
  Object.keys(transfer.peers).forEach(currentPeerId => {
    sentPeerChunks += transfer.peers[currentPeerId].currentChunk;
    totalPeerChunks += transfer.peers[currentPeerId].totalChunks;
  });

  const percentage = totalPeerChunks > 0 ? Math.round((sentPeerChunks / totalPeerChunks) * 100) : 100;
  const progressFill = document.getElementById(`progress-fill-${fileId}`);
  const progressMeta = document.getElementById(`progress-meta-${fileId}`);

  if (progressFill) {
    progressFill.style.width = `${percentage}%`;
  }

  if (progressMeta) {
    const formattedSize = formatBytes(transfer.file.size);
    if (percentage === 100) {
      progressMeta.textContent = `${formattedSize} • 发送成功`;
      finalizeFileTransferUI(fileId);
      transfer.completed = true;
      setTimeout(() => {
        const progressContainer = document.getElementById(`progress-container-${fileId}`);
        if (progressContainer) {
          progressContainer.style.display = 'none';
        }
      }, 1000);
    } else {
      progressMeta.textContent = `${formattedSize} • 正在发送 ${percentage}%`;
    }
  }
}

export function cancelOutgoingTransfer(fileId) {
  const transfer = appState.outgoingTransfers[fileId];
  if (!transfer || transfer.cancelled || transfer.completed) return;

  transfer.cancelled = true;

  Object.values(transfer.readers).forEach(reader => {
    if (reader.readyState === FileReader.LOADING) {
      try {
        reader.abort();
      } catch (error) {
        console.error('Failed to abort reader:', error);
      }
    }
  });
  transfer.readers = {};

  Object.keys(transfer.peers).forEach(peerId => {
    const fileChannel = appState.fileChannels[peerId];
    if (fileChannel) {
      fileChannel.onbufferedamountlow = null;
    }
    sendControlMessage(peerId, {
      type: 'file-cancel',
      fileId
    });
  });

  markFileTransferCancelled(fileId, transfer.file.size, '已取消发送');
  showToast('已取消文件发送', 'info');
}

export function handleFileCancelMessage(peerId, fileId) {
  const incomingTransfer = appState.incomingFiles[peerId];
  if (incomingTransfer && incomingTransfer.fileId === fileId) {
    const fileSize = incomingTransfer.size;
    incomingTransfer.chunks = [];
    appState.incomingFiles[peerId] = { fileId, cancelled: true };
    markFileTransferCancelled(fileId, fileSize, '对方已取消发送');
    return;
  }

  const outgoingTransfer = appState.outgoingTransfers[fileId];
  if (outgoingTransfer?.peers[peerId]) {
    outgoingTransfer.peers[peerId].cancelled = true;
  }
}

function finalizeFileTransferUI(fileId) {
  const actionsContainer = document.getElementById(`actions-${fileId}`);
  if (actionsContainer) {
    actionsContainer.innerHTML = '';
  }
}

function markFileTransferCancelled(fileId, fileSize, statusText) {
  const progressContainer = document.getElementById(`progress-container-${fileId}`);
  const progressFill = document.getElementById(`progress-fill-${fileId}`);
  const progressMeta = document.getElementById(`progress-meta-${fileId}`);
  const actionsContainer = document.getElementById(`actions-${fileId}`);

  if (progressFill) {
    progressFill.classList.add('cancelled');
  }
  if (progressContainer) {
    progressContainer.classList.add('cancelled');
  }
  if (progressMeta) {
    progressMeta.textContent = `${formatBytes(fileSize)} • ${statusText}`;
  }
  if (actionsContainer) {
    actionsContainer.innerHTML = '';
  }
}

export function handleIncomingFileChunk(peerId, arrayBuffer) {
  const fileTransfer = appState.incomingFiles[peerId];
  if (!fileTransfer) {
    console.error(`Received chunk from ${peerId} but no file metadata registered.`);
    return;
  }

  if (fileTransfer.cancelled) {
    return;
  }

  fileTransfer.chunks.push(arrayBuffer);
  fileTransfer.receivedChunksCount += 1;

  const percentage = fileTransfer.totalChunks > 0
    ? Math.round((fileTransfer.receivedChunksCount / fileTransfer.totalChunks) * 100)
    : 100;

  const progressFill = document.getElementById(`progress-fill-${fileTransfer.fileId}`);
  const progressMeta = document.getElementById(`progress-meta-${fileTransfer.fileId}`);

  if (progressFill) {
    progressFill.style.width = `${percentage}%`;
  }

  if (progressMeta) {
    const formattedSize = formatBytes(fileTransfer.size);
    if (fileTransfer.receivedChunksCount === fileTransfer.totalChunks) {
      progressMeta.textContent = `${formattedSize} • 接收完成`;
      triggerFileCompletion(peerId);
    } else {
      progressMeta.textContent = `${formattedSize} • 正在接收 ${percentage}%`;
    }
  }
}

export function triggerFileCompletion(peerId) {
  const fileTransfer = appState.incomingFiles[peerId];
  if (!fileTransfer) return;

  const fileBlob = new Blob(fileTransfer.chunks, { type: fileTransfer.type });
  const downloadUrl = URL.createObjectURL(fileBlob);
  const fileId = fileTransfer.fileId;

  const progressContainer = document.getElementById(`progress-container-${fileId}`);
  if (progressContainer) {
    progressContainer.style.display = 'none';
  }

  const actionsContainer = document.getElementById(`actions-${fileId}`);
  if (actionsContainer) {
    actionsContainer.innerHTML = '';

    const downloadBtn = document.createElement('a');
    downloadBtn.className = 'file-action-btn';
    downloadBtn.href = downloadUrl;
    downloadBtn.download = fileTransfer.name;
    downloadBtn.innerHTML = '<i data-lucide="download"></i>保存文件';
    downloadBtn.onclick = () => {
      showToast(`已保存文件 ${fileTransfer.name}`, 'success');
    };
    actionsContainer.appendChild(downloadBtn);
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  showNotification('收到新文件', `文件【${fileTransfer.name}】已传输完毕，点击保存！`);
}
