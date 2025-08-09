import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

type JoinPayload = { roomId: string };
type SignalPayload =
    | { roomId: string; type: "offer"; sdp: any }
    | { roomId: string; type: "answer"; sdp: any }
    | { roomId: string; type: "candidate"; candidate: any };

type RoomInfo = {
    members: Set<string>; // socket ids
};

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});

const rooms: Map<string, RoomInfo> = new Map();

io.on("connection", (socket) => {
    socket.on("join", ({ roomId }: JoinPayload) => {
        const room = rooms.get(roomId) || { members: new Set<string>() };
        if (room.members.size >= 2) {
            socket.emit("error", "room-full");
            return;
        }
        room.members.add(socket.id);
        rooms.set(roomId, room);

        socket.join(roomId);
        const isInitiator = room.members.size === 1;
        socket.emit("joined", { isInitiator });

        socket.to(roomId).emit("signal", { type: "candidate", candidate: null }); // noop to wake
    });

    socket.on("signal", (payload: SignalPayload) => {
        const { roomId } = payload;
        socket.to(roomId).emit("signal", payload as any);
    });

    socket.on("leave", ({ roomId }: { roomId: string }) => {
        socket.leave(roomId);
        socket.to(roomId).emit("signal", { type: "peer-left" });
        const room = rooms.get(roomId);
        if (room) {
            room.members.delete(socket.id);
            if (room.members.size === 0) rooms.delete(roomId);
        }
    });

    socket.on("disconnecting", () => {
        for (const roomId of socket.rooms) {
            if (roomId === socket.id) continue;
            socket.to(roomId).emit("signal", { type: "peer-left" });
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


