#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NEXUS · 实时运算中枢 —— 本机采样服务

只读采集本机系统指标，通过 127.0.0.1 的 HTTP 接口交给前端绘制。
不读取文件内容、窗口标题、命令行、浏览历史，不做任何外发。

用法：
    python sampler.py                # 默认 127.0.0.1:8768，并打开浏览器
    python sampler.py --port 8770 --no-browser
    python sampler.py --once         # 打印一次采样后退出（排查用）
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import psutil
except ImportError:                                                   # pragma: no cover
    sys.stderr.write("缺少依赖 psutil。请先运行：pip install -r requirements.txt\n")
    raise SystemExit(2)

APP_ID = "nexus"

# 打包成 exe 后：只读资源在 _MEIPASS，可写的日志/端口文件放在 exe 同目录
FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent
BASE = Path(getattr(sys, "_MEIPASS", APP_DIR))
LOG_PATH = APP_DIR / "nexus.log"


def _open_log():
    try:
        f = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
        f.write("\n===== %s =====\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
        return f
    except OSError:
        return None


_LOG = _open_log()


def log(msg):
    """写日志并尽量回显。pythonw.exe 下 sys.stdout 是 None，直接 print 会抛异常退出。"""
    try:
        if _LOG:
            _LOG.write(str(msg) + "\n")
    except Exception:                                                 # noqa: BLE001
        pass
    try:
        if sys.stdout is not None:
            sys.stdout.write(str(msg) + "\n")
            sys.stdout.flush()
    except Exception:                                                 # noqa: BLE001
        pass


def _fatal(msg, detail=""):
    log("启动失败：%s\n%s" % (msg, detail))
    try:
        if platform.system() == "Windows":
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, "%s\n\n详细信息见：\n%s" % (msg, LOG_PATH), "NEXUS 启动失败", 0x10)
    except Exception:                                                 # noqa: BLE001
        pass
APP_VER = "1.0.2"
WEB = BASE / "web"
PORT_DEFAULT = 8768
INTERVAL = 1.0
HISTORY = 120

LOCK = threading.Lock()
SNAPSHOT: dict = {}
SEQ = 0


# --------------------------------------------------------------------------- utils
def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def _round(v, n=2):
    return None if v is None else round(v, n)


def _pct(a, b):
    return None if not b else a * 100.0 / b


