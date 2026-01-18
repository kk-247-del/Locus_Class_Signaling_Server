import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);

const app = express();

/* ───────────────── CORS ───────────────── */

app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Cache-Control'],
}));

app.options('*', cors());

/* ───────────────── TURN ENDPOINT ───────────────── */

app.get('/turn', async (_, res) => {
  try {
    if (!process.env.TURN_ENDPOINT) {
      res.status(500).json({ error: 'TURN_ENDPOINT not set' });
      return;
    }

    const response = await fetch(process.env.TURN_ENDPOINT, {
      headers: { Accept: 'application/json' },
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

const server = http.createServer(app);

/* ───────────────── WEBSOCKET ───────────────── */

const wss = new WebSocketServer({ server });

/*
Map<roomId, {
  peers: Set<WebSocket>,
  offererId: string
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

  for (const peer of room.peers) {
    if (peer !== except && peer.readyState === peer.OPEN) {
      send(peer, msg);
    }
  }
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

      let entry = rooms.get(room);
      if (!entry) {
        entry = {
          peers: new Set(),
          offererId: sender, // first peer is always offerer
        };
        rooms.set(room, entry);
      }

      entry.peers.add(ws);

      send(ws, {
        type: 'peer-present',
        room,
        payload: {
          count: entry.peers.size,
          offererId: entry.offererId,
        },
      });

      broadcast(room, ws, {
        type: 'peer-present',
        room,
        payload: {
          count: entry.peers.size,
          offererId: entry.offererId,
        },
      });

      return;
    }

    if (!joinedRoom) return;

    if (type === 'offer' || type === 'answer' || type === 'candidate') {
      broadcast(joinedRoom, ws, {
        type,
        room: joinedRoom,
        payload,
      });
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    room.peers.delete(ws);
    if (room.peers.size === 0) {
      rooms.delete(joinedRoom);
    }
  });

  ws.on('error', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    room.peers.delete(ws);
    if (room.peers.size === 0) {
      rooms.delete(joinedRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling + TURN running on ${PORT}`);
});
