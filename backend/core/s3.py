"""Upload extracted audio to S3 (or an S3-compatible service) so AssemblyAI
can fetch it.

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
PRESIGNED_EXPIRY = 3600  # seconds; AssemblyAI fetches right at submission


class S3Error(Exception):
    """Raised when the S3 upload cannot be completed."""


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


def upload_audio(
    file_path: str,
    progress: Callable[[float], None] | None = None,
) -> S3Upload:
    """Upload ``file_path`` to S3 and return an ``S3Upload`` (bucket/key/URL).

    Raises S3Error when ``S3_BUCKET`` is unset, credentials are missing,
    or the upload/URL generation fails.
    """
    bucket = os.environ.get(BUCKET_ENV, "").strip()
    if not bucket:
        raise S3Error(
            f"{BUCKET_ENV} environment variable is required for S3 uploads."
        )

    if boto3 is None:
        raise S3Error("boto3 is not installed. Run: poetry install")

    key = f"clipforge/{uuid.uuid4().hex}.mp3"

    try:
        client = boto3.client("s3", **_client_kwargs())
        total = os.path.getsize(file_path)

        def callback(transferred: int, total_size: int | None = None) -> None:
            if progress is not None:
                progress(0.06 + 0.09 * transferred / max(total, 1))

        client.upload_file(
            file_path,
            bucket,
            key,
            ExtraArgs={"ContentType": "audio/mpeg"},
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


def delete_object(bucket: str, key: str) -> None:
    """Delete an object from the bucket. Best effort; failures are ignored.

    Called after transcription so the uploaded audio does not linger in
    R2/S3.
    """
    if boto3 is None:
        return
    try:
        boto3.client("s3", **_client_kwargs()).delete_object(
            Bucket=bucket, Key=key
        )
    except Exception:
        pass
