import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_ROOM_SIZE = process.env.MAX_ROOM_SIZE
    ? Number(process.env.MAX_ROOM_SIZE)
    : 10; // default cap for group calls

type JoinPayload = { roomId: string; name?: string };
type SignalPayload =
    | { roomId: string; type: "offer"; sdp: any; to: string }
    | { roomId: string; type: "answer"; sdp: any; to: string }
    | { roomId: string; type: "candidate"; candidate: any; to: string };

type MemberState = {
    name: string;
    muted: boolean;
    videoOn: boolean;
    handRaised?: boolean;
    role: "host" | "guest";
};

type RoomInfo = {
    members: Map<string, MemberState>; // socket id -> state
    locked: boolean;
    waiting: Map<string, { name: string }>;
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
    socket.on("join", ({ roomId, name }: JoinPayload) => {
        // eslint-disable-next-line no-console
        console.log(`join request: room=${roomId} socket=${socket.id}`);
        const room = rooms.get(roomId) || { members: new Map<string, MemberState>(), locked: false, waiting: new Map() };
        if (room.members.size >= MAX_ROOM_SIZE) {
            socket.emit("error", "room-full");
            return;
        }
        const safeName = (name && String(name).slice(0, 64)) || `Guest-${socket.id.slice(0, 6)}`;
        // If locked and not the first member, put into waiting room
        if (room.locked && room.members.size > 0) {
            room.waiting.set(socket.id, { name: safeName });
            rooms.set(roomId, room);
            socket.data.waitingRoomId = roomId;
            socket.emit("waiting");
            // notify hosts/members of waiting list update
            io.to(roomId).emit("waiting-list", { list: [...room.waiting.entries()].map(([id, w]) => ({ id, name: w.name })) });
            return;
        }

        const role: MemberState["role"] = room.members.size === 0 ? "host" : "guest";
        const state: MemberState = { name: safeName, muted: false, videoOn: true, handRaised: false, role };
        room.members.set(socket.id, state);
        rooms.set(roomId, room);

        socket.join(roomId);

        // Acknowledge with current peers (excluding self)
        const peers = [...room.members.entries()]
            .filter(([id]) => id !== socket.id)
            .map(([id, s]) => ({ id, ...s }));
        socket.emit("joined", { selfId: socket.id, selfRole: role, peers });

        // Notify others in the room about the new peer
        socket.to(roomId).emit("peer-joined", { id: socket.id, ...state });
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
        // Remove from waiting lists
        for (const [rid, room] of rooms.entries()) {
            if (room.waiting?.delete(socket.id)) {
                io.to(rid).emit("waiting-list", { list: [...room.waiting.entries()].map(([id, w]) => ({ id, name: w.name })) });
            }
        }
    });

    socket.on("state-update", ({ roomId, partial }: { roomId: string; partial: Partial<MemberState> }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const current = room.members.get(socket.id);
        if (!current) return;
        const updated: MemberState = { ...current, ...partial };
        room.members.set(socket.id, updated);
        socket.to(roomId).emit("state-update", { id: socket.id, partial });
    });

    socket.on("rename", ({ roomId, name }: { roomId: string; name: string }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const current = room.members.get(socket.id);
        if (!current) return;
        const safeName = (name && String(name).slice(0, 64)) || current.name;
        const updated: MemberState = { ...current, name: safeName };
        room.members.set(socket.id, updated);
        io.to(roomId).emit("state-update", { id: socket.id, partial: { name: safeName } });
    });

    socket.on("reaction", ({ roomId, emoji, to }: { roomId: string; emoji: string; to?: string }) => {
        const room = rooms.get(roomId);
        if (!room || typeof emoji !== "string" || emoji.length === 0) return;
        // eslint-disable-next-line no-console
        console.log("reaction", { roomId, from: socket.id, emoji, to });
        io.to(roomId).emit("reaction", { from: socket.id, emoji });
    });

    socket.on("chat", ({ roomId, text, to }: { roomId: string; text: string; to?: string }) => {
        const room = rooms.get(roomId);
        if (!room || typeof text !== "string") return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const payload = { from: socket.id, text: trimmed.slice(0, 2000), ts: Date.now() };
        // eslint-disable-next-line no-console
        console.log("chat", { roomId, from: socket.id, to: to || "room", len: trimmed.length });
        if (to && room.members.has(to)) {
            io.to(to).emit("chat", payload);
        } else {
            socket.to(roomId).emit("chat", payload);
        }
    });

    socket.on("lock-room", ({ roomId, locked }: { roomId: string; locked: boolean }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const current = room.members.get(socket.id);
        if (!current || current.role !== "host") return;
        room.locked = !!locked;
        rooms.set(roomId, room);
        io.to(roomId).emit("lock-state", { locked: room.locked });
    });

    socket.on("admit", ({ roomId, id }: { roomId: string; id: string }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const current = room.members.get(socket.id);
        if (!current || current.role !== "host") return;
        const waiting = room.waiting.get(id);
        if (!waiting) return;
        const target = io.sockets.sockets.get(id);
        if (!target) return;
        room.waiting.delete(id);
        const state: MemberState = { name: waiting.name, muted: false, videoOn: true, handRaised: false, role: "guest" };
        room.members.set(id, state);
        rooms.set(roomId, room);
        target.join(roomId);
        // Clear any previous waiting marker
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (target as any).data && ((target as any).data.waitingRoomId = undefined);
        const peers = [...room.members.entries()].filter(([mid]) => mid !== id).map(([mid, s]) => ({ id: mid, ...s }));
        target.emit("joined", { selfId: id, selfRole: "guest", peers });
        // Notify everyone in the room EXCEPT the admitted user
        target.broadcast.to(roomId).emit("peer-joined", { id, ...state });
        io.to(roomId).emit("waiting-list", { list: [...room.waiting.entries()].map(([wid, w]) => ({ id: wid, name: w.name })) });
    });

    socket.on("deny", ({ roomId, id }: { roomId: string; id: string }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const current = room.members.get(socket.id);
        if (!current || current.role !== "host") return;
        if (room.waiting.delete(id)) {
            io.to(roomId).emit("waiting-list", { list: [...room.waiting.entries()].map(([wid, w]) => ({ id: wid, name: w.name })) });
            io.to(id).emit("denied");
        }
    });
});

server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`signaling listening on :${PORT}`);
});