# --------------------------------------------------------------------------- GPU
class GpuReader:
    """尽力读取 GPU 引擎利用率；读不到就明确标记不可用，绝不编数。"""

    def __init__(self):
        self.kind = None
        self.reason = ""
        self._cache = (0.0, None)
        self._name = ""
        self.system = platform.system()
        if shutil_which("nvidia-smi"):
            self.kind = "nvidia"
        elif self.system == "Windows":
            self.kind = "pdh"
        elif self.system == "Linux" and list(Path("/sys/class/drm").glob("card*/device/gpu_busy_percent")):
            self.kind = "amdgpu"
        else:
            self.kind = "none"
            self.reason = "系统未提供可读的 GPU 利用率计数器"

    def start(self, interval=2.0):
        """后台刷新：Windows 的 GPU 计数器要拉 PowerShell，绝不能放在采样主循环里。"""
        if getattr(self, "_thread", None):
            return
        self._interval = interval
        self._thread = threading.Thread(target=self._loop, name="nexus-gpu", daemon=True)
        self._thread.start()

    def _loop(self):
        while True:
            t0 = time.time()
            try:
                self._refresh()
            except Exception as e:                                    # noqa: BLE001
                self._cache = (time.time(), {
                    "available": False, "reason": "GPU 读取失败：%s" % e,
                    "name": self._name, "engines": {}, "max_engine": "", "max_pct": None})
            time.sleep(max(0.5, self._interval - (time.time() - t0)))

    def _refresh(self):
        data = None
        if self.kind == "nvidia":
            data = self._nvidia()
        elif self.kind == "amdgpu":
            data = self._amdgpu()
        elif self.kind == "pdh":
            data = self._pdh()
        if data is None:
            data = {"available": False, "reason": self.reason or "GPU 指标不可用",
                    "name": self._name, "engines": {}, "max_engine": "", "max_pct": None}
        self._cache = (time.time(), data)

    def read(self):
        """只返回后台线程最近一次结果，不阻塞。"""
        ts, data = self._cache
        if data is None:
            return {"available": False, "reason": "正在读取 GPU 计数器…", "name": self._name,
                    "engines": {}, "max_engine": "", "max_pct": None}
        out = dict(data)
        out["age_ms"] = int((time.time() - ts) * 1000)
        return out

    def _nvidia(self):
        q = "name,utilization.gpu,memory.used,memory.total"
        out = subprocess.run(["nvidia-smi", "--query-gpu=" + q, "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=3)
        if out.returncode != 0:
            self.reason = "nvidia-smi 返回 %d" % out.returncode
            return None
        rows = [r for r in out.stdout.strip().splitlines() if r.strip()]
        if not rows:
            return None
        best = None
        for r in rows:
            parts = [p.strip() for p in r.split(",")]
            if len(parts) < 2:
                continue
            try:
                pct = float(parts[1])
            except ValueError:
                continue
            if best is None or pct > best[1]:
                best = (parts[0], pct, parts[2] if len(parts) > 2 else None,
                        parts[3] if len(parts) > 3 else None)
        if best is None:
            return None
        self._name = best[0]
        return {"available": True, "name": best[0], "engines": {"3D": best[1]},
                "max_engine": "3D", "max_pct": best[1],
                "mem_used": best[2], "mem_total": best[3], "source": "nvidia-smi"}

    def _amdgpu(self):
        for p in Path("/sys/class/drm").glob("card*/device/gpu_busy_percent"):
            try:
                v = float(p.read_text().strip())
            except (OSError, ValueError):
                continue
            self._name = p.parts[4] if len(p.parts) > 4 else "AMD GPU"
            return {"available": True, "name": self._name, "engines": {"3D": v},
                    "max_engine": "3D", "max_pct": v, "source": "gpu_busy_percent"}
        return None

    def _pdh(self):
        ps = ("$ErrorActionPreference='SilentlyContinue';"
              "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples | "
              "ForEach-Object { \"$($_.InstanceName)|$($_.CookedValue)\" }")
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                             capture_output=True, text=True, timeout=8,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if out.returncode != 0 or not out.stdout.strip():
            self.reason = "Windows GPU 性能计数器不可用（可能需要更新驱动）"
            return None
        per_type: dict[str, float] = {}
        for line in out.stdout.splitlines():
            line = line.strip()
            if "|" not in line:
                continue
            inst, _, val = line.rpartition("|")
            try:
                v = float(val)
            except ValueError:
                continue
            key = "其他"
            low = inst.lower()
            if "engtype_3d" in low or "engtype_3d" in low.replace("-", "_"):
                key = "3D"
            elif "engtype_copy" in low:
                key = "复制"
            elif "engtype_videodecode" in low:
                key = "视频解码"
            elif "engtype_videoencode" in low:
                key = "视频编码"
            elif "engtype_compute" in low:
                key = "计算"
            per_type[key] = max(per_type.get(key, 0.0), v)
        if not per_type:
            return None
        peak = max(per_type.items(), key=lambda kv: kv[1])
        return {"available": True, "name": self._name or "本机 GPU", "engines": per_type,
                "max_engine": peak[0], "max_pct": round(peak[1], 1), "source": "GPU Engine 计数器"}


def shutil_which(name):
    from shutil import which
    return which(name)


# --------------------------------------------------------------------------- sampler
class Sampler(threading.Thread):
    def __init__(self, interval=INTERVAL):
        super().__init__(daemon=True, name="nexus-sampler")
        self.interval = interval
        self.stop_event = threading.Event()
        self.gpu = GpuReader()
        self.gpu.start(3.0)
        self.prev_cpu_times: dict[int, float] = {}
        self.prev_net: dict[str, tuple] = {}
        self.prev_ctx = None
        self.prev_pids: set[int] = set()
        self.events: deque = deque(maxlen=14)
        self.history: deque = deque(maxlen=HISTORY)
        self.seq = 0
        self.proc_cpu: dict[int, float] = {}
        self.note = ""

    # -- 主循环
    def run(self):
        tick = time.time()
        while not self.stop_event.is_set():
            started = time.time()
            try:
                snap = self.collect()
                snap["sample_ms"] = int((time.time() - started) * 1000)
                global SNAPSHOT, SEQ
                with LOCK:
                    SNAPSHOT = snap
                    SEQ = snap["seq"]
            except Exception as e:                                    # noqa: BLE001
                self.note = "采样异常：%s" % e
            cost = time.time() - started
            if cost > self.interval * 1.5:
                log("采样耗时偏长：%.2fs（序号 %d）" % (cost, self.seq))
            sleep = max(0.05, self.interval - cost)
            self.stop_event.wait(sleep)

    # -- 单次采样
    def collect(self):
        self.seq += 1
        now = time.time()
        snap = {"seq": self.seq, "ts": int(now * 1000), "interval_ms": int(self.interval * 1000),
                "sample_ms": 0,
                "host": socket.gethostname(), "os": platform.platform(),
                "app": APP_ID, "ver": APP_VER}

        # CPU
        per_core = psutil.cpu_percent(interval=None, percpu=True)
        cpu_pct = psutil.cpu_percent(interval=None)
        ctx = psutil.cpu_stats().ctx_switches
        ctx_delta = None if self.prev_ctx is None else max(0, ctx - self.prev_ctx)
        self.prev_ctx = ctx

        # 进程（CPU 时间增量 → 占用率；受保护进程跳过）
        procs = []
        now_pids = set()
        cur_times: dict[int, float] = {}
        thread_total = 0
        for p in psutil.process_iter(["pid", "name", "num_threads", "memory_info"]):
            info = p.info
            pid = info.get("pid")
            if pid is None:
                continue
            now_pids.add(pid)
            thread_total += info.get("num_threads") or 0
            try:
                t = p.cpu_times()
                cur = t.user + t.system
            except (psutil.NoSuchProcess, psutil.AccessDenied, AttributeError):
                cur = None
            if cur is not None:
                cur_times[pid] = cur
                prev = self.prev_cpu_times.get(pid)
                pct = None if prev is None else _pct(cur - prev, self.interval) or 0.0
                self.proc_cpu[pid] = (pct or 0.0) if pct is not None else self.proc_cpu.get(pid, 0.0)
            mi = info.get("memory_info")
            procs.append({"pid": pid, "name": (info.get("name") or "?")[:40],
                          "cpu": _round(self.proc_cpu.get(pid, 0.0), 1),
                          "threads": info.get("num_threads") or 0,
                          "rss": int(mi.rss) if mi else None})

        started = now_pids - self.prev_pids
        ended = self.prev_pids - now_pids
        for pid in list(started)[:6]:
            name = next((x["name"] for x in procs if x["pid"] == pid), "?")
            self.events.append({"t": int(now), "kind": "start", "pid": pid, "name": name})
        for pid in list(ended)[:6]:
            self.events.append({"t": int(now), "kind": "exit", "pid": pid, "name": ""})
        self.prev_pids = now_pids
        self.prev_cpu_times = cur_times
        for pid in list(self.proc_cpu):
            if pid not in now_pids:
                self.proc_cpu.pop(pid, None)

        top_cpu = sorted(procs, key=lambda x: (x["cpu"] or 0), reverse=True)[:8]

        # 内存
        vm = psutil.virtual_memory()
        top_mem = sorted([p for p in procs if p.get("rss")], key=lambda x: x["rss"], reverse=True)[:8]
        mem = {"total": vm.total, "used": vm.total - vm.available, "avail": vm.available,
               "pct": vm.percent, "procs": top_mem}

        # 网络（选当前活动最大的物理网卡）
        net = self._net(now)

        # GPU
        gpu = self.gpu.read()

        snap.update({
            "cpu": {"pct": cpu_pct, "cores": per_core, "procs": top_cpu,
                    "ctx": ctx, "ctx_delta": ctx_delta,
                    "freq": self._freq()},
            "mem": mem,
            "gpu": gpu,
            "net": net,
            "sys": {"proc_count": len(now_pids), "threads": thread_total,
                    "cpu_count": psutil.cpu_count() or 0,
                    "uptime_s": int(now - psutil.boot_time()),
                    "load": [round(x, 2) for x in (os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0))]},
            "events": list(self.events)[-10:],
            "note": self.note,
        })

        self.history.append({"t": snap["ts"], "cpu": cpu_pct, "mem": vm.percent,
                             "gpu": gpu.get("max_pct"), "rx": net.get("rx_bps"), "tx": net.get("tx_bps")})
        snap["history"] = list(self.history)
        return snap

    def _freq(self):
        try:
            f = psutil.cpu_freq()
            return {"cur": round(f.current) if f else None, "max": round(f.max) if f else None}
        except Exception:                                             # noqa: BLE001
            return {"cur": None, "max": None}

    def _net(self, now):
        try:
            io = psutil.net_io_counters(pernic=True)
        except Exception:                                             # noqa: BLE001
            return {"available": False, "iface": None, "rx_bps": None, "tx_bps": None,
                    "rx_pps": None, "tx_pps": None, "reason": "网络计数器不可用"}
        best = None
        for name, c in io.items():
            low = name.lower()
            if low.startswith(("lo", "loopback")) or low.startswith("docker") or low.startswith("veth"):
                continue
            prev = self.prev_net.get(name)
            if prev is None:
                continue
            dt = now - prev[0]
            if dt <= 0:
                continue
            drx, dtx = c.bytes_recv - prev[1], c.bytes_sent - prev[2]
            dpk_rx, dpk_tx = c.packets_recv - prev[3], c.packets_sent - prev[4]
            if drx < 0 or dtx < 0:                                    # 计数器重置
                drx = dtx = 0
            score = drx + dtx
            if best is None or score > best[0]:
                best = (score, name, drx / dt, dtx / dt, max(0, dpk_rx) / dt, max(0, dpk_tx) / dt)
        self.prev_net = {n: (now, c.bytes_recv, c.bytes_sent, c.packets_recv, c.packets_sent)
                         for n, c in io.items()}
        if best is None:
            return {"available": False, "iface": None, "rx_bps": None, "tx_bps": None,
                    "rx_pps": None, "tx_pps": None, "reason": "首次采样，尚无速率基线"}
        _, name, rx, tx, rxp, txp = best
        return {"available": True, "iface": name,
                "rx_bps": round(rx), "tx_bps": round(tx),
                "rx_pps": round(rxp, 1), "tx_pps": round(txp, 1)}


# --------------------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    server_version = "NEXUS/%s" % APP_VER

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):                                # 静默访问日志
        if os.environ.get("NEXUS_HTTP_LOG"):
            sys.stderr.write("[http] " + fmt % args + "\n")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._json({"ok": True, "app": APP_ID, "ver": APP_VER, "seq": SEQ})
        if path == "/api/sample":
            with LOCK:
                snap = SNAPSHOT
            if not snap:
                return self._json({"ok": False, "reason": "采样尚未就绪"}, 503)
            return self._json(snap)
        if path == "/api/meta":
            return self._json({"app": APP_ID, "ver": APP_VER, "port": self.server.server_port,
                               "python": sys.version.split()[0], "psutil": psutil.__version__})
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] == "/api/shutdown":
            self._json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self._json({"ok": False}, 404)

    def end_headers(self):
        if self.path.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()


