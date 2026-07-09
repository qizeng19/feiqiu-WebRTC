// WebRTC & Signalling Client

// State Variables
let socket;
let roomId;
let localIp = 'localhost';
let port = 3000;
const peerConnections = {};  // targetSocketId -> RTCPeerConnection
const dataChannels = {};     // targetSocketId -> RTCDataChannel (for text)
const fileChannels = {};     // targetSocketId -> RTCDataChannel (for files)
const outgoingTransfers = {}; // fileId -> { file, peers: { peerId: { currentChunk, totalChunks } } }
const incomingFiles = {};     // peerId -> { fileId, name, size, type, totalChunks, receivedChunksCount, chunks: [] }
const peerNames = {};        // targetSocketId -> friendly name
const CHUNK_SIZE = 16384;    // 16KB WebRTC chunk size

// Get or create persistent device ID
let myDeviceId = localStorage.getItem('feiqiu_device_id');
if (!myDeviceId) {
  const chars = 'ABCDEF0123456789';
  myDeviceId = '';
  for (let i = 0; i < 4; i++) {
    myDeviceId += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  localStorage.setItem('feiqiu_device_id', myDeviceId);
}

// STUN servers (standard configuration, though LAN peer-to-peer mostly uses host candidates)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// UI Elements
const statusIndicator = document.getElementById('connection-status');
const statusText = statusIndicator.querySelector('.status-text');
const qrCodeImg = document.getElementById('qr-code-img');
const qrPlaceholder = document.getElementById('qr-placeholder');
const lanUrlInput = document.getElementById('lan-url');
const copyUrlBtn = document.getElementById('copy-url-btn');
const roomIdDisplay = document.getElementById('room-id-display');
const myPeerIdDisplay = document.getElementById('my-peer-id-display');
const localIpDisplay = document.getElementById('local-ip-display');
const peerCountDisplay = document.getElementById('peer-count');
const newRoomBtn = document.getElementById('new-room-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const messagesList = document.getElementById('messages-list');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const charCount = document.getElementById('char-count');
const toast = document.getElementById('toast');

// --- Helper Functions ---

// Generate a random room ID
function generateRandomRoomId(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Show toast message
function showToast(message, type = 'info') {
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');
  
  toastMsg.textContent = message;
  
  // Update icon based on type
  if (type === 'success') {
    toastIcon.setAttribute('data-lucide', 'check-circle');
    toastIcon.style.color = 'var(--success)';
  } else if (type === 'error') {
    toastIcon.setAttribute('data-lucide', 'alert-circle');
    toastIcon.style.color = 'var(--danger)';
  } else {
    toastIcon.setAttribute('data-lucide', 'info');
    toastIcon.style.color = 'var(--primary-color)';
  }
  
  lucide.createIcons(); // refresh lucide icons
  
  toast.classList.add('show');
  
  // Hide after 3 seconds
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Copy text to clipboard
async function copyToClipboard(text, successMessage = '已复制到剪贴板') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage, 'success');
  } catch (err) {
    console.error('Failed to copy: ', err);
    // Fallback for older browsers / insecure contexts
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      showToast(successMessage, 'success');
    } catch (fallbackErr) {
      showToast('复制失败，请手动选择复制', 'error');
    }
    document.body.removeChild(textArea);
  }
}

// Format timestamp
function getFormattedTime() {
  const now = new Date();
  return now.toTimeString().split(' ')[0].substring(0, 5);
}

