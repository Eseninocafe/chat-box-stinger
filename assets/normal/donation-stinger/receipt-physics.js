/* receipt-physics.js
   Donation receipt taped to the paper bag stinger.
   Blender exports a "rail": where the receipt lies on the bag face, every frame (fall, squash, curve).
   The receipt is drawn live onto a strip that bends toward the camera: a little while the bag
   falls, slapped flat on landing, then settling straight down. No libraries needed.
*/
(function (global) {
  'use strict';
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ===================== receipt texture =====================
     Measured from the Figma frame (596 × 596 render). Design units = render px when the
     receipt is 273 px wide outside the stroke (265 at the stroke centre + 8 stroke).          */
  const D = {
    outerW: 273, tooth: { pitch: 37.86, depth: 10.7 },
    logo: { top: 29.9, h: 73.1 },                                  // logo exported from Figma incl. its 8px strokes
    dash: { len: 14, pitch: 38.98, count: 6 },
    dash1: 129.3,
    name: { baseline: 168.5, size: 18, avatar: 28, icon: { w: 14, h: 16 }, gapAvatar: 8, gapIcon: 4, maxW: 210 },
    amount: { baseline: 206.2, size: 24 },
    message: { baseline: 237.7, size: 18, lineH: 22, maxW: 210 },
    dash2AfterText: 22.6, thanksAfterDash: 36.2,
    thanks: { size: 18 },
    bottomAfterThanks: 22.6,
  };
  const WEIGHTS = { name: 700, amount: 600, message: 600, thanks: 500 };

  function wrapLines(ctx, text, maxW) {
    const words = text.split(/\s+/).filter(Boolean), lines = [];
    let line = '';
    for (let w of words) {
      while (ctx.measureText(w).width > maxW) {                 // a single word wider than a line
        let cut = w.length; while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxW) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, cut)); w = w.slice(cut);
      }
      const test = line ? line + ' ' + w : w;
      if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  // shorten text until text + suffix fits
  function cut(ctx, text, maxW, suffix) {
    let t = text; while (t.length && ctx.measureText(t + suffix).width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + suffix;
  }
  const ellipsize = (ctx, text, maxW) => ctx.measureText(text).width <= maxW ? text : cut(ctx, text, maxW, '...');
  // heart icon from Figma (Vector 30): path box 2..22 × 2..20.44, 4 px stroke
  const HEART = 'M7.05937 2C9.85581 2 10.9396 2.87095 11.68 5.33894C11.8406 5.87408 12.8036 5.86566 12.9741 5.33359C13.7687 2.85349 15.0573 2.00004 17.1781 2C20.214 1.99994 22.2377 3.94891 22.0128 8.1462C21.788 12.3435 15.2668 20.4386 12.1187 20.4386C8.97069 20.4386 1.99967 12.044 2 8.1462C2.00022 4.24844 4.69855 2 7.05937 2Z';

  /**
   * data: { name, amount, message, platform: 'twitch'|'youtube', logo, avatar, platformIcon }  (loaded images, all optional)
   * opts: { width: outer width in texture px, stroke: texture px, font, weights, maxLines, maxHeight, minTextScale,
   *         bottomEdge: 'flat' | 'zigzag' }
   */
  function drawReceipt(data, opts) {
    const u = opts.width / D.outerW, sw = opts.stroke, font = opts.font || '"Inter", system-ui, sans-serif';
    const wt = Object.assign({}, WEIGHTS, opts.weights);
    const F = (k, size) => `${wt[k]} ${size * u}px ${font}`;
    const m = document.createElement('canvas').getContext('2d');

    // message lines (shrink, then cut, only if a maxHeight is given)
    const fixed = D.message.baseline + D.dash2AfterText + D.thanksAfterDash + D.bottomAfterThanks + D.tooth.depth;
    const maxH = (opts.maxHeight || Infinity) / u, minScale = opts.minTextScale || 0.75;
    let ms = 1, lines;
    for (;;) {
      m.font = F('message', D.message.size * ms);
      const msg = (data.message || '').trim();
      lines = msg ? wrapLines(m, `“${msg}”`, D.message.maxW * u) : [];   // no message: no quotes, no lines
      if (fixed + (lines.length - 1) * D.message.lineH * ms <= maxH || ms <= minScale) break;
      ms = Math.max(minScale, ms - 0.05);
    }
    const fitLines = Math.max(1, Math.floor((maxH - fixed) / (D.message.lineH * ms)) + 1);
    const maxLines = Math.min(fitLines, opts.maxLines || Infinity);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = cut(m, lines[maxLines - 1], D.message.maxW * u, ' ...”'); }

    const lineH = D.message.lineH * ms;
    const lastBase = lines.length ? D.message.baseline + (lines.length - 1) * lineH : D.amount.baseline;   // no message: dashes follow the amount
    const dash2 = lastBase + D.dash2AfterText, thanksBase = dash2 + D.thanksAfterDash;
    const flatEnd = opts.bottomEdge !== 'zigzag';                   // straight cut at the end (default) or torn zigzag
    const bottomValley = thanksBase + D.bottomAfterThanks, bottomPeak = flatEnd ? thanksBase + 26 : bottomValley + D.tooth.depth;

    const oy = sw / 2 + 1;                                         // room for the stroke above the top peaks
    const W = Math.ceil(opts.width), H = Math.ceil(bottomPeak * u + oy + sw / 2 + 1);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.translate(0, oy); g.lineJoin = 'round'; g.lineCap = 'round';
    const Y = v => v * u;

    // paper with zigzag top (peaks on the edge line) and bottom
    const x0 = sw / 2, x1 = W - sw / 2, cw = x1 - x0, n = Math.max(3, Math.round(cw / (D.tooth.pitch * u))), dep = D.tooth.depth * u;
    g.beginPath(); g.moveTo(x0, 0);
    for (let i = 0; i < n; i++) { g.lineTo(x0 + cw * (i + 0.5) / n, dep); g.lineTo(x0 + cw * (i + 1) / n, 0); }
    const by = Y(bottomPeak);
    g.lineTo(x1, by);
    if (flatEnd) g.lineTo(x0, by);
    else for (let i = n - 1; i >= 0; i--) { g.lineTo(x0 + cw * (i + 0.5) / n, by - dep); g.lineTo(x0 + cw * i / n, by); }
    g.closePath(); g.fillStyle = '#fff'; g.fill(); g.lineWidth = sw; g.strokeStyle = '#000'; g.stroke();

    const cx = W / 2;
    if (data.logo) { const lh = Y(D.logo.h), lw = lh * data.logo.width / data.logo.height; g.drawImage(data.logo, cx - lw / 2, Y(D.logo.top), lw, lh); }

    const dashes = yy => {
      const span = (D.dash.count - 1) * D.dash.pitch + D.dash.len, sx = cx - span * u / 2;
      g.lineWidth = sw; g.beginPath();
      for (let i = 0; i < D.dash.count; i++) { const x = sx + i * D.dash.pitch * u; g.moveTo(x, Y(yy)); g.lineTo(x + D.dash.len * u, Y(yy)); }
      g.stroke();
    };
    dashes(D.dash1); dashes(dash2);

    // avatar + platform icon + name, centred as one row
    const N = D.name, av = data.avatar ? N.avatar * u : 0, icW = data.platformIcon ? N.icon.w * u : 0, icH = N.icon.h * u;
    const ga = av ? N.gapAvatar * u : 0, gi = icW ? N.gapIcon * u : 0;
    g.font = F('name', N.size);
    const name = ellipsize(g, data.name || '', N.maxW * u - av - ga - icW - gi), nw = g.measureText(name).width;
    const capMid = Y(N.baseline) - 0.36 * N.size * u;              // middle of the capitals
    let rx = cx - (av + ga + icW + gi + nw) / 2;
    if (av) { g.save(); g.beginPath(); g.arc(rx + av / 2, capMid, av / 2, 0, Math.PI * 2); g.clip(); g.drawImage(data.avatar, rx, capMid - av / 2, av, av); g.restore(); rx += av + ga; }
    if (icW) { g.drawImage(data.platformIcon, rx, capMid - icH / 2, icW, icH); rx += icW + gi; }
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.fillStyle = data.platform === 'youtube' ? '#FF0033' : '#9146FF'; g.fillText(name, rx, Y(N.baseline));

    g.fillStyle = '#000'; g.textAlign = 'center';
    g.font = F('amount', D.amount.size); g.fillText(data.amount || '', cx, Y(D.amount.baseline));
    g.font = F('message', D.message.size * ms); lines.forEach((l, i) => g.fillText(l, cx, Y(D.message.baseline + i * lineH)));

    g.font = F('thanks', D.thanks.size);
    const tw = g.measureText('THANK YOU').width, hw = 20 * u, gap = 11.9 * u, tx = cx - (tw + gap + hw) / 2;
    g.textAlign = 'left'; g.fillText('THANK YOU', tx, Y(thanksBase));
    g.save(); g.translate(tx + tw + gap - 2 * u, Y(thanksBase) - 16.4 * u); g.scale(u, u);
    const hp = new Path2D(HEART); g.fillStyle = '#FF4D62'; g.fill(hp); g.lineWidth = sw / 2 / u; g.stroke(hp); g.restore();

    return { canvas: c, top: oy };                                  // top = texture y of the receipt's top edge
  }

  /* ===================== tracked rail ===================== */
  // rows of [lx, ly, rx, ry] per Blender frame, interpolated between frames
  function railAt(track, f) {
    const fr = track.frames, i = clamp(Math.floor(f), 0, fr.length - 1), j = Math.min(fr.length - 1, i + 1), t = clamp(f - i, 0, 1);
    return fr[i].map((a, k) => {
      const [lx, ly, rx, ry] = a.map((v, n) => lerp(v, fr[j][k][n], t));
      return { x: (lx + rx) / 2, y: (ly + ry) / 2, hw: Math.hypot(rx - lx, ry - ly) / 2, ang: Math.atan2(ry - ly, rx - lx) };
    });
  }

  /* ===================== motion =====================
     The receipt's bend is one damped spring: "curl" = how far its bottom lifts toward the camera.
     Falling, the air lifts it a little; landing slaps it back against the bag with a tiny rebound;
     then it settles at exactly straight down. On screen, lift shows as the paper getting shorter
     and slightly wider at the bottom (like the first 3D demo).                                      */
  class ReceiptSim {
    /**
     * track: bag track (rows of [lx, ly, rx, ry] per frame, fps)   data: receipt content (see drawReceipt)
     * opts:  stroke    line thickness in px (8)
     *        air       curl (radians) the air gives while falling at 1000 px/s (0.9)
     *        slap      how hard the landing pushes it back against the bag (0.008)
     *        bounce    rebound when it hits the bag (0..1, 0.2)
     *        wobble    flap speed in Hz (2)          settle  damping (0..1, higher = settles sooner; 0.6)
     *        maxCurl   most it may lift, degrees (45)
     *        perspective  extra width per px of lift   pitch  camera tilt in radians (how much lift shows)
     *        maxLines  message lines before "..." (3)    bottomEdge 'zigzag' | 'flat'
     *        tape { w, h, angle, offsetX, offsetY } in design px (offsetY: below the top edge)   font, weights, resolution
     *        texture   { canvas, top } to use instead of drawing the receipt here (ReceiptHTML.build gives one)
     */
    constructor(track, data, opts = {}) {
      this.track = track;
      this.o = Object.assign({ stroke: 8, air: 0.9, slap: 0.008, bounce: 0.2, wobble: 2, settle: 0.6, maxCurl: 45,
        perspective: 0.0018, pitch: 0.3, segment: 6, maxLines: 3, bottomEdge: 'zigzag', maxLength: Infinity, minTextScale: 0.75,
        tape: { w: 27.9, h: 46, angle: 15, offsetX: 0, offsetY: 3 }, resolution: 2, font: undefined, weights: undefined }, opts);
      const top0 = railAt(track, 0)[0];
      this.width = top0.hw * 2; this.u = this.width / D.outerW;      // receipt outer width = rail width
      const res = this.o.resolution;
      // texture: ready-made (e.g. from ReceiptHTML) or drawn here on canvas
      const tex = this.o.texture || drawReceipt(data, { width: this.width * res, stroke: this.o.stroke * res, font: this.o.font, weights: this.o.weights,
        maxLines: this.o.maxLines, bottomEdge: this.o.bottomEdge, maxHeight: this.o.maxLength * res, minTextScale: this.o.minTextScale });
      this.texture = tex.canvas; this.texTop = tex.top;
      this.length = (this.texture.height - this.texTop) / res;
      const t = this.o.tape;
      this.pinLength = (t.h / 2 * Math.cos(t.angle * Math.PI / 180) + t.w / 2 * Math.sin(t.angle * Math.PI / 180)) * this.u;
      this.n = Math.max(2, Math.ceil(this.length / this.o.segment)); this.seg = this.length / this.n;
      this.reset();
    }

    anchor(f) { const t = railAt(this.track, f)[0]; return { x: t.x, y: t.y, ang: t.ang, hw: t.hw }; }

    reset() { this.c = 0; this.cv = 0; this.frame = 0; this.vy = 0; this.vyS = 0; this.acc = 0; }

    _sub(f, dt) {
      const o = this.o, w = 2 * Math.PI * o.wobble, k = w * w, d = 2 * o.settle * w;
      // bag's falling speed, px/s (down = +). The stinger provides it (0 once landed); otherwise estimate it
      let vy;
      if (this.track.speed) { const sp = this.track.speed, i = clamp(Math.floor(f), 0, sp.length - 1), j = Math.min(sp.length - 1, i + 1); vy = lerp(sp[i], sp[j], clamp(f - i, 0, 1)); }
      else vy = (this.anchor(f).y - this.anchor(Math.max(0, f - this.dtF)).y) / dt;
      const vyS = this.track.speed ? vy : this.vyS + (vy - this.vyS) * 0.5;
      const ay = (vyS - this.vyS) / dt; this.vyS = vyS;
      const airGain = o.air * k / 1000;
      // spring back to straight, damping, air lift while falling, landing pushes it flat
      const acc = -k * this.c - d * this.cv + airGain * Math.max(0, vyS) + o.slap * ay;
      this.cv += acc * dt; this.c += this.cv * dt;
      if (this.c < 0) { this.c = 0; this.cv = -this.cv * o.bounce; } // hits the bag: small rebound
      const max = o.maxCurl * Math.PI / 180;
      if (this.c > max) { this.c = max; this.cv = Math.min(0, this.cv); }
    }

    /** Advance to frame f of the track. Pass the same whole frame number as the bag you show. */
    step(f) {
      const fps = this.track.fps || 60, dt = 1 / 60;
      if (f < this.frame) this.reset();
      this.acc += (f - this.frame) / fps;
      this.dtF = dt * fps;
      while (this.acc >= dt - 1e-9) { this.frame += this.dtF; this._sub(Math.min(f, this.frame), dt); this.acc -= dt; }
      this.frame = f;
    }

    /** Draw receipt and tape. ctx must be in frame pixels. */
    draw(ctx) {
      const a = this.anchor(this.frame), o = this.o, r = o.resolution, T = this.texture, n = this.n;
      const dx = -Math.sin(a.ang), dy = Math.cos(a.ang), ex = Math.cos(a.ang), ey = Math.sin(a.ang);   // down / across the bag
      const sp = Math.sin(o.pitch), free = Math.max(1, this.length - this.pinLength);
      const L = [], R = [];
      let y = 0, z = 0;
      for (let i = 0; i <= n; i++) {
        if (i) {                                                       // walk down the paper, bending more toward the bottom
          const s = (i - 0.5) * this.seg, phi = this.c * Math.pow(Math.max(0, (s - this.pinLength) / free), 1.5);
          y += Math.cos(phi) * this.seg; z += Math.sin(phi) * this.seg;
        }
        const along = y + z * sp, hw = a.hw * (1 + o.perspective * z);     // flat paper keeps its full length
        const cx = a.x + dx * along, cy = a.y + dy * along;
        L.push({ x: cx - ex * hw, y: cy - ey * hw }); R.push({ x: cx + ex * hw, y: cy + ey * hw });
      }
      // extend the first/last slice so the stroke above the top edge and below the end is drawn too
      const grow = (i, j, px) => { const vx = L[i].x - L[j].x, vy = L[i].y - L[j].y, dd = Math.hypot(vx, vy) || 1, kk = px / dd;
        L[i] = { x: L[i].x + vx * kk, y: L[i].y + vy * kk }; R[i] = { x: R[i].x + vx * kk, y: R[i].y + vy * kk }; };
      grow(0, 1, this.texTop / r);
      grow(n, n - 1, (T.height - this.texTop - n * this.seg * r) / r);
      const v = i => i === 0 ? 0 : i === n ? T.height : this.texTop + i * this.seg * r;
      for (let i = 0; i < n; i++) quad(ctx, T, L[i], R[i], R[i + 1], L[i + 1], v(i), v(i + 1));
      // tape: stuck to the bag, centred on the receipt's top edge
      const t = o.tape, u = this.u;
      const ty = (t.offsetY || 0) * u;
      ctx.save(); ctx.translate(a.x + ex * t.offsetX * u + dx * ty, a.y + ey * t.offsetX * u + dy * ty); ctx.rotate(a.ang + t.angle * Math.PI / 180);
      ctx.beginPath(); roundRect(ctx, -t.w * u / 2, -t.h * u / 2, t.w * u, t.h * u, 1.5 * u);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = o.stroke; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000'; ctx.stroke();
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // one horizontal slice of the texture (rows v0..v1) drawn into the quad tl, tr, br, bl.
  // The slice is mapped with an affine transform (average of its two corner triangles) and clipped
  // to the quad grown by 0.7 px on every side, so neighbouring slices overlap and no seams show.
  function quad(ctx, img, tl, tr, br, bl, v0, v1) {
    const W = img.width, h = v1 - v0;
    if (h <= 0) return;
    const ax = (tr.x - tl.x + br.x - bl.x) / 2 / W, ay = (tr.y - tl.y + br.y - bl.y) / 2 / W;   // texture x axis
    const bx = (bl.x - tl.x + br.x - tr.x) / 2 / h, by = (bl.y - tl.y + br.y - tr.y) / 2 / h;   // texture y axis
    const ox = (tl.x + tr.x + br.x + bl.x) / 4 - ax * W / 2 - bx * (v0 + h / 2);
    const oy = (tl.y + tr.y + br.y + bl.y) / 4 - ay * W / 2 - by * (v0 + h / 2);
    const cx = (tl.x + tr.x + br.x + bl.x) / 4, cy = (tl.y + tr.y + br.y + bl.y) / 4, e = 0.7;
    const g = p => { const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1, ux = (tr.x - tl.x), uy = (tr.y - tl.y), ul = Math.hypot(ux, uy) || 1;
      const along = (dx * ux + dy * uy) / ul, sA = Math.sign(along), across = (dx * -uy + dy * ux) / ul, sC = Math.sign(across);
      return { x: p.x + (ux / ul) * sA * e + (-uy / ul) * sC * e, y: p.y + (uy / ul) * sA * e + (ux / ul) * sC * e }; };
    const a = g(tl), b = g(tr), c = g(br), d = g(bl);
    ctx.save(); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.clip();
    ctx.transform(ax, ay, bx, by, ox, oy); ctx.drawImage(img, 0, v0 - 2, W, h + 4, 0, v0 - 2, W, h + 4); ctx.restore();
  }

  global.ReceiptSim = ReceiptSim;
  global.drawReceipt = drawReceipt;
})(window);
