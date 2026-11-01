#!/usr/bin/env bash
# HW9 分析器自测包装。
# 用法：bash selftest/run.sh
# 说明：本机 PATH 里的 python3 可能是 Windows Store 存根（exit 49），优先用 python。
set -euo pipefail
cd "$(dirname "$0")"

PY=""
for cand in python py; do
  if command -v "$cand" >/dev/null 2>&1; then
    if "$cand" -c "import sys; assert sys.version_info >= (3, 8)" >/dev/null 2>&1; then
      PY="$cand"
      break
    fi
  fi
done
if [ -z "$PY" ]; then
  echo "找不到可用的 Python（需要 3.8+）" >&2
  exit 2
fi

exec "$PY" check.py
