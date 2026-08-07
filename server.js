const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const PORT = process.env.PORT || 3004;
const roomStates = new Map();

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Helper to get local IP address
function getLocalIPs() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // family can be 'IPv4' or 4 depending on Node version
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      if (isIPv4 && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips.length > 0 ? ips : ['localhost'];
}

// API endpoint to let the client know the server's LAN IP
app.get('/api/info', (req, res) => {
  res.json({
    ips: getLocalIPs(),
    port: PORT
  });
});

function getOrCreateRoomState(roomId) {
  if (!roomStates.has(roomId)) {
    roomStates.set(roomId, {
      ownerSocketId: null,
      blockedDeviceIds: new Set()
    });
  }
  return roomStates.get(roomId);
}

function getRoomMembers(roomId) {
  const clients = io.sockets.adapter.rooms.get(roomId);
  const members = [];

  if (!clients) {
    return members;
  }

  for (const clientId of clients) {
    const clientSocket = io.sockets.sockets.get(clientId);
    if (!clientSocket) {
      continue;
    }
    members.push({
      socketId: clientSocket.id,
      deviceId: clientSocket.deviceId || clientSocket.id.substring(0, 4)
    });
  }

  return members;
}

function syncRoomOwner(roomId) {
  const state = roomStates.get(roomId);
  if (!state) {
    return null;
  }

  const members = getRoomMembers(roomId);
  const ownerStillPresent = members.some(member => member.socketId === state.ownerSocketId);

  if (!ownerStillPresent) {
    state.ownerSocketId = members[0] ? members[0].socketId : null;
  }

  return state.ownerSocketId;
}

function emitRoomState(roomId) {
  const state = roomStates.get(roomId);
  if (!state) {
    return;
  }

  const members = getRoomMembers(roomId);
  if (members.length === 0) {
    roomStates.delete(roomId);
    return;
  }

  syncRoomOwner(roomId);

  io.to(roomId).emit('room-state', {
    roomId,
    ownerSocketId: state.ownerSocketId,
    members,
    blockedDeviceIds: Array.from(state.blockedDeviceIds)
  });
}

function removeSocketFromRoom(targetSocket, roomId, reason) {
  if (!targetSocket || targetSocket.currentRoom !== roomId) {
    return;
  }

  targetSocket.emit('removed-from-room', {
    roomId,
    reason
  });
  targetSocket.leave(roomId);
  targetSocket.currentRoom = null;

  targetSocket.to(roomId).emit('peer-left', { peerId: targetSocket.id });
  syncRoomOwner(roomId);
  emitRoomState(roomId);
}

// Socket.io signaling
io.on('connection', (socket) => {
  socket.on('join', ({ roomId, deviceId }) => {
    socket.deviceId = deviceId || socket.id.substring(0, 4);
    const state = getOrCreateRoomState(roomId);

    if (state.blockedDeviceIds.has(socket.deviceId)) {
      socket.emit('join-denied', {
        roomId,
        reason: 'blocked'
      });
      return;
    }

    socket.currentRoom = roomId;
    socket.join(roomId);

    if (!state.ownerSocketId) {
      state.ownerSocketId = socket.id;
    }

    // Get all clients in this room (excluding the current one)
    const clients = io.sockets.adapter.rooms.get(roomId);
    const peers = [];
    if (clients) {
      for (const clientId of clients) {
        if (clientId !== socket.id) {
          const clientSocket = io.sockets.sockets.get(clientId);
          peers.push({
            socketId: clientId,
            deviceId: clientSocket ? clientSocket.deviceId : clientId.substring(0, 4)
          });
        }
      }
    }

    // Tell the joining client about existing peers in the room
    socket.emit('peers', { peers });

    // Tell existing peers about the new user
    socket.to(roomId).emit('peer-joined', { peerId: socket.id, deviceId: socket.deviceId });
    emitRoomState(roomId);
  });

  socket.on('signal', ({ targetId, signal }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!socket.currentRoom || !targetSocket || targetSocket.currentRoom !== socket.currentRoom) {
      return;
    }

    // Forward signaling data (offer, answer, candidate) to the target peer
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signal
    });
  });

  socket.on('room-action', ({ action, targetSocketId, targetDeviceId }) => {
    const roomId = socket.currentRoom;
    if (!roomId) {
      return;
    }

    const state = roomStates.get(roomId);
    if (!state || state.ownerSocketId !== socket.id) {
      socket.emit('room-action-error', {
        message: '只有房主可以执行此操作'
      });
      return;
    }

    if (action === 'unblock') {
      if (!targetDeviceId) {
        return;
      }
      state.blockedDeviceIds.delete(targetDeviceId);
      emitRoomState(roomId);
      return;
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket || targetSocket.currentRoom !== roomId || targetSocket.id === socket.id) {
      socket.emit('room-action-error', {
        message: '目标成员不存在或无法操作'
      });
      return;
    }

    if (action === 'kick') {
      removeSocketFromRoom(targetSocket, roomId, 'kicked');
      return;
    }

    if (action === 'block') {
      state.blockedDeviceIds.add(targetSocket.deviceId || targetSocket.id.substring(0, 4));
      removeSocketFromRoom(targetSocket, roomId, 'blocked');
    }
  });

  socket.on('disconnect', () => {
    if (socket.currentRoom) {
      const roomId = socket.currentRoom;
      socket.to(roomId).emit('peer-left', { peerId: socket.id });
      socket.currentRoom = null;
      syncRoomOwner(roomId);
      emitRoomState(roomId);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('--------------------------------------------------');
  console.log('FeiQiu WebRTC LAN Sharing Server started!');
  console.log(`Local access: http://localhost:${PORT}`);
  console.log('LAN access URLs:');
  ips.forEach(ip => {
    console.log(`  http://${ip}:${PORT}`);
  });
  console.log('--------------------------------------------------');
});
