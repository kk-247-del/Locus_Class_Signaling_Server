 import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Map<WebSocket, senderId>,
  offer: null | object,
  answer: null | object
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

  for (const ws of room.peers.keys()) {
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

    const { type, room, payload, sender } = msg;
    if (!type || !room) return;

    if (type === 'join') {
      joinedRoom = room;

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Map(),
          offer: null,
          answer: null,
        });
      }

      const r = rooms.get(room);
      r.peers.set(ws, sender);

      const peers = Array.from(r.peers.values());
      const offererId = peers[0]; // first joiner only

      // Notify all peers
      for (const peerWs of r.peers.keys()) {
        send(peerWs, {
          type: 'peer-present',
          room,
          payload: {
            count: r.peers.size,
            offererId,
          },
        });
      }

      return;
    }

    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (!r) return;

    if (type === 'offer') {
      // Always overwrite stale offers
      r.offer = {
        type: 'offer',
        room: joinedRoom,
        payload,
      };
      broadcast(joinedRoom, ws, r.offer);
      return;
    }

    if (type === 'answer') {
      r.answer = {
        type: 'answer',
        room: joinedRoom,
        payload,
      };
      broadcast(joinedRoom, ws, r.answer);
      return;
    }

    if (type === 'candidate') {
      broadcast(joinedRoom, ws, {
        type: 'candidate',
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

    // HARD RESET when any peer leaves
    if (r.peers.size < 2) {
      destroyRoom(joinedRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence signaling running on ${PORT}`);
});
