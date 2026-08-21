FROM python:3.12-slim

# ffmpeg on Debian trixie/bookworm ships with libass/libfontconfig/libfreetype
# already enabled, so no custom ffmpeg build is needed for caption burn-in.
# fontconfig + fonts-dejavu-core provide a safe fallback if a preset's font
# name can't be resolved from the bundled fonts below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
COPY core ./core
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

# Caption preset fonts (Anton, Space Grotesk — both SIL OFL, safe to bundle
# and resell). Registered with fontconfig so libass can resolve them by
# family name when burning captions in app/pipeline.py.
COPY assets/fonts /app/fonts
RUN fc-cache -f /app/fonts

RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
