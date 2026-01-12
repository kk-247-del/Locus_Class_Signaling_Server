import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);
const TURN_ENDPOINT = process.env.TURN_ENDPOINT;

const app = express();

/* ───────────────── CORS ───────────────── */

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }),
);

app.options('*', cors());

/* ───────────────── HTTP SERVER ───────────────── */

const server = http.createServer(app);

/* ───────────────── TURN ENDPOINT ───────────────── */

app.get('/turn', async (_, res) => {
  if (!TURN_ENDPOINT) {
    res.status(500).json({ error: 'TURN_ENDPOINT not set' });
    return;
  }

  try {
    const response = await fetch(TURN_ENDPOINT, {
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

/* ───────────────── WEBSOCKET SIGNALING ───────────────── */

const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
  peers: Map<WebSocket, senderId>
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
  const room = rooms.get(roomId);
  if (!room) return;

  for (const ws of room.peers.keys()) {
    try {
      ws.close();
    } catch {}
  }

  rooms.delete(roomId);
  console.log(`[ROOM] destroyed ${roomId}`);
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

      destroyRoom(room);

      rooms.set(room, {
        peers: new Map([[ws, sender]]),
      });

      send(ws, {
        type: 'peer-present',
        room,
        payload: {
          count: 1,
          offererId: sender,
        },
      });

      console.log(`[ROOM] ${room} joined by ${sender}`);
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
    destroyRoom(joinedRoom);
  });

  ws.on('error', () => {
    if (!joinedRoom) return;
    destroyRoom(joinedRoom);
  });
});

/* ───────────────── START ───────────────── */

server.listen(PORT, () => {
  console.log(`Hi Presence signaling + TURN running on ${PORT}`);
});
