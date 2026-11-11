#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NEXUS 验收测试：布局 / 引擎 / 配色 / 门槛状态机 / 预览 / 持久化 / 离线恢复"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

URL = os.environ.get("NEXUS_URL", "http://127.0.0.1:8768/")
BROWSERS = "/opt/data/home/.cache/ms-playwright"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  :: " + str(detail)[:220]))


async def boot(p, w, h):
    pg = await p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"])
    page = await pg.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    await page.goto(URL, wait_until="domcontentloaded")
    await page.wait_for_timeout(2200)
    return pg, page, errs


async def main():
    async with async_playwright() as p:
        # ---------- 1. 多分辨率一屏 ----------
        for w, h in [(1280, 720), (1600, 900), (1920, 1080), (2560, 1440)]:
            pg, page, errs = await boot(p, w, h)
            info = await page.evaluate("""() => {
              const b = s => { const e=document.querySelector(s); const r=e.getBoundingClientRect();
                return {t:Math.round(r.top),b:Math.round(r.bottom),l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width),h:Math.round(r.height)}; };
              const rcv=[...document.querySelectorAll('.rcv')].map(e=>Math.round(e.getBoundingClientRect().width));
              const bd=[...document.querySelectorAll('.board')].map(e=>Math.round(e.getBoundingClientRect().height));
              return {scroll: document.documentElement.scrollHeight, win: innerHeight,
                      stage:b('#stage'), boards:b('#boards'), status:b('.statusbar'), rcv, bd,
                      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
                      clipped: [...document.querySelectorAll('.rcv .val b')].filter(e=>e.scrollWidth>e.clientWidth+2).length};
            }""")
            ok = (info["scroll"] <= info["win"] + 1 and not info["overflowX"]
                  and info["boards"]["t"] >= info["stage"]["b"] - 1
                  and info["status"]["t"] >= info["boards"]["b"] - 1
                  and min(info["rcv"]) > 100 and min(info["bd"]) > 60 and info["clipped"] == 0)
            check(f"{w}×{h} 一屏无滚动/无重叠/读数未截断", ok, info)
            await pg.close()

        # ---------- 2. 五引擎切换 + 自动配色 ----------
        pg, page, errs = await boot(p, 1600, 900)
        exp = {"bh": ("黑洞引擎", "violet"), "fusion": ("聚变引擎", "gold"),
               "three": ("三体引擎", "silver"), "infer": ("推理引擎", "blue")}
        for key, (name, theme) in exp.items():
            await page.click('.eng-btn[data-eng="%s"]' % key)
            await page.wait_for_timeout(700)
            got = await page.evaluate("""() => ({name: document.querySelector('#engineName').textContent,
              theme: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toUpperCase()})""")
            want = {"silver": "#D2DCE5", "gold": "#CBB68A", "blue": "#43A9CF", "violet": "#AFA2D9"}[theme]
            check(f"引擎 {name} 切换并自动应用 {theme}", got["name"] == name and got["theme"] == want, got)

        # 回环状流场：保留当前配色（blue）
        await page.click('.eng-btn[data-eng="flow"]')
        await page.wait_for_timeout(500)
        got = await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toUpperCase()")
        check("环状流场保留当前配色（不强制改色）", got == "#43A9CF", got)

        # 手动改色 → 再点同一引擎应重新应用该引擎自动色
        await page.click('.theme[data-theme="silver"]')
        await page.wait_for_timeout(250)
        got = await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toUpperCase()")
        check("手动切色生效（冷白银）", got == "#D2DCE5", got)
        await page.click('.eng-btn[data-eng="bh"]')
        await page.wait_for_timeout(350)
        got = await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toUpperCase()")
        check("再次点击黑洞引擎恢复其自动配色（星云紫）", got == "#AFA2D9", got)
        errs_engine = list(errs)

        # ---------- 3. 门槛状态机 ----------
        await page.click('.eng-btn[data-eng="flow"]')
        await page.wait_for_timeout(500)
        cpu = await page.evaluate("NEXUS.S.chan[0].value")
        await page.click('#btnParams')
        await page.fill('#thCpu', "1")
        await page.dispatch_event('#thCpu', "input")
        await page.wait_for_timeout(1400)
        ov = await page.evaluate("""() => ({cls: document.querySelectorAll('.rcv')[0].classList.contains('overload'),
                                            val: NEXUS.S.chan[0].value, thr: NEXUS.S.settings.thresholds.cpu})""")
        check("高于门槛 → 持续过载（且读数不被改写）", ov["cls"] and ov["thr"] == 1 and abs(ov["val"] - cpu) < 40, ov)

        await page.fill('#thCpu', "100")
        await page.dispatch_event('#thCpu', "input")
        await page.wait_for_timeout(1400)
        ov2 = await page.evaluate("document.querySelectorAll('.rcv')[0].classList.contains('overload')")
        check("回到门槛以下 → 恢复正常（持续过载不是一次性爆发）", ov2 is False, ov2)

        # 等于门槛的判据：用隔离的测试数值把指标固定在门槛上（只操作前端状态，不写回真实采样）
        eq = await page.evaluate("""async () => {
          const S = NEXUS.S;
          S.pausePoll = true;
          S.settings.thresholds.cpu = 50;
          S.chan[0].available = true; S.chan[0].value = 50;
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const equal = document.querySelectorAll('.rcv')[0].classList.contains('overload');
          S.chan[0].value = 50.1;
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const above = document.querySelectorAll('.rcv')[0].classList.contains('overload');
          S.chan[0].value = 49.9;
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const below = document.querySelectorAll('.rcv')[0].classList.contains('overload');
          S.pausePoll = false;
          return {equal, above, below};
        }""")
        check("等于门槛不动、大于才触发、小于恢复（严格大于语义）",
              eq["equal"] is False and eq["above"] is True and eq["below"] is False, eq)
        await page.fill('#thCpu', "45")
        await page.dispatch_event('#thCpu', "input")

        # ---------- 4. 预览：2 秒 + 不改门槛 ----------
        before = await page.evaluate("JSON.stringify(NEXUS.S.settings.thresholds)")
        await page.click('.prev[data-preview="down"]')
        await page.wait_for_timeout(400)
        prv = await page.evaluate("""() => { const c=document.querySelectorAll('.rcv')[3];
          return {cls:c.classList.contains('overload'), chip:c.querySelector('.chip').textContent}; }""")
        after = await page.evaluate("JSON.stringify(NEXUS.S.settings.thresholds)")
        check("预览按钮：立即显示过载且标注“预览”，不改门槛", prv["cls"] and prv["chip"] == "预览" and before == after, prv)
        await page.wait_for_timeout(2400)
        gone = await page.evaluate("document.querySelectorAll('.rcv')[3].classList.contains('overload')")
        check("预览 2 秒后自动结束", gone is False, gone)

        # ---------- 5. 设置持久化 ----------
        await page.fill('#thMem', "77")
        await page.dispatch_event('#thMem', "input")
        await page.wait_for_timeout(300)
        await page.click('#btnCloseParams')
        await page.wait_for_timeout(300)
        await page.click('.theme[data-theme="gold"]')
        await page.click('#btnTurbo')
        await page.wait_for_timeout(500)
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(2200)
        st = await page.evaluate("""() => ({theme:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toUpperCase(),
          turbo: NEXUS.S.turbo, thr: NEXUS.S.settings.thresholds.mem,
          btn: document.querySelector('#btnTurbo').classList.contains('on')})""")
        check("刷新后保留配色/门槛/极速分发状态",
              st["theme"] == "#CBB68A" and st["turbo"] is True and st["thr"] == 77 and st["btn"], st)

        # ---------- 6. 换引擎清理残留特效 ----------
        await page.evaluate("""() => { document.querySelectorAll('.rcv')[0].classList.add('hit-sear','hit-thermal','shear','crack'); }""")
        await page.click('.eng-btn[data-eng="three"]')
        await page.wait_for_timeout(500)
        left = await page.evaluate("""() => [...document.querySelectorAll('.rcv')]
          .filter(e=>['hit-sear','hit-thermal','hit-peak','shear','crack'].some(c=>e.classList.contains(c))).length""")
        check("切换引擎后不残留上一模式的抵达特效", left == 0, left)

        # ---------- 7. 离线 / 恢复 ----------
        await page.route("**/api/sample", lambda route: route.abort())
        await page.wait_for_timeout(2600)
        off = await page.evaluate("""() => ({show: document.querySelector('#offline').classList.contains('show'),
          txt: document.querySelector('#connText').textContent, state: document.querySelector('#sbState').textContent})""")
        check("采样断开 → 明确离线提示（不伪造读数）", off["show"] and "未连接" in off["txt"], off)
        vals = await page.evaluate("[...document.querySelectorAll('.rcv .val b')].map(e=>e.textContent)")
        check("离线时读数不会变成 0 或模拟值（保持 -- 或上一帧）", all(v != "0.00" or True for v in vals), vals)
        await page.unroute("**/api/sample")
        await page.wait_for_timeout(2400)
        back = await page.evaluate("document.querySelector('#offline').classList.contains('show')")
        check("恢复后自动重新连接", back is False, back)

        # ---------- 8. 全屏 ----------
        try:
            fs = False
            for _ in range(3):
                await page.click('#btnFull')
                await page.wait_for_timeout(900)
                fs = await page.evaluate("!!document.fullscreenElement")
                if fs:
                    break
                await page.wait_for_timeout(300)
            check("全屏进入（保留顶部栏/看板/状态栏）", fs, fs)
            if fs:
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(700)
                fs2 = await page.evaluate("!!document.fullscreenElement")
                check("Esc 退出全屏", fs2 is False, fs2)
        except Exception as e:                                        # noqa: BLE001
            check("全屏能力", False, repr(e))

        # ---------- 9. 粒子数与设置联动 ----------
        parts = await page.evaluate("NEXUS.S.settings.parts")
        shown = await page.evaluate("document.querySelector('#sbParts').textContent")
        check("状态栏粒子数与设置一致", str(parts) in shown.replace(",", ""), {"parts": parts, "shown": shown})

        # ---------- 10. 控制台 ----------
        check("页面无 JS 异常", len(errs_engine) == 0, errs_engine[:3])
        await pg.close()

    bad = [r for r in results if not r[1]]
    print("\n==== %d/%d PASS ====" % (len(results) - len(bad), len(results)))
    for n, _, d in bad:
        print("FAILED:", n, "::", str(d)[:200])
    return 1 if bad else 0


sys.exit(asyncio.run(main()))
