"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, ButtonGroup, Container, Row, Col, Alert } from "react-bootstrap";
import io, { Socket } from "socket.io-client";

type SignalMessage =
    | { type: "offer"; sdp: RTCSessionDescriptionInit }
    | { type: "answer"; sdp: RTCSessionDescriptionInit }
    | { type: "candidate"; candidate: RTCIceCandidateInit }
    | { type: "peer-left" };

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
        // eslint-disable-next-line no-console
        console.log(...args);
    }
};

export default function RoomPage() {
    const params = useParams();
    const roomId = (params as Record<string, string>).roomId;
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [muted, setMuted] = useState(false);
    const [cameraOff, setCameraOff] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [peerState, setPeerState] = useState<string>("idle");
    const [remoteMuted, setRemoteMuted] = useState(true);
    const [needsRemotePlay, setNeedsRemotePlay] = useState(false);
    const [isInitiator, setIsInitiator] = useState(false);

    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const socketRef = useRef<Socket | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

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
            socket.emit("join", { roomId });
            dbg("emit: join", roomId);
        });
        socket.on("disconnect", () => { setIsConnected(false); dbg("socket disconnected"); });
        socket.io.on("error", (e: unknown) => dbg("socket.io error", e));
        socket.io.on("reconnect_attempt", () => dbg("reconnect_attempt"));
        socket.io.on("reconnect_error", (e: unknown) => dbg("reconnect_error", e));
        socket.io.on("reconnect_failed", () => dbg("reconnect_failed"));
        // @ts-ignore
        socket.on("connect_error", (e: any) => { dbg("connect_error", e?.message); setError(`signal connect error: ${e?.message || e}`); });

        socket.on("joined", (payload: { isInitiator: boolean }) => {
            setIsInitiator(payload.isInitiator);
            isInitiatorRef.current = payload.isInitiator;
            dbg("joined", payload);
            // Prepare media/PC but do NOT create offer yet. Wait for 'ready'.
            setupPeer().catch((e) => setError(String(e)));
        });

        socket.on("ready", async () => {
            dbg("room ready");
            // Only the initiator should create the offer once both peers are present
            if (isInitiatorRef.current && pcRef.current) {
                try {
                    const offer = await pcRef.current.createOffer();
                    await pcRef.current.setLocalDescription(offer);
                    dbg("created offer");
                    socket.emit("signal", { roomId, type: "offer", sdp: offer });
                } catch (e) {
                    setError(String(e));
                }
            }
        });

        socket.on("signal", async (msg: SignalMessage) => {
            dbg("recv signal", msg.type);
            try {
                if (msg.type === "offer") {
                    // Create the peer connection if it was cleared due to hot reloads
                    if (!pcRef.current) {
                        dbg("pcRef empty on offer → setupPeer()");
                        await setupPeer();
                    }
                    await pcRef.current?.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    // flush any queued candidates now that remoteDescription exists
                    for (const c of pendingCandidatesRef.current) {
                        await pcRef.current?.addIceCandidate(new RTCIceCandidate(c));
                        dbg("flushed queued candidate");
                    }
                    pendingCandidatesRef.current = [];
                    const answer = await pcRef.current?.createAnswer();
                    if (answer) {
                        await pcRef.current?.setLocalDescription(answer);
                        dbg("created answer");
                        socket.emit("signal", { roomId, type: "answer", sdp: answer });
                    }
                } else if (msg.type === "answer") {
                    if (!pcRef.current) {
                        dbg("pcRef empty on answer → setupPeer()");
                        await setupPeer();
                    }
                    await pcRef.current?.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    for (const c of pendingCandidatesRef.current) {
                        await pcRef.current?.addIceCandidate(new RTCIceCandidate(c));
                        dbg("flushed queued candidate");
                    }
                    pendingCandidatesRef.current = [];
                } else if (msg.type === "candidate" && msg.candidate) {
                    if (!pcRef.current || !pcRef.current.remoteDescription || !pcRef.current.remoteDescription.type) {
                        pendingCandidatesRef.current.push(msg.candidate);
                        dbg("queued candidate (no remoteDescription yet)");
                    } else {
                        await pcRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        dbg("added candidate");
                    }
                } else if (msg.type === "peer-left") {
                    dbg("peer-left");
                    cleanupRemote();
                }
            } catch (e) {
                dbg("signal handling error", e);
                setError(String(e));
            }
        });
    }, [roomId]);

    const isInitiatorRef = useRef(false);

    async function setupPeer() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localStreamRef.current = stream;
        dbg("gotUserMedia", stream.getTracks().map(t => `${t.kind}:${t.readyState}`));
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
            localVideoRef.current.muted = true;
            await localVideoRef.current.play().catch((err) => { dbg("local video play blocked", err); });
        }

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;
        dbg("pc created", ICE_SERVERS);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        pc.ontrack = (e) => {
            const remoteStream = e.streams[0];
            dbg("ontrack", remoteStream?.id, remoteStream?.getTracks().map(t => `${t.kind}:${t.readyState}`));
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = remoteStream;
                // Allow autoplay across browsers by muting initially
                remoteVideoRef.current.muted = remoteMuted;
                remoteVideoRef.current.play().catch((err) => {
                    dbg("remote video play blocked", err);
                    setNeedsRemotePlay(true);
                });
            }
        };

        // Safari sometimes fires tracks only after remote description is set.
        // Also bind onaddstream for older implementations
        // @ts-ignore legacy
        pc.onaddstream = (e: any) => {
            dbg("onaddstream (legacy)");
            if (remoteVideoRef.current && e.stream) {
                remoteVideoRef.current.srcObject = e.stream;
                // @ts-ignore
                remoteVideoRef.current.play?.().catch((err: unknown) => { dbg("remote video play blocked (legacy)", err); setNeedsRemotePlay(true); });
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socketRef.current?.emit("signal", { roomId, type: "candidate", candidate: e.candidate });
                dbg("ice candidate", e.candidate.type, e.candidate.protocol, e.candidate.address);
            }
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            setPeerState(state);
            dbg("iceConnectionState", state);
        };

        pc.onconnectionstatechange = () => dbg("connectionState", pc.connectionState);
        pc.onsignalingstatechange = () => dbg("signalingState", pc.signalingState);
        // Not in TS types: use event listener
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pc as any).addEventListener?.("icecandidateerror", (ev: any) => dbg("icecandidateerror", ev?.errorCode, ev?.errorText));
        pc.onnegotiationneeded = () => dbg("negotiationneeded");

        // do not create offer here; wait for 'ready' event
    }

    function cleanupRemote() {
        dbg("cleanupRemote");
        if (remoteVideoRef.current) {
            const stream = remoteVideoRef.current.srcObject as MediaStream | null;
            stream?.getTracks().forEach((t) => t.stop());
            remoteVideoRef.current.srcObject = null;
        }
    }

    function hangup() {
        dbg("hangup");
        socketRef.current?.emit("leave", { roomId });
        pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop());
        pcRef.current?.close();
        pcRef.current = null;
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        router.push("/");
    }

    async function resumeRemotePlayback() {
        try {
            if (remoteVideoRef.current) {
                // unmute and try to resume
                setRemoteMuted(false);
                remoteVideoRef.current.muted = false;
                await remoteVideoRef.current.play();
                setNeedsRemotePlay(false);
            }
        } catch (err) {
            setNeedsRemotePlay(true);
        }
    }

    function toggleMic() {
        if (!localStreamRef.current) return;
        const track = localStreamRef.current.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setMuted(!track.enabled);
        dbg("toggleMic", track.enabled);
    }

    function toggleCam() {
        if (!localStreamRef.current) return;
        const track = localStreamRef.current.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setCameraOff(!track.enabled);
        dbg("toggleCam", track.enabled);
    }

    async function shareScreen() {
        try {
            const display = await (navigator.mediaDevices as any).getDisplayMedia({ video: true });
            const videoTrack = display.getVideoTracks()[0];
            const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === "video");
            if (sender && videoTrack) {
                await sender.replaceTrack(videoTrack);
                videoTrack.onended = () => {
                    // revert back to camera when user stops sharing
                    const camTrack = localStreamRef.current?.getVideoTracks()[0];
                    if (camTrack) sender.replaceTrack(camTrack);
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
        // Ensure single start per component instance, but allow new rooms to initialize cleanly
        if (!startedRef.current) {
            startedRef.current = true;
            connectSocket();
        }
        return () => {
            socketRef.current?.removeAllListeners();
            socketRef.current?.disconnect();
            pcRef.current?.close();
            localStreamRef.current?.getTracks().forEach((t) => t.stop());
            startedRef.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roomId]);

    // Minimal render-time check
    if (DEBUG) console.log(remoteVideoRef.current?.srcObject);

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
                <Col md={6} className="mb-2">
                    <div className="position-relative">
                        <video ref={localVideoRef} playsInline autoPlay className="w-100 bg-black rounded" />
                        <span className="position-absolute top-0 start-0 badge bg-secondary m-2">You</span>
                    </div>
                </Col>
                <Col md={6} className="mb-2">
                    <div className="position-relative">
                        <video ref={remoteVideoRef} playsInline autoPlay className="w-100 bg-black rounded" />
                        {needsRemotePlay && (
                            <div
                                className="position-absolute top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
                                style={{ background: "rgba(0,0,0,0.4)" }}
                            >
                                <Button variant="light" onClick={resumeRemotePlayback}>
                                    Click to play remote video
                                </Button>
                            </div>
                        )}
                        <span className="position-absolute top-0 start-0 badge bg-primary m-2">Peer</span>
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


