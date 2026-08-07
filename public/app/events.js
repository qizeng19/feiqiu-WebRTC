import { appState } from './state.js';
import {
  attachBtn,
  chatPanel,
  charCount,
  clearChatBtn,
  closeSidebarBtn,
  copyUrlBtn,
  fileInput,
  lanUrlInput,
  mobileBackdrop,
  mobileClearBtn,
  mobileInfoBtn,
  mobileTabBtnDevices,
  mobileTabBtnQr,
  mobileTabContentDevices,
  mobileTabContentQr,
  navModerationPanel,
  navRail,
  newRoomBtn,
  sendBtn,
  sidebar,
  textInput
} from './dom.js';
import { handleFileSelect } from './file-transfer.js';
import { appendMessage, clearChatHistory, copyToClipboard, showToast } from './ui.js';
import { generateRandomRoomId } from './utils.js';

function sendMessage() {
  const text = textInput.value.trim();
  if (!text) return;

  const payload = JSON.stringify({
    type: 'text',
    text
  });

  let sentSuccessfully = false;
  Object.keys(appState.dataChannels).forEach(peerId => {
    const dataChannel = appState.dataChannels[peerId];
    if (dataChannel.readyState === 'open') {
      try {
        dataChannel.send(payload);
        sentSuccessfully = true;
      } catch (error) {
        console.error(`Error sending text to peer ${peerId}:`, error);
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

function restoreNavModerationPanel() {
  if (navModerationPanel && navRail && !navRail.contains(navModerationPanel)) {
    navRail.appendChild(navModerationPanel);
  }
}

function switchMobileTab(tab) {
  if (!mobileTabBtnQr || !mobileTabBtnDevices || !mobileTabContentQr || !mobileTabContentDevices) return;
  if (tab === 'qr') {
    mobileTabBtnQr.classList.add('active');
    mobileTabBtnDevices.classList.remove('active');
    mobileTabContentQr.style.display = 'flex';
    mobileTabContentDevices.style.display = 'none';
  } else if (tab === 'devices') {
    mobileTabBtnDevices.classList.add('active');
    mobileTabBtnQr.classList.remove('active');
    mobileTabContentDevices.style.display = 'flex';
    mobileTabContentQr.style.display = 'none';
    if (navModerationPanel && mobileTabContentDevices) {
      mobileTabContentDevices.appendChild(navModerationPanel);
    }
  }
}

function openMobileDrawer() {
  if (sidebar) {
    sidebar.classList.add('mobile-active');
  }
  if (mobileBackdrop) {
    mobileBackdrop.classList.add('active');
  }
  document.body.style.overflow = 'hidden';
  switchMobileTab('qr');
}

function closeMobileDrawer() {
  if (sidebar) {
    sidebar.classList.remove('mobile-active');
  }
  if (mobileBackdrop) {
    mobileBackdrop.classList.remove('active');
  }
  document.body.style.overflow = '';
  restoreNavModerationPanel();
}

export function initEventListeners() {
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', event => {
      if (event.target.files && event.target.files.length > 0) {
        handleFileSelect(event.target.files[0]);
        fileInput.value = '';
      }
    });
  }

  if (chatPanel) {
    ['dragenter', 'dragover'].forEach(eventName => {
      chatPanel.addEventListener(eventName, event => {
        event.preventDefault();
        chatPanel.classList.add('drag-active');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      chatPanel.addEventListener(eventName, event => {
        event.preventDefault();
        chatPanel.classList.remove('drag-active');
      }, false);
    });

    chatPanel.addEventListener('drop', event => {
      const files = event.dataTransfer.files;
      if (files && files.length > 0) {
        handleFileSelect(files[0]);
      }
    });
  }

  textInput.addEventListener('input', () => {
    charCount.textContent = `${textInput.value.length} 字符`;
  });

  textInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  copyUrlBtn.addEventListener('click', () => {
    copyToClipboard(lanUrlInput.value, '局域网链接已复制，去发送吧！');
  });

  newRoomBtn.addEventListener('click', () => {
    window.location.hash = generateRandomRoomId();
    window.location.reload();
  });

  clearChatBtn.addEventListener('click', clearChatHistory);

  if (mobileClearBtn) {
    mobileClearBtn.addEventListener('click', clearChatHistory);
  }

  window.addEventListener('hashchange', () => {
    window.location.reload();
  });

  if (mobileInfoBtn) {
    mobileInfoBtn.addEventListener('click', event => {
      event.stopPropagation();
      openMobileDrawer();
    });
  }

  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', () => {
      closeMobileDrawer();
    });
  }

  if (mobileBackdrop) {
    mobileBackdrop.addEventListener('click', () => {
      closeMobileDrawer();
    });
  }

  if (mobileTabBtnQr) {
    mobileTabBtnQr.addEventListener('click', () => {
      switchMobileTab('qr');
    });
  }

  if (mobileTabBtnDevices) {
    mobileTabBtnDevices.addEventListener('click', () => {
      switchMobileTab('devices');
    });
  }

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileDrawer();
    }
  });

  document.addEventListener('gesturestart', event => {
    event.preventDefault();
  });
}
