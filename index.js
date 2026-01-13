import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);

const app = express();

/* ───────────────── CORS (CRITICAL) ───────────────── */

app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Cache-Control',   // ← REQUIRED
  ],
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

const wss = new WebSocketServer({
  server,
  path: '/signal', // ← MUST MATCH CLIENT
});

/*
rooms: single-use only
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

      rooms.set(room, {
        peers: new Set([ws]),
        offererId: sender,
      });

      send(ws, {
        type: 'peer-present',
        room,
        payload: {
          count: 1,
          offererId: sender,
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
    if (joinedRoom) destroyRoom(joinedRoom);
  });

  ws.on('error', () => {
    if (joinedRoom) destroyRoom(joinedRoom);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling + TURN running on ${PORT}`);
});
