"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, ButtonGroup, Container, Row, Col, Alert, Badge, ListGroup, Form } from "react-bootstrap";
import io, { Socket } from "socket.io-client";

type SignalMessage =
    | { type: "offer"; sdp: RTCSessionDescriptionInit; from: string }
    | { type: "answer"; sdp: RTCSessionDescriptionInit; from: string }
    | { type: "candidate"; candidate: RTCIceCandidateInit; from: string };
type MemberState = { name: string; muted: boolean; videoOn: boolean; handRaised?: boolean; role: "host" | "guest" };
type JoinedPeer = { id: string } & MemberState;
type JoinedMessage = { selfId: string; peers: JoinedPeer[] };

const SIGNAL_URL = (process.env.NEXT_PUBLIC_SIGNAL_URL as string) || "ws://localhost:8080";
const ICE_SERVERS: RTCIceServer[] = (() => {
    try {
        const raw = process.env.NEXT_PUBLIC_ICE_SERVERS ||
            JSON.stringify([{ urls: ["stun:stun.l.google.com:19302"] }]);
        return JSON.parse(raw);
    } catch {
        return [{ urls: ["stun:stun.l.google.com:19302"] }];
    }
})();

// Debug logging helper (toggle with DEBUG)
const DEBUG = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbg = (...args: any[]) => {
    if (DEBUG) {
        console.log(...args);
    }
};

type PeerState = {
    pc: RTCPeerConnection;
    remoteStream: MediaStream | null;
    pendingCandidates: RTCIceCandidateInit[];
    isCaller: boolean;
};

