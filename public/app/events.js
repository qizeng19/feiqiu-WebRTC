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
  mobileClearBtn,
  mobileInfoBtn,
  newRoomBtn,
  navRail,
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

  if (mobileInfoBtn && sidebar) {
    mobileInfoBtn.addEventListener('click', event => {
      event.stopPropagation();
      sidebar.classList.toggle('mobile-active');
      if (navRail) {
        navRail.classList.toggle('mobile-active');
      }
    });
  }

  if (closeSidebarBtn && sidebar) {
    closeSidebarBtn.addEventListener('click', () => {
      sidebar.classList.remove('mobile-active');
      if (navRail) {
        navRail.classList.remove('mobile-active');
      }
    });
  }

  document.addEventListener('click', event => {
    if ((sidebar && sidebar.classList.contains('mobile-active')) || (navRail && navRail.classList.contains('mobile-active'))) {
      const clickInsideNavRail = navRail && navRail.contains(event.target);
      const clickInsideSidebar = sidebar && sidebar.contains(event.target);
      if (!clickInsideSidebar && !clickInsideNavRail && mobileInfoBtn && !mobileInfoBtn.contains(event.target)) {
        sidebar.classList.remove('mobile-active');
        if (navRail) {
          navRail.classList.remove('mobile-active');
        }
      }
    }
  });
}
