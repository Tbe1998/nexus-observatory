/* ============================================================
   NEXUS 应用层 —— 真实采样 → 指标归一化 → 通道速度 → 状态机 → UI
   ============================================================ */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '--' : v.toFixed(d));

  // ------------------------------------------------------------------ 配色
  const THEMES = {
    silver: { name: '冷白银', hex: '#D2DCE5' },
    gold: { name: '香槟金', hex: '#CBB68A' },
    blue: { name: '深海蓝', hex: '#43A9CF' },
    violet: { name: '星云紫', hex: '#AFA2D9' }
  };
  const ENGINES = [
    { key: 'flow', name: '环状流场', sub: 'RING FLOW FIELD', theme: null },
    { key: 'bh', name: '黑洞引擎', sub: 'BLACK HOLE', theme: 'violet' },
    { key: 'fusion', name: '聚变引擎', sub: 'FUSION CORE', theme: 'gold' },
    { key: 'three', name: '三体引擎', sub: 'THREE-BODY', theme: 'silver' },
    { key: 'infer', name: '推理引擎', sub: 'INFERENCE MESH', theme: 'blue' }
  ];
  const CH = [
    { key: 'cpu', idx: '01', name: '处理器', unit: '%', kind: 'pct' },
    { key: 'mem', idx: '02', name: '内存', unit: '%', kind: 'pct' },
    { key: 'gpu', idx: '03', name: '显卡', unit: '%', kind: 'pct' },
    { key: 'down', idx: '04', name: '下载', unit: 'KiB/s', kind: 'net' },
    { key: 'up', idx: '05', name: '上传', unit: 'KiB/s', kind: 'net' }
  ];
  const DEFAULTS = {
    engine: 'flow', theme: 'silver', turbo: false, parts: 12000,
    scale: 1, glow: 0.85, beat: 1, lightFx: true, overloadFx: true, mouseFx: true, autoFocus: false,
    thresholds: { cpu: 45, mem: 60, gpu: 50, down: 512, up: 128 }
  };
  const STORE_KEY = 'nexus.settings.v1';

  const S = {
    engine: 'flow', theme: 'silver', turbo: false,
    settings: JSON.parse(JSON.stringify(DEFAULTS)),
    snap: null, prevSeq: 0, offline: false, lastOk: 0, misses: 0,
    focused: null, previews: {}, speedMul: 1,
    smoothSpeed: [0.02, 0.02, 0.02, 0.02, 0.02],
    chan: CH.map(c => ({ ...c, value: null, norm: 0, speed: 0.02, available: false, overload: false })),
    up0: Date.now(), frames: 0, fps: 0
  };

  // ------------------------------------------------------------------ 存储
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      S.settings = Object.assign({}, DEFAULTS, o, { thresholds: Object.assign({}, DEFAULTS.thresholds, o.thresholds || {}) });
      S.engine = S.settings.engine || 'flow';
      S.theme = S.settings.theme || 'silver';
      S.turbo = !!S.settings.turbo;
    } catch (e) { /* 损坏就用默认 */ }
  }
  let saveTimer = 0;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      S.settings.engine = S.engine; S.settings.theme = S.theme; S.settings.turbo = S.turbo;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(S.settings)); } catch (e) {}
    }, 120);
  }

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  // ------------------------------------------------------------------ 渲染器
  let gl = null, engines = null;
  let canvas, stageEl, wrapEl;
  const view = { w: 1, h: 1, ring: { x: 0, y: 0, r: 100 }, receivers: [] };
  const mouse = { x: 0, y: 0, on: false, r: 90, sign: 1 };

  function initGL() {
    canvas = $('#gl');
    try {
      gl = new window.NexusGL(canvas);
    } catch (e) {
      $('#offline').textContent = '当前浏览器不支持 WebGL2：' + e.message;
      $('#offline').classList.add('show');
      return false;
    }
    engines = new window.NEXUS_ENGINES.Engines();
    engines.setParticles(S.settings.parts, S.chan);
    return true;
  }

  // ------------------------------------------------------------------ 布局
  function measure() {
    const wrapRect = wrapEl.getBoundingClientRect();
    view.w = Math.max(1, wrapRect.width);
    view.h = Math.max(1, wrapRect.height);
    if (gl) gl.resize(view.w, view.h, window.devicePixelRatio || 1);

    // 巨环：直径 ≈ 主视觉高度 × 1.08，中心偏左
    const r = view.h * 0.54;
    view.ring.r = r;
    view.ring.x = Math.max(r * 0.92, view.w * 0.255);
    view.ring.y = view.h * 0.52;

    const base = wrapRect;
    view.receivers = $$('.rcv').map(el => {
      const b = el.getBoundingClientRect();
      return { x: b.left - base.left, y: b.top - base.top + b.height / 2, h: b.height };
    });
    for (let i = 0; i < 5; i++) {
      if (!view.receivers[i]) view.receivers[i] = { x: view.w - 80, y: view.h * (0.15 + i * 0.17) };
      S.chan[i].y = view.receivers[i].y;
    }
    const lbl = $('.core-label');
    if (lbl) {
      lbl.style.left = view.ring.x + 'px';
      lbl.style.top = view.ring.y + 'px';
    }
    document.documentElement.style.setProperty('--accent', THEMES[S.theme].hex);
    document.documentElement.style.setProperty('--accent-soft', hexA(THEMES[S.theme].hex, 0.16));
    layoutInferLabels();
  }

  // 推理引擎的六层标注（DOM 文本，保证清晰）
  const INFER_LAYERS = ['输入编码', '注意力', '并行分支', '路径筛选', '汇合', '输出'];
  function ensureInferLabels() {
    let box = $('#inferLabels');
    if (!box) {
      box = document.createElement('div');
      box.id = 'inferLabels';
      box.className = 'infer-labels';
      box.innerHTML = INFER_LAYERS.map(t => '<span>' + t + '</span>').join('');
      wrapEl.appendChild(box);
    }
    return box;
  }
  function layoutInferLabels() {
    const box = ensureInferLabels();
    box.classList.toggle('show', S.engine === 'infer');
    if (S.engine !== 'infer') return;
    const gx0 = view.ring.x + view.ring.r * 1.05;
    const gx1 = (view.receivers[0] ? view.receivers[0].x : view.w - 80) - 40;
    const spanY = Math.min(view.h * 0.36, view.ring.r * 0.92);
    const y = view.ring.y - spanY * 0.58;
    const spans = box.children;
    for (let i = 0; i < spans.length; i++) {
      const x = gx0 + (i / 5) * Math.max(120, gx1 - gx0);
      spans[i].style.left = x + 'px';
      spans[i].style.top = y + 'px';
    }
  }

  function hexA(hex, a) {
    const [r, g, b] = rgb(hex);
    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
  }

  // ------------------------------------------------------------------ 接收端 DOM
  function buildReceivers() {
    const box = $('#receivers');
    box.innerHTML = CH.map((c, i) => `
      <div class="rcv" data-i="${i}" title="点击聚焦该渠道">
        <div class="rh"><span class="idx">${c.idx}</span><span class="nm">${c.name}</span></div>
        <span class="chip">过载</span>
        <div class="val"><b id="rv${i}">--</b><i>${c.unit}</i></div>
        <div class="sub"><span id="rs${i}">流速 --</span><span id="rp${i}">--</span></div>
        <div class="bar"><i id="rb${i}"></i></div>
      </div>`).join('');
    $$('.rcv').forEach(el => {
      el.addEventListener('click', () => {
        const i = +el.dataset.i;
        S.focused = S.focused === i ? null : i;
        renderFocus();
      });
    });
  }

  function renderFocus() {
    $$('.rcv').forEach((el, i) => {
      el.classList.toggle('focus', S.focused === i);
      el.classList.toggle('dimmed', S.focused !== null && S.focused !== i);
    });
  }

  function receiverHit(i, kind) {
    if (!S.settings.overloadFx) return;
    const el = $$('.rcv')[i];
    if (!el) return;
    const ov = S.chan[i].overload || (S.previews[i] > performance.now());
    let cls = '';
    if (kind === 'bh') cls = ov ? 'crack' : 'hit-sear';
    else if (kind === 'fusion') cls = ov ? 'hit-sear' : 'hit-thermal';
    else if (kind === 'three') cls = ov ? 'shear' : '';
    else if (kind === 'infer') cls = ov ? 'hit-peak' : '';
    else cls = 'hit-thermal';
    if (!cls) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    if (ov && (kind === 'bh' || kind === 'fusion')) {
      for (let k = 0; k < 5; k++) {
        const sp = document.createElement('span');
        sp.className = 'spark';
        sp.style.left = (70 + Math.random() * 20) + '%';
        sp.style.top = (30 + Math.random() * 40) + '%';
        sp.style.setProperty('--dx', (10 + Math.random() * 26) + 'px');
        sp.style.setProperty('--dy', (-8 - Math.random() * 14) + 'px');
        el.appendChild(sp);
        setTimeout(() => sp.remove(), 750);
      }
    }
    if (S.settings.autoFocus && S.chan[i].overload) {
      S.focused = i; renderFocus();
    }
  }

  // ------------------------------------------------------------------ 采样
  let pollTimer = 0;
  async function poll() {
    clearTimeout(pollTimer);
    if (S.pausePoll) { pollTimer = setTimeout(poll, 1000); return; }
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch('/api/sample', { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const snap = await res.json();
      if (!snap || !snap.seq) throw new Error('空采样');
      // 只要拿到响应就算链路正常：即使序号没变（同一秒内重复请求）也要清掉离线提示
      S.misses = 0;
      if (S.offline) { S.offline = false; showOffline(false); }
      if (snap.seq === S.prevSeq) return;       // 同一次采样不重复生成任务
      S.prevSeq = snap.seq;
      S.snap = snap;
      S.lastOk = performance.now();
      applySnapshot(snap);
    } catch (e) {
      S.misses = (S.misses || 0) + 1;
      // 偶发一次超时不弹提示，连续两次失败才认为真的断了
      if (S.misses >= 2) { S.offline = true; showOffline(true); }
    } finally {
      clearTimeout(kill);
      pollTimer = setTimeout(poll, 1000);
    }
  }

  function showOffline(on, stale) {
    const el = $('#offline');
    if (on) el.textContent = stale ? '采样数据延迟，正在等待最新读数……' : '采样服务未连接，正在重试……';
    el.classList.toggle('show', !!on);
    $('#connDot').classList.toggle('bad', !!on);
    $('#connText').textContent = on ? (stale ? '数据延迟' : '采样服务未连接') : '本机实时连接';
    $('#sbDot').classList.toggle('bad', !!on);
    $('#sbState').textContent = on ? (stale ? '数据延迟' : '采样离线') : '采样正常';
  }

  function applySnapshot(s) {
    showOffline(false);
    const cpu = s.cpu || {}, mem = s.mem || {}, gpu = s.gpu || {}, net = s.net || {}, sys = s.sys || {};
    const vals = {
      cpu: cpu.pct,
      mem: mem.pct,
      gpu: gpu.available ? gpu.max_pct : null,
      down: net.available ? net.rx_bps / 1024 : null,
      up: net.available ? net.tx_bps / 1024 : null
    };
    for (let i = 0; i < 5; i++) {
      const c = S.chan[i];
      const v = vals[c.key];
      c.available = v !== null && v !== undefined && Number.isFinite(v);
      c.value = c.available ? v : null;
      if (c.kind === 'pct') c.norm = c.available ? clamp(v / 100, 0, 1) : 0;
      else c.norm = c.available ? clamp(Math.log(1 + v * 1024 / 8192) / Math.log(1 + 10485760 / 8192), 0, 1) : 0;
      if (c.kind === 'pct') c.speed = 0.035 + Math.pow(c.norm, 1.15) * 1.35;
      else c.speed = 0.025 + c.norm * 1.65;
      if (!c.available) c.speed = 0.02;
      c.overload = c.available && c.value > S.settings.thresholds[c.key];
    }
    // 自检：门限相等时必须恢复正常，状态机每帧重算，不保留历史过载

    renderReceivers();
    renderBoardsHeader(s);
    $('#sampleTime').textContent = new Date(s.ts).toLocaleTimeString('zh-CN', { hour12: false });
    $('#seqText').textContent = 'SEQ ' + s.seq;
    $('#sbHost').textContent = (s.host || '本机') + ' · ' + (s.os || '').split('-')[0];
  }

  // 每帧只同步“是否过载/预览”的类名与角标，文字仍按采样节奏更新
  function syncOverloadState() {
    const now = performance.now();
    const els = $$('.rcv');
    for (let i = 0; i < 5; i++) {
      const el = els[i];
      if (!el) continue;
      const prev = S.previews[i] > now;
      const on = S.chan[i].overload || prev;
      if (el.classList.contains('overload') !== on) el.classList.toggle('overload', on);
      const chip = el.__chip || (el.__chip = el.querySelector('.chip'));
      if (chip) {
        const txt = prev ? '预览' : '过载';
        if (chip.textContent !== txt) chip.textContent = txt;
      }
    }
  }

  function renderReceivers() {
    for (let i = 0; i < 5; i++) {
      const c = S.chan[i];
      const v = $('#rv' + i);
      if (v) v.textContent = c.available ? (c.kind === 'pct' ? c.value.toFixed(1) : fmtBytes(c.value)) : '--';
      const unit = $('.rcv[data-i="' + i + '"] .val i');
      if (unit) unit.textContent = c.available ? (c.kind === 'pct' ? c.unit : fmtBytesUnit(c.value)) : c.unit;
      const sp = $('#rs' + i);
      if (sp) sp.textContent = c.available ? '流速 ' + (c.speed * 100).toFixed(0) : '不可用';
      const rp = $('#rp' + i);
      if (rp) rp.textContent = c.available ? (c.kind === 'pct' ? '门槛 ' + S.settings.thresholds[c.key] + '%' : '门槛 ' + S.settings.thresholds[c.key]) : '--';
      const bar = $('#rb' + i);
      if (bar) bar.style.width = (c.available ? clamp(c.kind === 'pct' ? c.value : c.norm * 100, 0, 100) : 0) + '%';
      const el = $$('.rcv')[i];
      if (el) {
        const prev = S.previews[i] > performance.now();
        el.classList.toggle('overload', c.overload || prev);
        const chip = el.querySelector('.chip');
        if (chip) chip.textContent = prev ? '预览' : '过载';
      }
    }
  }

  function fmtBytes(kib) {
    if (kib >= 1024) return (kib / 1024).toFixed(2);
    if (kib >= 10) return kib.toFixed(1);
    return kib.toFixed(2);
  }
  function fmtBytesUnit(kib) { return kib >= 1024 ? 'MiB/s' : 'KiB/s'; }

  // ------------------------------------------------------------------ 看板
  const boards = {};
  function initBoards() {
    $$('.board').forEach(b => {
      const key = b.dataset.board;
      const cv = b.querySelector('canvas');
      boards[key] = { el: b, cv, ctx: cv.getContext('2d'), det: b.querySelector('.det'), open: false, last: 0 };
      b.querySelector('.more').addEventListener('click', () => {
        const o = boards[key];
        o.open = !o.open;
        o.det.hidden = !o.open;
        o.el.querySelector('.more').textContent = o.open ? '收起' : '详情';
        if (o.open) renderDetail(key);
      });
    });
    const ro = new ResizeObserver(() => fitBoardCanvases());
    ro.observe($('#boards'));
    fitBoardCanvases();
  }

  function fitBoardCanvases() {
    Object.values(boards).forEach(o => {
      const r = o.cv.parentElement.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      o.cv.width = Math.max(1, Math.round(r.width * dpr));
      o.cv.height = Math.max(1, Math.round(r.height * dpr));
      o.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.w = r.width; o.h = r.height;
    });
  }

  function renderBoardsHeader(s) {
    const cpu = s.cpu || {}, mem = s.mem || {}, gpu = s.gpu || {}, net = s.net || {}, sys = s.sys || {};
    $('#bCpuVal').textContent = fmt(cpu.pct, 1);
    $('#bCpuSub').textContent = '逻辑核心 ' + ((cpu.cores || []).length || '--');
    $('#bCpuSub2').textContent = cpu.freq && cpu.freq.cur ? (cpu.freq.cur / 1000).toFixed(1) + ' GHz' : '';
    $('#bMemVal').textContent = fmt(mem.pct, 1);
    $('#bMemSub').textContent = gb(mem.used) + ' / ' + gb(mem.total);
    $('#bMemSub2').textContent = '可用 ' + gb(mem.avail);
    $('#bGpuVal').textContent = gpu.available ? fmt(gpu.max_pct, 1) : '--';
    $('#bGpuSub').textContent = gpu.available ? (gpu.max_engine || '引擎') + ' · 最繁忙引擎' : (gpu.reason || '不可用');
    $('#bGpuSub2').textContent = gpu.available ? (gpu.name || '') : '';
    $('#bDownVal').textContent = net.available ? fmtBytes(net.rx_bps / 1024) : '--';
    $('#bDownUnit').textContent = net.available ? fmtBytesUnit(net.rx_bps / 1024) : 'KiB/s';
    $('#bDownSub').textContent = net.available ? net.iface + ' · ' + (net.rx_pps || 0).toFixed(0) + ' 包/s' : '不可用';
    $('#bDownSub2').textContent = net.available ? '累计口径：采样差分' : '';
    $('#bUpVal').textContent = net.available ? fmtBytes(net.tx_bps / 1024) : '--';
    $('#bUpUnit').textContent = net.available ? fmtBytesUnit(net.tx_bps / 1024) : 'KiB/s';
    $('#bUpSub').textContent = net.available ? net.iface + ' · ' + (net.tx_pps || 0).toFixed(0) + ' 包/s' : '不可用';
    $('#bUpSub2').textContent = '';
    $('#bSysVal').textContent = sys.proc_count ?? '--';
    $('#bSysSub').textContent = '线程 ' + (sys.threads ?? '--') + ' · 上下文切换 ' + (cpu.ctx_delta ?? '--') + '/s';
    $('#bSysSub2').textContent = '采样 #' + (s.seq || '--');
    if (boards.sys && boards.sys.open) renderDetail('sys');
  }

  function gb(bytes) {
    if (!bytes && bytes !== 0) return '--';
    const g = bytes / 1073741824;
    return g >= 10 ? g.toFixed(1) + ' GB' : g.toFixed(2) + ' GB';
  }

  // ---- 各看板绘制（2D，约 12fps）
  function drawBoards(now) {
    const s = S.snap;
    if (!s) return;
    for (const [key, o] of Object.entries(boards)) {
      if (o.open) continue;
      if (now - o.last < 80) continue;
      o.last = now;
      const c = o.ctx, w = o.w, h = o.h;
      c.clearRect(0, 0, w, h);
      const accent = THEMES[S.theme].hex;
      if (key === 'cpu') drawCpu(c, w, h, s, accent);
      else if (key === 'mem') drawMem(c, w, h, s, accent);
      else if (key === 'gpu') drawGpu(c, w, h, s, accent);
      else if (key === 'down') drawNet(c, w, h, s, accent, 'rx');
      else if (key === 'up') drawNet(c, w, h, s, accent, 'tx');
      else if (key === 'sys') drawSys(c, w, h, s, accent);
    }
  }

  function drawCpu(c, w, h, s, accent) {
    const cores = s.cpu.cores || [];
    const rows = Math.min(cores.length, 24);
    const colW = Math.max(3, Math.floor((w - 4) / Math.max(rows, 1)) - 2);
    // 每核心竖条
    for (let i = 0; i < rows; i++) {
      const v = cores[i] / 100;
      const bh = Math.max(1, v * (h - 22));
      const x = i * (colW + 2) + 1;
      c.fillStyle = hexA(accent, 0.10);
      c.fillRect(x, 0, colW, h - 22);
      c.fillStyle = hexA(accent, 0.25 + v * 0.55);
      c.fillRect(x, h - 22 - bh, colW, bh);
    }
    // 顶部三行进程
    const procs = (s.cpu.procs || []).slice(0, 3);
    c.font = '8px ui-monospace, Consolas, monospace';
    c.fillStyle = hexA(accent, 0.62);
    procs.forEach((p, i) => {
      const t = (p.name || '?').slice(0, 16) + '  ' + (p.cpu || 0).toFixed(1) + '%';
      c.fillText(t, 2, 9 + i * 9.5);
    });
    // 任务流：小点沿横线流向右侧
    const t = performance.now() / 1000;
    c.strokeStyle = hexA(accent, 0.10);
    for (let l = 0; l < 2; l++) {
      const y = h - 8 + l * 4;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const x = ((t * (18 + i * 4) + i * 37) % (w + 20)) - 10;
      c.fillStyle = hexA(accent, 0.5);
      c.fillRect(x, h - 9, 2, 1.4);
    }
  }

  function drawMem(c, w, h, s, accent) {
    const procs = s.mem.procs || [];
    const total = s.mem.used || 1;
    const cols = 28, rows = Math.max(3, Math.floor(h / 9));
    const cw = w / cols, ch = h / rows;
    const cells = procs.map(p => p.rss || 0);
    const sum = cells.reduce((a, b) => a + b, 0) || 1;
    let idx = 0;
    const filled = Math.round(clamp(s.mem.pct / 100, 0, 1) * cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      c.fillStyle = hexA(accent, i < filled ? 0.16 : 0.045);
      c.fillRect(x + 0.5, y + 0.8, cw - 1.4, ch - 1.6);
    }
    // 进程块：按工作集大小
    for (const r of cells.slice(0, 6)) {
      const n = Math.max(1, Math.round((r / sum) * 30));
      for (let k = 0; k < n; k++) {
        const i = (idx * 7 + k * 13) % (cols * rows);
        c.fillStyle = hexA(accent, 0.30 + 0.35 * (r / sum));
        c.fillRect((i % cols) * cw + 0.5, Math.floor(i / cols) * ch + 0.8, cw - 1.4, ch - 1.6);
      }
      idx++;
    }
    // 分配/释放脉冲
    const t = performance.now() / 900;
    const px = ((Math.sin(t) * 0.5 + 0.5) * (w - 10));
    c.fillStyle = hexA(accent, 0.55);
    c.fillRect(px, 0, 1, h);
  }

  function drawGpu(c, w, h, s, accent) {
    const gpu = s.gpu || {};
    c.font = '8px ui-monospace, Consolas, monospace';
    if (!gpu.available) {
      c.fillStyle = hexA(accent, 0.35);
      c.fillText('GPU 指标不可用', 4, h / 2);
      c.fillStyle = hexA(accent, 0.18);
      c.fillText((gpu.reason || '').slice(0, 40), 4, h / 2 + 12);
      return;
    }
    const enginesArr = Object.entries(gpu.engines || {});
    const bw = w / Math.max(enginesArr.length, 1);
    enginesArr.forEach(([name, v], i) => {
      const x = i * bw;
      c.fillStyle = hexA(accent, 0.06);
      c.fillRect(x + 2, 6, bw - 4, h - 20);
      const bh = (Math.min(v, 100) / 100) * (h - 24);
      c.fillStyle = hexA(accent, 0.22 + Math.min(v, 100) / 160);
      c.fillRect(x + 2, h - 16 - bh, bw - 4, bh);
      c.fillStyle = hexA(accent, 0.55);
      c.fillText(name, x + 4, h - 4);
      c.fillStyle = hexA(accent, 0.75);
      c.fillText(v.toFixed(0) + '%', x + 4, 12);
    });
    // 并行单元阵列
    for (let i = 0; i < 18; i++) {
      const on = i < Math.round((gpu.max_pct || 0) / 6);
      c.fillStyle = hexA(accent, on ? 0.5 : 0.08);
      c.fillRect(4 + i * 6, h * 0.42, 3, 3);
    }
  }

  function drawNet(c, w, h, s, accent, dir) {
    const hist = (s.history || []).slice(-40);
    const key = dir;
    const max = Math.max(1, ...hist.map(x => x[key] || 0));
    const bw = w / 40;
    hist.forEach((x, i) => {
      const v = (x[key] || 0) / max;
      const bh = Math.max(1, v * (h - 12));
      c.fillStyle = hexA(accent, 0.16 + v * 0.5);
      c.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
    });
    // 包流
    const t = performance.now() / 1000;
    const rate = s.net && (dir === 'rx' ? s.net.rx_pps : s.net.tx_pps) || 0;
    const n = clamp(Math.round(rate / 40), 2, 14);
    for (let i = 0; i < n; i++) {
      const x = ((t * 60 + i * 23) % (w + 14)) - 7;
      const y = (h - 6) - ((i * 7) % 10);
      c.fillStyle = hexA(accent, 0.55);
      c.fillRect(x, y, 2.4, 1.2);
    }
    c.strokeStyle = hexA(accent, 0.08);
    c.beginPath(); c.moveTo(0, h - 2); c.lineTo(w, h - 2); c.stroke();
  }

  function drawSys(c, w, h, s, accent) {
    // 采样历史：CPU / 内存两条细线
    const hist = (s.history || []).slice(-60);
    const draw = (key, alpha) => {
      c.beginPath();
      hist.forEach((x, i) => {
        const px = (i / Math.max(1, hist.length - 1)) * w;
        const py = h - 4 - (clamp((x[key] || 0) / 100, 0, 1) * (h - 14));
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      });
      c.strokeStyle = hexA(accent, alpha);
      c.stroke();
    };
    draw('cpu', 0.55);
    draw('mem', 0.28);
    // 进程启停刻度
    c.font = '8px ui-monospace, Consolas, monospace';
    (s.events || []).slice(-6).forEach((e, i) => {
      c.fillStyle = hexA(accent, e.kind === 'start' ? 0.6 : 0.3);
      const y = 9 + i * 9;
      c.fillText((e.kind === 'start' ? '＋ ' : '－ ') + ((e.name || e.pid) + '').slice(0, 18), 2, y);
    });
  }

  function renderDetail(key) {
    const o = boards[key];
    const s = S.snap;
    if (!o || !s) return;
    const esc = (x) => String(x === null || x === undefined ? '--' : x).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    let html = '';
    if (key === 'cpu') {
      html = '<table><tr><td class="k">整体</td><td class="r">' + fmt(s.cpu.pct, 1) + '%</td></tr>';
      (s.cpu.procs || []).forEach(p => {
        html += `<tr><td>${esc(p.name)}</td><td class="r">${fmt(p.cpu, 1)}%</td></tr>`;
      });
      html += '<tr><td class="k">上下文切换</td><td class="r">' + (s.cpu.ctx_delta ?? '--') + '/s</td></tr></table>';
    } else if (key === 'mem') {
      html = `<table><tr><td class="k">物理内存</td><td class="r">${gb(s.mem.used)} / ${gb(s.mem.total)}</td></tr>`;
      (s.mem.procs || []).forEach(p => {
        html += `<tr><td>${esc(p.name)}</td><td class="r">${gb(p.rss)}</td></tr>`;
      });
      html += '</table>';
    } else if (key === 'gpu') {
      const g = s.gpu || {};
      html = `<table><tr><td class="k">状态</td><td class="r">${g.available ? '可用' : '不可用'}</td></tr>`;
      html += `<tr><td class="k">来源</td><td class="r">${esc(g.source || g.reason || '--')}</td></tr>`;
      Object.entries(g.engines || {}).forEach(([k, v]) => {
        html += `<tr><td>${esc(k)}</td><td class="r">${fmt(v, 1)}%</td></tr>`;
      });
      html += '</table>';
    } else if (key === 'down' || key === 'up') {
      const n = s.net || {};
      const k = key === 'down' ? 'rx' : 'tx';
      html = `<table><tr><td class="k">速率</td><td class="r">${n.available ? fmtBytes((n[k + '_bps'] || 0) / 1024) + ' ' + fmtBytesUnit((n[k + '_bps'] || 0) / 1024) : '--'}</td></tr>`;
      html += `<tr><td class="k">包速率</td><td class="r">${n.available ? (n[k + '_pps'] || 0).toFixed(0) + ' pkt/s' : '--'}</td></tr>`;
      html += `<tr><td class="k">网卡</td><td class="r">${esc(n.iface || '--')}</td></tr></table>`;
    } else {
      const sy = s.sys || {};
      html = `<table><tr><td class="k">进程数</td><td class="r">${sy.proc_count ?? '--'}</td></tr>`;
      html += `<tr><td class="k">线程数</td><td class="r">${sy.threads ?? '--'}</td></tr>`;
      html += `<tr><td class="k">运行时长</td><td class="r">${fmtUptime(sy.uptime_s)}</td></tr>`;
      html += `<tr><td class="k">采样序号</td><td class="r">${s.seq}</td></tr></table>`;
      (s.events || []).slice(-8).forEach(e => {
        html += `<div>${e.kind === 'start' ? '启动' : '退出'} · ${esc(e.name || '')} ${e.pid}</div>`;
      });
    }
    o.det.innerHTML = html;
  }

  function fmtUptime(sec) {
    if (sec == null) return '--';
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return (d ? d + '天 ' : '') + h + 'h ' + m + 'm';
  }

  // ------------------------------------------------------------------ 参数面板
  function bindParams() {
    const st = S.settings;
    const map = [
      ['rScale', 'oScale', 'scale', v => v.toFixed(2), v => +v],
      ['rParts', 'oParts', 'parts', v => Math.round(v).toLocaleString(), v => Math.round(+v)],
      ['rGlow', 'oGlow', 'glow', v => v.toFixed(2), v => +v],
      ['rBeat', 'oBeat', 'beat', v => v.toFixed(2), v => +v]
    ];
    map.forEach(([rid, oid, key, show, cast]) => {
      const el = $('#' + rid), out = $('#' + oid);
      el.value = st[key];
      out.textContent = show(+st[key]);
      el.addEventListener('input', () => {
        st[key] = cast(el.value);
        out.textContent = show(+el.value);
        if (key === 'parts' && engines) engines.setParticles(st.parts, S.chan);
        saveSettings();
      });
    });
    const sw = [['cLightFx', 'lightFx'], ['cOverload', 'overloadFx'], ['cMouse', 'mouseFx'], ['cFocus', 'autoFocus']];
    sw.forEach(([id, key]) => {
      const el = $('#' + id);
      el.checked = !!st[key];
      el.addEventListener('change', () => {
        st[key] = el.checked;
        if (key === 'overloadFx' && !el.checked) {
          $$('.rcv').forEach(x => x.classList.remove('overload', 'hit-sear', 'hit-thermal', 'hit-peak', 'shear', 'crack'));
        }
        saveSettings();
      });
    });
    const th = [['thCpu', 'cpu'], ['thMem', 'mem'], ['thGpu', 'gpu'], ['thDown', 'down'], ['thUp', 'up']];
    th.forEach(([id, key]) => {
      const el = $('#' + id);
      el.value = st.thresholds[key];
      el.addEventListener('input', () => {
        const v = +el.value;
        if (Number.isFinite(v) && v > 0) { st.thresholds[key] = v; saveSettings(); }
      });
    });
    $('#btnReset').addEventListener('click', () => {
      S.settings = JSON.parse(JSON.stringify(DEFAULTS));
      S.engine = DEFAULTS.engine; S.theme = DEFAULTS.theme; S.turbo = false;
      localStorage.removeItem(STORE_KEY);
      syncControls();
      applyTheme(S.theme, true);
      setEngine(S.engine, true);
      engines.setParticles(S.settings.parts, S.chan);
      saveSettings();
      toast('已恢复默认设置');
    });
    // 过载门槛的预览按钮按渠道索引
    $$('.prev').forEach(btn => {
      const key = btn.dataset.preview;
      const idx = CH.findIndex(c => c.key === key);
      btn.onclick = () => {
        S.previews[idx] = performance.now() + 2000;
        btn.classList.add('on');
        setTimeout(() => btn.classList.remove('on'), 2000);
        toast(CH[idx].name + '：预览过载视觉（2 秒，不影响读数与门槛）');
      };
    });
  }

  function syncControls() {
    const st = S.settings;
    $('#rScale').value = st.scale; $('#oScale').textContent = (+st.scale).toFixed(2);
    $('#rParts').value = st.parts; $('#oParts').textContent = (+st.parts).toLocaleString();
    $('#rGlow').value = st.glow; $('#oGlow').textContent = (+st.glow).toFixed(2);
    $('#rBeat').value = st.beat; $('#oBeat').textContent = (+st.beat).toFixed(2);
    $('#cLightFx').checked = !!st.lightFx;
    $('#cOverload').checked = !!st.overloadFx;
    $('#cMouse').checked = !!st.mouseFx;
    $('#cFocus').checked = !!st.autoFocus;
    $('#thCpu').value = st.thresholds.cpu; $('#thMem').value = st.thresholds.mem;
    $('#thGpu').value = st.thresholds.gpu; $('#thDown').value = st.thresholds.down;
    $('#thUp').value = st.thresholds.up;
  }

  // ------------------------------------------------------------------ 主题 / 引擎
  function applyTheme(name, silent) {
    S.theme = THEMES[name] ? name : 'silver';
    document.documentElement.style.setProperty('--accent', THEMES[S.theme].hex);
    document.documentElement.style.setProperty('--accent-soft', hexA(THEMES[S.theme].hex, 0.16));
    $$('.theme').forEach(b => b.classList.toggle('on', b.dataset.theme === S.theme));
    if (!silent) saveSettings();
  }

  function setEngine(key, silent) {
    const e = ENGINES.find(x => x.key === key) || ENGINES[0];
    S.engine = e.key;
    if (engines) { engines.setEngine(e.key, {}); engines.setParticles(S.settings.parts, S.chan); }
    $$('.eng-btn').forEach(b => b.classList.toggle('on', b.dataset.eng === e.key));
    $('#engineName').textContent = e.name;
    $('#engineSub').textContent = e.sub;
    layoutInferLabels();
    if (e.theme) applyTheme(e.theme, silent); else applyTheme(S.theme, silent);
    // 换引擎后清掉上一模式的残留反馈
    $$('.rcv').forEach(x => x.classList.remove('hit-sear', 'hit-thermal', 'hit-peak', 'shear', 'crack'));
    if (!silent) saveSettings();
  }

  // ------------------------------------------------------------------ 动画主循环
  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!gl || !engines) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000 || 0.016));
    last = now;
    if (document.hidden) return;

    const color = rgb(THEMES[S.theme].hex);
    gl.glow = clamp(+S.settings.glow || 0.85, 0.2, 1.5);
    const mul = (S.turbo ? 2.8 : 1) * (+S.settings.scale || 1);

    // 通道速度平滑
    for (let i = 0; i < 5; i++) {
      const target = S.chan[i].speed;
      const k = 1 - Math.exp(-dt * 3.2);
      S.smoothSpeed[i] = lerp(S.smoothSpeed[i], target, k);
      S.chan[i].speedSmooth = S.smoothSpeed[i];
    }
    // 过载状态每帧重算（门限相等即恢复）
    let anyOver = false;
    for (let i = 0; i < 5; i++) {
      const c = S.chan[i];
      c.overload = !!(c.available && c.value !== null && c.value > S.settings.thresholds[c.key]);
      if (c.overload) anyOver = true;
    }

    const ctx = {
      t: now / 1000, dt, w: view.w, h: view.h,
      col: color, chan: S.chan, receivers: view.receivers,
      ring: view.ring, mouse: S.settings.mouseFx ? mouse : { on: false },
      overload: S.chan.map(c => c.overload), ui: { receiverHit }, beat: +S.settings.beat,
      lightFx: !!S.settings.lightFx, speedMul: mul, turbo: S.turbo
    };
    gl.begin();
    engines.update(dt, ctx);
    engines.draw(gl, ctx);
    gl.end();

    syncOverloadState();
    const fps = gl.countFps(dt);
    S.frames++;
    $('#sbParts').textContent = '粒子 ' + particleCount().toLocaleString();
    if (fps !== S.fps) {
      S.fps = fps;
      $('#sbFps').textContent = 'FPS ' + fps;
    }
    if (S.snap && !S.offline && (Date.now() - S.snap.ts) > 6000) {
      S.offline = true;
      showOffline(true, true);     // 数据过期按延迟处理，不拿陈旧值冒充实时
    }
    if (S.frames % 30 === 0) {
      renderReceivers();
      const up = Math.floor((Date.now() - S.up0) / 1000);
      $('#sbUptime').textContent = '运行 ' + String(Math.floor(up / 3600)).padStart(2, '0') + ':' +
        String(Math.floor(up % 3600 / 60)).padStart(2, '0') + ':' + String(up % 60).padStart(2, '0');
    }
    drawBoards(now);
  }

  function particleCount() {
    if (!engines) return 0;
    return engines.streams.buf.reduce((a, b) => a + b.length, 0);
  }

  // ------------------------------------------------------------------ 交互
  function bindStage() {
    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
      mouse.r = Math.max(60, view.ring.r * 0.30);
      const d = Math.hypot(mouse.x - view.ring.x, mouse.y - view.ring.y);
      mouse.on = d < view.ring.r * 1.05;
      mouse.sign = 1;
    });
    canvas.addEventListener('mouseleave', () => { mouse.on = false; });
    canvas.addEventListener('click', e => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (Math.hypot(x - view.ring.x, y - view.ring.y) > view.ring.r * 1.02) return;
      if (!engines) return;
      const proj = engines.neural.project(view.ring.x, view.ring.y, view.ring.r * 0.80, null);
      engines.neural.hit(proj);
      engines.neural.ripples.push({ x, y, t: 0, dur: 1.1, max: 70 });
      // 只做一次局部视觉能量，不触发任何渠道过载
      toast('局部能量注入 · 不改变任何监控读数');
    });
  }

  function bindTop() {
    $('#btnTurbo').addEventListener('click', () => {
      S.turbo = !S.turbo;
      $('#btnTurbo').classList.toggle('on', S.turbo);
      saveSettings();
      toast(S.turbo ? '极速分发：×2.8 视觉倍率（不影响真实读数与门槛）' : '已恢复常规分发速度');
    });
    $('#btnFull').addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        else await document.exitFullscreen();
      } catch (e) { toast('全屏被浏览器拒绝：' + e.message); }
      setTimeout(() => { measure(); fitBoardCanvases(); }, 260);
    });
    document.addEventListener('fullscreenchange', () => {
      $('#fullLabel').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
      setTimeout(() => { measure(); fitBoardCanvases(); }, 180);
    });
    $$('.theme').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
    $('#btnParams').addEventListener('click', () => openDrawer(true));
    $('#btnCloseParams').addEventListener('click', () => openDrawer(false));
    $('#mask').addEventListener('click', () => openDrawer(false));
    $('#btnStop').addEventListener('click', async () => {
      if (!confirm('确定结束监控？采样服务将退出，页面会断开连接。')) return;
      try { await fetch('/api/shutdown', { method: 'POST' }); } catch (e) {}
      S.offline = true; showOffline(true);
      toast('采样服务已请求退出，可直接关闭此页面');
    });
    window.addEventListener('resize', () => { measure(); fitBoardCanvases(); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      openDrawer(false);
      // 浏览器原生全屏在部分环境不响应 Esc，这里主动退出一次
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  function openDrawer(on) {
    $('#drawer').hidden = !on;
    $('#mask').hidden = !on;
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ------------------------------------------------------------------ 启动
  function boot() {
    loadSettings();
    stageEl = $('#stage'); wrapEl = $('#stageCanvas');
    buildReceivers();
    if (!initGL()) return;
    measure();
    bindParams();
    bindTop();
    bindStage();
    initBoards();
    syncControls();
    applyTheme(S.theme, true);
    // 引擎切换按钮（放在主视觉右上，不占顶部控制栏）
    const sw = document.createElement('div');
    sw.className = 'engine-switch';
    sw.innerHTML = ENGINES.map(e => `<button class="eng-btn" data-eng="${e.key}">${e.name}</button>`).join('');
    stageEl.appendChild(sw);
    sw.addEventListener('click', ev => {
      const b = ev.target.closest('.eng-btn');
      if (b) setEngine(b.dataset.eng);
    });
    setEngine(S.engine, true);
    $('#btnTurbo').classList.toggle('on', S.turbo);
    measure();

    poll();
    requestAnimationFrame(frame);
    requestAnimationFrame(t => { last = t; });
    // 性能自测钩子：直接在页面里跑 N 帧，返回平均每帧毫秒（含 GL 提交）
    window.NEXUS = {
      S, api: { receiverHit, applyTheme, setEngine, toast },
      bench: (n) => {
        n = n || 60;
        const ctx = {
          t: performance.now() / 1000, dt: 1 / 60, w: view.w, h: view.h,
          col: rgb(THEMES[S.theme].hex), chan: S.chan, receivers: view.receivers,
          ring: view.ring, mouse: { on: false }, overload: S.chan.map(c => c.overload),
          ui: { receiverHit }, beat: +S.settings.beat, lightFx: true, speedMul: 1
        };
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          ctx.t += 1 / 60;
          gl.begin(); engines.update(1 / 60, ctx); engines.draw(gl, ctx); gl.end();
        }
        const ms = (performance.now() - t0) / n;
        return { ms: ms.toFixed(2), sprites: engines.streams.buf.reduce((a, b) => a + b.length, 0) };
      }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
