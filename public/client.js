// WebRTC & Signalling Client

// State Variables
let socket;
let roomId;
let localIp = 'localhost';
let port = 3000;
const peerConnections = {};  // targetSocketId -> RTCPeerConnection
const dataChannels = {};     // targetSocketId -> RTCDataChannel (for text)
const fileChannels = {};     // targetSocketId -> RTCDataChannel (for files)
const outgoingTransfers = {}; // fileId -> { file, cancelled, readers, peers: { peerId: { currentChunk, totalChunks } } }
const incomingFiles = {};     // peerId -> { fileId, name, size, type, totalChunks, receivedChunksCount, chunks: [] }
const peerNames = {};        // targetSocketId -> friendly name
const CHUNK_SIZE = 16384;    // 16KB WebRTC chunk size
let roomMembers = [];
let blockedDeviceIds = [];
let roomOwnerSocketId = null;
let roomAccessMessage = '';

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
const roomRoleBadge = document.getElementById('room-role-badge');
const roomRoleHint = document.getElementById('room-role-hint');
const roomMembersList = document.getElementById('room-members-list');
const blockedMembersList = document.getElementById('blocked-members-list');
const defaultInputPlaceholder = textInput.placeholder;

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

function resetViewportScroll() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

resetViewportScroll();

function updateViewportHeight() {
  const viewportHeight = window.visualViewport
    ? window.visualViewport.height
    : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${viewportHeight}px`);
}

updateViewportHeight();
window.addEventListener('load', resetViewportScroll);
window.addEventListener('pageshow', resetViewportScroll);
window.addEventListener('resize', updateViewportHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateViewportHeight);
}

// --- Helper Functions ---

// Default room ID and random room generator (2 digits)
const DEFAULT_ROOM_ID = '88';

function generateRandomRoomId() {
  const min = 10;
  const max = 99;
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

// Storage keys & limits for chat history
const STORAGE_KEY_PREFIX = 'feiqiu_chat_history_';
const MAX_HISTORY_ITEMS = 200;

function getStorageKey() {
  return STORAGE_KEY_PREFIX + (roomId || DEFAULT_ROOM_ID);
}

function saveMessageToStorage(msgObj) {
  if (!roomId) return;
  try {
    const key = getStorageKey();
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    history.push(msgObj);
    if (history.length > MAX_HISTORY_ITEMS) {
      history.shift();
    }
    localStorage.setItem(key, JSON.stringify(history));
  } catch (e) {
    console.error('Failed to save chat history to localStorage:', e);
  }
}

function loadChatHistory() {
  if (!roomId) return;
  try {
    const key = getStorageKey();
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    if (history.length > 0) {
      messagesList.innerHTML = '';
      history.forEach(msg => {
        if (msg.type === 'text') {
          appendMessage(msg.text, msg.isSelf, msg.senderName, msg.time, false);
        } else if (msg.type === 'file') {
          appendFileBubble(msg.isSelf, msg.senderName, msg.fileId, msg.fileName, msg.fileSize, msg.fileType, msg.time, false, true);
        }
      });
    }
  } catch (e) {
    console.error('Failed to load chat history from localStorage:', e);
  }
}

function clearChatHistory() {
  messagesList.innerHTML = '';
  appendSystemMessage('聊天记录已清空');
  if (roomId) {
    try {
      localStorage.removeItem(getStorageKey());
    } catch (e) {
      console.error('Failed to clear chat history from localStorage:', e);
    }
  }
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
function appendMessage(text, isSelf, senderName, timestamp = null, saveToCache = true) {
  const timeStr = timestamp || getFormattedTime();
  // Check if system message needs removal (like "waiting for peers")
  const emptyMsg = messagesList.querySelector('.system-message');
  if (emptyMsg && messagesList.children.length === 1) {
    messagesList.removeChild(emptyMsg);
  }

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${isSelf ? 'self' : 'peer'}`;
  
  const info = document.createElement('div');
  info.className = 'message-info';
  info.textContent = `${senderName} • ${timeStr}`;
  
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
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  if (saveToCache) {
    saveMessageToStorage({
      type: 'text',
      text,
      isSelf,
      senderName,
      time: timeStr
    });
  }
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
  if (!hash || hash === '#' || hash === '#default') {
    roomId = DEFAULT_ROOM_ID;
    if (history.replaceState) {
      history.replaceState(null, '', '#' + roomId);
    } else {
      window.location.hash = roomId;
    }
  } else {
    roomId = hash.substring(1);
  }
  
  roomIdDisplay.textContent = roomId;
}

