/* ============================================================
   NEXUS 五引擎 —— 神经网络 / 巨环 / 粒子分发 / 天体与网络形态
   ============================================================ */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ------------------------------------------------------------------ 神经球
  class Neural {
    constructor(count) {
      this.nodes = [];
      this.edges = [];
      this.count = 0;
      this.rot = 0;
      this.pulses = [];
      this.ripples = [];
      this.setCount(count || 300);
    }

    setCount(n) {
      this.count = n;
      const N = n;
      const nodes = [];
      const ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const th = ga * i;
        const rad = 0.80 + Math.random() * 0.20;
        nodes.push({
          x: Math.cos(th) * r * rad, y: y * rad, z: Math.sin(th) * r * rad,
          s: rnd(0.7, 1.9), ph: Math.random() * TAU, boost: 0
        });
      }
      // 每个节点连最近的 3 个邻居（去重）
      const seen = new Set();
      const edges = [];
      for (let i = 0; i < N; i++) {
        const a = nodes[i];
        const d = [];
        for (let j = 0; j < N; j++) {
          if (i === j) continue;
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          d.push([dx * dx + dy * dy + dz * dz, j]);
        }
        d.sort((p, q) => p[0] - q[0]);
        for (let k = 0; k < 4; k++) {
          const j = d[k][1];
          const key = i < j ? i + ':' + j : j + ':' + i;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ a: i, b: j, w: rnd(0.35, 1), ph: Math.random() * TAU, act: Math.random() < 0.10 });
        }
      }
      this.nodes = nodes;
      this.edges = edges;
      this.pulses.length = 0;
    }

    // 屏幕坐标（带轻微透视）
    project(cx, cy, R, mouse) {
      this.rot += 0.0;
      const cy0 = Math.cos(0.34), sy0 = Math.sin(0.34);
      const cr = Math.cos(this.rot), sr = Math.sin(this.rot);
      const out = [];
      for (const n of this.nodes) {
        // rotate Y then X(倾斜)
        let x = n.x * cr + n.z * sr;
        let z = -n.x * sr + n.z * cr;
        let y = n.y * cy0 - z * sy0;
        z = n.y * sy0 + z * cy0;
        const persp = 3.1 / (3.1 + z);
        let sx = cx + x * R * 0.86 * persp;
        let sy = cy + y * R * 0.86 * persp;
        if (mouse && mouse.on) {
          const dx = sx - mouse.x, dy = sy - mouse.y;
          const dist = Math.hypot(dx, dy);
          if (dist < mouse.r) {
            const f = (1 - dist / mouse.r);
            sx += (dx / (dist + 0.001)) * f * 9 * mouse.sign;
            sy += (dy / (dist + 0.001)) * f * 9 * mouse.sign;
            n.boost = Math.min(1.6, n.boost + f * 0.05);
          }
        }
        n.boost *= 0.975;
        out.push({ x: sx, y: sy, z, persp, n });
      }
      return out;
    }

    // 点一下：局部激活 + 沿连线传导
    hit(nodes) {
      for (let i = 0; i < 6; i++) {
        const p = nodes[(Math.random() * nodes.length) | 0];
        p.n.boost = 1.2;
      }
      const e = this.edges[(Math.random() * this.edges.length) | 0];
      if (e) this.pulses.push({ a: e.a, b: e.b, t: 0, dur: rnd(0.45, 0.85) });
    }

    draw(g, cx, cy, R, col, opts) {
      const light = opts.light !== false;
      const proj = this.project(cx, cy, R, opts.mouse);
      // 连线
      const edgeA = light ? 0.16 : 0.07;
      for (const e of this.edges) {
        const A = proj[e.a], B = proj[e.b];
        if (!A || !B) continue;
        const depth = clamp((A.z + B.z) * 0.5, -1, 1);
        const tw = 0.75 + 0.25 * Math.sin(opts.t * 2.1 + e.ph);
        let a = edgeA * (0.40 + 0.60 * (1 - (depth + 1) / 2)) * e.w * tw;
        if (e.act) a *= 2.6;
        g.line(A.x, A.y, B.x, B.y, col, a * 0.9);
        // 活跃路径上跑一个亮点，形成神经传导感
        if (e.act && light) {
          const k = ((opts.t * 0.35 + e.ph) % 1);
          g.sprite(lerp(A.x, B.x, k), lerp(A.y, B.y, k), 1.9, col, 0.55 * (1 - Math.abs(k - 0.5)), 1);
        }
      }
      // 节点
      for (let i = 0; i < proj.length; i++) {
        const p = proj[i];
        const front = clamp((1 - p.z) * 0.5, 0.05, 1);
        const tw = 0.55 + 0.45 * Math.sin(opts.t * 1.7 + p.n.ph);
        const a = (0.20 + 0.62 * front * tw + p.n.boost * 0.55) * (light ? 1 : 0.6);
        const sz = p.n.s * (1.1 + front * 1.7) * (1 + p.n.boost * 0.8);
        g.sprite(p.x, p.y, sz, col, a, 1);
      }
      // 传导脉冲
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const pl = this.pulses[i];
        pl.t += opts.dt;
        const k = pl.t / pl.dur;
        if (k >= 1) {
          const B = proj[pl.b];
          if (B) B.n.boost = Math.min(1.5, B.n.boost + 0.7);
          this.pulses.splice(i, 1);
          continue;
        }
        const A = proj[pl.a], B = proj[pl.b];
        if (!A || !B) { this.pulses.splice(i, 1); continue; }
        const x = lerp(A.x, B.x, k), y = lerp(A.y, B.y, k);
        g.sprite(x, y, 2.2, col, 0.75, 1);
        g.sprite(x, y, 5.5, col, 0.18, 1);
      }
      // 点击波纹
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const rp = this.ripples[i];
        rp.t += opts.dt;
        const k = rp.t / rp.dur;
        if (k >= 1) { this.ripples.splice(i, 1); continue; }
        const rr = k * rp.max;
        const a = (1 - k) * 0.5;
        for (let s = 0; s < 40; s++) {
          const ang = (s / 40) * TAU;
          g.sprite(rp.x + Math.cos(ang) * rr, rp.y + Math.sin(ang) * rr, 1.6, col, a, 1);
        }
      }
    }
  }

  // ------------------------------------------------------------------ 巨型圆环
  class Ring {
    constructor() { this.t = 0; this.scan = 0; }

    draw(g, cx, cy, R, col, chan, opts) {
      this.t += opts.dt;
      const beat = opts.beat || 1;
      const rings = [R * 1.018, R, R * 0.972, R * 0.938, R * 0.902];
      for (let i = 0; i < rings.length; i++) {
        const rr = rings[i];
        const alpha = [0.34, 0.26, 0.14, 0.09, 0.05][i];
        for (let a = 0; a < 240; a++) {
          const t0 = (a / 240) * TAU, t1 = ((a + 1) / 240) * TAU;
          g.line(cx + Math.cos(t0) * rr, cy + Math.sin(t0) * rr,
                 cx + Math.cos(t1) * rr, cy + Math.sin(t1) * rr, col, alpha);
        }
      }
      // 刻度：外圈密集短刻线
      const ticks = 268;
      for (let i = 0; i < ticks; i++) {
        const ang = (i / ticks) * TAU - Math.PI / 2;
        const len = (i % 9 === 0) ? R * 0.045 : (i % 3 === 0 ? R * 0.022 : R * 0.012);
        const inner = R * 1.006;
        const pulse = 0.14 + 0.10 * Math.sin(this.t * 1.1 + i * 0.35);
        g.line(cx + Math.cos(ang) * inner, cy + Math.sin(ang) * inner,
               cx + Math.cos(ang) * (inner + len), cy + Math.sin(ang) * (inner + len),
               col, pulse);
      }
      // 右侧五路计算区：扇区活跃度来自真实指标
      const chans = 5;
      for (let c = 0; c < chans; c++) {
        const mid = -0.52 + c * 0.26;                  // 右侧纵向扇形分布
        const span = 0.115;
        const v = chan[c] ? chan[c].norm : 0;
        const active = chan[c] && chan[c].available;
        for (let i = 0; i < 16; i++) {
          const k = i / 15;
          const ang = mid - span / 2 + span * k;
          const a0 = 0.10 + v * 0.70;
          const rr = R * (0.90 + (i % 4) * 0.012);
          g.line(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr,
                 cx + Math.cos(ang) * (rr + R * (0.02 + v * 0.03)),
                 cy + Math.sin(ang) * (rr + R * (0.02 + v * 0.03)),
                 col, active ? a0 : a0 * 0.35);
        }
        // 扇区支架：两道径向边 + 若干横档
        const e0 = mid - span / 2, e1 = mid + span / 2;
        for (const ang of [e0, e1]) {
          g.line(cx + Math.cos(ang) * R * 0.88, cy + Math.sin(ang) * R * 0.88,
                 cx + Math.cos(ang) * R * 1.02, cy + Math.sin(ang) * R * 1.02, col, 0.12 + v * 0.20);
        }
        for (let rung = 0; rung < 5; rung++) {
          const rr = R * (0.88 + rung * 0.035);
          const aa = (rung / 4) * (0.10 + v * 0.35);
          g.line(cx + Math.cos(e0) * rr, cy + Math.sin(e0) * rr,
                 cx + Math.cos(e1) * rr, cy + Math.sin(e1) * rr, col, aa);
        }
        // 任务提交小格
        const n = active ? 2 + Math.round(v * 4) : 1;
        for (let i = 0; i < n; i++) {
          const ang = mid + (Math.random() - 0.5) * span;
          const rr = R * (0.93 + Math.random() * 0.05);
          const w = 1.6 + Math.random() * 2.4;
          g.sprite(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, w, col, 0.12 + v * 0.4, 1);
        }
      }
      // 局部寄存阵列：右侧环内侧的小缓存格
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 26; i++) {
          const ang = -0.62 + (i / 25) * 1.24;
          const rr = R * (0.855 + row * 0.026);
          if ((i + row * 7 + Math.floor(this.t * 2)) % 9 !== 0) continue;
          g.sprite(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 2.0, col, 0.16 + 0.15 * Math.random(), 1);
        }
      }
      // 背景异步活动：稀疏代码条 / 缓存闪烁 / 短扫描
      for (let i = 0; i < 46; i++) {
        const ang = Math.random() * TAU;
        const rr = R * rnd(0.90, 1.02);
        if (Math.random() < 0.4) {
          g.sprite(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr,
                   rnd(0.8, 2.0), col, rnd(0.04, 0.13), 1);
        } else {
          const l = R * rnd(0.008, 0.03);
          g.line(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr,
                 cx + Math.cos(ang) * (rr + l), cy + Math.sin(ang) * (rr + l), col, rnd(0.03, 0.09));
        }
      }
      // 环外缘柔光
      for (let i = 0; i < 70; i++) {
        const ang = (i / 70) * TAU + this.t * 0.02;
        g.sprite(cx + Math.cos(ang) * R * 1.003, cy + Math.sin(ang) * R * 1.003,
                 R * 0.012, col, 0.020, 1);
      }
      // 扫描弧
      this.scan = (this.scan + opts.dt * 0.20 * beat) % TAU;
      for (let i = 0; i < 26; i++) {
        const ang = this.scan + i * 0.004;
        g.sprite(cx + Math.cos(ang) * R * 0.997, cy + Math.sin(ang) * R * 0.997, 1.8, col,
                 (1 - i / 26) * 0.22, 1);
      }
    }
  }

  // ------------------------------------------------------------------ 粒子流
  class Streams {
    constructor() { this.buf = [[], [], [], [], []]; }

    resize(total, chan) {
      const weights = chan.map(c => (c.available ? 0.35 + c.speed * 1.8 : 0.25));
      const sum = weights.reduce((a, b) => a + b, 0) || 1;
      // 最大余数法：保证各路相加严格等于设定值，状态栏不会出现 12,001
      const raw = weights.map(w => total * w / sum);
      const per = raw.map(v => Math.floor(v));
      let rest = total - per.reduce((a, b) => a + b, 0);
      const order = raw.map((v, i) => [v - per[i], i]).sort((a, b) => b[0] - a[0]);
      for (let k = 0; k < rest; k++) per[order[k % order.length][1]]++;
      for (let i = 0; i < 5; i++) {
        per[i] = Math.max(40, per[i]);
        const arr = this.buf[i];
        while (arr.length < per[i]) arr.push(this._mk());
        if (arr.length > per[i]) arr.length = per[i];
      }
    }

    _mk() {
      // 三成粒子贴中轴形成束流，其余散开到上下缘，避免糊成一条白带
      const tight = Math.random() < 0.32;
      return {
        t: Math.random(), lane: tight ? rnd(-0.22, 0.22) : rnd(-1, 1),
        sub: rnd(-1, 1), speed: rnd(0.7, 1.35),
        len: Math.random() < 0.12 ? rnd(0.025, 0.06) : rnd(0.004, 0.014),
        w: rnd(0.5, 1.5), ph: Math.random() * TAU, bright: Math.random()
      };
    }

    draw(g, chan, path, col, opts) {
      for (let c = 0; c < 5; c++) {
        const ch = chan[c];
        const arr = this.buf[c];
        const speed = ch.available ? ch.speed : 0.02;
        const baseA = ch.available ? clamp(0.06 + speed * 0.26, 0.06, 0.34) : 0.035;
        const lowLoad = ch.available && ch.norm < 0.12;
        const boostA = lowLoad ? 2.2 : 1;
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          p.t += opts.dt * speed * 0.55 * p.speed * (ch.available ? 1 : 0.25) * (opts.speedMul || 1);
          if (p.t > 1) {
            p.t -= 1;
            const tight = Math.random() < 0.32;
            p.lane = tight ? rnd(-0.22, 0.22) : rnd(-1, 1);
            p.sub = rnd(-1, 1);
            p.len = Math.random() < 0.12 ? rnd(0.025, 0.06) : rnd(0.004, 0.014);
            p.speed = rnd(0.7, 1.35); p.bright = Math.random();
          }
          const h = path(c, p.t, p.lane, opts);
          const tail = Math.max(0, p.t - p.len * (0.6 + speed * 0.9));
          const tl = path(c, tail, p.lane, opts);
          if (!h || !tl) continue;
          const fadeIn = clamp(p.t * 12, 0, 1);
          const fadeOut = clamp((1 - p.t) * 5, 0, 1);
          const a = baseA * boostA * fadeIn * fadeOut * (0.35 + p.bright * 1.0) * (opts.alphaMul || 1);
          g.seg(tl.x, tl.y, h.x, h.y, col, a * 0.35, col, a * 0.9);
          if (p.bright > 0.9) g.sprite(h.x, h.y, p.w * 1.5, col, a * 0.55, 1);
        }
      }
    }
  }

  // ------------------------------------------------------------------ 五引擎
  class Engines {
    constructor() {
      this.neural = new Neural(300);
      this.ring = new Ring();
      this.streams = new Streams();
      this.name = 'flow';
      this.t = 0;
      this.waves = [];
      this.waveTimer = 0;
      this.sun = null;
      this.bodies = null;
      this.infer = null;
      this.hits = [0, 0, 0, 0, 0];
      this.previewUntil = [0, 0, 0, 0, 0];
      this._fpsGuard = 0;
    }

    setEngine(name, opts) {
      this.name = name;
      this.waves.length = 0;
      this.waveTimer = 0;
      this.hits = [0, 0, 0, 0, 0];
      if (name === 'three' && !this.bodies) this._initThree();
      if (name === 'infer' && !this.infer) this._initInfer();
      // 切换引擎不重建粒子池，保持连续；数量由 setParticles 控制
    }

    setParticles(total, chan) {
      this._total = total;
      this.streams.resize(total, chan);
      this.neural.setCount(clamp(Math.round(total / 42), 160, 420));
    }

    _initThree() {
      const s = 0.25;
      this.bodies = [
        { x: -s, y: 0, vx: 0.06, vy: 0.20, m: 1.0, col: 0 },
        { x: s * 0.9, y: 0.05, vx: -0.14, vy: -0.10, m: 0.85, col: 1 },
        { x: 0.02, y: -s * 0.95, vx: 0.07, vy: -0.07, m: 0.92, col: 2 }
      ];
      this.trails = [[], [], []];
    }

    _initInfer() {
      const counts = [5, 11, 15, 15, 11, 5];
      const layers = [];
      const totalW = 1.0;
      for (let l = 0; l < counts.length; l++) {
        const ns = [];
        const x = -totalW / 2 + (l / (counts.length - 1)) * totalW;
        const n = counts[l];
        for (let i = 0; i < n; i++) {
          const y = n === 1 ? 0 : (i / (n - 1) - 0.5) * 0.62;
          ns.push({ x, y, z: (Math.random() - 0.5) * 0.10, ph: Math.random() * TAU });
        }
        layers.push({ nodes: ns, x });
      }
      this.infer = { layers, packets: [], cap: 144, next: 0 };
    }

    update(dt, ctx) {
      this.t += dt;
      this.neural.rot += dt * 0.055 * (ctx.beat || 1);
      // 黑洞整体引力波：每 1.5s 一道，最多两道
      if (this.name === 'bh') {
        this.waveTimer += dt;
        if (this.waveTimer >= 1.5 && this.waves.length < 2) {
          this.waveTimer -= 1.5;
          this.waves.push({ t: 0, dur: 2.7, hit: [false, false, false, false, false] });
        }
        for (let i = this.waves.length - 1; i >= 0; i--) {
          const wv = this.waves[i];
          wv.t += dt;
          const k = wv.t / wv.dur;
          // 抵达每个接收端的时间按横向距离错开，整道波共用一次发射
          for (let c = 0; c < 5; c++) {
            const arrive = 0.35 + c * 0.09 + 0.28;
            if (!wv.hit[c] && k >= arrive) {
              wv.hit[c] = true;
              ctx.ui.receiverHit(c, 'bh');
            }
          }
          if (k >= 1) this.waves.splice(i, 1);
        }
      } else {
        this.waves.length = 0;
        this.waveTimer = 0;
      }
      if (this.name === 'three') this._stepThree(dt);
      if (this.name === 'infer') this._stepInfer(dt, ctx);
    }

    _stepThree(dt) {
      const B = this.bodies;
      if (!B) return;
      const G = 0.9, soft = 0.028;
      const step = Math.min(dt, 1 / 45);
      for (let i = 0; i < 3; i++) {
        let ax = 0, ay = 0;
        for (let j = 0; j < 3; j++) {
          if (i === j) continue;
          const dx = B[j].x - B[i].x, dy = B[j].y - B[i].y;
          const d2 = dx * dx + dy * dy + soft;
          const f = G * B[j].m / (d2 * Math.sqrt(d2));
          ax += dx * f; ay += dy * f;
        }
        B[i].vx += ax * step; B[i].vy += ay * step;
      }
      for (let i = 0; i < 3; i++) {
        B[i].x += B[i].vx * step; B[i].y += B[i].vy * step;
        // 柔和边界：超出就轻微回拉，不做硬反弹
        const r = Math.hypot(B[i].x, B[i].y);
        if (r > 0.42) {
          B[i].vx *= 0.985; B[i].vy *= 0.985;
          B[i].x *= 0.995; B[i].y *= 0.995;
        }
        const tr = this.trails[i];
        tr.push([B[i].x, B[i].y]);
        if (tr.length > 90) tr.shift();
      }
    }

    _stepInfer(dt, ctx) {
      const I = this.infer;
      if (!I) return;
      I.next += dt;
      const spawnEvery = 0.11;
      while (I.next > spawnEvery) {
        I.next -= spawnEvery;
        if (I.packets.length < I.cap) {
          const ch = (Math.random() * 5) | 0;
          I.packets.push({ ch, layer: 0, prog: 0, dur: rnd(0.66, 0.87), from: 0, to: 0, hot: false, trail: [] });
        }
      }
      for (let i = I.packets.length - 1; i >= 0; i--) {
        const p = I.packets[i];
        p.prog += dt / p.dur;
        if (p.prog >= 1) {
          p.prog -= 1;
          p.layer++;
          if (p.layer >= I.layers.length - 1) {
            ctx.ui.receiverHit(p.ch, 'infer');
            I.packets.splice(i, 1);
            continue;
          }
        }
        p.trail.push([p.layer, p.prog]);
        if (p.trail.length > 3) p.trail.shift();
      }
    }

    // ---------------------------------------------------------------- 主绘制
    draw(g, ctx) {
      const { w, h, col, chan, t, dt } = ctx;
      const cx = ctx.ring.x, cy = ctx.ring.y, R = ctx.ring.r;
      // 背景稀疏星点，给空间纵深感
      if (!this._stars) {
        this._stars = Array.from({ length: 120 }, () => ({
          x: Math.random(), y: Math.random(), s: rnd(0.5, 1.3), a: rnd(0.03, 0.14), ph: Math.random() * TAU
        }));
      }
      for (const s of this._stars) {
        g.sprite(s.x * w, s.y * h, s.s, col, s.a * (0.6 + 0.4 * Math.sin(t * 0.8 + s.ph)), 1);
      }

      this.ring.draw(g, cx, cy, R, col, chan, { dt, beat: ctx.beat, light: ctx.lightFx });
      this.neural.draw(g, cx, cy, R * 0.74, col, {
        dt, t, light: ctx.lightFx, mouse: ctx.mouse
      });

      const pathCtx = { ...ctx, cx, cy, R };
      switch (this.name) {
        case 'bh': this._drawBH(g, pathCtx); break;
        case 'fusion': this._drawFusion(g, pathCtx); break;
        case 'three': this._drawThree(g, pathCtx); break;
        case 'infer': this._drawInfer(g, pathCtx); break;
        default: this._drawFlow(g, pathCtx); break;
      }
    }

    _pathStraight(c, t, lane, ctx) {
      const rx = ctx.ring.x + ctx.ring.r * 0.94;
      const x0 = rx, y0 = ctx.chan[c].y + lane * 30 + Math.sin(c * 2.7) * 4;
      const x1 = ctx.receivers[c].x - 6, y1 = ctx.chan[c].y + lane * 16;
      if (t < 0) return null;
      const wob = Math.sin(t * 9 + c) * 3 * (1 - t * 0.4);
      return { x: lerp(x0, x1, t), y: lerp(y0, y1, t) + wob };
    }

    _drawFlow(g, ctx) {
      this.streams.draw(g, ctx.chan, this._pathStraight, ctx.col, ctx);
      // 中央一股横向束流，强化“极速”感
      for (let i = 0; i < 60; i++) {
        const y = ctx.ring.y + (Math.random() - 0.5) * 6;
        const x = ctx.ring.x + ctx.ring.r * (0.95 + Math.random() * 1.2);
        g.sprite(x, y, rnd(0.6, 1.6), ctx.col, rnd(0.03, 0.12), 2.2);
      }
    }

    _pathGravity(c, t, lane, ctx) {
      const rx = ctx.ring.x + ctx.ring.r * 0.94;
      const x0 = rx, y0 = ctx.chan[c].y + lane * 7;
      const x1 = ctx.receivers[c].x - 6, y1 = ctx.chan[c].y + lane * 8;
      const coreX = ctx.ring.x + ctx.ring.r * 1.62;
      const coreY = ctx.ring.y;
      if (t < 0.5) {
        const k = t / 0.5;
        // 先保持水平，接近核心再弯折，避免五路糊成两片大翅膀
        const p1 = [lerp(x0, coreX, 0.55), y0 + (coreY - y0) * 0.10];
        const p2 = [coreX - 34, coreY + (y0 - coreY) * 0.14];
        return bez([x0, y0], p1, p2, k);
      }
      const k = (t - 0.5) / 0.5;
      const q1 = [coreX + 36, coreY + (y1 - coreY) * 0.14];
      const q2 = [lerp(coreX, x1, 0.5), y1];
      return bez([coreX + 36, coreY + (y1 - coreY) * 0.14], q2, [x1, y1], k);
    }

    _drawBH(g, ctx) {
      const coreX = ctx.ring.x + ctx.ring.r * 1.62;
      const coreY = ctx.ring.y;
      const rad = ctx.ring.r * 0.050;
      // 引力波：横跨五路的一道波
      for (const wv of this.waves) {
        const k = wv.t / wv.dur;
        const x = lerp(coreX, ctx.receivers[0].x, clamp(k, 0, 1));
        for (let c = 0; c < 5; c++) {
          const y = ctx.chan[c].y;
          const bend = Math.sin(k * Math.PI) * 16;
          g.sprite(x, y + bend * (c - 2) * 0.2, 2.2, ctx.col, (1 - k) * 0.35, 3.0);
        }
        for (let s = 0; s < 24; s++) {
          const y = lerp(ctx.chan[0].y - 24, ctx.chan[4].y + 24, s / 23);
          g.sprite(x + Math.sin(s + k * 9) * 3, y, 1.4, ctx.col, (1 - k) * 0.12, 1);
        }
      }
      this.streams.draw(g, ctx.chan, this._pathGravity, ctx.col, { ...ctx, alphaMul: 0.45 });
      // 被吸入的短弧
      for (let i = 0; i < 90; i++) {
        const a = Math.random() * TAU;
        const rr = rad * rnd(1.05, 2.6);
        g.sprite(coreX + Math.cos(a) * rr, coreY + Math.sin(a) * rr * 0.34, 1.5, ctx.col, rnd(0.05, 0.22), 1);
      }
      g.blackhole(coreX, coreY, rad, ctx.col, ctx.t, 0.30);
    }

    _pathRefract(c, t, lane, ctx) {
      const sx = ctx.ring.x + ctx.ring.r * 0.94;
      const sy = ctx.chan[c].y + lane * 12;
      const ex = ctx.receivers[c].x - 6, ey = ctx.chan[c].y + lane * 10;
      const sunX = ctx.ring.x + ctx.ring.r * 1.62, sunY = ctx.ring.y;
      const pull = 0.12;
      const p1 = [lerp(sx, sunX, 0.45), sy + (sunY - sy) * pull];
      const p2 = [lerp(sunX, ex, 0.45), sy + (ey - sy) * 0.55 + (sunY - sy) * pull * 0.5];
      return bez([sx, sy], p1, p2, [ex, ey], t);
    }

    _drawFusion(g, ctx) {
      const sunX = ctx.ring.x + ctx.ring.r * 1.62, sunY = ctx.ring.y;
      const rad = ctx.ring.r * 0.068;
      // 折射流：细亮边 + 透明扰动
      this.streams.draw(g, ctx.chan, this._pathRefract, ctx.col, { ...ctx, alphaMul: 0.42 });
      for (let i = 0; i < 46; i++) {
        const c = (Math.random() * 5) | 0;
        const t = Math.random();
        const p = this._pathRefract(c, t, (Math.random() - 0.5) * 1.6, ctx);
        if (!p) continue;
        g.sprite(p.x, p.y, rnd(0.8, 2.2), [1.0, 0.86, 0.66], rnd(0.03, 0.10), 2.6);
      }
      g.sun(sunX, sunY, rad, ctx.col, ctx.t);
      // 表面耀斑
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * TAU;
        const rr = rad * rnd(1.05, 1.5);
        g.sprite(sunX + Math.cos(a) * rr, sunY + Math.sin(a) * rr, rnd(1, 2.6), [1, 0.78, 0.45], rnd(0.05, 0.2), 1);
      }
    }

    _drawThree(g, ctx) {
      const cX = ctx.ring.x + ctx.ring.r * 1.62, cY = ctx.ring.y;
      const scale = ctx.ring.r * 1.16;
      const B = this.bodies || [];
      // 轨迹
      for (let i = 0; i < B.length; i++) {
        const tr = this.trails[i];
        for (let k = 1; k < tr.length; k++) {
          const a = (k / tr.length) * 0.30;
          g.line(cX + tr[k - 1][0] * scale, cY + tr[k - 1][1] * scale,
                 cX + tr[k][0] * scale, cY + tr[k][1] * scale, ctx.col, a);
        }
      }
      this.streams.draw(g, ctx.chan, (c, t, lane, cx2) => {
        const sx = cx2.ring.x + cx2.ring.r * 0.94;
        const sy = cx2.chan[c].y + lane * 8;
        const ex = cx2.receivers[c].x - 6, ey = cx2.chan[c].y + lane * 10;
        const b = B[c % 3] || { x: 0, y: 0 };
        const bx = cX + b.x * scale, by = cY + b.y * scale;
        if (t < 0.45) return bez([sx, sy], [lerp(sx, bx, 0.5), lerp(sy, by, 0.6) + lane * 20], [bx, by], t / 0.45);
        const k = (t - 0.45) / 0.55;
        return bez([bx, by], [lerp(bx, ex, 0.4), lerp(by, ey, 0.4) - lane * 18], [ex, ey], k);
      }, ctx.col, { ...ctx, alphaMul: 0.42 });
      // 三个核心
      for (let i = 0; i < B.length; i++) {
        const x = cX + B[i].x * scale, y = cY + B[i].y * scale;
        g.sprite(x, y, 4.4, ctx.col, 0.95, 1);
        g.sprite(x, y, 13, ctx.col, 0.26, 1);
        g.sprite(x, y, 30, ctx.col, 0.07, 1);
      }
      // 引力弹射火花
      for (let i = 0; i < 26; i++) {
        const b = B[(Math.random() * 3) | 0];
        if (!b) continue;
        g.sprite(cX + b.x * scale + rnd(-8, 8), cY + b.y * scale + rnd(-8, 8), rnd(0.6, 1.6), ctx.col, rnd(0.04, 0.18), 2);
      }
    }

    _drawInfer(g, ctx) {
      const I = this.infer;
      if (!I) return;
      const gx0 = ctx.ring.x + ctx.ring.r * 1.05;
      const gx1 = ctx.receivers[0].x - 40;
      const spanX = Math.max(120, gx1 - gx0);
      const spanY = Math.min(ctx.h * 0.36, ctx.ring.r * 0.92);
      const tx = (l) => gx0 + (l / 5) * spanX;
      const ty = (y) => ctx.ring.y + y * spanY;
      const L = I.layers;

      // 层间稀疏连接
      for (let l = 0; l < L.length - 1; l++) {
        const A = L[l].nodes, B = L[l + 1].nodes;
        for (let i = 0; i < A.length; i++) {
          for (let j = 0; j < B.length; j++) {
            if ((i * 7 + j * 13 + l * 5) % 7 !== 0) continue;
            const a = A[i], b = B[j];
            g.line(tx(l), ty(a.y), tx(l + 1), ty(b.y), ctx.col, 0.13);
          }
        }
      }
      // 节点 + 层刻度
      for (let l = 0; l < L.length; l++) {
        for (const n of L[l].nodes) {
          const tw = 0.5 + 0.5 * Math.sin(ctx.t * 1.9 + n.ph);
          g.sprite(tx(l), ty(n.y), 2.4 + tw * 0.9, ctx.col, 0.42 + tw * 0.35, 1);
          if (tw > 0.9) g.sprite(tx(l), ty(n.y), 5.5, ctx.col, 0.10, 1);
        }
        g.line(tx(l), ctx.ring.y - spanY * 0.52, tx(l), ctx.ring.y - spanY * 0.46, ctx.col, 0.26);
        g.line(tx(l) - 6, ctx.ring.y, tx(l) + 6, ctx.ring.y, ctx.col, 0.10);
        g.line(tx(l), ctx.ring.y + spanY * 0.46, tx(l), ctx.ring.y + spanY * 0.52, ctx.col, 0.12);
      }
      // 传导包：层间穿梭，带尾迹
      for (const p of I.packets) {
        const l = p.layer;
        const A = L[l].nodes, B = L[Math.min(l + 1, 5)].nodes;
        if (p.idxA == null) p.idxA = (Math.random() * A.length) | 0;
        if (p.idxB == null) p.idxB = (Math.random() * B.length) | 0;
        const a = A[p.idxA] || A[0], b = B[p.idxB] || B[0];
        const lx = tx(l), rx = tx(Math.min(l + 1, 5));
        const x = lerp(lx, rx, p.prog);
        const y = lerp(ty(a.y), ty(b.y), p.prog);
        const hot = ctx.overload[p.ch];
        const c = hot ? [1.0, 0.72, 0.58] : ctx.col;
        // 被选中的分支留亮痕，其余短尾迹
        g.line(lerp(lx, x, 0.35), lerp(ty(a.y), y, 0.35), x, y, c, 0.9);
        g.sprite(x, y, 3.0, c, 1.0, 1);
        g.sprite(x, y, 11, c, 0.20, 1);
        if (hot) {
          g.sprite(x, y, 16, c, 0.08, 1);
          g.line(x, y, x + 14, y + (Math.random() - 0.5) * 4, c, 0.25);
        }
      }
      // 算力洪峰：过载渠道额外三路并行候选 + 层间缓存格
      const over = ctx.overload || [];
      for (let ch = 0; ch < 5; ch++) {
        if (!over[ch]) continue;
        const warm = [1.0, 0.72, 0.58];
        for (let br = 1; br <= 3; br++) {
          const yOff = (br - 2) * 9;
          for (let l = 0; l < 5; l++) {
            const y0 = ctx.ring.y + yOff + Math.sin(ctx.t * 2 + l) * 4;
            const y1 = ctx.ring.y + yOff + Math.sin(ctx.t * 2 + l + 1) * 4;
            g.line(tx(l), y0, tx(l + 1), y1, warm, 0.16);
            const k = (ctx.t * 1.6 + l * 0.2 + br * 0.13) % 1;
            g.sprite(lerp(tx(l), tx(l + 1), k), lerp(y0, y1, k), 1.9, warm, 0.5, 1);
          }
        }
        // 缓存格：局部积聚后排出
        for (let c = 0; c < 3; c++) {
          const l = 1 + ((Math.floor(ctx.t * 1.4) + c) % 4);
          const x = tx(l) + 8;
          for (let k = 0; k < 4; k++) {
            const filled = ((ctx.t * 1.7 + c * 0.3 + k * 0.2) % 1) > 0.45;
            g.line(x, ctx.ring.y - 26 + k * 5, x + 5, ctx.ring.y - 26 + k * 5,
                   filled ? warm : ctx.col, filled ? 0.42 : 0.10);
          }
        }
      }
      // 入口与出口
      g.sprite(tx(0), ctx.ring.y, 6, ctx.col, 0.45, 1);
      g.sprite(tx(5), ctx.ring.y, 6, ctx.col, 0.45, 1);
      for (let i = 0; i < 22; i++) {
        const k = (ctx.t * 0.4 + i / 22) % 1;
        g.sprite(tx(5) + k * 26, ctx.ring.y + (i - 11) * 2.2, 1.4, ctx.col, 0.10 * (1 - k), 1);
      }
    }
  }

  // 三次贝塞尔（2 点 / 3 点坐标都用得上）
  function bez(p0, p1, p2, p3orT, maybeT) {
    if (maybeT === undefined) {
      // 二次
      const t = p3orT;
      const x = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0];
      const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1];
      return { x, y };
    }
    const t = maybeT;
    const u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3orT[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3orT[1];
    return { x, y };
  }

  window.NEXUS_ENGINES = { Engines, Neural, Ring, Streams, bez };
})();
