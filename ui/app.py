"""CustomTkinter main window with threaded pipeline execution."""

from __future__ import annotations

import os
import platform
import queue
import subprocess
import threading

import customtkinter as ctk

from core import config as config_mod
from core.analyzer import analyze, AnalysisError
from core.cutter import cut_clip, CutterError, slugify
from core.transcriber import transcribe, TranscriptionError
from core.youtube import download, DownloadError, is_url

OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "outputs"
)
DOWNLOADS_DIR = os.path.join(OUTPUT_DIR, "downloads")

ORIENTATION_OPTIONS = {
    "9:16": "portrait",
    "16:9": "landscape",
    "Original": "original",
}


class ClipForgeApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("ClipForge - Viral Clip Generator")
        self.geometry("760x640")
        self.minsize(640, 560)

        self.config = config_mod.load_config()
        self._msg_queue: queue.Queue = queue.Queue()
        self._output_files: list[str] = []

        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self._build_widgets()
        self._prefill_from_config()
        self._poll_messages()

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ UI
    def _build_widgets(self) -> None:
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(4, weight=1)

        input_frame = ctk.CTkFrame(self, corner_radius=10)
        input_frame.grid(row=0, column=0, padx=14, pady=(14, 6), sticky="ew")
        input_frame.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(input_frame, text="Video:").grid(row=0, column=0, padx=10, pady=10)
        self.file_entry = ctk.CTkEntry(
            input_frame,
            placeholder_text="Select a video file or paste a YouTube URL...",
        )
        self.file_entry.grid(row=0, column=1, padx=(0, 8), pady=10, sticky="ew")
        self.browse_btn = ctk.CTkButton(
            input_frame, text="Browse", width=90, command=self._browse_file
        )
        self.browse_btn.grid(row=0, column=2, padx=(0, 10), pady=10)

        cred_frame = ctk.CTkFrame(self, corner_radius=10)
        cred_frame.grid(row=1, column=0, padx=14, pady=6, sticky="ew")
        cred_frame.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(cred_frame, text="AssemblyAI key:").grid(row=0, column=0, padx=10, pady=(10, 4), sticky="w")
        self.aai_entry = ctk.CTkEntry(cred_frame, show="*")
        self.aai_entry.grid(row=0, column=1, padx=(0, 10), pady=(10, 4), sticky="ew")

        ctk.CTkLabel(cred_frame, text="LLM API key:").grid(row=1, column=0, padx=10, pady=4, sticky="w")
        self.llm_key_entry = ctk.CTkEntry(cred_frame, show="*")
        self.llm_key_entry.grid(row=1, column=1, padx=(0, 10), pady=4, sticky="ew")

        ctk.CTkLabel(cred_frame, text="LLM Base URL:").grid(row=2, column=0, padx=10, pady=4, sticky="w")
        self.base_url_entry = ctk.CTkEntry(cred_frame, placeholder_text="https://api.openai.com/v1")
        self.base_url_entry.grid(row=2, column=1, padx=(0, 10), pady=4, sticky="ew")

        ctk.CTkLabel(cred_frame, text="Model:").grid(row=3, column=0, padx=10, pady=(4, 10), sticky="w")
        self.model_entry = ctk.CTkEntry(cred_frame, placeholder_text="gpt-4o-mini")
        self.model_entry.grid(row=3, column=1, padx=(0, 10), pady=(4, 10), sticky="ew")

        action_frame = ctk.CTkFrame(self, corner_radius=10)
        action_frame.grid(row=2, column=0, padx=14, pady=6, sticky="ew")
        action_frame.grid_columnconfigure(1, weight=1)
        action_frame.grid_columnconfigure(2, weight=0)
        action_frame.grid_columnconfigure(3, weight=0)
        self.start_btn = ctk.CTkButton(
            action_frame, text="Start Pipeline", height=36, command=self._start_pipeline
        )
        self.start_btn.grid(row=0, column=0, padx=10, pady=10)
        self.status_label = ctk.CTkLabel(action_frame, text="Ready", text_color="#7f8ea3")
        self.status_label.grid(row=0, column=1, padx=10, pady=10, sticky="w")

        ctk.CTkLabel(action_frame, text="Output:").grid(
            row=1, column=0, padx=(10, 4), pady=(0, 10), sticky="w"
        )
        self.orientation_menu = ctk.CTkOptionMenu(
            action_frame, values=list(ORIENTATION_OPTIONS), width=140
        )
        self.orientation_menu.grid(row=1, column=1, padx=10, pady=(0, 10), sticky="w")

        ctk.CTkLabel(action_frame, text="Max clips:").grid(
            row=1, column=2, padx=(10, 4), pady=(0, 10), sticky="w"
        )
        self.max_clips_menu = ctk.CTkOptionMenu(
            action_frame, values=["5", "10", "20"], width=80
        )
        self.max_clips_menu.grid(row=1, column=3, padx=10, pady=(0, 10), sticky="w")

        progress_frame = ctk.CTkFrame(self, fg_color="transparent")
        progress_frame.grid(row=3, column=0, padx=14, pady=(4, 6), sticky="ew")
        progress_frame.grid_columnconfigure(0, weight=1)

        self.progress = ctk.CTkProgressBar(progress_frame)
        self.progress.grid(row=0, column=0, sticky="ew")
        self.progress.set(0)

        self.percent_label = ctk.CTkLabel(progress_frame, text="0%", width=48)
        self.percent_label.grid(row=0, column=1, padx=(10, 0))

        log_frame = ctk.CTkFrame(self, corner_radius=10)
        log_frame.grid(row=4, column=0, padx=14, pady=(0, 6), sticky="nsew")
        log_frame.grid_rowconfigure(0, weight=1)
        log_frame.grid_columnconfigure(0, weight=1)

        self.log_box = ctk.CTkTextbox(log_frame, wrap="word", font=("monospace", 12))
        self.log_box.grid(row=0, column=0, padx=8, pady=8, sticky="nsew")
        self.log_box.configure(state="disabled")

        self.open_btn = ctk.CTkButton(
            self, text="Open Output Folder", height=34, state="disabled",
            command=self._open_output_folder,
        )
        self.open_btn.grid(row=5, column=0, padx=14, pady=(0, 14))

    def _prefill_from_config(self) -> None:
        self.aai_entry.insert(0, self.config.get("assemblyai_key", ""))
        self.llm_key_entry.insert(0, self.config.get("llm_api_key", ""))
        self.base_url_entry.insert(0, self.config.get("llm_base_url", ""))
        self.model_entry.insert(0, self.config.get("llm_model", ""))
        orient = self.config.get("output_orientation", "portrait")
        display = next(
            (name for name, value in ORIENTATION_OPTIONS.items() if value == orient),
            "9:16",
        )
        self.orientation_menu.set(display)
        self.max_clips_menu.set(str(self.config.get("max_clips", 10)))

    # -------------------------------------------------------------- events
    def _browse_file(self) -> None:
        from tkinter import filedialog, messagebox

        path = filedialog.askopenfilename(
            title="Select a video file",
            filetypes=[("Video files", "*.mp4 *.mov *.mkv *.webm *.avi *.m4v *.ts")],
        )
        if path:
            self.file_entry.delete(0, "end")
            self.file_entry.insert(0, path)

    def _validate(self) -> str | None:
        video = self.file_entry.get().strip()
        if not video:
            return "Please select a video file or enter a YouTube URL."
        if not is_url(video) and not os.path.isfile(video):
            return f"File not found: {video}"
        if not self.aai_entry.get().strip():
            return "AssemblyAI API key is required."
        if not self.llm_key_entry.get().strip():
            return "LLM API key is required."
        if not self.base_url_entry.get().strip():
            return "LLM Base URL is required."
        if not self.model_entry.get().strip():
            return "Model name is required."
        return None

    def _start_pipeline(self) -> None:
        from tkinter import messagebox

        error = self._validate()
        if error:
            messagebox.showerror("Invalid Input", error)
            return

        self.start_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.progress.set(0)
        self.percent_label.configure(text="0%")
        self._log("[i] Starting pipeline...")

        self._save_settings()

        thread = threading.Thread(target=self._run_pipeline, daemon=True)
        thread.start()

    def _run_pipeline(self) -> None:
        try:
            video = self.file_entry.get().strip()
            aai_key = self.aai_entry.get().strip()
            llm_key = self.llm_key_entry.get().strip()
            base_url = self.base_url_entry.get().strip()
            model = self.model_entry.get().strip()

            trans_start = 0.05
            trans_span = 0.35

            if is_url(video):
                self._set_status("[0/3] Downloading video...")
                self._log(f"[0/3] Downloading {video} ...")
                video = download(video, DOWNLOADS_DIR, progress=self._set_progress)
                self._log(f"[0/3] Downloaded to {video}")
                trans_start = 0.3
                trans_span = 0.2

            self._set_status("[1/3] Transcribing audio with AssemblyAI...")
            self._set_progress(trans_start)
            transcript = transcribe(
                video,
                aai_key,
                progress=lambda p: self._set_progress(trans_start + trans_span * p),
            )
            self._log(f"[1/3] Transcription complete ({len(transcript):,} chars).")
            self._set_progress(trans_start + trans_span)

            self._set_status("[2/3] Analyzing transcript for viral moments...")
            clips = analyze(transcript, llm_key, base_url, model)
            max_clips = int(self.max_clips_menu.get())
            if len(clips) > max_clips:
                self._log(
                    f"[2/3] Limiting to {max_clips} clips (found {len(clips)})."
                )
                clips = clips[:max_clips]
            self._log(f"[2/3] Found {len(clips)} viral moments.")
            self._set_progress(0.6)

            self._set_status("[3/3] Cutting and cropping clips with FFmpeg...")
            out_dir = os.path.join(OUTPUT_DIR, slugify(self._video_label(video)))
            orientation = ORIENTATION_OPTIONS.get(
                self.orientation_menu.get(), "portrait"
            )
            self._output_files = []
            for i, clip in enumerate(clips, start=1):
                self._log(
                    f'[3/3] Cutting "{clip["title"]}" ({clip["start"]:.1f}s - {clip["end"]:.1f}s)...'
                )
                self._set_progress(0.6 + (0.35 * (i - 1) / max(len(clips), 1)))
                out = cut_clip(
                    video,
                    clip["start"],
                    clip["end"],
                    clip["title"],
                    out_dir,
                    i,
                    orientation,
                )
                self._output_files.append(out)

            self._set_progress(1.0)
            self._set_status("Done! All clips generated successfully.")
            self._log(f"[✓] Done! {len(self._output_files)} clips saved to {out_dir}")
            self._log(f"    Output: {out_dir}")
            self._notify_done()

        except (TranscriptionError, AnalysisError, CutterError, DownloadError) as exc:
            self._log(f"[!] {exc}", error=True)
            self._set_status("Failed")
            self._notify_failed()
        except Exception as exc:  # pragma: no cover - unexpected
            self._log(f"[!] Unexpected error: {exc}", error=True)
            self._set_status("Failed")
            self._notify_failed()

    # ------------------------------------------------------ thread-safe UI
    def _log(self, message: str, error: bool = False) -> None:
        self._msg_queue.put(("log", message, error))

    def _set_status(self, text: str) -> None:
        self._msg_queue.put(("status", text))

    def _set_progress(self, value: float) -> None:
        self._msg_queue.put(("progress", value))

    def _notify_done(self) -> None:
        self._msg_queue.put(("done", None))

    def _notify_failed(self) -> None:
        self._msg_queue.put(("failed", None))

    def _poll_messages(self) -> None:
        try:
            while True:
                kind, payload, *rest = self._msg_queue.get_nowait()
                if kind == "log":
                    message, error = payload, (rest[0] if rest else False)
                    self.log_box.configure(state="normal")
                    self.log_box.insert("end", message + "\n")
                    if error:
                        self.log_box.tag_add("err", f"end-{len(message)+1}c", "end-1c")
                        self.log_box.tag_config("err", foreground="#ff6b6b")
                    self.log_box.see("end")
                    self.log_box.configure(state="disabled")
                elif kind == "status":
                    self.status_label.configure(text=str(payload))
                elif kind == "progress":
                    value = float(payload)
                    self.progress.set(value)
                    self.percent_label.configure(text=f"{int(round(value * 100))}%")
                elif kind == "done":
                    self.start_btn.configure(state="normal")
                    self.open_btn.configure(state="normal")
                elif kind == "failed":
                    self.start_btn.configure(state="normal")
        except queue.Empty:
            pass
        self.after(100, self._poll_messages)

    # -------------------------------------------------------------- helpers
    def _video_label(self, video_path: str) -> str:
        return os.path.splitext(os.path.basename(video_path))[0]

    def _save_settings(self) -> None:
        self.config.update(
            assemblyai_key=self.aai_entry.get().strip(),
            llm_api_key=self.llm_key_entry.get().strip(),
            llm_base_url=self.base_url_entry.get().strip(),
            llm_model=self.model_entry.get().strip(),
            output_orientation=ORIENTATION_OPTIONS.get(
                self.orientation_menu.get(), "portrait"
            ),
            max_clips=int(self.max_clips_menu.get()),
        )
        try:
            config_mod.save_config(self.config)
        except OSError:
            self._log("[!] Could not save settings to config.json", error=True)

    def _open_output_folder(self) -> None:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        if platform.system() == "Windows":
            os.startfile(OUTPUT_DIR)  # type: ignore[attr-defined]
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", OUTPUT_DIR])
        else:
            subprocess.Popen(["xdg-open", OUTPUT_DIR])

    def _on_close(self) -> None:
        try:
            self._save_settings()
        except Exception:
            pass
        self.destroy()
