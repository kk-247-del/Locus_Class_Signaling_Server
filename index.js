import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
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
const wss = new WebSocketServer({ server });

/*
rooms: Map<roomId, {
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

function destroyRoom(roomId) {
  rooms.delete(roomId);
}

/* ───────────────── WEBSOCKET ───────────────── */

wss.on('connection', (ws) => {
  let joinedRoom = null;
  let selfId = null;

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
      selfId = sender;

      if (!rooms.has(room)) {
        rooms.set(room, {
          peers: new Set(),
          offererId: sender, // first joiner wins
        });
      }

      const r = rooms.get(room);
      r.peers.add(ws);

      for (const peer of r.peers) {
        send(peer, {
          type: 'peer-present',
          room,
          payload: {
            count: r.peers.size,
            offererId: r.offererId,
          },
        });
      }

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

    // HARD RULE: room is dead once anyone leaves
    destroyRoom(joinedRoom);
  });

  ws.on('error', () => {
    if (!joinedRoom) return;
    destroyRoom(joinedRoom);
  });
});

server.listen(PORT, () => {
  console.log(`Hi Presence signaling running on ${PORT}`);
});
