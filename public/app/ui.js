import { DEFAULT_ROOM_ID } from './config.js';
import { getChatHistory, clearChatHistoryStorage, saveMessageToStorage } from './chat-history.js';
import { appState, isRoomOwner, setLocalIp, setPort, setRoomAccessMessage, setRoomId } from './state.js';
import {
  attachBtn,
  blockedMembersList,
  defaultInputPlaceholder,
  fileInput,
  lanUrlInput,
  localIpDisplay,
  messagesList,
  peerCountDisplay,
  qrCodeImg,
  qrPlaceholder,
  roomIdDisplay,
  roomMembersList,
  roomRoleBadge,
  roomRoleHint,
  sendBtn,
  statusIndicator,
  statusText,
  textInput,
  toast
} from './dom.js';
import { formatBytes, getFormattedTime } from './utils.js';

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function removeInitialSystemMessageIfNeeded() {
  const emptyMessage = messagesList.querySelector('.system-message');
  if (emptyMessage && messagesList.children.length === 1) {
    messagesList.removeChild(emptyMessage);
  }
}

function emitRoomAction(payload) {
  if (!appState.socket || !appState.socket.connected) {
    showToast('信令服务未连接，无法执行该操作', 'error');
    return;
  }
  appState.socket.emit('room-action', payload);
}

function createRoomActionButton(label, icon, type, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `member-action-btn${type ? ` ${type}` : ''}`;
  button.innerHTML = `<i data-lucide="${icon}"></i>${label}`;
  button.addEventListener('click', onClick);
  return button;
}

export function showToast(message, type = 'info') {
  const toastMessage = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');

  toastMessage.textContent = message;

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

  refreshIcons();
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

export async function copyToClipboard(text, successMessage = '已复制到剪贴板') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage, 'success');
  } catch (error) {
    console.error('Failed to copy: ', error);
    const fallbackTextArea = document.createElement('textarea');
    fallbackTextArea.value = text;
    fallbackTextArea.style.position = 'fixed';
    document.body.appendChild(fallbackTextArea);
    fallbackTextArea.focus();
    fallbackTextArea.select();
    try {
      document.execCommand('copy');
      showToast(successMessage, 'success');
    } catch (fallbackError) {
      showToast('复制失败，请手动选择复制', 'error');
    }
    document.body.removeChild(fallbackTextArea);
  }
}

export function appendMessage(text, isSelf, senderName, timestamp = null, saveToCache = true) {
  const time = timestamp || getFormattedTime();
  removeInitialSystemMessageIfNeeded();

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${isSelf ? 'self' : 'peer'}`;

  const info = document.createElement('div');
  info.className = 'message-info';
  info.textContent = `${senderName} • ${time}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const textSpan = document.createElement('span');
  textSpan.textContent = text;
  bubble.appendChild(textSpan);

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
  messagesList.scrollTop = messagesList.scrollHeight;
  refreshIcons();

  if (saveToCache) {
    saveMessageToStorage({
      type: 'text',
      text,
      isSelf,
      senderName,
      time
    });
  }
}

export function appendSystemMessage(text) {
  const message = document.createElement('div');
  message.className = 'system-message';
  message.innerHTML = `<p>${text}</p>`;
  messagesList.appendChild(message);
  messagesList.scrollTop = messagesList.scrollHeight;
}

