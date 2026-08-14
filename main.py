#!/usr/bin/env python3
"""ClipForge application entry point."""

from __future__ import annotations

import sys

from dotenv import load_dotenv


def main() -> None:
    load_dotenv()
    from ui.app import ClipForgeApp

    app = ClipForgeApp()
    app.mainloop()


if __name__ == "__main__":
    sys.exit(main())
