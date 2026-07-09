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

// Socket.io signaling
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ roomId, deviceId }) => {
    currentRoom = roomId;
    socket.deviceId = deviceId || socket.id.substring(0, 4);
    socket.join(roomId);

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
  });

  socket.on('signal', ({ targetId, signal }) => {
    // Forward signaling data (offer, answer, candidate) to the target peer
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signal
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('peer-left', { peerId: socket.id });
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
