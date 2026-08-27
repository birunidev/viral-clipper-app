"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, MonitorPlay, Warning, Record, UploadSimple, Check } from "@phosphor-icons/react";
import { extractVideoId, loadYouTubeIframeAPI, createYouTubePlayer, parseYouTubeError } from "@/lib/youtube-iframe";
import { hasDisplayMediaSupport, tabAudioLikelyUnsupported, requestTabCaptureStream, tryCropToElement, stopStream } from "@/lib/tab-capture";
import { getSupportedMimeType, createRecorder } from "@/lib/media-recorder";
import { Button } from "@/components/ui/button";

type Props = {
  youtubeUrl: string;
  onCaptured: (blob: Blob, title: string) => void;
  onError?: (msg: string) => void;
};

export function YoutubeCapture({ youtubeUrl, onCaptured, onError }: Props) {
  const videoId = extractVideoId(youtubeUrl.trim());
  const containerId = "yt-capture-player";
  const playerRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<{ recorder: MediaRecorder } | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("video/webm");

  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "await_picker" | "capturing" | "recording" | "done">("idle");
  const [error, setError] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [current, setCurrent] = useState<number>(0);
  const [isTabHidden, setIsTabHidden] = useState(false);
  const [showInstructions, setShowInstructions] = useState(true);
  const [noAudioWarn, setNoAudioWarn] = useState(false);
  const [cropActive, setCropActive] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const playerStateRef = useRef<number | null>(null);

  const hasSupport = hasDisplayMediaSupport();
  const safariWarn = tabAudioLikelyUnsupported();

  // Load IFrame API and create player when videoId valid
  useEffect(() => {
    if (!videoId) {
      setError("Invalid YouTube URL.");
      return;
    }
    setError("");
    setPhase("loading");
    setCurrent(0);
    setDuration(0);
    let destroyed = false;
    let player: any = null;
    loadYouTubeIframeAPI()
      .then(() => {
        if (destroyed) return;
        // ensure container exists
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = "";
        player = createYouTubePlayer(containerId, videoId, {
          onReady: (e: any) => {
            try {
              const d = e.target.getDuration?.();
              if (d) setDuration(d);
            } catch {}
            setPhase("ready");
          },
          onStateChange: (e: any) => {
            const state = e.data;
            playerStateRef.current = state;
            // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
            if (state === 1) {
              // playing – if we are in capturing/recording phase, ensure recorder is running
              setShowInstructions(false);
              // duration sync
              try {
                const d = e.target.getDuration?.();
                if (d) setDuration(d);
              } catch {}
              // if recorder hasn't started but we are in capturing, start now (sync requirement)
              if (phase !== "recording" && streamRef.current && recorderRef.current == null) {
                // will be started by startCapture flow; but if user pressed play manually, start here
                // no-op – startCapture already waits for playing before starting recorder
              }
            }
            if (state === 0) {
              // ended – auto stop recording
              if (phase === "recording" || phase === "capturing") {
                stopRecording();
              }
            }
          },
          onError: (e: any) => {
            const msg = parseYouTubeError(e.data);
            setError(msg);
            onError?.(msg);
            setPhase("idle");
          },
        });
        playerRef.current = player;
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load YouTube player");
        setPhase("idle");
      });

    return () => {
      destroyed = true;
      try { player?.destroy?.(); } catch {}
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Poll player time for progress while recording
  useEffect(() => {
    if (phase !== "recording" && phase !== "capturing") return;
    const iv = setInterval(() => {
      try {
        const p = playerRef.current;
        if (p?.getCurrentTime && p?.getDuration) {
          const c = p.getCurrentTime();
          const d = p.getDuration();
          setCurrent(c);
          if (d) setDuration(d);
        }
      } catch {}
    }, 500);
    return () => clearInterval(iv);
  }, [phase]);

  // visibility warning
  useEffect(() => {
    const onVis = () => setIsTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      stopStream(streamRef.current);
      try { recorderRef.current?.recorder?.stop(); } catch {}
    };
  }, []);

  async function startCapture() {
    if (!videoId) {
      setError("Enter a valid YouTube URL first.");
      return;
    }
    if (!hasSupport) {
      setError("Tab capture not supported. Use Chrome or Edge on desktop.");
      return;
    }
    setError("");
    setNoAudioWarn(false);
    setCropActive(false);
    setRecordedBlob(null);
    chunksRef.current = [];
    setShowInstructions(false);
    setPhase("await_picker");

    // Instruct – small delay so user reads modal before picker steals focus
    // But spec says instruct before picker opens – we show instructions already, now open picker
    let stream: MediaStream;
    try {
      stream = await requestTabCaptureStream();
    } catch (e: any) {
      setError(e instanceof Error ? e.message : "Capture denied");
      setPhase("ready");
      setShowInstructions(true);
      return;
    }
    streamRef.current = stream;
    if ((stream as any)._noAudio) setNoAudioWarn(true);

    // Try CropTarget to clean video region (progressive enhancement)
    try {
      const iframeEl = document.getElementById(containerId) as HTMLElement | null;
      const target = iframeEl || (document.getElementById("yt-capture-wrapper") as HTMLElement | null);
      if (target) {
        const ok = await tryCropToElement(stream, target);
        setCropActive(ok);
      }
    } catch {}

    // Mirror stream ended (user stops sharing via browser UI)
    stream.getVideoTracks().forEach((t) => {
      t.onended = () => {
        if (phase === "recording" || phase === "capturing") stopRecording();
      };
    });

    setPhase("capturing");

    // Wait for actual playback (playing) – don't start recorder on click alone
    const player = playerRef.current;
    if (player?.playVideo) {
      try { player.playVideo(); } catch {}
    }
    // Poll for playing state for up to 10s, then start anyway (user may have paused)
    let waited = 0;
    const waitIv = setInterval(() => {
      waited += 200;
      const st = playerStateRef.current;
      const isPlaying = st === 1;
      if (isPlaying || waited >= 10000) {
        clearInterval(waitIv);
        startRecordingFromStream(stream);
      }
    }, 200);
  }

  function startRecordingFromStream(stream: MediaStream) {
    if (recorderRef.current) return;
    const mime = getSupportedMimeType();
    mimeRef.current = mime;
    setPhase("recording");
    const ctrl = createRecorder(
      stream,
      (blob) => {
        chunksRef.current.push(blob);
      },
      { mimeType: mime, timesliceMs: 1000, videoBitsPerSecond: 5_000_000 }
    );
    recorderRef.current = ctrl as any;

    // Also listen to stream inactive (user stopped sharing)
    try {
      (stream as any).oninactive = () => stopRecording();
      stream.addEventListener("inactive", stopRecording);
    } catch {}
  }

  function stopRecording() {
    const ctrl = recorderRef.current as any;
    const stream = streamRef.current;
    try {
      if (ctrl?.recorder?.state === "recording") {
        ctrl.recorder.onstop = () => {
          const blob = new Blob(chunksRef.current as BlobPart[], { type: mimeRef.current || "video/webm" });
          setRecordedBlob(blob);
          setPhase("done");
          stopStream(stream);
          streamRef.current = null;
          recorderRef.current = null;
        };
        ctrl.recorder.stop();
      } else {
        // no recorder yet – just stop stream and finalize whatever chunks we have
        const blob = chunksRef.current.length ? new Blob(chunksRef.current as BlobPart[], { type: mimeRef.current || "video/webm" }) : null;
        if (blob && blob.size > 0) setRecordedBlob(blob);
        setPhase(blob && blob.size > 0 ? "done" : "ready");
        stopStream(stream);
        streamRef.current = null;
        recorderRef.current = null;
      }
    } catch {
      stopStream(stream);
      streamRef.current = null;
      recorderRef.current = null;
      setPhase("ready");
    }
  }

  function handleUseRecording() {
    if (!recordedBlob) return;
    let title = "captured video";
    try {
      const p: any = playerRef.current;
      const data = p?.getVideoData?.();
      if (data?.title) title = data.title;
    } catch {}
    onCaptured(recordedBlob, title);
  }

  function discardAndReset() {
    setRecordedBlob(null);
    chunksRef.current = [];
    setPhase("ready");
    setShowInstructions(true);
    setCurrent(0);
    stopStream(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
  }

  const percent = duration ? Math.min(100, (current / duration) * 100) : 0;

  if (!videoId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
        Enter a YouTube URL above to preview. Capture requires a valid public video.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-zinc-950">
      {/* Dominant progress/processing overlay */}
      <div className="relative min-h-[340px] p-6 text-white">
        {/* Header */}
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-medium">
            <MonitorPlay size={18} weight="fill" />
            {phase === "recording" ? "Capturing…" : phase === "capturing" ? "Starting…" : phase === "done" ? "Capture finished" : "Ready to capture"}
            {cropActive && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide">CROPPED</span>}
          </p>
          {duration > 0 && <span className="text-xs tabular-nums text-white/60">{formatTime(current)} / {formatTime(duration)}</span>}
        </div>

        {/* Progress bar driven by real playback position */}
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-white transition-all duration-500" style={{ width: `${percent}%` }} />
        </div>

        {/* Status / instructions */}
        {(phase === "idle" || phase === "ready" || phase === "await_picker") && showInstructions && (
          <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.06] p-3 text-xs leading-relaxed text-white/80">
            <p className="font-medium text-white">Before you start:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Click <b>Start Capture</b> – your browser will ask what to share.</li>
              <li>Choose <b>This Tab</b> and enable <b>Share tab audio</b> (required).</li>
              <li>Capture takes as long as the video’s runtime – keep this tab active &amp; visible.</li>
              <li>Recording starts automatically when playback begins – don’t close the picker early.</li>
            </ol>
            <p className="mt-2 text-[11px] text-white/60">Small preview player stays in the corner – it must stay visible for the recording to work.</p>
          </div>
        )}

        {phase === "await_picker" && (
          <p className="mt-4 animate-pulse text-xs font-medium text-amber-300">Waiting for tab picker… Select “This Tab” + Share audio</p>
        )}

        {phase === "recording" && (
          <div className="mt-4 flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 rounded-full bg-red-500 px-2.5 py-1 font-medium text-white">
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> REC
            </span>
            <span className="text-white/70">Recording – keep tab visible</span>
          </div>
        )}

        {isTabHidden && (phase === "recording" || phase === "capturing") && (
          <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/15 px-3 py-2 text-xs text-amber-200">
            <Warning size={14} weight="fill" /> Tab hidden – browser may throttle. Bring tab to front.
          </div>
        )}

        {noAudioWarn && (
          <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/15 px-3 py-2 text-xs text-amber-200">
            <Warning size={14} weight="fill" /> No audio track – you didn’t enable “Share tab audio”. Recording will be silent; restart and enable it.
          </div>
        )}

        {safariWarn && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/15 px-3 py-2 text-xs leading-relaxed text-amber-200">
            Safari can’t capture tab audio. Video will be silent – use Chrome/Edge on desktop for full capture.
          </div>
        )}

        {!hasSupport && (
          <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-400/15 px-3 py-2 text-xs text-red-200">
            <Warning size={14} weight="fill" /> Tab capture not supported in this browser. Use Chrome or Edge on desktop.
          </div>
        )}

        {/* Action buttons */}
        <div className="mt-5 flex flex-wrap gap-2">
          {(phase === "ready" || phase === "idle") && (
            <Button onClick={startCapture} disabled={!hasSupport || !videoId}>
              <Record size={16} weight="fill" /> Start Capture
            </Button>
          )}
          {(phase === "capturing" || phase === "recording") && (
            <Button variant="secondary" onClick={stopRecording}>
              <Clock size={16} /> Stop capture
            </Button>
          )}
          {phase === "done" && recordedBlob && (
            <>
              <Button onClick={handleUseRecording}>
                <UploadSimple size={16} /> Use this recording ({(recordedBlob.size / 1024 / 1024).toFixed(1)} MB)
              </Button>
              <Button variant="ghost" onClick={discardAndReset}>Re-record</Button>
              <a
                href={URL.createObjectURL(recordedBlob)}
                download={`capture-${videoId}.webm`}
                className="inline-flex h-9 items-center justify-center rounded-lg border border-white/15 bg-white/10 px-4 text-sm font-medium text-white hover:bg-white/15"
                onClick={(e) => setTimeout(() => URL.revokeObjectURL((e.target as HTMLAnchorElement).href), 60000)}
              >
                Download locally
              </a>
            </>
          )}
        </div>

        {error && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-red-300">
            <Warning size={14} weight="fill" /> {error}
          </p>
        )}

        {phase === "done" && recordedBlob && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-300">
            <Check size={14} weight="bold" /> Captured {formatTime(duration)} – click “Use this recording” to upload. No need to re-record if upload fails – just retry.
          </p>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-white/50">
          Tip: The small player in the corner must stay rendered (not hidden/covered) or the recording will be blank. The overlay above is the focus – capture runs at real-time speed.
        </p>
      </div>

      {/* Small, corner-positioned, always-visible iframe – never display:none / opacity:0 */}
      <div
        id="yt-capture-wrapper"
        className="pointer-events-none fixed bottom-4 right-4 z-30 h-[90px] w-[160px] overflow-hidden rounded-lg border border-white/15 bg-black opacity-80 shadow-xl"
        aria-hidden
        style={{ opacity: 0.85 }}
      >
        <div id={containerId} className="h-full w-full" />
      </div>

      {/* Ensure page doesn't clip fixed corner when capture not active – keep element in DOM */}
    </div>
  );
}

function formatTime(s: number): string {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
