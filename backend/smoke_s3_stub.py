"""Local stand-in for ``core.s3`` for the smoke test.

Routes S3 operations to ``/tmp/clipzard-smoke-bucket/`` so we can test
the full /api/v1/update/* flow end-to-end without touching AWS.

Import as `import smoke_s3_stub` BEFORE `import core.s3` so the stub
overrides the real module.
"""
import os
import hashlib
import pathlib
import shutil
import sys
import types
from dataclasses import dataclass
from typing import Optional

BUCKET_ROOT = pathlib.Path(os.environ.get("SMOKE_S3_BUCKET", "/tmp/clipzard-smoke-bucket"))
BUCKET_ROOT.mkdir(parents=True, exist_ok=True)


@dataclass
class S3Upload:
    bucket: str
    key: str
    url: str
    size_bytes: int = 0


PRESIGNED_EXPIRY = 3600


class S3Error(Exception):
    pass


class _StubClient:
    """Just enough of boto3's S3 client for the upload/download/delete/head
    calls the updates router makes."""

    def upload_fileobj(self, fileobj, bucket, key, Config=None, ExtraArgs=None):
        dest = BUCKET_ROOT / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            shutil.copyfileobj(fileobj, f)

    def head_object(self, Bucket, Key):
        p = BUCKET_ROOT / Key
        if not p.exists():
            raise FileNotFoundError(Key)
        return {"ContentLength": p.stat().st_size}

    def get_object(self, Bucket, Key):
        p = BUCKET_ROOT / Key
        if not p.exists():
            raise FileNotFoundError(Key)
        return {"Body": open(p, "rb")}

    def delete_object(self, Bucket, Key):
        p = BUCKET_ROOT / Key
        try:
            p.unlink()
        except FileNotFoundError:
            pass

    def generate_presigned_url(self, method, Params=None, ExpiresIn=3600):
        return f"file://{BUCKET_ROOT}/{Params.get('Key', '')}"


def _client():
    return _StubClient()


def _get_bucket() -> str:
    return "smoke-bucket"


def upload_file_as(file_path: str, key: str, content_type: str | None = None, progress=None) -> S3Upload:
    dest = BUCKET_ROOT / key
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file_path, dest)
    return S3Upload(bucket="smoke-bucket", key=key, url="", size_bytes=dest.stat().st_size)


def upload_file(file_path: str, key_prefix: str = "clipzard", content_type: str | None = None, progress=None) -> S3Upload:
    return upload_file_as(file_path, key_prefix + "/" + pathlib.Path(file_path).name, content_type)


def upload_audio(file_path: str, progress=None) -> S3Upload:
    return upload_file(file_path, "clipzard", "audio/mpeg")


def presign_put_url(key: str, content_type: str, expires: int = 3600) -> str:
    return f"file://{BUCKET_ROOT}/{key}"


def presigned_get_url(bucket: str, key: str, expires: int = 3600) -> str:
    return f"file://{BUCKET_ROOT}/{key}"


def head_object_size(bucket: str, key: str) -> int | None:
    p = BUCKET_ROOT / key
    return p.stat().st_size if p.exists() else None


def head_object_size_default_bucket(key: str) -> int | None:
    return head_object_size(_get_bucket(), key)


def delete_object(bucket: str, key: str) -> None:
    p = BUCKET_ROOT / key
    try:
        p.unlink()
    except FileNotFoundError:
        pass


def download_object(key: str, dest: str, progress=None) -> str:
    src = BUCKET_ROOT / key
    pathlib.Path(dest).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return dest


def ensure_ytdlp_latest():  # noop stub
    return None


def schedule_ytdlp_auto_update():
    return None


# Install the stub before the real core.s3 is imported anywhere.
_core_s3 = types.ModuleType("core.s3")
for _name, _val in list(globals().items()):
    if _name.startswith("_") and _name not in ("_core_s3", "_StubClient"):
        continue
    if not _name.startswith("__"):
        setattr(_core_s3, _name, _val)
sys.modules["core.s3"] = _core_s3
