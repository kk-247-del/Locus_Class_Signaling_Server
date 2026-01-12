import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Set<WebSocket>,
}>
*/
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(roomId, except, msg) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const ws of room.peers) {
    if (ws !== except && ws.readyState === ws.OPEN) {
      send(ws, msg);
    }
  }
}

function destroyRoom(roomId) {
  rooms.delete(roomId);
}

wss.on('connection', (ws) => {
  let joinedRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, room, payload } = msg;
    if (!type || !room) return;

    /* ───────── JOIN ───────── */
    if (type === 'join') {
      joinedRoom = room;

      if (!rooms.has(room)) {
        rooms.set(room, { peers: new Set() });
      }

      const r = rooms.get(room);
      r.peers.add(ws);

      const peers = Array.from(r.peers);
      const offererIndex = 0;

      for (let i = 0; i < peers.length; i++) {
        send(peers[i], {
          type: 'peer-present',
          room,
          payload: {
            count: peers.length,
            offerer: i === offererIndex,
          },
        });
      }

      return;
    }

    if (!joinedRoom) return;

    /* ───────── SDP / ICE ───────── */
    if (
      type === 'offer' ||
      type === 'answer' ||
      type === 'candidate'
    ) {
      broadcast(joinedRoom, ws, {
        type,
        room: joinedRoom,
        payload,
      });
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;

    const r = rooms.get(joinedRoom);
    if (!r) return;

    r.peers.delete(ws);

    if (r.peers.size === 0) {
      destroyRoom(joinedRoom);
    }
  });

  ws.on('error', () => {
    ws.close();
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence signaling running on ${PORT}`);
});
