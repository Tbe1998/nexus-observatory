#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包 NEXUS 分发压缩包：BAT 转 GBK（避免中文 Windows 乱码），排除运行期文件。"""
import hashlib
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
OUT = BASE.parent / "NEXUS-v1.0.1.zip"

EXCLUDE_DIRS = {"__pycache__", ".git", "node_modules"}
EXCLUDE_FILES = {"nexus.port", "nexus.log", "诊断结果.txt", ".DS_Store"}
INCLUDE = [
    "sampler.py", "requirements.txt", "README.md", "使用说明.txt", "start.sh",
    "启动 NEXUS.bat", "停止监控.bat", "诊断 NEXUS.bat",
]
INCLUDE_DIRS = ["web", "tools", "docs"]
GBK_FILES = {"启动 NEXUS.bat", "停止监控.bat", "诊断 NEXUS.bat"}


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    if OUT.exists():
        OUT.unlink()
    names = []
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in INCLUDE:
            p = BASE / rel
            if not p.exists():
                print("跳过缺失文件:", rel)
                continue
            data = p.read_bytes()
            if rel in GBK_FILES:
                data = data.decode("utf-8").encode("gbk", "replace")
            z.writestr(zipfile.ZipInfo("NEXUS/" + rel, (2026, 11, 11, 0, 0, 0)), data)
            names.append(rel)
        for d in INCLUDE_DIRS:
            for p in sorted((BASE / d).rglob("*")):
                if p.is_dir() or p.name in EXCLUDE_FILES or p.suffix == ".pyc":
                    continue
                if any(part in EXCLUDE_DIRS for part in p.parts):
                    continue
                rel = p.relative_to(BASE).as_posix()
                z.write(p, "NEXUS/" + rel)
                names.append(rel)
    print("打包完成:", OUT)
    print("文件数:", len(names), "大小: %.1f MB" % (OUT.stat().st_size / 1048576))
    print("sha256:", sha256(OUT))
    for n in names:
        print("  ", n)


if __name__ == "__main__":
    main()
