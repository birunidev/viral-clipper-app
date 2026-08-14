"""Load and save user settings to a local config.json.

Note: API keys are stored as plaintext on disk, next to the app.
This is local, single-user storage only and is not encrypted.
"""

from __future__ import annotations

import json
import os

from dotenv import load_dotenv

load_dotenv()

CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")

DEFAULT_CONFIG = {
    "assemblyai_key": "",
    "llm_api_key": "",
    "llm_base_url": "https://api.openai.com/v1",
    "llm_model": "gpt-4o-mini",
    "output_dir": "outputs",
    "output_orientation": "portrait",
    "max_clips": 10,
}


def load_config(path: str = CONFIG_FILE) -> dict:
    """Load settings from config.json, falling back to defaults."""
    config = dict(DEFAULT_CONFIG)
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
            if isinstance(saved, dict):
                config.update(saved)
        except (json.JSONDecodeError, OSError):
            pass
    return config


def save_config(config: dict, path: str = CONFIG_FILE) -> None:
    """Persist settings to config.json, creating parent dirs if needed."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=2, ensure_ascii=False)