def port_busy(port):
    with socket.socket() as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0


def existing_instance(port):
    """已经有 NEXUS 在跑就复用，避免重复启动多个采样器。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.6) as s:
            s.sendall(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            buf = s.recv(600).decode("utf-8", "ignore")
        return '"app":"nexus"' in buf or APP_ID in buf
    except OSError:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description="NEXUS 本机采样服务")
    ap.add_argument("--port", type=int, default=int(os.environ.get("NEXUS_PORT", PORT_DEFAULT)))
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--once", action="store_true", help="打印一次采样后退出")
    ap.add_argument("--interval", type=float, default=INTERVAL)
    args = ap.parse_args(argv)

    sampler = Sampler(interval=args.interval)
    if args.once:
        s = sampler.collect()
        log(json.dumps({k: s[k] for k in ("seq", "cpu", "mem", "gpu", "net", "sys")},
                       ensure_ascii=False, indent=2)[:4000])
        return 0

    port = args.port
    if existing_instance(port):
        url = "http://127.0.0.1:%d/" % port
        log("NEXUS 已在运行：%s" % url)
        if not args.no_browser:
            webbrowser.open(url)
        return 0
    while port_busy(port) and port < args.port + 20:
        port += 1

    sampler.start()
    time.sleep(0.35)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d/" % port
    log("NEXUS 采样服务：%s （仅本机可访问，Ctrl+C 停止）" % url)
    (APP_DIR / "nexus.port").write_text(str(port), encoding="utf-8")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("已停止。")
    finally:
        sampler.stop_event.set()
        httpd.server_close()
        try:
            (APP_DIR / "nexus.port").unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:                                            # noqa: BLE001
        import traceback
        _fatal("采样服务启动失败：%s" % e, traceback.format_exc())
        sys.exit(1)
