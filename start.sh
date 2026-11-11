#!/usr/bin/env bash
# NEXUS · 实时运算中枢 —— Linux / macOS 启动入口
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if ! "$PY" -c "import psutil" >/dev/null 2>&1; then
  echo "正在安装依赖 psutil ..."
  "$PY" -m pip install --quiet psutil || {
    echo "[!] psutil 安装失败，请手动执行：$PY -m pip install psutil"; exit 1; }
fi
exec "$PY" sampler.py "$@"
