"""S3 / R2 helpers: upload, download, presigned URLs, delete.

Supports Amazon S3 and Cloudflare R2. Credentials come from the standard
env variables (``AWS_ACCESS_KEY_ID``, ``AWS_SECRET_ACCESS_KEY``,
``AWS_SESSION_TOKEN``), the bucket from ``S3_BUCKET``, and an optional
custom endpoint from ``S3_ENDPOINT_URL``. For Cloudflare R2 set
``S3_ENDPOINT_URL`` to ``https://<account-id>.r2.cloudflarestorage.com``
and leave the region as-is.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Callable

try:
    import boto3
except ImportError:  # pragma: no cover - defensive
    boto3 = None

BUCKET_ENV = "S3_BUCKET"
ENDPOINT_ENV = "S3_ENDPOINT_URL"
REGION_ENV = "AWS_REGION"
DEFAULT_REGION_ENV = "AWS_DEFAULT_REGION"
PRESIGNED_EXPIRY = 3600  # seconds


class S3Error(Exception):
    """Raised when an S3 operation cannot be completed."""


@dataclass
class S3Upload:
    """Details of an uploaded object, enough to clean it up later."""

    bucket: str
    key: str
    url: str


def _client_kwargs() -> dict:
    kwargs = {}
    endpoint = os.environ.get(ENDPOINT_ENV, "").strip()
    if endpoint:
        kwargs["endpoint_url"] = endpoint
        region = os.environ.get(REGION_ENV, "").strip() or os.environ.get(
            DEFAULT_REGION_ENV, ""
        ).strip()
        kwargs["region_name"] = region or "auto"
    return kwargs


def _get_bucket() -> str:
    bucket = os.environ.get(BUCKET_ENV, "").strip()
    if not bucket:
        raise S3Error(
            f"{BUCKET_ENV} environment variable is required for S3 uploads."
        )
    return bucket


def _client():
    if boto3 is None:
        raise S3Error("boto3 is not installed. Run: poetry install")
    return boto3.client("s3", **_client_kwargs())


def _ext_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lstrip(".") or "bin"
    return ext.lower()


def upload_file(
    file_path: str,
    key_prefix: str = "clipforge",
    content_type: str | None = None,
    progress: Callable[[float], None] | None = None,
) -> S3Upload:
    """Upload ``file_path`` under ``key_prefix`` and return an ``S3Upload``.

    ``progress`` (optional) receives a fraction in [0, 1].
    """
    bucket = _get_bucket()
    key = f"{key_prefix.rstrip('/')}/{uuid.uuid4().hex}.{_ext_for(file_path)}"

    try:
        client = _client()
        total = os.path.getsize(file_path)

        def callback(transferred: int, total_size: int | None = None) -> None:
            if progress is not None:
                progress(transferred / max(total, 1))

        client.upload_file(
            file_path,
            bucket,
            key,
            ExtraArgs={"ContentType": content_type} if content_type else None,
            Callback=callback,
        )

        url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=PRESIGNED_EXPIRY,
        )
    except S3Error:
        raise
    except Exception as exc:
        raise S3Error(f"S3 upload failed: {exc}") from exc

    return S3Upload(bucket=bucket, key=key, url=url)


def upload_audio(
    file_path: str,
    progress: Callable[[float], None] | None = None,
) -> S3Upload:
    """Upload an MP3 and report progress mapped to the transcription range."""
    def _cb(fraction: float) -> None:
        if progress is not None:
            progress(0.06 + 0.09 * fraction)

    return upload_file(file_path, "clipforge", "audio/mpeg", _cb)


def presigned_get_url(bucket: str, key: str, expires: int = PRESIGNED_EXPIRY) -> str:
    """Return a presigned GET URL for an object (default bucket if empty)."""
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expires,
    )


def download_object(key: str, dest: str) -> str:
    """Download ``key`` from the default bucket to ``dest``."""
    client = _client()
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    try:
        client.download_file(_get_bucket(), key, dest)
    except Exception as exc:
        raise S3Error(f"S3 download failed for {key!r}: {exc}") from exc
    return dest


def delete_object(bucket: str, key: str) -> None:
    """Delete an object from the bucket. Best effort; failures are ignored."""
    if boto3 is None:
        return
    try:
        _client().delete_object(Bucket=bucket, Key=key)
    except Exception:
        pass
