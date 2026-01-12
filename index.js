import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);

const app = express();

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Accept', 'Content-Type', 'Cache-Control'],
  })
);

app.options('*', cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ───────────────── TURN ENDPOINT ───────────────── */

app.get('/turn', async (_, res) => {
  try {
    if (!process.env.TURN_ENDPOINT) {
      res.status(500).json({ error: 'TURN_ENDPOINT not set' });
      return;
    }

    const response = await fetch(process.env.TURN_ENDPOINT, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      res.status(502).json({ error: 'TURN upstream failure' });
      return;
    }

    const data = await response.json();
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch {
    res.status(500).json({ error: 'TURN service unavailable' });
  }
});

/* ───────────────── SIGNALING ───────────────── */

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
      const offererId = peers[0];

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
      r.offer = { type: 'offer', room: joinedRoom, payload };
      broadcast(joinedRoom, ws, r.offer);
      return;
    }

    if (type === 'answer') {
      r.answer = { type: 'answer', room: joinedRoom, payload };
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
    if (r.peers.size < 2) destroyRoom(joinedRoom);
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence signaling + TURN running on ${PORT}`);
});
