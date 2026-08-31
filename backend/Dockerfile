FROM python:3.12-slim

# ffmpeg on Debian trixie/bookworm ships with libass/libfontconfig/libfreetype
# already enabled, so no custom ffmpeg build is needed for caption burn-in.
# fontconfig + fonts-dejavu-core provide a safe fallback if a preset's font
# name can't be resolved from the bundled fonts below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core curl unzip ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl -fsSL https://deno.land/install.sh | sh \
    && mv /root/.deno/bin/deno /usr/local/bin/deno \
    && rm -rf /root/.deno \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && deno --version

# Poetry — system-wide install (no venv inside image)
ENV POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_CREATE=false \
    POETRY_CACHE_DIR=/tmp/poetry_cache

RUN pip install --no-cache-dir poetry==2.4.1

WORKDIR /app

# Install deps first (layer cache). Copy only Poetry manifests.
COPY pyproject.toml poetry.lock ./

RUN poetry install --only main --no-root && rm -rf $POETRY_CACHE_DIR

# Now copy the app
COPY core ./core
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

# Caption preset fonts (Anton, Space Grotesk — both SIL OFL, safe to bundle
# and resell). Registered with fontconfig so libass can resolve them by
# family name when burning captions in app/pipeline.py.
COPY assets/fonts /app/fonts
RUN fc-cache -f /app/fonts

# Ensure yt-dlp is at latest at build time (complements runtime auto-update)
RUN poetry run pip install --no-cache-dir -U yt-dlp || true

EXPOSE 8000
CMD ["sh", "-c", "poetry run alembic upgrade head && poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000"]
