"use client";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, ButtonGroup, Container, Row, Col, Alert, Badge, ListGroup, Offcanvas, Form } from "react-bootstrap";
import io, { Socket } from "socket.io-client";

type SignalMessage =
    | { type: "offer"; sdp: RTCSessionDescriptionInit; from: string }
    | { type: "answer"; sdp: RTCSessionDescriptionInit; from: string }
    | { type: "candidate"; candidate: RTCIceCandidateInit; from: string };
type MemberState = { name: string; muted: boolean; videoOn: boolean; handRaised?: boolean; sharing?: boolean; role: "host" | "guest" };
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
    cameraStream: MediaStream | null;
    screenStream: MediaStream | null;
    pendingCandidates: RTCIceCandidateInit[];
    isCaller: boolean;
    screenSender?: RTCRtpSender;
};

export default function RoomPage() {
    const params = useParams();
    const roomId = (params as Record<string, string>).roomId;
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    useEffect(() => {
        const preset = urlParams?.get('name');
        if (preset) {
            setPreJoinName(preset);
            setNameInput(preset);
            displayNameRef.current = preset;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [muted, setMuted] = useState(false);
    const [cameraOff, setCameraOff] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [needsRemotePlay, setNeedsRemotePlay] = useState(false);
    const [selfId, setSelfId] = useState<string>("");
    const [selfRole, setSelfRole] = useState<"host" | "guest" | null>(null);
    const [peerIds, setPeerIds] = useState<string[]>([]);
    const [nameInput, setNameInput] = useState("");
    const [preJoinName, setPreJoinName] = useState("");
    const [showRoster, setShowRoster] = useState(true);
    const [inviteCopied, setInviteCopied] = useState(false);
    const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
    const [pinnedId, setPinnedId] = useState<string | "self" | null>(null);
    const [elapsedMs, setElapsedMs] = useState<number>(0);
    const [recentReaction, setRecentReaction] = useState<{ from: string; emoji: string; ts: number } | null>(null);
    const [handRaisedMe, setHandRaisedMe] = useState(false);
    const [showChat, setShowChat] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [messages, setMessages] = useState<Array<{ from: string; text: string; ts: number }>>([]);
    const [showSettings, setShowSettings] = useState(false);
    const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
    const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
    const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
    const [selectedCamId, setSelectedCamId] = useState<string | null>(null);
    const [selectedRes, setSelectedRes] = useState<string>(() => typeof window !== 'undefined' ? (localStorage.getItem('vc_selected_res') || '720p') : '720p');
    const memberStateRef = useRef<Map<string, MemberState>>(new Map());

    const localPipRef = useRef<HTMLVideoElement>(null);
    const localSideRef = useRef<HTMLVideoElement>(null);
    const localStageRef = useRef<HTMLVideoElement>(null);
    const stageVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
    const remoteRefCbMapRef = useRef<Record<string, (el: HTMLVideoElement | null) => void>>({});
    const peerMapRef = useRef<Map<string, PeerState>>(new Map());
    const socketRef = useRef<Socket | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const needsPlaySetRef = useRef<Set<string>>(new Set());
    const localScreenStreamRef = useRef<MediaStream | null>(null);
    const displayNameRef = useRef<string>("");
    const volumeRef = useRef<Map<string, number>>(new Map());
    const prevEnergyRef = useRef<Map<string, { energy: number; duration: number }>>(new Map());
    const statsIntervalRef = useRef<number | null>(null);
    const localAudioContextRef = useRef<AudioContext | null>(null);
    const localAnalyserRef = useRef<AnalyserNode | null>(null);
    const localLevelRef = useRef<number>(0);
    const meetingStartRef = useRef<number | null>(null);
    const meetingTimerRef = useRef<number | null>(null);
    const sharingRef = useRef<boolean>(false);

    const refreshPeerIds = useCallback(() => {
        setPeerIds(Array.from(peerMapRef.current.keys()));
    }, []);

    const getRemoteRefCallback = useCallback((peerId: string) => {
        const existing = remoteRefCbMapRef.current[peerId];
        if (existing) return existing;
        const cb = (el: HTMLVideoElement | null) => {
            const prev = remoteVideoRefs.current[peerId];
            if (prev === el) return;
            remoteVideoRefs.current[peerId] = el;
            const peerState = peerMapRef.current.get(peerId);
            if (el && peerState?.cameraStream) {
                el.srcObject = peerState.cameraStream;
                el.playsInline = true;
                (el as any).autoplay = true;
                el.play().catch(() => {
                    needsPlaySetRef.current.add(peerId);
                    setNeedsRemotePlay(true);
                });
            }
        };
        remoteRefCbMapRef.current[peerId] = cb;
        return cb;
    }, []);

    const setLocalVideoRef = useCallback((el: HTMLVideoElement | null) => {
        localSideRef.current = el;
        const stream = localStreamRef.current;
        if (el && stream) {
            el.srcObject = stream;
            el.muted = true;
            el.playsInline = true;
            (el as any).autoplay = true;
            el.play().catch(() => { /* ignore autoplay block; overlay handles */ });
        }
    }, []);

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
            socket.emit("join", { roomId, name: displayNameRef.current || undefined });
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

        socket.on("joined", async (payload: JoinedMessage & { selfRole?: "host" | "guest" }) => {
            dbg("joined", payload);
            setSelfId(payload.selfId);
            if (payload.selfRole) setSelfRole(payload.selfRole);
            setError(null);
            for (const p of payload.peers) {
                memberStateRef.current.set(p.id, { name: p.name, muted: p.muted, videoOn: p.videoOn, handRaised: p.handRaised, role: p.role });
            }
            try {
                await setupLocalMedia();
            } catch (e) {
                setError(String(e));
                return;
            }
            if (!meetingStartRef.current) {
                meetingStartRef.current = Date.now();
                if (!meetingTimerRef.current) {
                    meetingTimerRef.current = window.setInterval(() => {
                        if (meetingStartRef.current) setElapsedMs(Date.now() - meetingStartRef.current);
                    }, 1000) as unknown as number;
                }
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
        socket.on("waiting", () => {
            setError("Waiting for host to admit you…");
        });
        socket.on("waiting-list", ({ list }: { list: Array<{ id: string; name: string }> }) => {
            waitingListRef.current = list;
            refreshPeerIds();
        });
        socket.on("lock-state", ({ locked }: { locked: boolean }) => {
            roomLockedRef.current = locked;
            if (!locked) setError(null);
        });
        socket.on("denied", () => {
            setError("Host denied entry.");
        });

        socket.on("peer-joined", ({ id, name, muted, videoOn, handRaised, role }: { id: string } & MemberState) => {
            dbg("peer-joined", id);
            memberStateRef.current.set(id, { name, muted, videoOn, handRaised, role });
            // Prepare a connection to accept their offer later
            ensurePeerConnection(id, false);
            // Clear any waiting banner once someone is admitted
            setError((prev) => (prev && prev.startsWith("Waiting") ? null : prev));
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
        socket.on("reaction", ({ from, emoji }: { from: string; emoji: string }) => {
            console.log("recv reaction", { from, emoji });
            setRecentReaction({ from, emoji, ts: Date.now() });
            window.setTimeout(() => {
                setRecentReaction((cur) => (cur && cur.from === from ? null : cur));
            }, 1500);
        });
        socket.on("chat", (m: { from: string; text: string; ts: number }) => {
            setMessages((prev) => [...prev, m].slice(-200));
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
        await Promise.all([
            attachLocal(localPipRef.current),
            attachLocal(localSideRef.current),
            attachLocal(localStageRef.current),
        ]);

        // Enumerate devices after permission
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const aud = devices.filter((d) => d.kind === 'audioinput');
            const vid = devices.filter((d) => d.kind === 'videoinput');
            setAudioInputs(aud);
            setVideoInputs(vid);
            const savedMic = typeof window !== 'undefined' ? localStorage.getItem('vc_selected_mic') : null;
            const savedCam = typeof window !== 'undefined' ? localStorage.getItem('vc_selected_cam') : null;
            setSelectedMicId(savedMic || stream.getAudioTracks()[0]?.getSettings().deviceId || aud[0]?.deviceId || null);
            setSelectedCamId(savedCam || stream.getVideoTracks()[0]?.getSettings().deviceId || vid[0]?.deviceId || null);
        } catch { }

        // Prepare local audio level monitoring
        try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            localAudioContextRef.current = ctx;
            localAnalyserRef.current = analyser;
        } catch (_e) {
            // AudioContext may fail without user gesture; ignore
        }
    }

    function ensurePeerConnection(peerId: string, isCaller: boolean): RTCPeerConnection {
        const existing = peerMapRef.current.get(peerId)?.pc;
        if (existing) return existing;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const state: PeerState = { pc, cameraStream: null, screenStream: null, pendingCandidates: [], isCaller };
        peerMapRef.current.set(peerId, state);

        const stream = localStreamRef.current;
        if (stream) {
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        }

        pc.ontrack = (e) => {
            const incomingStream = e.streams[0];
            if (e.track.kind === 'video') {
                if (!state.cameraStream) {
                    state.cameraStream = incomingStream;
                    const el = remoteVideoRefs.current[peerId];
                    if (el) {
                        el.srcObject = state.cameraStream;
                        el.muted = false;
                        el.play().catch(() => { needsPlaySetRef.current.add(peerId); setNeedsRemotePlay(true); });
                    }
                } else if (!state.screenStream && (!state.cameraStream || incomingStream.id !== state.cameraStream.id)) {
                    state.screenStream = incomingStream;
                    // Auto-focus stage on screenshare
                    setPinnedId((cur) => cur || peerId);
                    // If stage is already showing this peer, update it
                    if (stageVideoRef.current && pinnedId === peerId) {
                        stageVideoRef.current.srcObject = state.screenStream;
                        stageVideoRef.current.play().catch(() => { });
                    }
                }
            }
        };

        // @ts-expect-error legacy
        pc.onaddstream = (e: unknown) => {
            dbg("onaddstream (legacy)");
            const remote = (e as { stream?: MediaStream }).stream;
            if (remote) {
                if (!state.cameraStream) state.cameraStream = remote;
                const el = remoteVideoRefs.current[peerId];
                if (el) {
                    el.srcObject = state.cameraStream;
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
            // Do NOT stop local tracks here; that would kill our camera for all remaining peers
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

    async function invite() {
        try {
            const url = typeof window !== "undefined" ? window.location.href : "";
            if ((navigator as any).share) {
                await (navigator as any).share({ title: "Join my room", url });
            } else if (navigator.clipboard && url) {
                await navigator.clipboard.writeText(url);
                setInviteCopied(true);
                setTimeout(() => setInviteCopied(false), 1500);
            }
        } catch {
            // ignore share/copy errors
        }
    }

    const waitingListRef = useRef<Array<{ id: string; name: string }>>([]);
    const roomLockedRef = useRef<boolean>(false);
    function setLocked(next: boolean) {
        socketRef.current?.emit("lock-room", { roomId, locked: next });
    }
    function admit(id: string) {
        socketRef.current?.emit("admit", { roomId, id });
    }
    function deny(id: string) {
        socketRef.current?.emit("deny", { roomId, id });
    }

    function sendReaction(emoji: string) {
        console.log("send reaction", emoji);
        try {
            socketRef.current?.emit("reaction", { roomId, emoji });
        } catch (e) {
            console.log("reaction emit error", e);
        }
        // also show locally on self
        setRecentReaction({ from: selfId || "self", emoji, ts: Date.now() });
        setTimeout(() => setRecentReaction(null), 1500);
    }

    function toggleHand() {
        const next = !handRaisedMe;
        setHandRaisedMe(next);
        socketRef.current?.emit("state-update", { roomId, partial: { handRaised: next } });
    }

    function sendChat() {
        const text = chatInput.trim();
        if (!text) return;
        socketRef.current?.emit("chat", { roomId, text });
        const selfMsg = { from: selfId || "self", text, ts: Date.now() };
        setMessages((prev) => [...prev, selfMsg].slice(-200));
        setChatInput("");
    }

    async function switchMicrophone(deviceId: string) {
        try {
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false });
            const newTrack = micStream.getAudioTracks()[0];
            const oldTrack = localStreamRef.current?.getAudioTracks()[0];
            if (!newTrack) return;
            for (const [, state] of peerMapRef.current) {
                const sender = state.pc.getSenders().find((s) => s.track?.kind === 'audio');
                if (sender) await sender.replaceTrack(newTrack);
            }
            if (oldTrack) {
                localStreamRef.current?.removeTrack(oldTrack);
                oldTrack.stop();
            }
            localStreamRef.current?.addTrack(newTrack);
            setSelectedMicId(deviceId);
            if (typeof window !== 'undefined') localStorage.setItem('vc_selected_mic', deviceId);
        } catch (e) { setError(String(e)); }
    }

    function resolutionToConstraints(label: string): MediaTrackConstraints {
        const map: Record<string, { width: number; height: number }> = {
            '360p': { width: 640, height: 360 },
            '480p': { width: 852, height: 480 },
            '720p': { width: 1280, height: 720 },
            '1080p': { width: 1920, height: 1080 },
        };
        const v = map[label] || map['720p'];
        return { width: v.width, height: v.height } as MediaTrackConstraints;
    }

    async function switchCamera(deviceId: string) {
        try {
            const constraints = resolutionToConstraints(selectedRes);
            const camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, ...constraints }, audio: false });
            const newTrack = camStream.getVideoTracks()[0];
            const oldTrack = localStreamRef.current?.getVideoTracks()[0];
            if (!newTrack) return;
            for (const [, state] of peerMapRef.current) {
                const sender = state.pc.getSenders().find((s) => s.track?.kind === 'video');
                if (sender) await sender.replaceTrack(newTrack);
            }
            if (oldTrack) {
                localStreamRef.current?.removeTrack(oldTrack);
                oldTrack.stop();
            }
            localStreamRef.current?.addTrack(newTrack);
            // Re-attach to local elements
            setLocalVideoRef(localSideRef.current);
            setLocalVideoRef(localStageRef.current);
            setSelectedCamId(deviceId);
            if (typeof window !== 'undefined') localStorage.setItem('vc_selected_cam', deviceId);
        } catch (e) { setError(String(e)); }
    }

    async function changeResolution(label: string) {
        setSelectedRes(label);
        if (typeof window !== 'undefined') localStorage.setItem('vc_selected_res', label);
        try {
            const track = localStreamRef.current?.getVideoTracks()[0];
            if (track && (track as any).applyConstraints) {
                await (track as any).applyConstraints(resolutionToConstraints(label));
            } else if (selectedCamId) {
                await switchCamera(selectedCamId);
            }
        } catch (e) { setError(String(e)); }
    }

    // Periodically compute audio levels per peer and highlight active speaker
    const startActiveSpeakerMonitor = useCallback(() => {
        if (statsIntervalRef.current) return;
        const interval = window.setInterval(async () => {
            // Compute local level via Analyser if available
            try {
                if (localAnalyserRef.current && selfId) {
                    const analyser = localAnalyserRef.current;
                    const bins = new Uint8Array(analyser.frequencyBinCount);
                    analyser.getByteTimeDomainData(bins);
                    let sum = 0;
                    for (let i = 0; i < bins.length; i++) {
                        const v = (bins[i] - 128) / 128; // -1..1
                        sum += v * v;
                    }
                    const rms = Math.sqrt(sum / bins.length);
                    localLevelRef.current = rms;
                    volumeRef.current.set(selfId, rms);
                }
            } catch { }

            // For each peer, use getStats to estimate inbound audio energy rate
            for (const [peerId, { pc }] of peerMapRef.current) {
                try {
                    const stats = await pc.getStats();
                    let best = 0;
                    stats.forEach((r: any) => {
                        if (r.type === "inbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) {
                            if (typeof r.audioLevel === "number") {
                                best = Math.max(best, r.audioLevel);
                            } else if (typeof r.totalAudioEnergy === "number" && typeof r.totalSamplesDuration === "number") {
                                const prev = prevEnergyRef.current.get(peerId) || { energy: 0, duration: 0 };
                                const dE = Math.max(0, r.totalAudioEnergy - prev.energy);
                                const dT = Math.max(0.001, r.totalSamplesDuration - prev.duration);
                                const level = dE / dT; // average energy in window
                                prevEnergyRef.current.set(peerId, { energy: r.totalAudioEnergy, duration: r.totalSamplesDuration });
                                best = Math.max(best, level);
                            }
                        }
                    });
                    // Basic smoothing
                    const old = volumeRef.current.get(peerId) ?? 0;
                    const smoothed = old * 0.7 + best * 0.3;
                    volumeRef.current.set(peerId, smoothed);
                } catch { /* ignore */ }
            }

            // Select the loudest over a threshold
            let maxId: string | null = null;
            let maxVal = 0.05; // threshold to avoid noise
            for (const [id, val] of volumeRef.current.entries()) {
                if (val > maxVal) { maxVal = val; maxId = id; }
            }
            setActiveSpeakerId(maxId);
        }, 500);
        statsIntervalRef.current = interval as unknown as number;
    }, [selfId]);

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
            if (sharingRef.current) {
                // Stop sharing: revert to camera
                const camTrack = localStreamRef.current?.getVideoTracks()[0];
                if (camTrack) {
                    for (const [, state] of peerMapRef.current) {
                        const sender = state.pc.getSenders().find((s) => s.track?.kind === "video");
                        if (sender) await sender.replaceTrack(camTrack);
                    }
                }
                // Reset local stage video if it was showing our screen
                if (pinnedId === 'self') {
                    setLocalVideoRef(stageVideoRef.current);
                }
                sharingRef.current = false;
                socketRef.current?.emit("state-update", { roomId, partial: { sharing: false } });
                return;
            }
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
                    sharingRef.current = false;
                    socketRef.current?.emit("state-update", { roomId, partial: { sharing: false } });
                    if (pinnedId === 'self') setLocalVideoRef(stageVideoRef.current);
                };
                dbg("shareScreen started");
                sharingRef.current = true;
                socketRef.current?.emit("state-update", { roomId, partial: { sharing: true } });
                // If we are pinned, show our screen on stage
                if (pinnedId === 'self') {
                    const ms = new MediaStream([videoTrack]);
                    stageVideoRef.current && (stageVideoRef.current.srcObject = ms, stageVideoRef.current.play?.());
                }
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
            startActiveSpeakerMonitor();
        }
        return () => {
            try { socketRef.current?.removeAllListeners(); } catch { }
            try { socketRef.current?.disconnect(); } catch { }
            cleanupAllPeers();
            localStreamRef.current?.getTracks().forEach((t) => t.stop());
            if (statsIntervalRef.current) { window.clearInterval(statsIntervalRef.current); statsIntervalRef.current = null; }
            try { localAudioContextRef.current?.close(); } catch { }
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
                        <div className="d-flex align-items-center">
                            <small className={isConnected ? "text-success" : "text-danger"}>
                                {isConnected ? "Connected" : "Disconnected"}
                            </small>
                            <small className="ms-3 text-white">{new Date(elapsedMs).toISOString().slice(11, 19)}</small>
                            <Button size="sm" variant="outline-light" className="ms-3" onClick={() => setShowRoster(true)}>Participants</Button>
                            <Button size="sm" variant="outline-light" className="ms-2" onClick={() => setShowChat(true)}>Chat</Button>
                            <Button size="sm" variant="outline-light" className="ms-2" onClick={() => setShowSettings(true)}>Settings</Button>
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



            {/* Grid below header; stage (if any) is rendered after roster offcanvas to keep z-order sane */}
            <Row>
                <Col xs={12} md={8} className="mb-3">
                    <div className="d-flex flex-wrap gap-3 justify-content-center">
                        {/* Local self-view (hidden if pinned) */}
                        {pinnedId !== "self" && (
                            <div className={`position-relative ${activeSpeakerId === selfId ? "border border-3 border-warning" : ""}`} style={{ width: 280 }}>
                                <video ref={setLocalVideoRef} playsInline autoPlay className="w-100 h-100 mirror" />
                                <Badge bg="secondary" className="position-absolute top-0 start-0 m-2">{displayNameRef.current || "You"}</Badge>
                                <Badge bg={muted ? "danger" : "success"} className="position-absolute top-0 end-0 m-2">{muted ? "Muted" : "Mic On"}</Badge>
                                <Button size="sm" variant="dark" className="position-absolute bottom-0 end-0 m-2" onClick={() => setPinnedId("self")}>Pin</Button>
                            </div>
                        )}
                        {/* Remote peers grid */}
                        {peerIds
                            .filter((id) => id !== pinnedId)
                            .filter((id) => !!peerMapRef.current.get(id)?.cameraStream)
                            .map((id) => (
                                <div key={id} className={`position-relative ${activeSpeakerId === id ? "border border-3 border-warning" : ""}`} style={{ width: 280, overflow: "hidden" }}>
                                    <video ref={getRemoteRefCallback(id)} playsInline autoPlay className="w-100 h-100" />
                                    <Badge bg="primary" className="position-absolute top-0 start-0 m-2">
                                        {(memberStateRef.current.get(id)?.name || id).slice(0, 12)}
                                        {memberStateRef.current.get(id)?.handRaised ? ' ✋' : ''}
                                    </Badge>
                                    <Badge bg={(memberStateRef.current.get(id)?.muted ? "danger" : "success")} className="position-absolute top-0 end-0 m-2">
                                        {memberStateRef.current.get(id)?.muted ? "Muted" : "Mic On"}
                                    </Badge>
                                    {memberStateRef.current.get(id)?.sharing && (
                                        <Badge bg="info" className="position-absolute bottom-0 start-0 m-2">Sharing</Badge>
                                    )}
                                    <Button size="sm" variant="dark" className="position-absolute bottom-0 end-0 m-2" onClick={() => setPinnedId(pinnedId === id ? null : id)}>{pinnedId === id ? "Unpin" : "Pin"}</Button>
                                    {recentReaction && recentReaction.from === id && (
                                        <div className="position-absolute top-50 start-50 translate-middle fs-1" style={{ pointerEvents: "none" }}>{recentReaction.emoji}</div>
                                    )}
                                </div>
                            ))}
                    </div>
                    {needsRemotePlay && (
                        <div className="mt-3 d-flex justify-content-center">
                            <Button variant="light" onClick={resumeRemotePlayback}>Click to play remote videos</Button>
                        </div>
                    )}
                </Col>
                <Col xs={12} md={4} className="mb-3 d-flex justify-content-end">
                    <div className="d-flex gap-2">
                        {/* {pinnedId && <Button size="sm" variant="outline-light" onClick={() => setPinnedId(null)}>Unpin</Button>} */}
                        {/* <Button size="sm" variant="outline-light" onClick={() => setShowRoster(true)}>Participants</Button> */}
                    </div>
                </Col>
            </Row>

            {/* Participants Offcanvas with host controls */}
            <Offcanvas show={showRoster} onHide={() => setShowRoster(false)} placement="end" scroll backdrop={false}>
                <Offcanvas.Header closeButton>
                    <Offcanvas.Title>Participants</Offcanvas.Title>
                </Offcanvas.Header>
                <Offcanvas.Body>
                    {selfRole === 'host' && (
                        <div className="mb-3 d-flex align-items-center justify-content-between">
                            <div>
                                <strong>Room</strong>
                            </div>
                            <div className="d-flex gap-2">
                                <Button size="sm" variant={roomLockedRef.current ? 'warning' : 'outline-secondary'} onClick={() => setLocked(!roomLockedRef.current)}>
                                    {roomLockedRef.current ? 'Unlock' : 'Lock'}
                                </Button>
                            </div>
                        </div>
                    )}
                    {/* Name editing removed per request – we only show list here */}
                    <ListGroup variant="flush">
                        <ListGroup.Item>
                            <div className="d-flex justify-content-between align-items-center">
                                <span>{displayNameRef.current || "You"} {handRaisedMe ? '✋' : ''} <small className="text-muted">({selfId.slice(0, 6)})</small></span>
                                <span className={`badge bg-${muted ? "danger" : "success"}`}>{muted ? "Muted" : "Mic On"}</span>
                            </div>
                        </ListGroup.Item>
                        {peerIds.map((id) => (
                            <ListGroup.Item key={id}>
                                <div className="d-flex justify-content-between align-items-center">
                                    <span>{memberStateRef.current.get(id)?.name || id} {memberStateRef.current.get(id)?.handRaised ? '✋' : ''} <small className="text-muted">({id.slice(0, 6)})</small></span>
                                    <span className={`badge bg-${memberStateRef.current.get(id)?.muted ? "danger" : "success"}`}>
                                        {memberStateRef.current.get(id)?.muted ? "Muted" : "Mic On"}
                                    </span>
                                </div>
                            </ListGroup.Item>
                        ))}
                        {selfRole === 'host' && waitingListRef.current.length > 0 && (
                            <>
                                <div className="mt-3 mb-2"><strong>Waiting room</strong></div>
                                {waitingListRef.current.map((w) => (
                                    <ListGroup.Item key={w.id} className="d-flex justify-content-between align-items-center">
                                        <span>{w.name} <small className="text-muted">({w.id.slice(0, 6)})</small></span>
                                        <span className="d-flex gap-2">
                                            <Button size="sm" variant="success" onClick={() => admit(w.id)}>Admit</Button>
                                            <Button size="sm" variant="outline-danger" onClick={() => deny(w.id)}>Deny</Button>
                                        </span>
                                    </ListGroup.Item>
                                ))}
                            </>
                        )}
                    </ListGroup>
                </Offcanvas.Body>
            </Offcanvas>

            {/* Chat Offcanvas */}
            <Offcanvas show={showChat} onHide={() => setShowChat(false)} placement="end" scroll backdrop={false}>
                <Offcanvas.Header closeButton>
                    <Offcanvas.Title>Chat</Offcanvas.Title>
                </Offcanvas.Header>
                <Offcanvas.Body>
                    <div style={{ maxHeight: '60vh', overflowY: 'auto' }} className="mb-3">
                        {messages.map((m, idx) => (
                            <div key={idx} className="mb-2">
                                <small className="text-muted">{m.from.slice(0, 6)} · {new Date(m.ts).toLocaleTimeString()}</small>
                                <div>{m.text}</div>
                            </div>
                        ))}
                    </div>
                    <Form onSubmit={(e) => { e.preventDefault(); sendChat(); }}>
                        <div className="d-flex gap-2">
                            <Form.Control value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Type a message" />
                            <Button type="submit">Send</Button>
                        </div>
                    </Form>
                </Offcanvas.Body>
            </Offcanvas>

            {/* Settings Offcanvas */}
            <Offcanvas show={showSettings} onHide={() => setShowSettings(false)} placement="end" scroll backdrop={false}>
                <Offcanvas.Header closeButton>
                    <Offcanvas.Title>Settings</Offcanvas.Title>
                </Offcanvas.Header>
                <Offcanvas.Body>
                    <div className="mb-3">
                        <strong>Microphone</strong>
                        <Form.Select className="mt-2" value={selectedMicId ?? ''} onChange={(e) => switchMicrophone(e.target.value)}>
                            {audioInputs.map(d => (<option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 6)}`}</option>))}
                        </Form.Select>
                    </div>
                    <div className="mb-3">
                        <strong>Camera</strong>
                        <Form.Select className="mt-2" value={selectedCamId ?? ''} onChange={(e) => switchCamera(e.target.value)}>
                            {videoInputs.map(d => (<option key={d.deviceId} value={d.deviceId}>{d.label || `Cam ${d.deviceId.slice(0, 6)}`}</option>))}
                        </Form.Select>
                    </div>
                    <div className="mb-3">
                        <strong>Resolution</strong>
                        <Form.Select className="mt-2" value={selectedRes} onChange={(e) => changeResolution(e.target.value)}>
                            <option value="360p">360p</option>
                            <option value="480p">480p</option>
                            <option value="720p">720p</option>
                            <option value="1080p">1080p</option>
                        </Form.Select>
                    </div>
                </Offcanvas.Body>
            </Offcanvas>

            {/* Stage for pinned tile */}
            {pinnedId && (
                <Row className="mb-3">
                    <Col xs={12} className="d-flex justify-content-center">
                        <div className={`position-relative ${activeSpeakerId === (pinnedId === "self" ? selfId : pinnedId) ? "border border-3 border-warning" : ""}`} style={{ width: "min(100%, 720px)" }}>
                            <video ref={stageVideoRef} playsInline autoPlay className="w-100 h-100" />
                            <Badge bg={pinnedId === "self" ? "secondary" : "primary"} className="position-absolute top-0 start-0 m-2">
                                {pinnedId === "self" ? (displayNameRef.current || "You").slice(0, 12) : (memberStateRef.current.get(pinnedId)?.name || pinnedId).slice(0, 12)}
                            </Badge>
                            <Button size="sm" variant="dark" className="position-absolute bottom-0 end-0 m-2" onClick={() => setPinnedId(null)}>Unpin</Button>
                        </div>
                    </Col>
                </Row>
            )}

            <Row className="mt-3">
                <Col className="d-flex justify-content-center">
                    <ButtonGroup>
                        <Button variant={muted ? "outline-danger" : "outline-secondary"} onClick={toggleMic}>
                            {muted ? "Unmute" : "Mute"}
                        </Button>
                        <Button variant={cameraOff ? "outline-danger" : "outline-secondary"} onClick={toggleCam}>
                            {cameraOff ? "Camera On" : "Camera Off"}
                        </Button>
                        <Button variant={sharingRef.current ? "warning" : "outline-secondary"} onClick={shareScreen}>{sharingRef.current ? "Stop Share" : "Share Screen"}</Button>
                        <Button variant="outline-secondary" onClick={() => sendReaction("👍")}>👍</Button>
                        <Button variant="outline-secondary" onClick={() => sendReaction("👏")}>👏</Button>
                        <Button variant={handRaisedMe ? "warning" : "outline-secondary"} onClick={toggleHand}>✋</Button>
                        <Button variant={inviteCopied ? "success" : "outline-secondary"} onClick={invite}>{inviteCopied ? "Link Copied" : "Invite"}</Button>
                        <Button variant="danger" onClick={hangup}>Hang up</Button>
                    </ButtonGroup>
                </Col>
            </Row>
        </Container>
    );
}


