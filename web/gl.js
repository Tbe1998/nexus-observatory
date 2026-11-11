/* ============================================================
   NEXUS 渲染核心 —— WebGL2 实例化粒子 + 线段 + 程序化天体
   所有坐标为 CSS 像素，内部换算到 devicePixelRatio
   ============================================================ */
(function () {
  'use strict';

  const VS_SPRITE = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 a_corner;
  layout(location=1) in vec2 a_pos;
  layout(location=2) in float a_size;
  layout(location=3) in vec3 a_col;
  layout(location=4) in float a_alpha;
  layout(location=5) in float a_stretch;
  uniform vec2 u_res; uniform float u_glow;
  out vec2 v_uv; out vec3 v_col; out float v_alpha;
  void main(){
    vec2 c = a_corner;
    c.x *= a_stretch;
    vec2 p = a_pos + c * a_size;
    v_uv = a_corner;
    v_col = a_col;
    v_alpha = a_alpha * u_glow;
    gl_Position = vec4((p / u_res) * 2.0 - 1.0, 0.0, 1.0);
    gl_Position.y = -gl_Position.y;
  }`;

  const FS_SPRITE = `#version 300 es
  precision highp float;
  in vec2 v_uv; in vec3 v_col; in float v_alpha;
  out vec4 outColor;
  void main(){
    float d = length(v_uv);
    if (d > 1.0) discard;
    float soft = smoothstep(1.0, 0.12, d);
    float core = pow(max(0.0, 1.0 - d), 3.0);
    float a = (soft * 0.55 + core * 0.9) * v_alpha;
    outColor = vec4(v_col * a, a);
  }`;

  const VS_LINE = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 a_pos;
  layout(location=1) in vec3 a_col;
  layout(location=2) in float a_alpha;
  uniform vec2 u_res; uniform float u_glow;
  out vec3 v_col; out float v_alpha;
  void main(){
    v_col = a_col; v_alpha = a_alpha * u_glow;
    vec2 ndc = (a_pos / u_res) * 2.0 - 1.0;
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  }`;

  const FS_LINE = `#version 300 es
  precision highp float;
  in vec3 v_col; in float v_alpha;
  out vec4 outColor;
  void main(){ outColor = vec4(v_col * v_alpha, v_alpha); }`;

  // 程序化天体：0=太阳，1=黑洞吸积盘，2=引力透镜薄环
  const VS_QUAD = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 a_corner;
  uniform vec4 u_rect;   // x,y,w,h (px)
  uniform vec2 u_res;
  out vec2 v_uv;
  void main(){
    vec2 p = u_rect.xy + (a_corner * 0.5 + 0.5) * u_rect.zw;
    v_uv = a_corner;
    vec2 ndc = (p / u_res) * 2.0 - 1.0;
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  }`;

  const HEAD = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform vec4 u_rect; uniform float u_time; uniform vec3 u_col; uniform int u_kind;
  uniform float u_tilt; uniform float u_seed;
  out vec4 outColor;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.55;
    for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.03; a *= 0.52; }
    return v;
  }
  `;

  const FS_SUN = HEAD + `
  void main(){
    vec2 p = v_uv;
    float r = length(p) / 0.45;
    vec2 q = p / 0.45;
    vec3 hot = vec3(1.0, 0.93, 0.78);
    vec3 mid = vec3(1.0, 0.62, 0.22);
    vec3 deep = vec3(0.72, 0.24, 0.05);

    if (r < 1.0) {
      float nz = sqrt(max(0.0, 1.0 - r*r));
      vec2 sp = q / max(0.2, nz);
      float t = u_time * 0.22;
      float g1 = fbm(sp * 4.2 + vec2(t * 0.7, t * 0.25));
      float g2 = fbm(sp * 11.0 - vec2(t * 0.5, t * 1.1));
      float gran = 0.55 * g1 + 0.45 * g2;
      float spots = smoothstep(0.62, 0.86, fbm(sp * 2.1 + 7.0)) * 0.55;
      vec3 c = mix(deep, mid, smoothstep(0.18, 0.75, gran));
      c = mix(c, hot, smoothstep(0.52, 0.92, gran) * (0.65 + 0.35 * nz));
      c *= mix(0.62, 1.0, pow(nz, 0.42));
      c *= (1.0 - spots * smoothstep(0.9, 0.2, r));
      float aa = smoothstep(1.0, 0.965, r);
      outColor = vec4(c * aa, aa);
      return;
    }
    // 日冕：透明叠加，没有黑底
    float d = r - 1.0;
    float ang = atan(q.y, q.x);
    float fil = 0.55 + 0.45 * sin(ang * 13.0 + u_time * 0.5 + fbm(p * 3.0) * 4.0);
    float glow = exp(-d * 3.6) * fil * 1.15 + exp(-d * 1.2) * 0.30;
    vec3 c = mix(vec3(1.0, 0.50, 0.14), vec3(1.0, 0.88, 0.66), exp(-d * 5.0));
    float a = clamp(glow, 0.0, 1.0) * 0.85;
    outColor = vec4(c * a, a);
  }`;

  const FS_BH = HEAD + `
  void main(){
    vec2 p = v_uv;
    float ct = cos(u_tilt), st = sin(u_tilt);
    vec2 q = vec2(p.x * ct - p.y * st, p.x * st + p.y * ct);
    q.y /= 0.30;                       // 倾斜吸积盘
    float r = length(q);
    float ang = atan(q.y, q.x);
    float t = u_time;

    // 暗核
    float core = smoothstep(0.30, 0.245, r);
    // 吸积盘：内缘 0.30，外缘 1.35
    float band = smoothstep(0.30, 0.40, r) * (1.0 - smoothstep(0.55, 1.42, r));
    float streak = fbm(vec2(ang * 2.6 + t * 0.55, log(r + 0.06) * 7.0 - t * 0.20));
    float streak2 = fbm(vec2(ang * 7.0 - t * 0.85, log(r + 0.04) * 15.0));
    float bright = band * (0.32 + 0.95 * pow(streak, 1.6) + 0.5 * pow(streak2, 2.2));
    bright *= smoothstep(0.26, 0.36, r);
    // 多普勒：朝观察者的一侧更亮
    float dop = 0.62 + 0.55 * smoothstep(-1.0, 1.0, sin(ang));
    vec3 warm = vec3(1.0, 0.80, 0.58);
    vec3 cool = vec3(0.62, 0.68, 0.86);
    vec3 c = mix(cool, warm, smoothstep(0.35, 1.0, bright)) * bright * dop;
    c *= mix(vec3(1.0), u_col * 1.7, 0.20);
    // 引力透镜薄环
    float lens = exp(-pow((r - 0.335) / 0.022, 2.0)) * 0.85;
    lens += exp(-pow((r - 1.30) / 0.045, 2.0)) * 0.18;
    c += u_col * lens * 1.4;

    float a = clamp(max(bright * 1.25, lens), 0.0, 1.0);
    a = max(a, core);
    outColor = vec4(c * (1.0 - core), a);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  class NexusGL {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: true, powerPreference: 'high-performance'
      });
      if (!gl) throw new Error('当前环境不支持 WebGL2');
      this.gl = gl;
      this.w = 1; this.h = 1; this.dpr = 1;
      this.sprites = []; this.lines = [];
      this.queue = [];
      this.maxSprites = 40000; this.maxLines = 60000;
      this._init();
      this.fps = 0; this._fpsT = 0; this._fpsN = 0;
    }

    _init() {
      const gl = this.gl;
      this.pSprite = program(gl, VS_SPRITE, FS_SPRITE);
      this.pLine = program(gl, VS_LINE, FS_LINE);
      this.pQuad = program(gl, VS_QUAD, FS_SUN);
      this.pQuad2 = program(gl, VS_QUAD, FS_BH);

      this.quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      // 实例缓冲：pos(2) size(1) col(3) alpha(1) stretch(1) = 8 floats
      this.sprBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sprBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.maxSprites * 8 * 4, gl.DYNAMIC_DRAW);

      this.sprData = new Float32Array(this.maxSprites * 8);

      this.lnBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lnBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.maxLines * 12 * 4, gl.DYNAMIC_DRAW);
      this.lnData = new Float32Array(this.maxLines * 12);

      this.sprVAO = gl.createVertexArray();
      gl.bindVertexArray(this.sprVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sprBuf);
      const stride = 8 * 4;
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0); gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8); gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 12); gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 24); gl.vertexAttribDivisor(4, 1);
      gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 28); gl.vertexAttribDivisor(5, 1);

      this.lnVAO = gl.createVertexArray();
      gl.bindVertexArray(this.lnVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lnBuf);
      // 每个顶点：pos(2) + color(3) + alpha(1) = 6 floats
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 6 * 4, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 6 * 4, 2 * 4);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 6 * 4, 5 * 4);

      this.qVAO = gl.createVertexArray();
      gl.bindVertexArray(this.qVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      this.u = {
        sprite: { res: gl.getUniformLocation(this.pSprite, 'u_res'), glow: gl.getUniformLocation(this.pSprite, 'u_glow') },
        line: { res: gl.getUniformLocation(this.pLine, 'u_res'), glow: gl.getUniformLocation(this.pLine, 'u_glow') },
        quad: {
          rect: gl.getUniformLocation(this.pQuad, 'u_rect'),
          res: gl.getUniformLocation(this.pQuad, 'u_res'),
          time: gl.getUniformLocation(this.pQuad, 'u_time'),
          col: gl.getUniformLocation(this.pQuad, 'u_col'),
          tilt: gl.getUniformLocation(this.pQuad, 'u_tilt')
        },
        quad2: {
          rect: gl.getUniformLocation(this.pQuad2, 'u_rect'),
          res: gl.getUniformLocation(this.pQuad2, 'u_res'),
          time: gl.getUniformLocation(this.pQuad2, 'u_time'),
          col: gl.getUniformLocation(this.pQuad2, 'u_col'),
          tilt: gl.getUniformLocation(this.pQuad2, 'u_tilt')
        }
      };

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
    }

    resize(cssW, cssH, dpr) {
      this.dpr = Math.min(dpr || 1, 1.6);
      this.w = Math.max(1, Math.round(cssW));
      this.h = Math.max(1, Math.round(cssH));
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    begin() {
      this.sprites.length = 0; this.lines.length = 0; this.queue.length = 0;
      this.glow = 1;
      const gl = this.gl;
      gl.clearColor(0.012, 0.02, 0.031, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    sprite(x, y, size, col, alpha, stretch) {
      if (this.sprites.length >= this.maxSprites) return;
      this.sprites.push([x, y, size, col[0], col[1], col[2], alpha, stretch || 1]);
    }

    line(x1, y1, x2, y2, col, alpha) {
      if (this.lines.length >= this.maxLines) return;
      this.lines.push([x1, y1, col[0], col[1], col[2], alpha,
                       x2, y2, col[0], col[1], col[2], alpha]);
    }

    seg(x1, y1, x2, y2, c1, a1, c2, a2) {
      if (this.lines.length >= this.maxLines) return;
      this.lines.push([x1, y1, c1[0], c1[1], c1[2], a1, x2, y2, c2[0], c2[1], c2[2], a2]);
    }

    sun(cx, cy, r, col, t) {
      this.queue.push({ t: 'sun', cx, cy, r, col, time: t });
    }

    blackhole(cx, cy, r, col, t, tilt) {
      this.queue.push({ t: 'bh', cx, cy, r, col, time: t, tilt: tilt || 0.28 });
    }

    _flushBatches() {
      const gl = this.gl;
      if (this.sprites.length) {
        const n = this.sprites.length;
        const d = this.sprData;
        for (let i = 0; i < n; i++) {
          const s = this.sprites[i], o = i * 8;
          d[o] = s[0]; d[o + 1] = s[1]; d[o + 2] = s[2];
          d[o + 3] = s[3]; d[o + 4] = s[4]; d[o + 5] = s[5];
          d[o + 6] = s[6]; d[o + 7] = s[7];
        }
        gl.useProgram(this.pSprite);
        gl.uniform2f(this.u.sprite.res, this.w, this.h);
        gl.uniform1f(this.u.sprite.glow, this.glow);
        gl.bindVertexArray(this.sprVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.sprBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 8);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        this.sprites.length = 0;
      }
      if (this.lines.length) {
        const n = this.lines.length;
        const d = this.lnData;
        for (let i = 0; i < n; i++) {
          const s = this.lines[i], o = i * 12;
          for (let k = 0; k < 12; k++) d[o + k] = s[k];
        }
        gl.useProgram(this.pLine);
        gl.uniform2f(this.u.line.res, this.w, this.h);
        gl.uniform1f(this.u.line.glow, this.glow);
        gl.bindVertexArray(this.lnVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lnBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 12);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.LINES, 0, n * 2);
        this.lines.length = 0;
      }
    }

    end() {
      const gl = this.gl;
      this._flushBatches();
      for (const q of this.queue) {
        if (q.t === 'sun') {
          gl.useProgram(this.pQuad);
          const u = this.u.quad;
          const half = q.r / 0.45;
          gl.uniform4f(u.rect, q.cx - half, q.cy - half, half * 2, half * 2);
          gl.uniform2f(u.res, this.w, this.h);
          gl.uniform1f(u.time, q.time);
          gl.uniform3f(u.col, q.col[0], q.col[1], q.col[2]);
          gl.uniform1f(u.tilt, 0);
        } else {
          gl.useProgram(this.pQuad2);
          const u = this.u.quad2;
          const half = q.r / 0.30;
          gl.uniform4f(u.rect, q.cx - half, q.cy - half, half * 2, half * 2);
          gl.uniform2f(u.res, this.w, this.h);
          gl.uniform1f(u.time, q.time);
          gl.uniform3f(u.col, q.col[0], q.col[1], q.col[2]);
          gl.uniform1f(u.tilt, q.tilt);
        }
        gl.bindVertexArray(this.qVAO);
        // 太阳 / 吸积盘用加法混合；暗核由着色器 alpha 自然压黑
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      this.queue.length = 0;
      gl.bindVertexArray(null);
    }

    countFps(dt) {
      this._fpsN++;
      this._fpsT += dt;
      if (this._fpsT >= 0.5) {
        this.fps = Math.round(this._fpsN / this._fpsT);
        this._fpsT = 0; this._fpsN = 0;
      }
      return this.fps;
    }
  }

  window.NexusGL = NexusGL;
})();
