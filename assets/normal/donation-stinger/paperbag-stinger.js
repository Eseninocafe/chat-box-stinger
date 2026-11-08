/* paperbag-stinger.js
   The donation paper bag stinger, drawn fully in code at 60 fps: the bag hops, falls, lands,
   squashes and turns into the crumpled bag, then rocks and settles. The normal variant has the
   live receipt (receipt-physics.js) taped on; the compact variant is the bag alone.

   Load receipt-physics.js (and receipt-html.js for the HTML receipt) before this file.
*/
(function (global) {
  'use strict';
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => t * t * (3 - 2 * t);

  /* ---------- bag shapes from Figma, in Group 5's coordinates (Group 4 sits 5.5 px further left) ---------- */
  const TOP = 'M431.508 4H9.5L19.5 92.646H421.508L431.508 4Z';
  const BOTTOM = 'L431.508 479.386C431.508 488.793 427.771 497.815 421.119 504.466C414.468 511.118 405.446 514.855 396.039 514.855H44.969C35.562 514.855 26.5404 511.118 19.8886 504.466C13.2369 497.815 9.5 488.793 9.5 479.386';
  // side points: right side at y 218 / 319.5 / 411.5, left side at y 197 / 297 / 400.5
  // clean = on the straight tapered sides of Group 4, crumpled = Group 5
  const side = (x0, x1, y) => x0 + (x1 - x0) * (y - 92.646) / (479.386 - 92.646);
  const CLEAN = { r: [218, 319.5, 411.5].map(y => side(421.508, 431.508, y)), l: [197, 297, 400.5].map(y => side(19.5, 9.5, y)) };
  const CRUMPLED = { r: [429, 426, 439], l: [9, 14.5, 4] };
  const body = k => {
    const r = i => lerp(CLEAN.r[i], CRUMPLED.r[i], k), l = i => lerp(CLEAN.l[i], CRUMPLED.l[i], k);
    return `M19.5 92.646H421.508L${r(0)} 218L${r(1)} 319.5L${r(2)} 411.5${BOTTOM}L${l(2)} 400.5L${l(1)} 297L${l(0)} 197Z`;
  };
  const CREASES = [
    [[49.5, 338], [82.9, 283.2], [68, 236.5]],
    [[345, 385], [370.3, 338.4], [401.5, 358]],
    [[58, 421.5], [83, 447.5]],
    [[179.5, 468], [233.4, 421.6], [294, 447.5]],
  ];
  const PIVOT = { x: 220.504, y: 514.855 };       // bottom centre of the bag
  const BAG_W = 422;

  // squash after landing (seconds after impact → amount; 1 = squashed, negative = stretched)
  const SQUASH = [[0, 0], [0.033, 1], [0.1, -0.07], [0.167, 0.05], [0.25, 0]];
  function keyed(keys, t) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return lerp(v0, v1, ease((t - t0) / (t1 - t0)));
    }
    return keys[keys.length - 1][1];
  }

  class PaperBagStinger {
    /**
     * canvas: the canvas to draw into (its size is set to the frame size × devicePixelRatio)
     * opts:   size (frame px, 596), x / y (where Group 3's top-left sits when resting: 77.5, 76),
     *         drop (px above resting height at the start, null = as high as fits in frame),
     *         hop (px it first jumps up), tilt (degrees, 0 = lands flat),
     *         gravity (px/s²), duration (s), stroke (px), squashX / squashY (amount at full squash),
     *         receipt: options passed on to ReceiptSim
     */
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.o = Object.assign({ size: 596, x: 77.5, y: 76, drop: null, hop: 22, tilt: 0, gravity: 1913, duration: 2.4,
        stroke: 8, squashX: 0.05, squashY: 0.08, receipt: {} }, opts);
      const o = this.o;
      if (o.drop == null) o.drop = Math.max(0, o.y - o.stroke / 2 - 2 - o.hop);   // highest start where the hop stays in frame
      this.v0 = Math.sqrt(2 * o.gravity * o.hop);                     // upward speed for the hop
      this.tPeak = this.v0 / o.gravity;
      this.tImpact = (this.v0 + Math.sqrt(this.v0 * this.v0 + 2 * o.gravity * o.drop)) / o.gravity;
      const dpr = global.devicePixelRatio || 1;
      canvas.width = o.size * dpr; canvas.height = o.size * dpr;
      this.ctx = canvas.getContext('2d'); this.dpr = dpr;
    }

    /** Bag pose at time t (seconds). */
    state(t) {
      const o = this.o, g = o.gravity, th0 = o.tilt * Math.PI / 180;
      let off, tilt, sq, crumple, crease;
      if (t < this.tImpact) {
        off = -o.drop - this.v0 * t + 0.5 * g * t * t;
        tilt = th0;
        sq = t > this.tPeak ? -0.15 * (t - this.tPeak) / (this.tImpact - this.tPeak) : 0;   // stretch while falling
        crumple = 0; crease = 0;
      } else {
        const s = t - this.tImpact;
        off = 0;
        tilt = th0 * Math.exp(-6 * s) * Math.cos(13 * s);              // rocks onto the other side and settles
        sq = keyed(SQUASH, s);
        crumple = ease(clamp(s / 0.08, 0, 1));
        crease = clamp(s / 0.05, 0, 1);                                 // creases snap in within 3 frames
      }
      const lift = BAG_W / 2 * Math.sin(Math.abs(tilt));              // a tilted bag stands on its corner
      return { off, tilt, sx: 1 + o.squashX * sq, sy: 1 - o.squashY * sq, crumple, crease, lift };
    }

    /** Matrix from bag coordinates to frame pixels. */
    matrix(st) {
      const o = this.o;
      return new DOMMatrix()
        .translate(o.x + PIVOT.x, o.y + PIVOT.y + st.off - st.lift)
        .rotate(st.tilt * 180 / Math.PI)
        .scale(st.sx, st.sy)
        .translate(-PIVOT.x, -PIVOT.y);
    }

    /** Receipt track for ReceiptSim, sampled at 60 fps from the bag animation. */
    track() {
      const frames = [], n = Math.ceil(this.o.duration * 60);
      for (let i = 0; i <= n; i++) {
        const m = this.matrix(this.state(i / 60));
        const P = (x, y) => { const p = m.transformPoint({ x, y }); return [+p.x.toFixed(2), +p.y.toFixed(2)]; };
        // receipt top edge (tape line) and a row lower down the face; 273 px wide
        frames.push([[...P(220 - 136.5, 127.4), ...P(220 + 136.5, 127.4)], [...P(220 - 136.5, 485), ...P(220 + 136.5, 485)]]);
      }
      // falling speed of the bag itself (not the squash or rock), so the receipt only catches air while airborne
      const speed = Array.from({ length: n + 1 }, (_, i) => { const t = i / 60; return t < this.tImpact ? -this.v0 + this.o.gravity * t : 0; });
      return { w: this.o.size, h: this.o.size, fps: 60, gravity: this.o.gravity, floorY: this.o.y + PIVOT.y, frames, speed };
    }

    drawBag(st) {
      const ctx = this.ctx, m = this.matrix(st), o = this.o;
      const shape = d => { const p = new Path2D(); p.addPath(new Path2D(d), m); return p; };   // transform the shape, not the stroke
      ctx.lineWidth = o.stroke; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
      for (const d of [body(st.crumple), TOP]) { const p = shape(d); ctx.fill(p); ctx.stroke(p); }
      if (st.crease > 0) {                                              // crease lines draw on after the landing
        ctx.beginPath();
        for (const line of CREASES) {
          const pts = line.map(([x, y]) => m.transformPoint({ x, y }));
          const segs = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
          let left = segs.reduce((a, b) => a + b, 0) * st.crease;
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 0; i < segs.length && left > 0; i++) {
            const k = Math.min(1, left / segs[i]);
            ctx.lineTo(lerp(pts[i].x, pts[i + 1].x, k), lerp(pts[i].y, pts[i + 1].y, k));
            left -= segs[i];
          }
        }
        ctx.stroke();
      }
    }

    /**
     * Play once. donation = receipt data ({ name, amount, message, platform, logo, avatar, platformIcon })
     * for the normal variant, or null for the compact one. opts: { speed }. Resolves when finished.
     */
    async play(donation, { speed = 1 } = {}) {
      this.stop();
      let sim = null;
      if (donation) {
        // receipt from the HTML/CSS auto layout when ReceiptHTML is set up, otherwise drawn on canvas
        const texture = global.ReceiptHTML && global.ReceiptHTML.ready ? await global.ReceiptHTML.build(donation) : undefined;
        sim = new global.ReceiptSim(this.track(), donation, Object.assign({ stroke: this.o.stroke, texture }, this.o.receipt));
      }
      const ctx = this.ctx, last = Math.ceil(this.o.duration * 60);
      return new Promise(done => {
        let t0 = null;
        const tick = now => {
          if (t0 === null) t0 = now;
          const frame = Math.min(last, Math.floor((now - t0) / 1000 * 60 * speed));   // bag and receipt use the same frame
          ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.o.size, this.o.size);
          this.drawBag(this.state(frame / 60));
          if (sim) { sim.step(frame); sim.draw(ctx); }
          if (frame < last) this.raf = requestAnimationFrame(tick); else { this.raf = null; done(); }
        };
        this.raf = requestAnimationFrame(tick);
      });
    }

    stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }

    /** Wipe the canvas (e.g. when the stinger is done). */
    clear() { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  }

  global.PaperBagStinger = PaperBagStinger;
})(window);
