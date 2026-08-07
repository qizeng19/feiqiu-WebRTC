export function generateRandomRoomId() {
  const min = 10;
  const max = 99;
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

export function getFormattedTime() {
  const now = new Date();
  return now.toTimeString().split(' ')[0].substring(0, 5);
}

export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
