export const CHUNK_SIZE = 16384;
export const DEFAULT_ROOM_ID = '88';
export const STORAGE_KEY_PREFIX = 'feiqiu_chat_history_';
export const MAX_HISTORY_ITEMS = 200;

export const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};
