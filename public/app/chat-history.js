import { DEFAULT_ROOM_ID, MAX_HISTORY_ITEMS, STORAGE_KEY_PREFIX } from './config.js';
import { appState } from './state.js';

export function getStorageKey() {
  return STORAGE_KEY_PREFIX + (appState.roomId || DEFAULT_ROOM_ID);
}

export function saveMessageToStorage(message) {
  if (!appState.roomId) return;
  try {
    const history = JSON.parse(localStorage.getItem(getStorageKey()) || '[]');
    history.push(message);
    if (history.length > MAX_HISTORY_ITEMS) {
      history.shift();
    }
    localStorage.setItem(getStorageKey(), JSON.stringify(history));
  } catch (error) {
    console.error('Failed to save chat history to localStorage:', error);
  }
}

export function getChatHistory() {
  if (!appState.roomId) return [];
  try {
    return JSON.parse(localStorage.getItem(getStorageKey()) || '[]');
  } catch (error) {
    console.error('Failed to load chat history from localStorage:', error);
    return [];
  }
}

export function clearChatHistoryStorage() {
  if (!appState.roomId) return;
  try {
    localStorage.removeItem(getStorageKey());
  } catch (error) {
    console.error('Failed to clear chat history from localStorage:', error);
  }
}
