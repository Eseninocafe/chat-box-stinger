/* receipt-html.js
   Builds the donation receipt from HTML + CSS auto layout (your Figma "Frame 525"), turns it into
   an image, and hands it to ReceiptSim to bend. Edit the CSS below like Figma auto layout.

   Load order: receipt-physics.js, receipt-html.js, paperbag-stinger.js
   Before the first donation:  await ReceiptHTML.init({ fonts, logo, heart, icons })  (all URLs)
*/
(function (global) {
  'use strict';

  /* ---------- Figma auto layout (Frame 525 and children) ---------- */
  const CSS = `
  .r-frame525 { display: flex; flex-direction: column; align-items: center; padding: 24px; gap: 14px;
                width: 265px; box-sizing: border-box; font-family: 'Inter'; font-style: normal; color: #000; }
  .r-logo     { display: block; flex: none; width: 165px; height: 87.9px; }
  .r-dashes   { display: flex; flex-direction: row; justify-content: space-between; align-items: center;
                align-self: stretch; height: 8px; flex: none; }
  .r-dash     { display: block; width: 22px; height: 8px; border-radius: 4px; background: #000; }   /* 14px line + 8px round caps */
  .r-frame529 { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; align-self: stretch; flex: none; }
  .r-chip     { display: flex; flex-direction: row; justify-content: center; align-items: center; gap: 4px;
                align-self: stretch; height: 28px; }
  .r-avatar   { display: block; flex: none; width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
  .r-frame1   { display: flex; flex-direction: row; align-items: center; gap: 2px; flex-grow: 1; min-width: 0; height: 22px; }
  .r-icon     { position: relative; flex: none; width: 18px; height: 18px; }
  .r-icon img { position: absolute; width: 18px; height: 18px; left: 0; top: 0; }   /* the chat box's 18px icons, padding included */
  .r-name     { flex-grow: 1; min-width: 0; font-weight: 700; font-size: 18px; line-height: 22px; white-space: pre; overflow: hidden; }
  .r-frame526 { display: flex; flex-direction: row; justify-content: center; align-items: center; align-self: stretch; height: 29px; }
  .r-amount   { flex-grow: 1; font-weight: 600; font-size: 24px; line-height: 29px; text-align: center; }
  .r-frame527 { display: flex; flex-direction: column; align-items: center; gap: 2px; align-self: stretch; }
  .r-message  { margin: 0; align-self: stretch; font-weight: 600; font-size: 18px; line-height: 22px; text-align: center; white-space: pre; }
  .r-frame528 { display: flex; flex-direction: row; justify-content: center; align-items: center; gap: 8px; height: 22px; flex: none; }
  .r-thanks   { font-weight: 600; font-size: 18px; line-height: 22px; white-space: pre; }
  .r-heart    { display: block; flex: none; width: 25px; height: 23px; margin: -2.28px -2.49px; }      /* stroke hangs outside its 20 x 18.4 box */
  `;

  /* ---------- receipt outline (zigzag paper) around the frame, in px ---------- */
  const SHAPE = {
    width: 273, stroke: 8, teeth: 7, depth: 11,
    frameAbovePeaks: 1.45,          // Frame 525 starts this far above the top zigzag peaks
    peaksBelowFrame: 4.55,          // bottom zigzag peaks sit this far below Frame 525
    contentW: 265,                  // Frame 525 width
  };
  const LIMITS = { rowW: 217, messageW: 217, messageLines: 3 };

  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toDataURL = async src => {
    if (!src) return null;
    if (typeof src !== 'string') src = src.src;                      // an <img>
    if (src.startsWith('data:')) return src;
    const blob = await (await fetch(src)).blob();
    return new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(blob); });
  };

  const measure = document.createElement('canvas').getContext('2d');
  function cut(text, maxW, suffix) {
    let t = text; while (t.length && measure.measureText(t + suffix).width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + suffix;
  }
  function wrap(text, maxW) {
    const lines = []; let line = '';
    for (let w of text.split(/\s+/).filter(Boolean)) {
      while (measure.measureText(w).width > maxW) {                    // a word wider than the line
        let n = w.length; while (n > 1 && measure.measureText(w.slice(0, n)).width > maxW) n--;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, n)); w = w.slice(n);
      }
      const test = line ? line + ' ' + w : w;
      if (line && measure.measureText(test).width > maxW) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  const ReceiptHTML = {
    ready: false,
    toDataURL,   // for prefetching an avatar (build() takes a data URL as is)

    /** opts: { fonts: { 500: url, 600: url, 700: url }, logo: url, heart: url, icons: { twitch: url, youtube: url } } */
    async init(opts) {
      const fonts = {};
      for (const [w, url] of Object.entries(opts.fonts)) {
        fonts[w] = await toDataURL(url);
        const face = new FontFace('Inter', `url(${fonts[w]})`, { weight: String(w) });
        document.fonts.add(await face.load());                        // same font for measuring and drawing
      }
      this.fontCSS = Object.entries(fonts).map(([w, d]) =>
        `@font-face { font-family: 'Inter'; font-weight: ${w}; src: url(${d}) format('woff2'); }`).join('\n');
      this.logo = await toDataURL(opts.logo);
      this.heart = await toDataURL(opts.heart);
      this.icons = {};
      for (const [k, url] of Object.entries(opts.icons || {})) this.icons[k] = await toDataURL(url).catch(() => null);
      this.ready = true;
    },

    /** The receipt's inner HTML for a donation. */
    html(d, avatar) {
      const icon = this.icons[d.platform] || null;                    // no platform (e.g. Anonymous): no icon
      // the viewer's colour (the stinger picks it as the chat box does); only a plain colour gets into the markup
      const color = /^(#[0-9a-f]{3,8}|rgb\([\d\s,.]+\))$/i.test(d.color || '') ? d.color : '#000';
      // name gets what's left of the 217px row after the avatar (28 + 4 gap) and icon (18 + 2 gap)
      measure.font = "700 18px 'Inter'";
      const nameW = LIMITS.rowW - (avatar ? 32 : 0) - (icon ? 20 : 0), raw = d.name || '';
      const name = measure.measureText(raw).width <= nameW ? raw : cut(raw, nameW, '...');
      const msg = (d.message || '').trim();
      let lines = [];
      if (msg) {
        measure.font = "600 18px 'Inter'";
        lines = wrap(`“${msg}”`, LIMITS.messageW);
        if (lines.length > LIMITS.messageLines) {
          lines = lines.slice(0, LIMITS.messageLines);
          lines[lines.length - 1] = cut(lines[lines.length - 1].replace(/”$/, ''), LIMITS.messageW, ' ...”');
        }
      }
      const dashes = `<div class="r-dashes">${'<i class="r-dash"></i>'.repeat(6)}</div>`;
      return `<div class="r-frame525">
  <img class="r-logo" src="${this.logo}"/>
  ${dashes}
  <div class="r-frame529">
    <div class="r-chip">
      ${avatar ? `<img class="r-avatar" src="${avatar}"/>` : ''}
      <div class="r-frame1">${icon ? `<span class="r-icon"><img src="${icon}"/></span>` : ''}<span class="r-name" style="color:${color}">${esc(name)}</span></div>
    </div>
    <div class="r-frame526"><span class="r-amount">${esc(d.amount || '')}</span></div>
    ${lines.length ? `<div class="r-frame527"><p class="r-message">${esc(lines.join('\n'))}</p></div>` : ''}
  </div>
  ${dashes}
  <div class="r-frame528"><span class="r-thanks">THANK YOU</span><img class="r-heart" src="${this.heart}"/></div>
</div>`;
    },

    /**
     * Render a donation to a texture for ReceiptSim: { canvas, top } (top = texture y of the top edge).
     * d: { name, color, amount, message, platform, avatar (url or img) }   resolution: texture px per px
     */
    async build(d, resolution = 2) {
      if (!this.ready) throw new Error('Call ReceiptHTML.init() first');
      const avatar = await toDataURL(d.avatar).catch(() => null);     // the avatar host must allow CORS, otherwise it's left out
      const body = this.html(d, avatar);

      // 1. lay it out in the page to get the auto layout height
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
      probe.innerHTML = `<style>${CSS}</style>${body}`;
      document.body.appendChild(probe);
      await Promise.all([...probe.querySelectorAll('img')].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
      const frameH = probe.querySelector('.r-frame525').getBoundingClientRect().height;
      probe.remove();

      // 2. paper outline + the same HTML in one SVG
      const s = SHAPE, sw = s.stroke, x0 = sw / 2, x1 = s.width - sw / 2, cw = x1 - x0;
      const top = sw / 2, frameTop = top - s.frameAbovePeaks, bottom = frameTop + frameH + s.peaksBelowFrame, H = bottom + sw / 2;
      let p = `M${x0} ${top}`;
      for (let i = 0; i < s.teeth; i++) p += `L${x0 + cw * (i + 0.5) / s.teeth} ${top + s.depth}L${x0 + cw * (i + 1) / s.teeth} ${top}`;
      p += `L${x1} ${bottom}`;
      for (let i = s.teeth - 1; i >= 0; i--) p += `L${x0 + cw * (i + 0.5) / s.teeth} ${bottom - s.depth}L${x0 + cw * i / s.teeth} ${bottom}`;
      p += 'Z';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width * resolution}" height="${H * resolution}" viewBox="0 0 ${s.width} ${H}">
<style>${this.fontCSS}${CSS}</style>
<path d="${p}" fill="#fff" stroke="#000" stroke-width="${sw}" stroke-linejoin="round"/>
<foreignObject x="${(s.width - s.contentW) / 2}" y="${frameTop}" width="${s.contentW}" height="${frameH}">
<div xmlns="http://www.w3.org/1999/xhtml">${body}</div>
</foreignObject></svg>`;

      // 3. SVG → image → canvas
      const img = new Image();
      await new Promise((ok, fail) => { img.onload = ok; img.onerror = () => fail(new Error('Receipt SVG failed to render')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const c = document.createElement('canvas'); c.width = Math.ceil(s.width * resolution); c.height = Math.ceil(H * resolution);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { canvas: c, top: top * resolution };
    },
  };

  global.ReceiptHTML = ReceiptHTML;
})(window);