export function appendFileBubble(
  isSelf,
  senderName,
  fileId,
  fileName,
  fileSize,
  fileType,
  timestamp = null,
  saveToCache = true,
  isHistory = false,
  onCancel = null
) {
  const time = timestamp || getFormattedTime();
  removeInitialSystemMessageIfNeeded();

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${isSelf ? 'self' : 'peer'}`;

  const info = document.createElement('div');
  info.className = 'message-info';
  info.textContent = `${senderName} • ${time}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  let iconName = 'file';
  const extension = fileName ? fileName.split('.').pop().toLowerCase() : '';
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(extension)) {
    iconName = 'file-text';
  } else if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(extension)) {
    iconName = 'image';
  } else if (['mp3', 'wav', 'ogg', 'm4a'].includes(extension)) {
    iconName = 'music';
  } else if (['mp4', 'webm', 'mkv', 'avi'].includes(extension)) {
    iconName = 'video';
  } else if (['zip', 'rar', 'tar', 'gz', '7z'].includes(extension)) {
    iconName = 'archive';
  } else if (extension === 'apk') {
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
      <div class="file-actions" id="actions-${fileId}"></div>
    </div>
  `;

  wrapper.appendChild(info);
  wrapper.appendChild(bubble);
  messagesList.appendChild(wrapper);

  if (isSelf && !isHistory && onCancel) {
    const actionsContainer = document.getElementById(`actions-${fileId}`);
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'file-action-btn danger';
    cancelBtn.innerHTML = '<i data-lucide="x"></i>取消';
    cancelBtn.onclick = onCancel;
    actionsContainer.appendChild(cancelBtn);
  }

  messagesList.scrollTop = messagesList.scrollHeight;
  refreshIcons();

  if (saveToCache) {
    saveMessageToStorage({
      type: 'file',
      fileId,
      fileName,
      fileSize,
      fileType,
      isSelf,
      senderName,
      time
    });
  }
}

export function updateRoomURL() {
  const hash = window.location.hash;
  if (!hash || hash === '#' || hash === '#default') {
    setRoomId(DEFAULT_ROOM_ID);
    if (history.replaceState) {
      history.replaceState(null, '', `#${appState.roomId}`);
    } else {
      window.location.hash = appState.roomId;
    }
  } else {
    setRoomId(hash.substring(1));
  }

  roomIdDisplay.textContent = appState.roomId;
}

export function setComposerDisabled(disabled, placeholderText = defaultInputPlaceholder) {
  textInput.disabled = disabled;
  textInput.placeholder = placeholderText;
  if (attachBtn) {
    attachBtn.disabled = disabled;
  }
  if (fileInput) {
    fileInput.disabled = disabled;
  }
}

