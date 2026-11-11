#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NEXUS 前端自动核验：截图 + 收集控制台错误 + 量一屏布局 + 读 FPS"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

URL = os.environ.get("NEXUS_URL", "http://127.0.0.1:8768/")
OUT = os.environ.get("NEXUS_SHOT", "/tmp/nexus.png")
W = int(os.environ.get("NEXUS_W", "1600"))
H = int(os.environ.get("NEXUS_H", "900"))
ENGINE = os.environ.get("NEXUS_ENGINE", "")


async def main():
    logs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-gl=angle",
                                          "--use-angle=swiftshader"])
        pg = await b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        pg.on("console", lambda m: logs.append("%s: %s" % (m.type, m.text)))
        pg.on("pageerror", lambda e: logs.append("pageerror: %s" % e))
        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.wait_for_timeout(2600)
        if ENGINE:
            await pg.click('.eng-btn[data-eng="%s"]' % ENGINE)
            await pg.wait_for_timeout(2600)
        await pg.screenshot(path=OUT)
        info = await pg.evaluate("""() => {
          const r = (s) => { const e = document.querySelector(s); if (!e) return null;
            const b = e.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),
            w:Math.round(b.width),h:Math.round(b.height), bottom:Math.round(b.bottom)}; };
          const recv = [...document.querySelectorAll('.rcv')].map(e => Math.round(e.getBoundingClientRect().width));
          return {
            stage: r('#stage'), boards: r('#boards'), status: r('.statusbar'),
            docH: document.documentElement.scrollHeight, winH: innerHeight,
            overflow: document.documentElement.scrollHeight > innerHeight + 1,
            fps: (window.NEXUS && document.querySelector('#sbFps').textContent) || '',
            parts: document.querySelector('#sbParts').textContent,
            engine: document.querySelector('#engineName').textContent,
            theme: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
            recvW: recv, gl: !!document.querySelector('#gl').getContext,
            values: [...document.querySelectorAll('.rcv .val b')].map(e => e.textContent),
            console: 0,
          };
        }""")
        print(json.dumps(info, ensure_ascii=False, indent=1))
        errs = [l for l in logs if l.startswith(("error", "pageerror"))]
        print("CONSOLE ERRORS:", len(errs))
        for l in errs[:12]:
            print("  ", l[:300])
        await b.close()
    return 1 if errs else 0


sys.exit(asyncio.run(main()))