function isRoomOwner() {
  return Boolean(socket && socket.id && roomOwnerSocketId === socket.id);
}

function setComposerDisabled(disabled, placeholderText = defaultInputPlaceholder) {
  textInput.disabled = disabled;
  textInput.placeholder = placeholderText;
  if (attachBtn) {
    attachBtn.disabled = disabled;
  }
  if (fileInput) {
    fileInput.disabled = disabled;
  }
}

function sendRoomAction(payload) {
  if (!socket || !socket.connected) {
    showToast('信令服务未连接，无法执行该操作', 'error');
    return;
  }
  socket.emit('room-action', payload);
}

function setPeerDisplayName(peerId, deviceId) {
  if (!peerId) {
    return;
  }
  peerNames[peerId] = `设备 ${deviceId || peerId.substring(0, 4)}`;
}

function createActionButton(label, icon, type, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `member-action-btn${type ? ` ${type}` : ''}`;
  button.innerHTML = `<i data-lucide="${icon}"></i>${label}`;
  button.addEventListener('click', onClick);
  return button;
}

function renderRoomManagementPanel() {
  const ownerMode = isRoomOwner();
  roomRoleBadge.textContent = ownerMode ? '当前房主' : '普通成员';
  roomRoleBadge.className = `role-badge${ownerMode ? ' owner' : ''}`;
  roomRoleHint.textContent = ownerMode
    ? '你可以将成员踢出当前房间，或加入屏蔽名单后再恢复。'
    : '当前房间的第一个进入者为房主，只有房主可以管理成员。';

  roomMembersList.innerHTML = '';
  if (roomMembers.length === 0) {
    roomMembersList.innerHTML = '<div class="member-empty">等待成员加入...</div>';
  } else {
    roomMembers.forEach(member => {
      const item = document.createElement('div');
      item.className = 'member-item';

      const meta = document.createElement('div');
      meta.className = 'member-meta';

      const name = document.createElement('div');
      name.className = 'member-name';
      const labels = [];
      if (member.socketId === roomOwnerSocketId) {
        labels.push('房主');
      }
      if (socket && member.socketId === socket.id) {
        labels.push('我');
      }
      name.textContent = `设备 ${member.deviceId}${labels.length ? ` · ${labels.join(' / ')}` : ''}`;

      const desc = document.createElement('div');
      desc.className = 'member-desc';
      desc.textContent = member.socketId === roomOwnerSocketId ? '当前房主' : '在线成员';
      if (socket && member.socketId === socket.id) {
        desc.textContent += ' · 当前设备';
      }

      meta.appendChild(name);
      meta.appendChild(desc);
      item.appendChild(meta);

      if (ownerMode && socket && member.socketId !== socket.id) {
        const actions = document.createElement('div');
        actions.className = 'member-actions';
        actions.appendChild(createActionButton('踢出', 'log-out', 'warn', () => {
          sendRoomAction({
            action: 'kick',
            targetSocketId: member.socketId
          });
        }));
        actions.appendChild(createActionButton('屏蔽', 'ban', 'danger', () => {
          sendRoomAction({
            action: 'block',
            targetSocketId: member.socketId
          });
        }));
        item.appendChild(actions);
      }

      roomMembersList.appendChild(item);
    });
  }

  blockedMembersList.innerHTML = '';
  if (blockedDeviceIds.length === 0) {
    blockedMembersList.innerHTML = '<div class="member-empty">暂无屏蔽成员</div>';
  } else {
    blockedDeviceIds.forEach(deviceId => {
      const item = document.createElement('div');
      item.className = 'member-item blocked';

      const meta = document.createElement('div');
      meta.className = 'member-meta';

      const name = document.createElement('div');
      name.className = 'member-name';
      name.textContent = `设备 ${deviceId}`;

      const desc = document.createElement('div');
      desc.className = 'member-desc';
      desc.textContent = '已被房主屏蔽';

      meta.appendChild(name);
      meta.appendChild(desc);
      item.appendChild(meta);

      if (ownerMode) {
        const actions = document.createElement('div');
        actions.className = 'member-actions';
        actions.appendChild(createActionButton('恢复', 'rotate-ccw', '', () => {
          sendRoomAction({
            action: 'unblock',
            targetDeviceId: deviceId
          });
        }));
        item.appendChild(actions);
      }

      blockedMembersList.appendChild(item);
    });
  }

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function leaveCurrentRoomState(message) {
  roomAccessMessage = message;
  roomMembers = [];
  blockedDeviceIds = [];
  roomOwnerSocketId = null;
  setComposerDisabled(true, message);
  renderRoomManagementPanel();
  Object.keys(peerConnections).forEach(cleanupPeer);
  updateConnectionUI();
}

// Set up UI updates based on WebRTC connections
function updateConnectionUI() {
  const peersCount = Object.keys(dataChannels).filter(id => dataChannels[id].readyState === 'open').length;
  peerCountDisplay.textContent = `${peersCount} 个设备`;

  if (roomAccessMessage) {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.textContent = roomAccessMessage;
    sendBtn.disabled = true;
    setComposerDisabled(true, roomAccessMessage);
    return;
  }

  setComposerDisabled(false);

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
  
  // Preserve server-provided deviceId; only use socket id prefix as fallback.
  if (!peerNames[peerId]) {
    setPeerDisplayName(peerId);
  }

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

        if (totalChunks === 0) {
          triggerFileCompletion(peerId);
        }
        
        // Reply file-ready to sender
        sendControlMessage(peerId, {
          type: 'file-ready',
          fileId: fileId
        });
      } else if (data.type === 'file-ready') {
        const { fileId } = data;
        const transfer = outgoingTransfers[fileId];
        if (transfer && !transfer.cancelled) {
          // Initialize progress record for this peer
          if (!transfer.peers[peerId]) {
            transfer.peers[peerId] = { currentChunk: 0, totalChunks: Math.ceil(transfer.file.size / CHUNK_SIZE) };
          }
          // Start sending
          startFileSendingLoop(peerId, fileId, transfer.file);
        }
      } else if (data.type === 'file-cancel') {
        handleFileCancelMessage(peerId, data.fileId);
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
  const targetPeerIds = Object.keys(dataChannels).filter(peerId => dataChannels[peerId].readyState === 'open');
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const peers = {};
  targetPeerIds.forEach(peerId => {
    peers[peerId] = { currentChunk: 0, totalChunks };
  });

  // Register in outgoingTransfers
  outgoingTransfers[fileId] = {
    file: file,
    cancelled: false,
    readers: {},
    peers
  };

  // Append self bubble
  appendFileBubble(true, '我', fileId, file.name, file.size, file.type);

  // Send metadata to all peers
  const metadata = {
    type: 'file-metadata',
    fileId: fileId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    totalChunks: totalChunks
  };

  targetPeerIds.forEach(peerId => {
    sendControlMessage(peerId, metadata);
  });
}

// Send loop for file chunks with backpressure handling
function startFileSendingLoop(peerId, fileId, file) {
  const fc = fileChannels[peerId];
  if (!fc || fc.readyState !== 'open') return;

  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.cancelled) return;

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let currentChunk = transfer.peers[peerId]?.currentChunk || 0;
  const threshold = 65536; // 64KB
  fc.bufferedAmountLowThreshold = threshold;

  function sendNext() {
    const latestTransfer = outgoingTransfers[fileId];
    if (!latestTransfer || latestTransfer.cancelled) return;

    // Check if channel is still open
    if (!fileChannels[peerId] || fileChannels[peerId].readyState !== 'open') return;

    while (currentChunk < totalChunks) {
      if (fc.bufferedAmount > threshold) {
        fc.onbufferedamountlow = () => {
          fc.onbufferedamountlow = null;
          const latestTransfer = outgoingTransfers[fileId];
          if (!latestTransfer || latestTransfer.cancelled) return;
          sendNext();
        };
        return;
      }

      const start = currentChunk * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      const reader = new FileReader();
      transfer.readers[peerId] = reader;
      reader.onload = (e) => {
        const latestTransfer = outgoingTransfers[fileId];
        if (!latestTransfer || latestTransfer.cancelled) return;

        try {
          fc.send(e.target.result);
          currentChunk++;
          updateOutgoingProgress(fileId, peerId, currentChunk, totalChunks);
          sendNext();
        } catch (err) {
          console.error(`Error sending file chunk to ${peerId}:`, err);
        } finally {
          const activeTransfer = outgoingTransfers[fileId];
          if (activeTransfer?.readers[peerId] === reader) {
            delete activeTransfer.readers[peerId];
          }
        }
      };
      reader.onerror = () => {
        const activeTransfer = outgoingTransfers[fileId];
        if (activeTransfer?.readers[peerId] === reader) {
          delete activeTransfer.readers[peerId];
        }
        if (!outgoingTransfers[fileId]?.cancelled) {
          console.error(`Error reading file chunk for ${peerId}:`, reader.error);
        }
      };
      reader.onabort = () => {
        const activeTransfer = outgoingTransfers[fileId];
        if (activeTransfer?.readers[peerId] === reader) {
          delete activeTransfer.readers[peerId];
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

// Cancel an outgoing file transfer and notify every target peer
function cancelOutgoingTransfer(fileId) {
  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.cancelled || transfer.completed) return;

  transfer.cancelled = true;

  Object.values(transfer.readers).forEach(reader => {
    if (reader.readyState === FileReader.LOADING) {
      try { reader.abort(); } catch (err) {}
    }
  });
  transfer.readers = {};

  Object.keys(transfer.peers).forEach(peerId => {
    const fc = fileChannels[peerId];
    if (fc) fc.onbufferedamountlow = null;
    sendControlMessage(peerId, {
      type: 'file-cancel',
      fileId
    });
  });

  markFileTransferCancelled(fileId, transfer.file.size, '已取消发送');
  showToast('已取消文件发送', 'info');
}

// Handle transfer cancellation from the remote sender
function handleFileCancelMessage(peerId, fileId) {
  const incoming = incomingFiles[peerId];
  if (incoming && incoming.fileId === fileId) {
    const fileSize = incoming.size;
    incoming.chunks = [];
    incomingFiles[peerId] = { fileId, cancelled: true };
    markFileTransferCancelled(fileId, fileSize, '对方已取消发送');
    return;
  }

  const outgoing = outgoingTransfers[fileId];
  if (outgoing?.peers[peerId]) {
    outgoing.peers[peerId].cancelled = true;
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

// Receive binary chunk from peer
function handleIncomingFileChunk(peerId, arrayBuffer) {
  const fileTransfer = incomingFiles[peerId];
  if (!fileTransfer) {
    console.error(`Received chunk from ${peerId} but no file metadata registered.`);
    return;
  }

  if (fileTransfer.cancelled) {
    return;
  }

  fileTransfer.chunks.push(arrayBuffer);
  fileTransfer.receivedChunksCount++;

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
function appendFileBubble(isSelf, senderName, fileId, fileName, fileSize, fileType, timestamp = null, saveToCache = true, isHistory = false) {
  const timeStr = timestamp || getFormattedTime();
  const emptyMsg = messagesList.querySelector('.system-message');
  if (emptyMsg && messagesList.children.length === 1) {
    messagesList.removeChild(emptyMsg);
  }

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${isSelf ? 'self' : 'peer'}`;
  
  const info = document.createElement('div');
  info.className = 'message-info';
  info.textContent = `${senderName} • ${timeStr}`;
  
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  
  // Decide icon based on file extension
  let iconName = 'file';
  const ext = fileName ? fileName.split('.').pop().toLowerCase() : '';
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
  const statusText = isHistory ? `${formattedSize} • 历史文件记录` : (isSelf ? '正在发送 0%' : '正在接收 0%');
  
  bubble.innerHTML = `
    <div class="file-bubble-container" id="msg-${fileId}">
      <div class="file-info-header">
        <div class="file-icon-wrapper">
          <i data-lucide="${iconName}"></i>
        </div>
        <div class="file-details">
          <div class="file-name" title="${fileName}">${fileName}</div>
          <div class="file-meta-info" id="progress-meta-${fileId}">${statusText}</div>
        </div>
      </div>
      <div class="progress-bar-container" id="progress-container-${fileId}" style="${isHistory ? 'display: none;' : ''}">
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

  if (isSelf && !isHistory) {
    const actionsContainer = document.getElementById(`actions-${fileId}`);
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'file-action-btn danger';
    cancelBtn.innerHTML = '<i data-lucide="x"></i>取消';
    cancelBtn.onclick = () => cancelOutgoingTransfer(fileId);
    actionsContainer.appendChild(cancelBtn);
  }
  
  messagesList.scrollTop = messagesList.scrollHeight;
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  if (saveToCache) {
    saveMessageToStorage({
      type: 'file',
      fileId,
      fileName,
      fileSize,
      fileType,
      isSelf,
      senderName,
      time: timeStr
    });
  }
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
    if (!roomAccessMessage) {
      socket.emit('join', { roomId, deviceId: myDeviceId });
    }
    renderRoomManagementPanel();
    updateConnectionUI();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from signaling server');
    // Cleanup all peers since connection lost
    Object.keys(peerConnections).forEach(cleanupPeer);
    renderRoomManagementPanel();
    updateConnectionUI();
  });

  socket.on('join-denied', ({ reason }) => {
    if (reason === 'blocked') {
      leaveCurrentRoomState('你已被房主屏蔽');
      appendSystemMessage('你已被房主屏蔽，当前无法加入该房间');
      showToast('你已被房主屏蔽', 'error');
      return;
    }

    leaveCurrentRoomState('无法加入当前房间');
    appendSystemMessage('无法加入当前房间');
  });

  // Get initial list of peers in the room
  socket.on('peers', ({ peers }) => {
    console.log('Received list of existing peers:', peers);
    // As the new joiner, we will initiate WebRTC connections to everyone
    peers.forEach(peer => {
      setPeerDisplayName(peer.socketId, peer.deviceId);
      startNegotiation(peer.socketId);
    });
  });

  // Peer joined the room
  socket.on('peer-joined', ({ peerId, deviceId }) => {
    console.log(`Peer joined: ${peerId} (${deviceId})`);
    setPeerDisplayName(peerId, deviceId);
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

  socket.on('room-state', ({ ownerSocketId, members, blockedDeviceIds: nextBlockedDeviceIds }) => {
    const previousOwnerSocketId = roomOwnerSocketId;
    roomOwnerSocketId = ownerSocketId;
    roomMembers = members || [];
    blockedDeviceIds = nextBlockedDeviceIds || [];
    roomMembers.forEach(member => {
      setPeerDisplayName(member.socketId, member.deviceId);
    });
    renderRoomManagementPanel();

    if (previousOwnerSocketId && previousOwnerSocketId !== ownerSocketId) {
      const nextOwner = roomMembers.find(member => member.socketId === ownerSocketId);
      if (socket && ownerSocketId === socket.id) {
        appendSystemMessage('你现在是当前房间的房主');
      } else if (nextOwner) {
        appendSystemMessage(`当前房主已切换为设备 ${nextOwner.deviceId}`);
      }
    }
  });

  socket.on('removed-from-room', ({ reason }) => {
    if (reason === 'blocked') {
      leaveCurrentRoomState('你已被房主屏蔽');
      appendSystemMessage('你已被房主屏蔽，并移出了当前房间');
      showToast('你已被房主屏蔽', 'error');
      return;
    }

    leaveCurrentRoomState('你已被房主移出');
    appendSystemMessage('你已被房主移出当前房间，可刷新后重新加入');
    showToast('你已被房主移出当前房间', 'info');
  });

  socket.on('room-action-error', ({ message }) => {
    showToast(message || '房间操作失败', 'error');
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
  clearChatHistory();
});

const mobileClearBtn = document.getElementById('mobile-clear-btn');
if (mobileClearBtn) {
  mobileClearBtn.addEventListener('click', () => {
    clearChatHistory();
  });
}

// Listen to Hash Change to allow changing rooms on the fly
window.addEventListener('hashchange', () => {
  window.location.reload();
});

// Initialize notification permissions
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

renderRoomManagementPanel();

// Mobile Sidebar Toggle
const mobileInfoBtn = document.getElementById('mobile-info-btn');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');
const sidebar = document.querySelector('.sidebar');

if (mobileInfoBtn && sidebar) {
  mobileInfoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('mobile-active');
  });
}

if (closeSidebarBtn && sidebar) {
  closeSidebarBtn.addEventListener('click', () => {
    sidebar.classList.remove('mobile-active');
  });
}

document.addEventListener('click', (e) => {
  if (sidebar && sidebar.classList.contains('mobile-active')) {
    if (!sidebar.contains(e.target) && mobileInfoBtn && !mobileInfoBtn.contains(e.target)) {
      sidebar.classList.remove('mobile-active');
    }
  }
});

// Display persistent device ID
myPeerIdDisplay.textContent = `设备 ${myDeviceId}`;

// Initialize Room ID
updateRoomURL();

// Load chat history for current room
loadChatHistory();

// Fetch local Server details & IP (for QR & Direct LAN access info)
fetchServerInfo();

// Start signaling
connectSignaling();
