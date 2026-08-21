"""Built-in caption style presets.

Each preset is a JSON config consumed by ``core/captions.py`` to build the
ASS subtitle file that gets burned into a rendered clip. Field reference:

- ``font``: font family name (must be registered in the image via fontconfig).
- ``font_size``: base font size; scaled proportionally to the output height
  by the ASS ``PlayRes`` header at build time.
- ``x`` / ``y``: caption anchor. ``x`` in ``left | center | right``; ``y``
  a fraction of the frame height (e.g. ``0.8`` = 80% from top).
- ``bold`` / ``italic``: text weight/slant.
- ``primary_color``: idle (unspoken) text color.
- ``highlight_color``: the active/current word color (karaoke).
- ``outline_color``, ``outline``, ``shadow``: libass outline/shadow.
- ``words_per_line`` / ``max_chars_per_line``: how words are grouped.
- ``boxed`` / ``box_opacity``: optional semi-opaque backdrop behind text.

Colors are hex strings; they are converted to ASS ``&HAABBGGRR`` at build
time so the alpha (opacity) can be tuned per preset.
"""

from __future__ import annotations

BUILTIN_CAPTION_STYLES: list[dict] = [
    {
        "key": "classic",
        "label": "Classic",
        "config": {
            "font": "Anton",
            "font_size": 72,
            "x": "center",
            "y": 0.8,
            "bold": True,
            "italic": False,
            "primary_color": "#FFFFFF",
            "highlight_color": "#FFD60A",
            "outline_color": "#000000",
            "outline": 4,
            "shadow": 0,
            "words_per_line": 4,
            "max_chars_per_line": 32,
            "boxed": False,
            "box_opacity": 0.0,
        },
    },
    {
        "key": "clean",
        "label": "Clean",
        "config": {
            "font": "Space Grotesk",
            "font_size": 64,
            "x": "center",
            "y": 0.8,
            "bold": False,
            "italic": False,
            "primary_color": "#FFFFFF",
            "highlight_color": "#FFFFFF",
            "outline_color": "#000000",
            "outline": 3,
            "shadow": 0,
            "words_per_line": 5,
            "max_chars_per_line": 36,
            "boxed": False,
            "box_opacity": 0.0,
        },
    },
    {
        "key": "pop",
        "label": "Pop",
        "config": {
            "font": "Anton",
            "font_size": 88,
            "x": "center",
            "y": 0.75,
            "bold": True,
            "italic": False,
            "primary_color": "#FFFFFF",
            "highlight_color": "#FF5A52",
            "outline_color": "#000000",
            "outline": 5,
            "shadow": 2,
            "words_per_line": 3,
            "max_chars_per_line": 28,
            "boxed": False,
            "box_opacity": 0.0,
        },
    },
    {
        "key": "boxed",
        "label": "Boxed",
        "config": {
            "font": "Space Grotesk",
            "font_size": 60,
            "x": "center",
            "y": 0.82,
            "bold": True,
            "italic": False,
            "primary_color": "#FFFFFF",
            "highlight_color": "#FFD60A",
            "outline_color": "#000000",
            "outline": 2,
            "shadow": 0,
            "words_per_line": 4,
            "max_chars_per_line": 32,
            "boxed": True,
            "box_opacity": 0.45,
        },
    },
    {
        "key": "minimal",
        "label": "Minimal",
        "config": {
            "font": "Space Grotesk",
            "font_size": 56,
            "x": "center",
            "y": 0.85,
            "bold": False,
            "italic": False,
            "primary_color": "#E4E4E7",
            "highlight_color": "#FFFFFF",
            "outline_color": "#000000",
            "outline": 2,
            "shadow": 0,
            "words_per_line": 6,
            "max_chars_per_line": 40,
            "boxed": False,
            "box_opacity": 0.0,
        },
    },
]


def builtin_style_by_key(key: str) -> dict | None:
    for style in BUILTIN_CAPTION_STYLES:
        if style["key"] == key:
            return style
    return None
