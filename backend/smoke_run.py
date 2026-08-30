"""Smoke-test entrypoint. Pre-installs the S3 stub, then runs uvicorn."""
import os
import sys
import pathlib

# Add backend dir to path so `app.*` and `core.*` resolve
BACKEND = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND))

# CRITICAL: stub S3 before any other import
import smoke_s3_stub  # noqa: F401
import core.s3 as _core_s3  # trigger any pre-existing cache
import smoke_s3_stub  # re-install after any pre-cache step

# Now load the app
from app.main import app  # noqa: E402

# Re-attach stub methods to the now-loaded core.s3 module (the app's
# import of `from core import s3` replaced the stub in sys.modules).
import types
for _name in dir(smoke_s3_stub):
    if _name in ("sys", "pathlib", "shutil", "hashlib", "os", "types", "S3Error",
                 "S3Upload", "_StubClient", "BUCKET_ROOT", "PRESIGNED_EXPIRY",
                 "dataclass", "Optional", "_client", "_get_bucket",
                 "upload_file_as", "upload_file", "upload_audio",
                 "presign_put_url", "presigned_get_url",
                 "head_object_size", "head_object_size_default_bucket",
                 "delete_object", "download_object",
                 "ensure_ytdlp_latest", "schedule_ytdlp_auto_update"):
        setattr(_core_s3, _name, getattr(smoke_s3_stub, _name))

# Also patch the module reference in `core` namespace
import core
core.s3 = _core_s3
sys.modules["core.s3"] = _core_s3

# Verify
print(f"[smoke] S3 stub active: bucket={_core_s3._get_bucket()}, has _client={hasattr(_core_s3, '_client')}")
print(f"[smoke] app routes: {len(app.routes)}")
update_paths = [p for p in [r.path for r in app.routes if hasattr(r, 'path') and r.path] if 'update' in p]
print(f"[smoke] update paths: {update_paths}")

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8765,
        log_level="info",
        reload=False,
    )