// Append message to chat panel
function appendMessage(text, isSelf, senderName, id = null) {
  // Check if system message needs removal (like "waiting for peers")
  const emptyMsg = messagesList.querySelector('.system-message');
  if (emptyMsg && messagesList.children.length === 1) {
    messagesList.removeChild(emptyMsg);
  }

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${isSelf ? 'self' : 'peer'}`;
  
  const info = document.createElement('div');
  info.className = 'message-info';
  info.textContent = `${senderName} • ${getFormattedTime()}`;
  
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  
  // Escape html characters to prevent XSS
  const textSpan = document.createElement('span');
  textSpan.textContent = text;
  bubble.appendChild(textSpan);

  // Add Copy action to bubble
  const actions = document.createElement('div');
  actions.className = 'bubble-actions';
  
  const copyBtn = document.createElement('button');
  copyBtn.className = 'bubble-action-btn';
  copyBtn.innerHTML = '<i data-lucide="copy"></i>复制文本';
  copyBtn.onclick = () => copyToClipboard(text, '文本内容已复制');
  actions.appendChild(copyBtn);
  
  bubble.appendChild(actions);
  wrapper.appendChild(info);
  wrapper.appendChild(bubble);
  
  messagesList.appendChild(wrapper);
  
  // Scroll to bottom
  messagesList.scrollTop = messagesList.scrollHeight;
  lucide.createIcons();
}

// Append a system message
function appendSystemMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'system-message';
  msg.innerHTML = `<p>${text}</p>`;
  messagesList.appendChild(msg);
  messagesList.scrollTop = messagesList.scrollHeight;
}

// Update room-related info
function updateRoomURL() {
  const hash = window.location.hash;
  if (!hash) {
    // Generate a default hash if none exists
    roomId = generateRandomRoomId();
    window.location.hash = roomId;
  } else {
    roomId = hash.substring(1);
  }
  
  roomIdDisplay.textContent = roomId;
}

// Set up UI updates based on WebRTC connections
function updateConnectionUI() {
  const peersCount = Object.keys(dataChannels).filter(id => dataChannels[id].readyState === 'open').length;
  peerCountDisplay.textContent = `${peersCount} 个设备`;

  if (peersCount > 0) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = `已连接 (${peersCount})`;
    sendBtn.disabled = false;
  } else {
    if (socket && socket.connected) {
      statusIndicator.className = 'status-indicator connecting';
      statusText.textContent = '等待设备加入';
    } else {
      statusIndicator.className = 'status-indicator disconnected';
      statusText.textContent = '未连接';
    }
    sendBtn.disabled = true;
  }
}

// Fetch host IP details from server
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    
    // Choose the first non-localhost IP if available, otherwise localhost
    localIp = data.ips.find(ip => ip !== '127.0.0.1' && ip !== 'localhost') || 'localhost';
    port = data.port;
    
    localIpDisplay.textContent = localIp;
    
    // Construct the direct LAN URL
    const lanUrl = `http://${localIp}:${port}/#${roomId}`;
    lanUrlInput.value = lanUrl;
    
    // Generate QR Code using a public API
    qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(lanUrl)}`;
    qrCodeImg.onload = () => {
      qrPlaceholder.style.display = 'none';
      qrCodeImg.style.display = 'block';
    };
  } catch (err) {
    console.error('Failed to get server info:', err);
    localIpDisplay.textContent = '无法获取';
    const fallbackUrl = `${window.location.origin}/#${roomId}`;
    lanUrlInput.value = fallbackUrl;
    
    qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(fallbackUrl)}`;
    qrCodeImg.onload = () => {
      qrPlaceholder.style.display = 'none';
      qrCodeImg.style.display = 'block';
    };
  }
}

// --- WebRTC Logic ---

// Set up connection for a peer
function createPeerConnection(peerId, isInitiator) {
  console.log(`Creating RTCPeerConnection for ${peerId}, initiator: ${isInitiator}`);
  
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[peerId] = pc;
  
  // Set up friendly name
  peerNames[peerId] = `设备 ${peerId.substring(0, 4)}`;

  // ICE Candidates exchange
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        targetId: peerId,
        signal: { candidate: event.candidate }
      });
    }
  };

  // Log state changes
  pc.onconnectionstatechange = () => {
    console.log(`Connection state for ${peerId}: ${pc.connectionState}`);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeer(peerId);
    }
  };

  // If initiator, create the data channel
  if (isInitiator) {
    const dc = pc.createDataChannel('text-channel', { ordered: true });
    setupDataChannel(peerId, dc);
    
    const fc = pc.createDataChannel('file-channel', { ordered: true });
    setupFileChannel(peerId, fc);
  } else {
    // If receiver, handle incoming data channel
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === 'text-channel') {
        setupDataChannel(peerId, channel);
      } else if (channel.label === 'file-channel') {
        setupFileChannel(peerId, channel);
      }
    };
  }

  return pc;
}

// Set up Data Channel events
function setupDataChannel(peerId, dc) {
  dataChannels[peerId] = dc;

  dc.onopen = () => {
    console.log(`Data Channel open with ${peerId}`);
    appendSystemMessage(`与【${peerNames[peerId]}】成功建立 P2P 加密通道`);
    updateConnectionUI();
  };

  dc.onclose = () => {
    console.log(`Data Channel closed with ${peerId}`);
    appendSystemMessage(`与【${peerNames[peerId]}】连接断开`);
    cleanupPeer(peerId);
  };

  dc.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'text') {
        appendMessage(data.text, false, peerNames[peerId]);
        
        // Show browser notification if tab is hidden
        if (document.hidden) {
          showNotification(peerNames[peerId], data.text);
        }
      } else if (data.type === 'file-metadata') {
        const { fileId, fileName, fileSize, fileType, totalChunks } = data;
        
        // Initialize incoming transfer
        incomingFiles[peerId] = {
          fileId,
          name: fileName,
          size: fileSize,
          type: fileType,
          totalChunks,
          receivedChunksCount: 0,
          chunks: []
        };
        
        // Append peer bubble
        appendFileBubble(false, peerNames[peerId] || `设备 ${peerId.substring(0, 4)}`, fileId, fileName, fileSize, fileType);
        
        // Reply file-ready to sender
        sendControlMessage(peerId, {
          type: 'file-ready',
          fileId: fileId
        });
      } else if (data.type === 'file-ready') {
        const { fileId } = data;
        const transfer = outgoingTransfers[fileId];
        if (transfer) {
          // Initialize progress record for this peer
          transfer.peers[peerId] = { currentChunk: 0, totalChunks: Math.ceil(transfer.file.size / CHUNK_SIZE) };
          // Start sending
          startFileSendingLoop(peerId, fileId, transfer.file);
        }
      }
    } catch (err) {
      console.error('Error receiving message:', err);
    }
  };
}

// Cleanup peer connection resources
function cleanupPeer(peerId) {
  if (dataChannels[peerId]) {
    try { dataChannels[peerId].close(); } catch(e) {}
    delete dataChannels[peerId];
  }
  
  if (fileChannels[peerId]) {
    try { fileChannels[peerId].close(); } catch(e) {}
    delete fileChannels[peerId];
  }
  
  if (peerConnections[peerId]) {
    try { peerConnections[peerId].close(); } catch(e) {}
    delete peerConnections[peerId];
  }
  
  if (peerNames[peerId]) {
    delete peerNames[peerId];
  }
  
  if (incomingFiles[peerId]) {
    delete incomingFiles[peerId];
  }
  
  updateConnectionUI();
}

// --- File Transfer Helper Functions ---

// Send control message to a peer
function sendControlMessage(peerId, payload) {
  const dc = dataChannels[peerId];
  if (dc && dc.readyState === 'open') {
    try {
      dc.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error(`Error sending control message to peer ${peerId}:`, err);
    }
  }
  return false;
}

// Setup dedicated file channel
function setupFileChannel(peerId, fc) {
  fileChannels[peerId] = fc;
  fc.binaryType = 'arraybuffer';

  fc.onopen = () => {
    console.log(`File Channel open with ${peerId}`);
  };

  fc.onclose = () => {
    console.log(`File Channel closed with ${peerId}`);
    delete fileChannels[peerId];
  };

  fc.onmessage = (event) => {
    handleIncomingFileChunk(peerId, event.data);
  };
}

// Handle file selection from input or drag-drop
function handleFileSelect(file) {
  if (!file) return;

  const peerCount = Object.keys(dataChannels).filter(id => dataChannels[id].readyState === 'open').length;
  if (peerCount === 0) {
    showToast('无可用连接，无法发送文件', 'error');
    return;
  }

  const fileId = 'file-' + Math.random().toString(36).substring(2, 9);

  // Register in outgoingTransfers
  outgoingTransfers[fileId] = {
    file: file,
    peers: {}
  };

  // Append self bubble
  appendFileBubble(true, '我', fileId, file.name, file.size, file.type);

  // Send metadata to all peers
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const metadata = {
    type: 'file-metadata',
    fileId: fileId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    totalChunks: totalChunks
  };

  Object.keys(dataChannels).forEach(peerId => {
    if (dataChannels[peerId].readyState === 'open') {
      sendControlMessage(peerId, metadata);
    }
  });
}

// Send loop for file chunks with backpressure handling
function startFileSendingLoop(peerId, fileId, file) {
  const fc = fileChannels[peerId];
  if (!fc || fc.readyState !== 'open') return;

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let currentChunk = 0;
  const threshold = 65536; // 64KB
  fc.bufferedAmountLowThreshold = threshold;

  function sendNext() {
    // Check if channel is still open
    if (!fileChannels[peerId] || fileChannels[peerId].readyState !== 'open') return;

    while (currentChunk < totalChunks) {
      if (fc.bufferedAmount > threshold) {
        fc.onbufferedamountlow = () => {
          fc.onbufferedamountlow = null;
          sendNext();
        };
        return;
      }

      const start = currentChunk * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          fc.send(e.target.result);
          currentChunk++;
          updateOutgoingProgress(fileId, peerId, currentChunk, totalChunks);
          sendNext();
        } catch (err) {
          console.error(`Error sending file chunk to ${peerId}:`, err);
        }
      };
      reader.readAsArrayBuffer(blob);
      return; // wait for FileReader onload
    }

    console.log(`Finished sending file ${fileId} to peer ${peerId}`);
    updateOutgoingProgress(fileId, peerId, totalChunks, totalChunks);
  }

  sendNext();
}

// Update progress of outgoing transfer
function updateOutgoingProgress(fileId, peerId, currentChunk, totalChunks) {
  const transfer = outgoingTransfers[fileId];
  if (!transfer) return;

  if (!transfer.peers[peerId]) {
    transfer.peers[peerId] = { currentChunk, totalChunks };
  } else {
    transfer.peers[peerId].currentChunk = currentChunk;
  }

  // Calculate average progress across all peers we are sending to
  const peers = transfer.peers;
  let totalPeerChunks = 0;
  let sentPeerChunks = 0;

  Object.keys(peers).forEach(pId => {
    sentPeerChunks += peers[pId].currentChunk;
    totalPeerChunks += peers[pId].totalChunks;
  });

  const percentage = totalPeerChunks > 0 ? Math.round((sentPeerChunks / totalPeerChunks) * 100) : 0;

  const progressFill = document.getElementById(`progress-fill-${fileId}`);
  const progressMeta = document.getElementById(`progress-meta-${fileId}`);

  if (progressFill) {
    progressFill.style.width = `${percentage}%`;
  }

  if (progressMeta) {
    const formattedSize = formatBytes(transfer.file.size);
    if (percentage === 100) {
      progressMeta.textContent = `${formattedSize} • 发送成功`;
      
      // Hide progress container after a slight delay
      setTimeout(() => {
        const progressContainer = document.getElementById(`progress-container-${fileId}`);
        if (progressContainer) progressContainer.style.display = 'none';
      }, 1000);
    } else {
      progressMeta.textContent = `${formattedSize} • 正在发送 ${percentage}%`;
    }
  }
}

// Receive binary chunk from peer
function handleIncomingFileChunk(peerId, arrayBuffer) {
  const fileTransfer = incomingFiles[peerId];
  if (!fileTransfer) {
    console.error(`Received chunk from ${peerId} but no file metadata registered.`);
    return;
  }

  fileTransfer.chunks.push(arrayBuffer);
  fileTransfer.receivedChunksCount++;

  const percentage = Math.round((fileTransfer.receivedChunksCount / fileTransfer.totalChunks) * 100);

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

// Complete file download and prompt download
function triggerFileCompletion(peerId) {
  const fileTransfer = incomingFiles[peerId];
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
    lucide.createIcons();
  }

  // Show desktop notification
  showNotification('收到新文件', `文件【${fileTransfer.name}】已传输完毕，点击保存！`);
}

// Append file progress bubble to message panel
function appendFileBubble(isSelf, senderName, fileId, fileName, fileSize, fileType) {
  const emptyMsg = messagesList.querySelector('.system-message');
  if (emptyMsg && messagesList.children.length === 1) {
    messagesList.removeChild(emptyMsg);
  }

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${isSelf ? 'self' : 'peer'}`;
  
  const info = document.createElement('div');
  info.className = 'message-info';
  info.textContent = `${senderName} • ${getFormattedTime()}`;
  
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  
  // Decide icon based on file extension
  let iconName = 'file';
  const ext = fileName.split('.').pop().toLowerCase();
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(ext)) {
    iconName = 'file-text';
  } else if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) {
    iconName = 'image';
  } else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
    iconName = 'music';
  } else if (['mp4', 'webm', 'mkv', 'avi'].includes(ext)) {
    iconName = 'video';
  } else if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) {
    iconName = 'archive';
  } else if (ext === 'apk') {
    iconName = 'box';
  }
  
  const formattedSize = formatBytes(fileSize);
  
  bubble.innerHTML = `
    <div class="file-bubble-container" id="msg-${fileId}">
      <div class="file-info-header">
        <div class="file-icon-wrapper">
          <i data-lucide="${iconName}"></i>
        </div>
        <div class="file-details">
          <div class="file-name" title="${fileName}">${fileName}</div>
          <div class="file-meta-info" id="progress-meta-${fileId}">${formattedSize} • ${isSelf ? '正在发送 0%' : '正在接收 0%'}</div>
        </div>
      </div>
      <div class="progress-bar-container" id="progress-container-${fileId}">
        <div class="progress-bar-fill" id="progress-fill-${fileId}"></div>
      </div>
      <div class="file-actions" id="actions-${fileId}">
        <!-- Dynamically loaded actions -->
      </div>
    </div>
  `;
  
  wrapper.appendChild(info);
  wrapper.appendChild(bubble);
  messagesList.appendChild(wrapper);
  
  messagesList.scrollTop = messagesList.scrollHeight;
  lucide.createIcons();
}

