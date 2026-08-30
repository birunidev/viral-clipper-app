#!/usr/bin/env bash
# Run all three smoke tests in sequence.  Stops on the first failure
# so the orchestrator exits non-zero and CI catches the regression.
#
# Usage (from backend/):
#     .venv/Scripts/python.exe scripts/smoke_run_all.sh
#     # or
#     bash scripts/smoke_run_all.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PY="$BACKEND_DIR/.venv/Scripts/python.exe"

if [ ! -x "$VENV_PY" ]; then
  VENV_PY="python"
fi

echo "=== smoke_account_licenses ==="
"$VENV_PY" "$SCRIPT_DIR/smoke_account_licenses.py"
echo

echo "=== smoke_license_purchase ==="
"$VENV_PY" "$SCRIPT_DIR/smoke_license_purchase.py"
echo

echo "=== smoke_credit_purchase ==="
"$VENV_PY" "$SCRIPT_DIR/smoke_credit_purchase.py"
echo

echo "ALL SMOKES PASSED"
