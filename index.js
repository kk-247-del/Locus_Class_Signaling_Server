import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);

if (!process.env.TURN_ENDPOINT) {
  console.error('TURN_ENDPOINT not set');
  process.exit(1);
}

const app = express();

/* ───────────────── CORS (FIXED) ───────────────── */

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Cache-Control'],
  })
);

app.options('*', cors());

/* ───────────────── TURN ENDPOINT ───────────────── */

app.get('/turn', async (_req, res) => {
  try {
    const upstream = await fetch(process.env.TURN_ENDPOINT, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!upstream.ok) {
      res.status(502).json({ error: 'TURN upstream failure' });
      return;
    }

    const data = await upstream.json();

    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'TURN service unavailable' });
  }
});

/* ───────────────── SIGNALING ───────────────── */

const server = http.createServer(app);
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
  rooms.delete(roomId);
}

/* ───────────────── WS HANDLER ───────────────── */

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

    if (type === 'offer' || type === 'answer' || type === 'candidate') {
      broadcast(joinedRoom, ws, {
        type,
        room: joinedRoom,
        payload,
      });
    }
  });

  /* ───────────── HARD RESET ON CLOSE (CRITICAL) ───────────── */

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