// Convert bytes to human readable format
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Show system desktop notification
function showNotification(title, text) {
  if (!("Notification" in window)) return;
  
  if (Notification.permission === "granted") {
    new Notification(title, { body: text, icon: '/favicon.ico' });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then(permission => {
      if (permission === "granted") {
        new Notification(title, { body: text });
      }
    });
  }
}

// Start WebRTC negotiations (Create Offer)
async function startNegotiation(peerId) {
  const pc = createPeerConnection(peerId, true);
  
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('signal', {
      targetId: peerId,
      signal: { sdp: pc.localDescription }
    });
  } catch (err) {
    console.error(`Error creating offer for ${peerId}:`, err);
  }
}

// --- Socket.io Signaling Setup ---

function connectSignaling() {
  socket = io();

  socket.on('connect', () => {
    console.log('Connected to signaling server');
    socket.emit('join', { roomId, deviceId: myDeviceId });
    updateConnectionUI();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from signaling server');
    // Cleanup all peers since connection lost
    Object.keys(peerConnections).forEach(cleanupPeer);
    updateConnectionUI();
  });

  // Get initial list of peers in the room
  socket.on('peers', ({ peers }) => {
    console.log('Received list of existing peers:', peers);
    // As the new joiner, we will initiate WebRTC connections to everyone
    peers.forEach(peer => {
      peerNames[peer.socketId] = `设备 ${peer.deviceId}`;
      startNegotiation(peer.socketId);
    });
  });

  // Peer joined the room
  socket.on('peer-joined', ({ peerId, deviceId }) => {
    console.log(`Peer joined: ${peerId} (${deviceId})`);
    peerNames[peerId] = `设备 ${deviceId}`;
    // The existing client waits for the new client to negotiate, 
    // or creates the receiver connection.
    createPeerConnection(peerId, false);
  });

  // Received WebRTC signaling message
  socket.on('signal', async ({ senderId, signal }) => {
    let pc = peerConnections[senderId];
    
    // Create peer connection if not exists (defensive check)
    if (!pc) {
      pc = createPeerConnection(senderId, false);
    }

    try {
      if (signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', {
            targetId: senderId,
            signal: { sdp: pc.localDescription }
          });
        }
      } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (err) {
      console.error('Error handling signaling message:', err);
    }
  });

  // Peer left room
  socket.on('peer-left', ({ peerId }) => {
    console.log(`Peer left: ${peerId}`);
    cleanupPeer(peerId);
  });
}

