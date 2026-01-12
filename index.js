import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);
const TURN_ENDPOINT = process.env.TURN_ENDPOINT;

const app = express();

/* ───────────── CORS ───────────── */

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Cache-Control'],
  }),
);

app.options('*', cors());

/* ───────────── TURN ───────────── */

app.get('/turn', async (_, res) => {
  if (!TURN_ENDPOINT) {
    res.status(500).json({ error: 'TURN_ENDPOINT not set' });
    return;
  }

  try {
    const r = await fetch(TURN_ENDPOINT, {
      headers: { Accept: 'application/json' },
    });

    if (!r.ok) {
      res.status(502).json({ error: 'TURN upstream failure' });
      return;
    }

    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch {
    res.status(500).json({ error: 'TURN unavailable' });
  }
});

/* ───────────── SIGNALING ───────────── */

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, Map<WebSocket, senderId>>
*/
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function destroyRoom(roomId) {
  const peers = rooms.get(roomId);
  if (!peers) return;

  for (const ws of peers.keys()) {
    try {
      ws.close();
    } catch {}
  }

  rooms.delete(roomId);
  console.log(`[ROOM] destroyed ${roomId}`);
}

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, room, sender, payload } = msg;
    if (!type || !room) return;

    if (type === 'join') {
      roomId = room;

      if (!rooms.has(room)) {
        rooms.set(room, new Map());
      }

      const peers = rooms.get(room);

      // Enforce max 2 peers
      if (peers.size >= 2) {
        destroyRoom(room);
        rooms.set(room, new Map());
      }

      peers.set(ws, sender);

      const offererId = peers.values().next().value;

      for (const p of peers.keys()) {
        send(p, {
          type: 'peer-present',
          room,
          payload: {
            count: peers.size,
            offererId,
          },
        });
      }

      return;
    }

    if (!roomId) return;

    if (type === 'offer' || type === 'answer' || type === 'candidate') {
      const peers = rooms.get(roomId);
      if (!peers) return;

      for (const p of peers.keys()) {
        if (p !== ws) {
          send(p, { type, room: roomId, payload });
        }
      }
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    destroyRoom(roomId);
  });

  ws.on('error', () => {
    if (!roomId) return;
    destroyRoom(roomId);
  });
});

/* ───────────── START ───────────── */

server.listen(PORT, () => {
  console.log(`Hi Presence signaling + TURN running on ${PORT}`);
});
