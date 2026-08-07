import { myPeerIdDisplay } from './dom.js';
import { initEventListeners } from './events.js';
import { connectSignaling } from './signaling.js';
import { appState } from './state.js';
import { initStaticUI, fetchServerInfo, loadChatHistory, renderRoomManagementPanel, updateRoomURL } from './ui.js';
import { initViewport } from './viewport.js';

initViewport();
initStaticUI();
initEventListeners();

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

myPeerIdDisplay.textContent = `设备 ${appState.myDeviceId}`;
updateRoomURL();
loadChatHistory();
renderRoomManagementPanel();
fetchServerInfo();
connectSignaling();
