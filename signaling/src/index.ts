import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_ROOM_SIZE = process.env.MAX_ROOM_SIZE
    ? Number(process.env.MAX_ROOM_SIZE)
    : 10; // default cap for group calls

type JoinPayload = { roomId: string };
type SignalPayload =
    | { roomId: string; type: "offer"; sdp: any; to: string }
    | { roomId: string; type: "answer"; sdp: any; to: string }
    | { roomId: string; type: "candidate"; candidate: any; to: string };

type RoomInfo = {
    members: Set<string>; // socket ids
};

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const io = new Server(server, {
    transports: ["websocket"],
    allowUpgrades: false,
    cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"], credentials: false },
});

const rooms: Map<string, RoomInfo> = new Map();

io.on("connection", (socket) => {
    // eslint-disable-next-line no-console
    console.log("socket connected:", socket.id);
    socket.on("join", ({ roomId }: JoinPayload) => {
        // eslint-disable-next-line no-console
        console.log(`join request: room=${roomId} socket=${socket.id}`);
        const room = rooms.get(roomId) || { members: new Set<string>() };
        if (room.members.size >= MAX_ROOM_SIZE) {
            socket.emit("error", "room-full");
            return;
        }
        room.members.add(socket.id);
        rooms.set(roomId, room);

        socket.join(roomId);

        // Acknowledge with current peers (excluding self)
        const peers = [...room.members].filter((id) => id !== socket.id);
        socket.emit("joined", { selfId: socket.id, peers });

        // Notify others in the room about the new peer
        socket.to(roomId).emit("peer-joined", { id: socket.id });
    });

    socket.on("signal", (payload: SignalPayload) => {
        // eslint-disable-next-line no-console
        console.log(`signal ${payload.type} → room ${payload.roomId} from ${socket.id} to ${payload.to}`);
        const { roomId, to } = payload;

        const room = rooms.get(roomId);
        if (!room) return;
        // Only forward if target is part of the room
        if (!room.members.has(to)) return;

        io.to(to).emit("signal", { ...payload, from: socket.id });
    });

    socket.on("leave", ({ roomId }: { roomId: string }) => {
        socket.leave(roomId);
        socket.to(roomId).emit("peer-left", { id: socket.id });
        const room = rooms.get(roomId);
        if (room) {
            room.members.delete(socket.id);
            if (room.members.size === 0) rooms.delete(roomId);
        }
    });

    socket.on("disconnecting", () => {
        for (const roomId of socket.rooms) {
            if (roomId === socket.id) continue;
            socket.to(roomId).emit("peer-left", { id: socket.id });
            const room = rooms.get(roomId);
            if (room) {
                room.members.delete(socket.id);
                if (room.members.size === 0) rooms.delete(roomId);
            }
        }
    });
});

server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`signaling listening on :${PORT}`);
});


