"use client";

import React, { useState, useRef, useEffect } from "react";
import { App } from "antd";
import {
  ArrowLeftOutlined,
  ShoppingOutlined,
  CopyOutlined,
  CheckOutlined,
  LikeOutlined,
  DislikeOutlined,
  SoundOutlined,
  RedoOutlined,
} from "@ant-design/icons";

interface Message {
  id: string;
  role: "user" | "advisor";
  text: string;
  audioUrl?: string;
}

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" && window.location.port !== "8000" && window.location.hostname !== "localhost"
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : "http://localhost:8000");

const SUGGESTIONS = [
  "What is the Tata Motors Guru Program?",
  "How do I earn points?",
  "What is PPD and annual slab?",
  "Can I redeem points for cash?",
  "I want to speak with customer care",
];

const VOLUME_THRESHOLD = 14;      // Speaking volume threshold
const SILENCE_DURATION_MS = 1000; // 1s silence auto-trigger

export default function VoiceAgentPage() {
  const { message } = App.useApp();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "init-1",
      role: "advisor",
      text: "Hello! I am your Tata Motors Guru Program voice assistant. How can I assist you with your rewards, tiers, or points today?",
    },
  ]);
  const [isRecording, setIsRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // VAD refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const hasSpokenRef = useRef<boolean>(false);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentState]);

  const handleOrbClick = () => {
    if (agentState === "speaking") {
      stopAudioPlayback();
      return;
    }
    if (agentState === "listening") {
      stopRecording();
      return;
    }
    if (agentState === "idle") {
      startRecording();
    }
  };

  const cleanupAudioNodes = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    hasSpokenRef.current = false;
  };

  const startRecording = async () => {
    try {
      stopAudioPlayback();
      cleanupAudioNodes();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audioChunksRef.current = [];

      // Web Audio VAD
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      hasSpokenRef.current = false;

      const checkAudioLevel = () => {
        if (!analyser) return;

        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const averageVolume = sum / bufferLength;

        if (averageVolume > VOLUME_THRESHOLD) {
          hasSpokenRef.current = true;
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        } else if (hasSpokenRef.current) {
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              console.log("[VAD] 1s silence detected -> auto stop");
              stopRecording();
            }, SILENCE_DURATION_MS);
          }
        }

        animFrameRef.current = requestAnimationFrame(checkAudioLevel);
      };

      // MediaRecorder
      let options: MediaRecorderOptions = {};
      if (typeof MediaRecorder !== "undefined") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          options = { mimeType: "audio/webm;codecs=opus" };
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          options = { mimeType: "audio/webm" };
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          options = { mimeType: "audio/mp4" };
        }
      }

      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        cleanupAudioNodes();
        stream.getTracks().forEach((track) => track.stop());
        const mime = recorder.mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: mime });
        if (audioBlob.size > 1000) {
          await sendVoiceToBackend(audioBlob);
        } else {
          setAgentState("idle");
          message.warning("Audio was too short. Please try speaking again.");
        }
      };

      recorder.start();
      setIsRecording(true);
      setAgentState("listening");

      animFrameRef.current = requestAnimationFrame(checkAudioLevel);
    } catch (err: any) {
      console.error("Microphone access error:", err);
      cleanupAudioNodes();
      message.error(`Microphone: ${err?.name || "Error"} - ${err?.message || "Check device"}`);
      setAgentState("idle");
    }
  };

  const stopRecording = () => {
    cleanupAudioNodes();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setAgentState("thinking");
    }
  };

  const sendVoiceToBackend = async (blob: Blob) => {
    try {
      setAgentState("thinking");
      const formData = new FormData();
      formData.append("file", blob, "user_voice.webm");

      const res = await fetch(`${BACKEND_URL}/voice-query`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const data = await res.json();
      handleResponse(data);
    } catch (err) {
      console.error("Voice query error:", err);
      message.error(`Could not reach backend on ${BACKEND_URL}`);
      setAgentState("idle");
    }
  };

  const sendTextQuery = async (text: string) => {
    try {
      stopAudioPlayback();
      setAgentState("thinking");

      const userMsgId = `user-${Date.now()}`;
      setMessages((prev) => [...prev, { id: userMsgId, role: "user", text }]);

      const res = await fetch(`${BACKEND_URL}/text-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const data = await res.json();
      handleResponse(data, false);
    } catch (err) {
      console.error("Text query error:", err);
      message.error("Failed to get response from server.");
      setAgentState("idle");
    }
  };

  const handleResponse = (data: { transcript?: string; answer?: string; audio_url?: string }, appendUserMsg = true) => {
    const timestamp = Date.now();

    if (appendUserMsg && data.transcript) {
      setMessages((prev) => [
        ...prev,
        { id: `user-${timestamp}`, role: "user", text: data.transcript! },
      ]);
    }

    if (data.answer) {
      setMessages((prev) => [
        ...prev,
        { id: `advisor-${timestamp}`, role: "advisor", text: data.answer!, audioUrl: data.audio_url },
      ]);
    }

    if (data.audio_url && audioPlayerRef.current) {
      const audioUrl = data.audio_url;

      audioPlayerRef.current.src = audioUrl;
      audioPlayerRef.current.load();
      audioPlayerRef.current
        .play()
        .then(() => setAgentState("speaking"))
        .catch((err) => {
          console.error("Autoplay blocked:", err);
          setAgentState("idle");
        });
    } else {
      setAgentState("idle");
    }
  };

  const replayAudio = (audioUrl?: string) => {
    if (!audioUrl || !audioPlayerRef.current) return;
    stopAudioPlayback();
    const url = audioUrl;
    audioPlayerRef.current.src = url;
    audioPlayerRef.current.play().then(() => setAgentState("speaking")).catch(() => setAgentState("idle"));
  };

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    message.success({ content: "Copied to clipboard!", duration: 1.5 });
    setTimeout(() => setCopiedId(null), 2000);
  };

  const stopAudioPlayback = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    setAgentState("idle");
  };

  return (
    <div className="assistant-container">
      {/* Background Audio */}
      <audio
        ref={audioPlayerRef}
        onEnded={() => setAgentState("idle")}
        onError={() => setAgentState("idle")}
        style={{ display: "none" }}
      />

      {/* Top Header - Matches Screenshot */}
      <header className="assistant-header">
        <div className="header-left">
          <div className="circle-btn">
            <ArrowLeftOutlined />
          </div>
          <div className="header-title">AI Assistant</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div className="header-status">
            <span className={`status-dot ${agentState}`} />
            <span style={{ textTransform: "capitalize" }}>
              {agentState === "listening"
                ? "Listening..."
                : agentState === "thinking"
                ? "Thinking..."
                : agentState === "speaking"
                ? "Speaking..."
                : "Online"}
            </span>
          </div>
         
        </div>
      </header>

      {/* Main Chat Stream */}
      <main className="assistant-main">
        {/* Suggestion Pills */}
        <div className="suggestion-bar">
          {SUGGESTIONS.map((item, idx) => (
            <button
              key={idx}
              onClick={() => sendTextQuery(item)}
              disabled={agentState !== "idle"}
              className="suggestion-pill"
            >
              {item}
            </button>
          ))}
        </div>

        {/* Messages */}
        {messages.map((msg) => (
          <React.Fragment key={msg.id}>
            {msg.role === "user" ? (
              <div className="msg-user-row">
                <div className="msg-user-bubble">{msg.text}</div>
              </div>
            ) : (
              <div className="msg-advisor-row">
                <div className="advisor-avatar">
                  🤖
                </div>
                <div className="advisor-content">
                  <div className="advisor-text">{msg.text}</div>
                  <div className="advisor-actions">
                    <span
                      className="action-btn"
                      title={copiedId === msg.id ? "Copied!" : "Copy"}
                      onClick={() => copyToClipboard(msg.id, msg.text)}
                    >
                      {copiedId === msg.id ? (
                        <CheckOutlined style={{ color: "#7054f7" }} />
                      ) : (
                        <CopyOutlined />
                      )}
                    </span>
                    <span className="action-btn" title="Like">
                      <LikeOutlined />
                    </span>
                    <span className="action-btn" title="Dislike">
                      <DislikeOutlined />
                    </span>
                    {msg.audioUrl && (
                      <span
                        className="action-btn"
                        title="Replay Voice"
                        onClick={() => replayAudio(msg.audioUrl)}
                      >
                        <SoundOutlined />
                      </span>
                    )}
                    <span className="action-btn" title="Retry">
                      <RedoOutlined />
                    </span>
                  </div>
                </div>
              </div>
            )}
          </React.Fragment>
        ))}

        {/* Typing indicator matching screenshot dots */}
        {agentState === "thinking" && (
          <div className="msg-advisor-row">
            <div className="advisor-avatar">
              🤖
            </div>
            <div className="advisor-content">
              <div className="typing-dots">
                <span></span>
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </main>

      {/* Floating Bottom Fluid Voice Orb */}
      <div className="floating-orb-dock">
        <span className="orb-status-caption">
          {agentState === "listening"
            ? "Listening... (1s silence auto-sends)"
            : agentState === "thinking"
            ? "Processing..."
            : agentState === "speaking"
            ? "Advisor is speaking..."
            : "Tap to speak"}
        </span>

        <button
          onClick={handleOrbClick}
          disabled={agentState === "thinking"}
          className={`iris-voice-orb ${agentState}`}
          aria-label="Voice Assistant"
        >
          <div className="iris-sphere" />
          {agentState === "listening" && <div className="orb-glow-ring" />}
        </button>
      </div>
    </div>
  );
}
