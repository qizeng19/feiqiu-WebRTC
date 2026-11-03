export const CHUNK_SIZE = 16384;
export const DEFAULT_ROOM_ID = '88';
export const STORAGE_KEY_PREFIX = 'feiqiu_chat_history_';
export const MAX_HISTORY_ITEMS = 200;

// 心跳保活与重连配置
export const HEARTBEAT_INTERVAL = 3000;      // 每 3 秒发送一次轻量保活心跳包，保持 NAT 映射与无线网卡活跃
export const HEARTBEAT_TIMEOUT = 12000;      // 12 秒无心跳响应判定为假死断开
export const DISCONNECT_GRACE_PERIOD = 4000; // WebRTC disconnected 状态等待自愈容忍时间（毫秒）

export const rtcConfig = {
  // 此工具用于同一局域网，直接交换 host candidates，避免依赖公网 STUN。
  iceServers: [],
  iceCandidatePoolSize: 0
};