// --- Event Listeners & Initialization ---

// File Upload Buttons
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');

if (attachBtn && fileInput) {
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
      fileInput.value = ''; // Reset file input so same file can be selected again
    }
  });
}

// Drag & Drop File Transfer
const chatPanel = document.querySelector('.chat-panel');
if (chatPanel) {
  ['dragenter', 'dragover'].forEach(eventName => {
    chatPanel.addEventListener(eventName, (e) => {
      e.preventDefault();
      chatPanel.classList.add('drag-active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    chatPanel.addEventListener(eventName, (e) => {
      e.preventDefault();
      chatPanel.classList.remove('drag-active');
    }, false);
  });

  chatPanel.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      handleFileSelect(files[0]);
    }
  });
}

// Update char count & send button state
textInput.addEventListener('input', () => {
  const length = textInput.value.length;
  charCount.textContent = `${length} 字符`;
});

// Keypress: Enter to send, Shift+Enter for line break
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

// Send Message Button click
sendBtn.addEventListener('click', sendMessage);

// Send message logic
function sendMessage() {
  const text = textInput.value.trim();
  if (!text) return;

  const msgPayload = {
    type: 'text',
    text: text
  };

  const payloadStr = JSON.stringify(msgPayload);
  let sentSuccessfully = false;

  // Send to all open WebRTC Data Channels
  Object.keys(dataChannels).forEach(peerId => {
    const dc = dataChannels[peerId];
    if (dc.readyState === 'open') {
      try {
        dc.send(payloadStr);
        sentSuccessfully = true;
      } catch (err) {
        console.error(`Error sending text to peer ${peerId}:`, err);
      }
    }
  });

  if (sentSuccessfully) {
    appendMessage(text, true, '我');
    textInput.value = '';
    charCount.textContent = '0 字符';
    textInput.focus();
  } else {
    showToast('无可用连接，发送失败', 'error');
  }
}

// Copy URL Button click
copyUrlBtn.addEventListener('click', () => {
  copyToClipboard(lanUrlInput.value, '局域网链接已复制，去发送吧！');
});

// New Room Button click
newRoomBtn.addEventListener('click', () => {
  const newRoomId = generateRandomRoomId();
  window.location.hash = newRoomId;
  window.location.reload();
});

// Clear Chat history
clearChatBtn.addEventListener('click', () => {
  messagesList.innerHTML = '';
  appendSystemMessage('聊天记录已清空');
});

// Listen to Hash Change to allow changing rooms on the fly
window.addEventListener('hashchange', () => {
  window.location.reload();
});

// Initialize notification permissions
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

// Display persistent device ID
myPeerIdDisplay.textContent = `设备 ${myDeviceId}`;

// Initialize Room ID
updateRoomURL();

// Fetch local Server details & IP (for QR & Direct LAN access info)
fetchServerInfo();

// Start signaling
connectSignaling();