export function renderRoomManagementPanel() {
  const ownerMode = isRoomOwner();
  roomRoleBadge.textContent = ownerMode ? '当前房主' : '普通成员';
  roomRoleBadge.className = `role-badge${ownerMode ? ' owner' : ''}`;
  roomRoleHint.textContent = ownerMode
    ? '你可以将成员踢出当前房间，或加入屏蔽名单后再恢复。'
    : '当前房间的第一个进入者为房主，只有房主可以管理成员。';

  roomMembersList.innerHTML = '';
  if (appState.roomMembers.length === 0) {
    roomMembersList.innerHTML = '<div class="member-empty">等待成员加入...</div>';
  } else {
    appState.roomMembers.forEach(member => {
      const item = document.createElement('div');
      item.className = 'member-item';

      const meta = document.createElement('div');
      meta.className = 'member-meta';

      const name = document.createElement('div');
      name.className = 'member-name';
      const labels = [];
      if (member.socketId === appState.roomOwnerSocketId) {
        labels.push('房主');
      }
      if (appState.socket && member.socketId === appState.socket.id) {
        labels.push('我');
      }
      name.textContent = `设备 ${member.deviceId}${labels.length ? ` · ${labels.join(' / ')}` : ''}`;

      const desc = document.createElement('div');
      desc.className = 'member-desc';
      desc.textContent = member.socketId === appState.roomOwnerSocketId ? '当前房主' : '在线成员';
      if (appState.socket && member.socketId === appState.socket.id) {
        desc.textContent += ' · 当前设备';
      }

      meta.appendChild(name);
      meta.appendChild(desc);
      item.appendChild(meta);

      if (ownerMode && appState.socket && member.socketId !== appState.socket.id) {
        const actions = document.createElement('div');
        actions.className = 'member-actions';
        actions.appendChild(createRoomActionButton('踢出', 'log-out', 'warn', () => {
          emitRoomAction({
            action: 'kick',
            targetSocketId: member.socketId
          });
        }));
        actions.appendChild(createRoomActionButton('屏蔽', 'ban', 'danger', () => {
          emitRoomAction({
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
  if (appState.blockedDeviceIds.length === 0) {
    blockedMembersList.innerHTML = '<div class="member-empty">暂无屏蔽成员</div>';
  } else {
    appState.blockedDeviceIds.forEach(deviceId => {
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
        actions.appendChild(createRoomActionButton('恢复', 'rotate-ccw', '', () => {
          emitRoomAction({
            action: 'unblock',
            targetDeviceId: deviceId
          });
        }));
        item.appendChild(actions);
      }

      blockedMembersList.appendChild(item);
    });
  }

  refreshIcons();
}

export function leaveCurrentRoomState(message, cleanupPeers) {
  setRoomAccessMessage(message);
  appState.roomMembers = [];
  appState.blockedDeviceIds = [];
  appState.roomOwnerSocketId = null;
  setComposerDisabled(true, message);
  renderRoomManagementPanel();
  cleanupPeers();
  updateConnectionUI();
}

export function updateConnectionUI() {
  const connectedPeerCount = Object.keys(appState.dataChannels)
    .filter(peerId => appState.dataChannels[peerId].readyState === 'open')
    .length;

  peerCountDisplay.textContent = `${connectedPeerCount} 个设备`;

  if (appState.roomAccessMessage) {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.textContent = appState.roomAccessMessage;
    sendBtn.disabled = true;
    setComposerDisabled(true, appState.roomAccessMessage);
    return;
  }

  setComposerDisabled(false);

  if (connectedPeerCount > 0) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = `已连接 (${connectedPeerCount})`;
    sendBtn.disabled = false;
  } else if (appState.socket && appState.socket.connected) {
    statusIndicator.className = 'status-indicator connecting';
    statusText.textContent = '等待设备加入';
    sendBtn.disabled = true;
  } else {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.textContent = '未连接';
    sendBtn.disabled = true;
  }
}

export async function fetchServerInfo() {
  try {
    const response = await fetch('/api/info');
    const data = await response.json();
    setLocalIp(data.ips.find(ip => ip !== '127.0.0.1' && ip !== 'localhost') || 'localhost');
    setPort(data.port);
    localIpDisplay.textContent = appState.localIp;

    const lanUrl = `http://${appState.localIp}:${appState.port}/#${appState.roomId}`;
    lanUrlInput.value = lanUrl;

    qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(lanUrl)}`;
    qrCodeImg.onload = () => {
      qrPlaceholder.style.display = 'none';
      qrCodeImg.style.display = 'block';
    };
  } catch (error) {
    console.error('Failed to get server info:', error);
    localIpDisplay.textContent = '无法获取';
    const fallbackUrl = `${window.location.origin}/#${appState.roomId}`;
    lanUrlInput.value = fallbackUrl;

    qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(fallbackUrl)}`;
    qrCodeImg.onload = () => {
      qrPlaceholder.style.display = 'none';
      qrCodeImg.style.display = 'block';
    };
  }
}

export function clearChatHistory() {
  messagesList.innerHTML = '';
  appendSystemMessage('聊天记录已清空');
  clearChatHistoryStorage();
}

export function loadChatHistory() {
  const history = getChatHistory();
  if (history.length === 0) {
    return;
  }

  messagesList.innerHTML = '';
  history.forEach(message => {
    if (message.type === 'text') {
      appendMessage(message.text, message.isSelf, message.senderName, message.time, false);
    } else if (message.type === 'file') {
      appendFileBubble(
        message.isSelf,
        message.senderName,
        message.fileId,
        message.fileName,
        message.fileSize,
        message.fileType,
        message.time,
        false,
        true
      );
    }
  });
}

export function showNotification(title, text) {
  if (!('Notification' in window)) return;

  if (Notification.permission === 'granted') {
    new Notification(title, { body: text, icon: '/favicon.ico' });
    return;
  }

  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        new Notification(title, { body: text });
      }
    });
  }
}

export function initStaticUI() {
  refreshIcons();
}
