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

export default function RoomPage() {
    const params = useParams();
    const roomId = (params as Record<string, string>).roomId;
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [muted, setMuted] = useState(false);
    const [cameraOff, setCameraOff] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [isInitiator, setIsInitiator] = useState(false);

    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const socketRef = useRef<Socket | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);

    const connectSocket = useMemo(() => () => {
        const socket = io(SIGNAL_URL, { transports: ["websocket"], autoConnect: true });
        socketRef.current = socket;

        socket.on("connect", () => setIsConnected(true));
        socket.on("disconnect", () => setIsConnected(false));

        socket.emit("join", { roomId });

        socket.on("joined", (payload: { isInitiator: boolean }) => {
            setIsInitiator(payload.isInitiator);
            setupPeer(payload.isInitiator).catch((e) => setError(String(e)));
        });

        socket.on("signal", async (msg: SignalMessage) => {
            try {
                if (msg.type === "offer") {
                    await pcRef.current?.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    const answer = await pcRef.current?.createAnswer();
                    if (answer) {
                        await pcRef.current?.setLocalDescription(answer);
                        socket.emit("signal", { roomId, type: "answer", sdp: answer });
                    }
                } else if (msg.type === "answer") {
                    await pcRef.current?.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                } else if (msg.type === "candidate" && msg.candidate) {
                    await pcRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
                } else if (msg.type === "peer-left") {
                    cleanupRemote();
                }
            } catch (e) {
                setError(String(e));
            }
        });
    }, [roomId]);

    async function setupPeer(shouldInitiate: boolean) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localStreamRef.current = stream;
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
            localVideoRef.current.muted = true;
            await localVideoRef.current.play().catch(() => { });
        }

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        pc.ontrack = (e) => {
            const remoteStream = e.streams[0];
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = remoteStream;
                remoteVideoRef.current.play().catch(() => { });
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socketRef.current?.emit("signal", { roomId, type: "candidate", candidate: e.candidate });
            }
        };

        if (shouldInitiate) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socketRef.current?.emit("signal", { roomId, type: "offer", sdp: offer });
        }
    }

    function cleanupRemote() {
        if (remoteVideoRef.current) {
            const stream = remoteVideoRef.current.srcObject as MediaStream | null;
            stream?.getTracks().forEach((t) => t.stop());
            remoteVideoRef.current.srcObject = null;
        }
    }

    function hangup() {
        socketRef.current?.emit("leave", { roomId });
        pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop());
        pcRef.current?.close();
        pcRef.current = null;
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        router.push("/");
    }

    function toggleMic() {
        if (!localStreamRef.current) return;
        const track = localStreamRef.current.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setMuted(!track.enabled);
    }

    function toggleCam() {
        if (!localStreamRef.current) return;
        const track = localStreamRef.current.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setCameraOff(!track.enabled);
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
            }
        } catch (e) {
            setError(String(e));
        }
    }

    useEffect(() => {
        connectSocket();
        return () => {
            socketRef.current?.disconnect();
            pcRef.current?.close();
            localStreamRef.current?.getTracks().forEach((t) => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
                    <video ref={localVideoRef} playsInline autoPlay className="w-100 bg-black" />
                </Col>
                <Col md={6} className="mb-2">
                    <video ref={remoteVideoRef} playsInline autoPlay className="w-100 bg-black" />
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


