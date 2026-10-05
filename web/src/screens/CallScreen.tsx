import { useEffect, useRef, useState } from "react";
import { switchCamera, type CallEndReason, type CallState } from "../chat/call";
import { listDevices } from "../chat/mediaDevices";

interface CallScreenProps {
  callState: Exclude<CallState, { status: "idle" }>;
  onAccept: () => void;
  onDecline: () => void;
  onHangUp: () => void;
}

const END_REASON_LABEL: Record<CallEndReason, string> = {
  hangup: "Call ended",
  declined: "Declined",
  cancelled: "Call cancelled",
  timeout: "Unreachable",
  failed: "Call failed",
};

function VideoPane({ stream, muted, testId }: { stream: MediaStream | null; muted: boolean; testId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} data-testid={testId} />;
}

function AudioPane({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay data-testid="remote-audio" />;
}

export function CallScreen({ callState, onAccept, onDecline, onHangUp }: CallScreenProps) {
  const [muted, setMuted] = useState(false);
  const [cameraCount, setCameraCount] = useState(0);
  const [switching, setSwitching] = useState(false);

  // Counted again as the call moves on: a browser may only list every camera once one is in use.
  useEffect(() => {
    listDevices("videoinput").then((cameras) => setCameraCount(cameras.length), () => setCameraCount(0));
  }, [callState.status]);

  function handleSwitchCamera() {
    setSwitching(true);
    switchCamera()
      .catch((err) => console.warn("could not switch camera:", err))
      .finally(() => setSwitching(false));
  }

  function toggleMute() {
    if (!("localStream" in callState)) return;
    const next = !muted;
    for (const track of callState.localStream.getAudioTracks()) track.enabled = !next;
    setMuted(next);
  }

  if (callState.status === "incoming-ringing") {
    return (
      <div className="call-overlay">
        <div className="call-card" data-testid="incoming-call-banner">
          <p>Incoming {callState.kind} call</p>
          <div className="call-actions">
            <button onClick={onAccept}>Accept</button>
            <button className="danger" onClick={onDecline}>
              Decline
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (callState.status === "ended") {
    return (
      <div className="call-overlay">
        <div className="call-card" data-testid="call-ended">
          <p data-testid="call-end-reason">{END_REASON_LABEL[callState.reason]}</p>
        </div>
      </div>
    );
  }

  // outgoing-ringing, connecting, or connected
  const isVideo = callState.kind === "video";
  const remoteStream = "remoteStream" in callState ? callState.remoteStream : null;

  return (
    <div className="call-overlay">
      <div className="call-card" data-testid="active-call-screen">
        <p data-testid="call-status-label">{callState.status === "outgoing-ringing" ? "Calling..." : callState.status === "connecting" ? "Connecting..." : "Connected"}</p>
        {isVideo ? (
          <div className="video-grid">
            <VideoPane stream={remoteStream} muted={false} testId="remote-video" />
            <VideoPane stream={callState.localStream} muted testId="local-video" />
          </div>
        ) : (
          <AudioPane stream={remoteStream} />
        )}
        <div className="call-actions">
          <button className="secondary" onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </button>
          {isVideo && cameraCount > 1 && (
            <button className="secondary" onClick={handleSwitchCamera} disabled={switching}>
              Switch camera
            </button>
          )}
          <button className="danger" onClick={onHangUp}>
            Hang Up
          </button>
        </div>
      </div>
    </div>
  );
}