export default function RoomPage() {
    const params = useParams();
    const roomId = (params as Record<string, string>).roomId;
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [muted, setMuted] = useState(false);
    const [cameraOff, setCameraOff] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [needsRemotePlay, setNeedsRemotePlay] = useState(false);
    const [selfId, setSelfId] = useState<string>("");
    const [peerIds, setPeerIds] = useState<string[]>([]);
    const [nameInput, setNameInput] = useState("");
    const memberStateRef = useRef<Map<string, MemberState>>(new Map());

    const localPipRef = useRef<HTMLVideoElement>(null);
    const localSideRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
    const peerMapRef = useRef<Map<string, PeerState>>(new Map());
    const socketRef = useRef<Socket | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const needsPlaySetRef = useRef<Set<string>>(new Set());

    const refreshPeerIds = useCallback(() => {
        setPeerIds(Array.from(peerMapRef.current.keys()));
    }, []);

    const attachRemoteRef = (peerId: string) => (el: HTMLVideoElement | null) => {
        remoteVideoRefs.current[peerId] = el;
        const peerState = peerMapRef.current.get(peerId);
        if (el && peerState?.remoteStream) {
            el.srcObject = peerState.remoteStream;
            el.playsInline = true;
            el.autoplay = true as unknown as boolean;
            el.play().catch(() => {
                needsPlaySetRef.current.add(peerId);
                setNeedsRemotePlay(true);
            });
        }
    };

    const connectSocket = useMemo(() => () => {
        dbg("SIGNAL_URL", SIGNAL_URL, "room", roomId);
        const socket = io(SIGNAL_URL, {
            transports: ["websocket"],
            upgrade: false,
            withCredentials: false,
            autoConnect: true,
        });
        socketRef.current = socket;

        socket.on("connect", () => {
            setIsConnected(true);
            dbg("socket connected", socket.id);
            socket.emit("join", { roomId, name: nameInput || undefined });
            dbg("emit: join", roomId);
        });
        socket.on("disconnect", () => { setIsConnected(false); dbg("socket disconnected"); });
        socket.io.on("error", (e: unknown) => dbg("socket.io error", e));
        socket.io.on("reconnect_attempt", () => dbg("reconnect_attempt"));
        socket.io.on("reconnect_error", (e: unknown) => dbg("reconnect_error", e));
        socket.io.on("reconnect_failed", () => dbg("reconnect_failed"));
        socket.on("connect_error", (e: Error) => {
            const message = e?.message ?? "connect_error";
            dbg("connect_error", message);
            setError(`signal connect error: ${message}`);
        });

        socket.on("joined", async (payload: JoinedMessage) => {
            dbg("joined", payload);
            setSelfId(payload.selfId);
            for (const p of payload.peers) {
                memberStateRef.current.set(p.id, { name: p.name, muted: p.muted, videoOn: p.videoOn, handRaised: p.handRaised, role: p.role });
            }
            try {
                await setupLocalMedia();
            } catch (e) {
                setError(String(e));
                return;
            }
            // As the new joiner, create offers to all existing peers
            for (const peer of payload.peers) {
                const peerId = peer.id;
                const pc = ensurePeerConnection(peerId, true);
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    socket.emit("signal", { roomId, type: "offer", sdp: offer, to: peerId });
                    dbg("sent offer →", peerId);
                } catch (e) {
                    setError(String(e));
                }
            }
            refreshPeerIds();
        });

        socket.on("peer-joined", ({ id, name, muted, videoOn, handRaised, role }: { id: string } & MemberState) => {
            dbg("peer-joined", id);
            memberStateRef.current.set(id, { name, muted, videoOn, handRaised, role });
            // Prepare a connection to accept their offer later
            ensurePeerConnection(id, false);
            refreshPeerIds();
        });

        socket.on("peer-left", ({ id }: { id: string }) => {
            dbg("peer-left", id);
            closePeer(id);
            memberStateRef.current.delete(id);
            refreshPeerIds();
        });

        socket.on("signal", async (msg: SignalMessage) => {
            const from = (msg as any).from as string;
            dbg("recv signal", msg.type, "from", from);
            const pc = ensurePeerConnection(from, false);
            try {
                if (msg.type === "offer") {
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    // flush any queued candidates now that remoteDescription exists
                    const state = peerMapRef.current.get(from);
                    if (state) {
                        for (const c of state.pendingCandidates) {
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                        }
                        state.pendingCandidates = [];
                    }
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    socket.emit("signal", { roomId, type: "answer", sdp: answer, to: from });
                    dbg("sent answer →", from);
                } else if (msg.type === "answer") {
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    const state = peerMapRef.current.get(from);
                    if (state) {
                        for (const c of state.pendingCandidates) {
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                        }
                        state.pendingCandidates = [];
                    }
                } else if (msg.type === "candidate" && msg.candidate) {
                    if (!pc.remoteDescription || !pc.remoteDescription.type) {
                        const state = peerMapRef.current.get(from);
                        if (state) state.pendingCandidates.push(msg.candidate);
                        dbg("queued candidate (no remoteDescription yet) from", from);
                    } else {
                        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        dbg("added candidate from", from);
                    }
                }
            } catch (e) {
                dbg("signal handling error", e);
                setError(String(e));
            }
        });
        socket.on("state-update", ({ id, partial }: { id: string; partial: Partial<MemberState> }) => {
            const prev = memberStateRef.current.get(id);
            if (prev) {
                memberStateRef.current.set(id, { ...prev, ...partial });
                refreshPeerIds();
            }
        });
    }, [roomId]);

    async function setupLocalMedia() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localStreamRef.current = stream;
        dbg("gotUserMedia", stream.getTracks().map(t => `${t.kind}:${t.readyState}`));
        const attachLocal = async (el: HTMLVideoElement | null) => {
            if (!el) return;
            el.srcObject = stream;
            el.muted = true;
            await el.play().catch((err) => { dbg("local video play blocked", err); });
        };
        await Promise.all([attachLocal(localPipRef.current), attachLocal(localSideRef.current)]);
    }

    function ensurePeerConnection(peerId: string, isCaller: boolean): RTCPeerConnection {
        const existing = peerMapRef.current.get(peerId)?.pc;
        if (existing) return existing;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const state: PeerState = { pc, remoteStream: null, pendingCandidates: [], isCaller };
        peerMapRef.current.set(peerId, state);

        const stream = localStreamRef.current;
        if (stream) {
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        }

        pc.ontrack = (e) => {
            const remoteStream = e.streams[0];
            state.remoteStream = remoteStream;
            const el = remoteVideoRefs.current[peerId];
            if (el) {
                el.srcObject = remoteStream;
                el.muted = false;
                el.play().catch(() => {
                    needsPlaySetRef.current.add(peerId);
                    setNeedsRemotePlay(true);
                });
            }
        };

        // @ts-expect-error legacy
        pc.onaddstream = (e: unknown) => {
            dbg("onaddstream (legacy)");
            const remote = (e as { stream?: MediaStream }).stream;
            if (remote) {
                state.remoteStream = remote;
                const el = remoteVideoRefs.current[peerId];
                if (el) {
                    el.srcObject = remote;
                    el.play?.().catch(() => { needsPlaySetRef.current.add(peerId); setNeedsRemotePlay(true); });
                }
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socketRef.current?.emit("signal", { roomId, type: "candidate", candidate: e.candidate, to: peerId });
                dbg("ice candidate →", peerId);
            }
        };

        pc.oniceconnectionstatechange = () => {
            dbg("iceConnectionState", peerId, pc.iceConnectionState);
        };
        pc.onconnectionstatechange = () => dbg("connectionState", peerId, pc.connectionState);
        pc.onsignalingstatechange = () => dbg("signalingState", peerId, pc.signalingState);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pc as any).addEventListener?.("icecandidateerror", (ev: any) => dbg("icecandidateerror", peerId, ev?.errorCode, ev?.errorText));
        pc.onnegotiationneeded = () => dbg("negotiationneeded", peerId);

        return pc;
    }

    function closePeer(peerId: string) {
        const entry = peerMapRef.current.get(peerId);
        if (entry) {
            try { entry.pc.getSenders().forEach((s) => s.track && s.track.stop()); } catch { }
            try { entry.pc.close(); } catch { }
        }
        peerMapRef.current.delete(peerId);
        const el = remoteVideoRefs.current[peerId];
        if (el) {
            const stream = el.srcObject as MediaStream | null;
            stream?.getTracks().forEach((t) => t.stop());
            el.srcObject = null;
        }
        needsPlaySetRef.current.delete(peerId);
    }

    function cleanupAllPeers() {
        for (const id of Array.from(peerMapRef.current.keys())) {
            closePeer(id);
        }
        refreshPeerIds();
    }

    function hangup() {
        dbg("hangup");
        socketRef.current?.emit("leave", { roomId });
        cleanupAllPeers();
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        router.push("/");
    }

    async function resumeRemotePlayback() {
        try {
            for (const peerId of peerIds) {
                const el = remoteVideoRefs.current[peerId];
                if (el) {
                    el.muted = false;
                    await el.play();
                }
            }
            setNeedsRemotePlay(false);
            needsPlaySetRef.current.clear();
        } catch (_err) {
            setNeedsRemotePlay(true);
        }
    }

    function toggleMic() {
        if (!localStreamRef.current) return;
        const track = localStreamRef.current.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setMuted(!track.enabled);
        socketRef.current?.emit("state-update", { roomId, partial: { muted: !track.enabled } });
        dbg("toggleMic", track.enabled);
    }

    function toggleCam() {
        if (!localStreamRef.current) return;
        const track = localStreamRef.current.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setCameraOff(!track.enabled);
        socketRef.current?.emit("state-update", { roomId, partial: { videoOn: track.enabled } });
        dbg("toggleCam", track.enabled);
    }

    async function shareScreen() {
        try {
            const display = await (
                navigator.mediaDevices as MediaDevices & {
                    getDisplayMedia(options?: DisplayMediaStreamOptions): Promise<MediaStream>;
                }
            ).getDisplayMedia({ video: true });
            const videoTrack = display.getVideoTracks()[0];
            if (videoTrack) {
                for (const [, state] of peerMapRef.current) {
                    const sender = state.pc.getSenders().find((s) => s.track?.kind === "video");
                    if (sender) await sender.replaceTrack(videoTrack);
                }
                videoTrack.onended = () => {
                    const camTrack = localStreamRef.current?.getVideoTracks()[0];
                    if (camTrack) {
                        for (const [, state] of peerMapRef.current) {
                            const sender = state.pc.getSenders().find((s) => s.track?.kind === "video");
                            if (sender) sender.replaceTrack(camTrack);
                        }
                    }
                };
                dbg("shareScreen started");
            }
        } catch (e) {
            setError(String(e));
            dbg("shareScreen error", e);
        }
    }

    const startedRef = useRef(false);
    useEffect(() => {
        if (!startedRef.current) {
            startedRef.current = true;
            connectSocket();
        }
        return () => {
            try { socketRef.current?.removeAllListeners(); } catch { }
            try { socketRef.current?.disconnect(); } catch { }
            cleanupAllPeers();
            localStreamRef.current?.getTracks().forEach((t) => t.stop());
            startedRef.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roomId]);

    // Minimal render-time check
    if (DEBUG) console.log(peerIds);

    return (
        <Container fluid className="py-3">
            <Row className="mb-2">
                <Col>
                    <div className="d-flex align-items-center justify-content-between">
                        <div>
                            <strong>Room:</strong> {roomId}
                        </div>
                        <div>
                            <small className={isConnected ? "text-success" : "text-danger"}>
                                {isConnected ? "Connected" : "Disconnected"}
                            </small>
                        </div>
                    </div>
                </Col>
            </Row>

            {error && (
                <Row className="mb-2">
                    <Col>
                        <Alert variant="danger" onClose={() => setError(null)} dismissible>
                            {error}
                        </Alert>
                    </Col>
                </Row>
            )}

            <Row>
                <Col xs={12} md={8} className="mb-3">
                    <div className="d-flex flex-wrap gap-3 justify-content-center">
                        {/* Local self-view */}
                        <div className="position-relative" style={{ width: 280 }}>
                            <video ref={localSideRef} playsInline autoPlay className="w-100 h-100 mirror" />
                            <Badge bg="secondary" className="position-absolute top-0 start-0 m-2">{nameInput || "You"}</Badge>
                            <Badge bg={muted ? "danger" : "success"} className="position-absolute top-0 end-0 m-2">{muted ? "Muted" : "Mic On"}</Badge>
                        </div>
                        {/* Remote peers grid */}
                        {peerIds.map((id) => (
                            <div key={id} className="position-relative" style={{ width: 280 }}>
                                <video ref={attachRemoteRef(id)} playsInline autoPlay className="w-100 h-100" />
                                <Badge bg="primary" className="position-absolute top-0 start-0 m-2">{(memberStateRef.current.get(id)?.name || id).slice(0, 12)}</Badge>
                                <Badge bg={(memberStateRef.current.get(id)?.muted ? "danger" : "success")} className="position-absolute top-0 end-0 m-2">
                                    {memberStateRef.current.get(id)?.muted ? "Muted" : "Mic On"}
                                </Badge>
                            </div>
                        ))}
                    </div>
                    {needsRemotePlay && (
                        <div className="mt-3 d-flex justify-content-center">
                            <Button variant="light" onClick={resumeRemotePlayback}>Click to play remote videos</Button>
                        </div>
                    )}
                </Col>
                <Col xs={12} md={4} className="mb-3">
                    <div className="p-3 border rounded">
                        <div className="mb-2"><strong>Participants</strong></div>
                        <Form.Group className="mb-3">
                            <Form.Label>Your name</Form.Label>
                            <Form.Control
                                placeholder="Enter display name"
                                value={nameInput}
                                onChange={(e) => setNameInput(e.target.value)}
                            />
                            <Form.Text>Used when you (re)join</Form.Text>
                        </Form.Group>
                        <ListGroup variant="flush">
                            <ListGroup.Item>
                                <div className="d-flex justify-content-between align-items-center">
                                    <span>{nameInput || "You"} <small className="text-muted">({selfId.slice(0, 6)})</small></span>
                                    <span className={`badge bg-${muted ? "danger" : "success"}`}>{muted ? "Muted" : "Mic On"}</span>
                                </div>
                            </ListGroup.Item>
                            {peerIds.map((id) => (
                                <ListGroup.Item key={id}>
                                    <div className="d-flex justify-content-between align-items-center">
                                        <span>{memberStateRef.current.get(id)?.name || id} <small className="text-muted">({id.slice(0, 6)})</small></span>
                                        <span className={`badge bg-${memberStateRef.current.get(id)?.muted ? "danger" : "success"}`}>
                                            {memberStateRef.current.get(id)?.muted ? "Muted" : "Mic On"}
                                        </span>
                                    </div>
                                </ListGroup.Item>
                            ))}
                        </ListGroup>
                    </div>
                </Col>
            </Row>

            <Row className="mt-3">
                <Col className="d-flex justify-content-center">
                    <ButtonGroup>
                        <Button variant={muted ? "outline-danger" : "outline-secondary"} onClick={toggleMic}>
                            {muted ? "Unmute" : "Mute"}
                        </Button>
                        <Button variant={cameraOff ? "outline-danger" : "outline-secondary"} onClick={toggleCam}>
                            {cameraOff ? "Camera On" : "Camera Off"}
                        </Button>
                        <Button variant="outline-secondary" onClick={shareScreen}>Share Screen</Button>
                        <Button variant="danger" onClick={hangup}>Hang up</Button>
                    </ButtonGroup>
                </Col>
            </Row>
        </Container>
    );
}


