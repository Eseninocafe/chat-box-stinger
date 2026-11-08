'use strict';
/* =========================================================================
   Eseninocafe multichat stingers
   - tip-jar stinger : intro + persistent bit gems + arc bit throws
   - sub-stinger     : full-screen frame sequence @ 25fps
   - donation-stinger: same player — the paper bag, for Streamlabs donations,
                       StreamElements tips and YouTube Super Chats (cheers go to the
                       tip jar; YouTube memberships to the sub stinger). compact: Blender
                       frames; normal: drawn live in code with the donation's receipt
                       taped on (assets/normal/donation-stinger)
   - raid-bell       : same player — the bell's intro, then one click per raider
                       (up to CFG.raidMaxClicks)
   Trigger API: window.stinger  (also driven live by Streamer.bot, see bottom)

   Two variants, picked in index.html from the browser-source size:
   - compact (400x400): falling-jar intro, SVG-frame sub stinger, raid bell
                        animated in Blender (fill added at load)
   - normal  (596x596): static jar and raid bell that fade in, webm sub stinger,
                        ground, throw arcs drawn on the jar art; the bell is two
                        parts and its button is pressed in code
   Both use the v7 physics prototype's gem-outline bodies and thick walls.
   ========================================================================= */

const { Engine, Bodies, Body, Composite, Sleeping } = Matter;

/* ---------------- config ---------------- */
const CFG = {
  fps: 25,                 // frame sequences play at 25fps
  gemSize: 72,             // settled gem size (design-space px, scaled via MAP)
  defaultBits: 20,         // demo fill amount
  maxJarGems: 30,          // physical jar capacity — oldest gems culled beyond this
  maxQueuedThrows: 40,     // big cheers get clamped to this many visible throws
  throwDurationMs: 780,    // full flight time along the arc
  throwStaggerMs: 170,     // gap between queued throws
  physicsHandoff: 0.8,     // fraction of the flight where physics takes over
  outsideTTLMs: 3200,      // gems that land outside the jar rest, then fade away
  outsideFadeMs: 700,
  noteDurationMs: 850,     
  noteOverlapThreshold: 0.3, // 0.6 means previous note is 60% done before next spawns
  // cheer(amount) decomposes the cheered bits into gem throws, biggest tier
  // first: one gem per full `min` of that tier, remainder flows down.
  // Each gray gem represents ~10 bits so the jar isn't flooded with tiny throws.
  bitTiers: [
    { min: 10000, gem: 'red'    },
    { min: 5000,  gem: 'blue'   },
    { min: 1000,  gem: 'green'  },
    { min: 100,   gem: 'purple' },
    { min: 10,    gem: 'gray'   },
  ],
  // merge ratios when jar overflows — N gems of color become 1 of the next tier
  mergeUp: [
    { from: 'gray',   to: 'purple', count: 10 },
    { from: 'purple', to: 'green',  count: 10 },
    { from: 'green',  to: 'blue',   count: 5  },
    { from: 'blue',   to: 'red',    count: 2  },
  ],
  storageKey: 'eseninocafe.tipjar.bits',
  subFrames: 65,
  waitBeforeFadeMs: 800,
  fadeOutMs: 400,
  subFadeInMs: 250,        // sub/dono/raid stinger eases in instead of popping
  raidMaxClicks: 10,       // the raid bell clicks once per raider, at most this many times
  raidPauseFrames: 8,      // the bell rests this many frames (0.32s at 25fps) before the first click
  raidNoteFrame: 3,        // which frame of each click (0-6) sends up its music note: 3 = button fully down
  // gem bodies and walls (the v7 physics prototype's model, both variants)
  gemBounds: 0.85,         // gem body = the sprite's stroke outline scaled by this
  wallThick: { compact: 20, normal: 28 },   // jar wall bodies grow this far inward from the drawn line (px)
  // normal variant only
  jarFadeInMs: 400,        // the static jar fades in over this (compact fades over its first 3 fall frames)
  noteScale: 0.7,          // music-note size; 0.7 matches compact's notes relative to the canvas
};

const NORMAL = window.VARIANT === 'normal';
const A = `assets/${NORMAL ? 'normal' : 'compact'}`;
// normal has one static jar frame; it's both the back and the front (multiply) pass, see loop()
const TIP_FILL   = NORMAL ? ()=>`${A}/tip-jar-stinger/tip-jar.svg` : i => `${A}/tip-jar-stinger/fill/tip-jar.${pad2(i)}.svg`;
const TIP_STROKE = NORMAL ? TIP_FILL : i => `${A}/tip-jar-stinger/stroke/tip-jar.${pad2(i)}.svg`;
const SUB_FRAME  = i => `${A}/sub-stinger/sub-stinger.${pad2(i)}.svg`;
const SUB_VIDEO  = `${A}/sub-stinger/sub-stinger-animation.webm`;
const RAID_INTRO = `${A}/raid-bell-stinger/intro.svg`;     // compact: Blender animations
const RAID_CLICK = `${A}/raid-bell-stinger/click.svg`;
const RAID_BODY   = `${A}/raid-bell-stinger/bell-body.svg`;    // normal: two filled parts
const RAID_BUTTON = `${A}/raid-bell-stinger/bell-button.svg`;
const DONO_DIR   = `${A}/donation-stinger`;
const DONO_SVG   = `${DONO_DIR}/paper-bag-stinger.svg`;   // compact: the paper bag's frames, for donations/tips
const NOTE_URLS  = [`${A}/music-eighth-note.svg`, `${A}/music-quaver-note.svg`];
const GEM_COLORS = ['red','blue','green','purple','gray'];
const GEM_URLS = GEM_COLORS.map(c => NORMAL ? `assets/gems/bit-${c}.svg` : `${A}/bit-${c}.svg`);
let gemByColor = {};   // color -> loaded image, filled in loadAssets

const collision = window.TIPJAR_COLLISION;
const W = collision.meta.sourceWidth, H = collision.meta.sourceHeight;

/* ---- design-space mapping ----
   The throw arcs, note arcs, gem and sub-stinger sizes were authored in the
   original 500x650 mocks (bit-throw-structure.svg / music-effect.svg). The
   animation canvas can change (now 400x400) — everything is anchored to the
   jar's final backBox, so the authored geometry follows the art automatically. */
const DESIGN = { bbBottomCenter:[252.25, 324.285], bbW:340.9, subBottomY:650, noteStartY:254 };
// design space laid over a box (canvas px): spanning its width, the note arcs starting
// at its top — as in the v7 prototype. Used for the front-on jar and the raid bell.
const overBox = b => { const s = b.w/DESIGN.bbW;
  return { s, dx: b.x + b.w/2 - DESIGN.bbBottomCenter[0]*s, dy: b.y - DESIGN.noteStartY*s }; };
const MAP = (()=>{
  const last = collision.frames[collision.frames.length-1], bb = last.backBox;
  if(!bb){
    // no back box (the front-on normal jar): over the walls' box
    const pts = last.wallSegments.flat();
    const minX = Math.min(...pts.map(p=>p[0]))*W, maxX = Math.max(...pts.map(p=>p[0]))*W;
    return overBox({ x: minX, y: Math.min(...pts.map(p=>p[1]))*H, w: maxX-minX });
  }
  const s = (bb.w*W)/DESIGN.bbW;
  return { s,
    dx: bb.cx*W - DESIGN.bbBottomCenter[0]*s,
    dy: (bb.cy+bb.h/2)*H - DESIGN.bbBottomCenter[1]*s };
})();
const mapPt = p => [p[0]*MAP.s+MAP.dx, p[1]*MAP.s+MAP.dy];

let GEM = NORMAL ? CFG.gemSize : Math.round(CFG.gemSize*MAP.s);
const BODY = CFG.gemBounds;   // physics body size as a fraction of GEM

// wall bodies fill the band from the drawn line to WALL_T inside it
const WALL_T = CFG.wallThick[NORMAL ? 'normal' : 'compact'];
const LIVE = { frictionAir:.002, restitution:.15 };

/* =========================================================================
   Bit-throw geometry (from bit-throw-structure.svg, 500x650 space)

   Bits spawn one by one on a front "camera-near" arc at the bottom, fly a
   cubic bezier up over the rim and into the jar mouth, shrinking from
   near-camera size down to GEM at the mouth. Three reference curves were
   drawn (left / center / right); everything in between is interpolated
   with a quadratic Lagrange basis over u ∈ [0,1] (0=left, 0.5=center, 1=right).
   ========================================================================= */
const THROW = {
  spawn: { x0:81.5, x1:412.5, yEdge:491.264, sag:527 - 491.264 },
  // sample values at u = 0, 0.5, 1
  mouthX:    [227, 249.5, 267.5],
  mouthY:    326.5,
  ctrlSpawn: [[105,152.499],[249.5,211.5],[389.5,152.499]], // control near spawn
  ctrlMouth: [[201.5,101.5],[251,47.5002],[293,101.5]],     // control near mouth
  sizeEdge: 124, sizeCenter: 134,  // near-camera bit size at arc edge / center
  shrinkEnd: 0.75,                 // fraction of flight where size reaches GEM
};

// music-note arcs (from music-effect.svg, design space): notes float up-outward.
// noteArcs(m) places them with a design-space -> canvas mapper.
const noteArcs = m => ({
  right: { P0:m([353,254]),   P1:m([367.5,192.502]), P2:m([418.5,155.002]), P3:m([442.5,148.502]) },
  left:  { P0:m([151.5,254]), P1:m([137,192.502]),   P2:m([86,155.002]),    P3:m([62,148.502])    },
});
const NOTE_ARCS = noteArcs(mapPt);      // over the tip jar
let raidNoteArcs = null;                // over the raid bell, set once its art loads

function pad2(i){ return String(i).padStart(2,'0'); }
const lerp = (a,b,f)=>a+(b-a)*f;
const bump = u => 4*u*(1-u);                    // 0 at edges, 1 at center
const smooth = t => t*t*(3-2*t);                // smoothstep
// quadratic Lagrange through samples at u = 0, 0.5, 1
function lag(u, s){ return s[0]*(2*u-1)*(u-1) + s[1]*4*u*(1-u) + s[2]*u*(2*u-1); }
function lagPt(u, pts){ return [lag(u, pts.map(p=>p[0])), lag(u, pts.map(p=>p[1]))]; }

// normal: the three throw arcs (left / center / right) drawn on the v7 jar art,
// in canvas px, spawn end first; blended over u like the compact samples
const NORMAL_THROWS = [
  [[107,406.283], [124.5,70.7831], [221,19.7834],   [246.5,244.783]],
  [[297,428.5],   [292.5,115],     [294,-34.2166],  [292.5,244.783]],
  [[486,406.283], [468.5,70.7827], [372,19.7829],   [346.5,244.783]],
];
const NORMAL_THROW_SIZE = 110;   // near-camera bit size at spawn

function throwPathFor(u){
  if(NORMAL){
    const [P0, P1, P2, P3] = [0,1,2,3].map(k => lagPt(u, NORMAL_THROWS.map(a => a[k])));
    return { P0, P1, P2, P3, size0: NORMAL_THROW_SIZE };
  }
  const P0 = [ lerp(THROW.spawn.x0, THROW.spawn.x1, u),
               THROW.spawn.yEdge + THROW.spawn.sag * bump(u) ];
  const P1 = lagPt(u, THROW.ctrlSpawn);
  const P2 = lagPt(u, THROW.ctrlMouth);
  const P3 = [ lag(u, THROW.mouthX), THROW.mouthY ];
  const size0 = lerp(THROW.sizeEdge, THROW.sizeCenter, bump(u));
  return { P0:mapPt(P0), P1:mapPt(P1), P2:mapPt(P2), P3:mapPt(P3), size0: size0*MAP.s };
}
function cubic(p, t){
  const m = 1-t;
  return [
    m*m*m*p.P0[0] + 3*m*m*t*p.P1[0] + 3*m*t*t*p.P2[0] + t*t*t*p.P3[0],
    m*m*m*p.P0[1] + 3*m*m*t*p.P1[1] + 3*m*t*t*p.P2[1] + t*t*t*p.P3[1],
  ];
}
function cubicTangent(p, t){          // derivative, per unit t
  const m = 1-t;
  return [
    3*( (p.P1[0]-p.P0[0])*m*m + 2*(p.P2[0]-p.P1[0])*m*t + (p.P3[0]-p.P2[0])*t*t ),
    3*( (p.P1[1]-p.P0[1])*m*m + 2*(p.P2[1]-p.P1[1])*m*t + (p.P3[1]-p.P2[1])*t*t ),
  ];
}

/* ---------------- persistence ---------------- */
let savedGems = []; // array of {c, x, y, ang}

function loadBits(){
  let data;
  try{
    const stored = localStorage.getItem(CFG.storageKey);
    if(stored) data = JSON.parse(stored);
  }catch(e){}
  
  if (Array.isArray(data)) return data;
  if (typeof data === 'number') {
    const arr = [];
    for(let i=0; i<data; i++) arr.push({ c: null });
    return arr;
  }
  return [];
}
function saveBits(arr){ try{ localStorage.setItem(CFG.storageKey, JSON.stringify(arr)); }catch(e){} }

function setBitCount(n){
  savedGems = [];
  const count = Math.max(0, n|0);
  for(let i=0; i<count; i++) savedGems.push({ c: null });
  saveBits(savedGems);
  updateHUDCount();
}

function updateHUDCount() {
  const el = $('bitCount'); 
  if(el) {
    if (jarState === 'IDLE') el.textContent = 'bits: ' + savedGems.length;
    else el.textContent = 'bits: ' + (prefill.length + gems.length);
  }
}

function saveJarState() {
  const arr = [];
  const allGems = [...prefill, ...gems];
  for(const g of allGems) {
    if (g.position.y < H + GEM && g.plugin.outsideSince === undefined) {   // not one fading out beside the jar
      arr.push({
        c: g.plugin.color,
        x: g.position.x,
        y: g.position.y,
        ang: g.angle,
        v: window.VARIANT,   // positions are canvas px, only valid for the same variant
      });
    }
  }
  savedGems = arr;
  saveBits(savedGems);
  updateHUDCount();
}

/* ---------------- assets ---------------- */
const $ = id => document.getElementById(id);

/* OBS's browser source (CEF) drops image decodes when the whole set — ~150 SVGs —
   is requested in one burst: an onerror fires for a file that is sitting right
   there on disk, and the old loader turned that into a red "asset error" bar over
   the stream. So: load through a small pool, retry a failure before believing it,
   and never let a frame that stays missing take the whole overlay down. */
const LOAD_CONCURRENCY = 8;   // parallel image requests
const LOAD_RETRIES     = 3;   // extra attempts after the first failure

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadImgOnce(url){
  return new Promise((res, rej)=>{
    const im = new Image();
    im.onload = ()=>res(im);
    im.onerror = ()=>rej(new Error('missing ' + url));
    im.src = url;
  });
}

async function loadImg(url, retries = LOAD_RETRIES){
  for(let attempt = 0; ; attempt++){
    try{
      // bust the failed entry out of the cache on a retry (file:// ignores the query)
      return await loadImgOnce(attempt && location.protocol !== 'file:' ? `${url}?retry=${attempt}` : url);
    }catch(err){
      if(attempt >= retries) throw err;
      await sleep(60 * (attempt + 1));
    }
  }
}

// Load a list through the pool. A url that never loads comes back as null instead
// of rejecting, so one bad frame can't reject the whole batch.
async function loadList(urls){
  const out = new Array(urls.length);
  let next = 0;
  const worker = async ()=>{
    while(next < urls.length){
      const i = next++;
      try{ out[i] = await loadImg(urls[i]); }
      catch(err){ out[i] = null; console.warn('[assets] ' + err.message); }
    }
  };
  await Promise.all(Array.from({length: Math.min(LOAD_CONCURRENCY, urls.length)}, worker));
  return out;
}

// Frame arrays are index-aligned with collision.js / the stinger timeline, so a
// hole gets filled with its nearest loaded neighbour (a repeated frame is invisible
// at 25fps) rather than removed, which would shift every frame after it.
function patchGaps(imgs){
  const have = imgs.some(Boolean);
  if(!have) return imgs;
  for(let i=0; i<imgs.length; i++){
    if(imgs[i]) continue;
    let j = i - 1;
    while(j >= 0 && !imgs[j]) j--;
    if(j < 0){ j = i + 1; while(j < imgs.length && !imgs[j]) j++; }
    imgs[i] = imgs[j];
  }
  return imgs;
}

let fillImgs = [], strokeImgs = [], gemImgs = [], subImgs = [], donoImgs = [], noteImgs = [];
let subVideo = null;   // normal variant's sub stinger
let paperBag = null;   // normal variant's donation stinger (PaperBagStinger, drawn live)
let donoBuilding = false;   // its receipt is being built: the stinger queue counts that as on screen
let raidIntroImgs = [], raidClickImgs = [];

/* Animated SVG stingers (the raid bell's Blender exports, the paper-bag donation
   stinger): every frame is a <g> that a looping SMIL <animate> on `display` shows for
   1/25s, in file order. Split into one image per frame (SMIL removed, that frame made
   visible) so the frame player sets the timing — e.g. the bell's intro once, then its
   click loop once per click. Reads the SVG text, so it needs http(s) like the gem
   outlines. Returns { imgs, box } — box is the last frame's outline bounds (canvas px). */
async function loadSvgFrames(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(res.status + ' ' + url);
  const svg = new DOMParser().parseFromString(await res.text(), 'image/svg+xml').documentElement;
  const frames = [...svg.querySelectorAll('animate[attributeName="display"]')].map(a => a.parentNode);
  if(!frames.length) throw new Error('no animated frames in ' + url);
  frames.forEach((g, i) => g.setAttribute('data-frame', i));
  svg.querySelectorAll('animate').forEach(a => a.remove());
  const xml = new XMLSerializer();
  const single = i => {
    const one = svg.cloneNode(true);
    one.querySelectorAll('[data-frame]').forEach(g => {
      if(+g.getAttribute('data-frame') !== i) g.remove();
      else g.setAttribute('display', 'inline');   // frames may start hidden (display="none")
    });
    return one;
  };
  const urls = frames.map((_, i) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml.serializeToString(single(i))));
  // getBBox needs the frame in the document (hidden, zero size)
  const host = document.body.appendChild(document.importNode(single(frames.length-1), true));
  host.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  const bb = host.getBBox(); host.remove();
  return { imgs: patchGaps(await loadList(urls)).filter(Boolean), box: { x: bb.x, y: bb.y, w: bb.width, h: bb.height } };
}

/* Freestyle exports the bell as strokes only, so each frame gets the tip jar's white
   fill here: every pixel the outline encloses — the ones the canvas edge can't reach
   once breaks in the line up to 2*FILL_GAP px are bridged — is painted white under
   the strokes. The bridge is grown back afterwards, so no white shows outside the line.
   A visible white patch smaller than FILL_SPECK px is a break or pinhole in the line
   (Freestyle leaves them where strokes meet), not part of the bell: it's painted black,
   or it would show as a white dot.
   ponytail: a break wider than 2*FILL_GAP leaks, and that part of the bell stays
   unfilled; raise FILL_GAP, or export a fill pass, if the art ever needs it. */
const FILL_GAP = 3, FILL_SPECK = 40;
function dilate(m, w, h, r){                       // square max-filter, two separable passes
  const t = new Uint8Array(m.length), o = new Uint8Array(m.length);
  for(let y=0; y<h; y++) for(let x=0; x<w; x++){
    let v = 0; for(let k=Math.max(0,x-r), e=Math.min(w-1,x+r); k<=e && !v; k++) v = m[y*w+k]; t[y*w+x] = v; }
  for(let y=0; y<h; y++) for(let x=0; x<w; x++){
    let v = 0; for(let k=Math.max(0,y-r), e=Math.min(h-1,y+r); k<=e && !v; k++) v = t[k*w+x]; o[y*w+x] = v; }
  return o;
}
async function withFill(im){
  const w = im.width, h = im.height, n = w*h, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0, w, h);
  const a = x.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(n);
  for(let i=0; i<n; i++) ink[i] = a[i*4+3] >= 64;
  const wall = dilate(ink, w, h, FILL_GAP), out = new Uint8Array(n), stack = [];
  const reach = i => { if(!wall[i] && !out[i]){ out[i] = 1; stack.push(i); } };
  for(let X=0; X<w; X++){ reach(X); reach(n-w+X); }
  for(let Y=0; Y<h; Y++){ reach(Y*w); reach(Y*w+w-1); }
  while(stack.length){
    const i = stack.pop(), X = i % w;
    if(X > 0) reach(i-1); if(X < w-1) reach(i+1); if(i >= w) reach(i-w); if(i < n-w) reach(i+w);
  }
  // +2: also past the line's soft outer edge, so the fill's border sits under the stroke
  const outside = dilate(out, w, h, FILL_GAP + 2), fill = x.createImageData(w, h), d = fill.data;
  for(let i=0; i<n; i++) if(!outside[i]) d.fill(255, i*4, i*4+4);
  // visible = filled and not under the line; its small patches are specks -> black
  const vis = i => !outside[i] && a[i*4+3] < 128, seen = new Uint8Array(n);
  for(let i=0; i<n; i++){
    if(seen[i] || !vis(i)) continue;
    const patch = [i]; seen[i] = 1;
    for(let k=0; k<patch.length; k++){
      const j = patch[k], X = j % w;
      for(const m of [X > 0 ? j-1 : -1, X < w-1 ? j+1 : -1, j >= w ? j-w : -1, j < n-w ? j+w : -1])
        if(m >= 0 && !seen[m] && vis(m)){ seen[m] = 1; patch.push(m); }
    }
    if(patch.length < FILL_SPECK) for(const j of patch) d[j*4] = d[j*4+1] = d[j*4+2] = 0;
  }
  x.putImageData(fill, 0, 0);
  x.drawImage(im, 0, 0, w, h);                     // the strokes over the fill
  return loadImgOnce(c.toDataURL());              // an image, not a resident canvas (see bakeAssets)
}

/* Normal raid bell: two filled parts, assembled as in the reference (Group.svg, 325x234
   including the 8px centred stroke): the button sits BEHIND the body, and each click
   presses it down and back up over 7 frames. The press follows the compact Blender
   click (0, 2, 5.7, 7.7, 5.7, 2, 0 px on its 186px-wide bell), scaled to this 316px
   one — about all the room there is between the button and the dome. The bell is
   centred on the canvas's bottom edge, as the normal jar is. */
const NORMAL_BELL = {
  w: 325, h: 234,                 // assembled size (stroke included)
  body:   [0, 35.91],             // where each part's SVG sits in the assembly
  button: [95.96, 0],
  press:  [0, 3.4, 9.7, 13.1, 9.7, 3.4, 0],   // button offset (px down) per click frame
};
async function buildNormalBell(){
  const [body, button] = await Promise.all([loadImg(RAID_BODY), loadImg(RAID_BUTTON)]);
  const ox = (W - NORMAL_BELL.w)/2, oy = H - NORMAL_BELL.h;
  const frame = dy => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.drawImage(button, ox + NORMAL_BELL.button[0], oy + NORMAL_BELL.button[1] + dy);
    x.drawImage(body, ox + NORMAL_BELL.body[0], oy + NORMAL_BELL.body[1]);
    return c;   // ~1.4MB each, 7 of them; kept as canvases so it also runs from file://
  };
  const clicks = NORMAL_BELL.press.map(frame);
  return {
    intro: Array(Math.round(CFG.jarFadeInMs/1000*CFG.fps)).fill(clicks[0]),   // rests while it fades in, like the jar
    clicks,
    box: { x: ox + 4, y: oy + 4, w: NORMAL_BELL.w - 8 },   // outline, without the stroke (as getBBox gives compact's)
  };
}

/* Gem outline (normal variant, from the v7 prototype): the longest stroked <path>
   in the gem SVG, sampled to 24 points and rounded with one Chaikin pass, in image
   px relative to the image centre. makeGem scales it by GEM*CFG.gemBounds. */
const gemShapes = new Map();   // image -> outline points
function chaikin(pts){
  const out = [];
  for(let i=0; i<pts.length; i++){
    const a = pts[i], b = pts[(i+1)%pts.length];
    out.push([a[0]*.75+b[0]*.25, a[1]*.75+b[1]*.25], [a[0]*.25+b[0]*.75, a[1]*.25+b[1]*.75]);
  }
  return out;
}
function gemOutline(text, im){
  const src = new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('svg');
  if(!src) return null;
  const vb = (src.getAttribute('viewBox') || `0 0 ${im.width} ${im.height}`).trim().split(/[\s,]+/).map(Number);
  const NS = 'http://www.w3.org/2000/svg', host = document.createElementNS(NS, 'svg');
  host.setAttribute('viewBox', vb.join(' '));
  host.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  document.body.appendChild(host);   // getTotalLength needs the path in the document
  let best = null, bestL = 0;
  src.querySelectorAll('path').forEach(el=>{
    if(el.closest('clipPath,defs,pattern,mask')) return;
    if((el.getAttribute('stroke') || 'none').toLowerCase() === 'none') return;
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', el.getAttribute('d') || ''); host.appendChild(p);
    const L = p.getTotalLength(); if(L > bestL){ bestL = L; best = p; }
  });
  let pts = null;
  if(best){
    const sx = im.width/vb[2], sy = im.height/vb[3], N = 24; pts = [];
    for(let i=0; i<N; i++){
      const q = best.getPointAtLength(bestL*i/N);
      pts.push([(q.x-vb[0])*sx - im.width/2, (q.y-vb[1])*sy - im.height/2]);
    }
    pts = chaikin(pts);
  }
  host.remove();
  return pts;
}

async function loadAssets(){
  const nTip = collision.frames.length;   // frame count follows collision.js
  const [tipF, tipS, subs, gems, notes] = await Promise.all([
    loadList(Array.from({length:nTip}, (_,i)=>TIP_FILL(i))),
    loadList(Array.from({length:nTip}, (_,i)=>TIP_STROKE(i))),
    loadList(NORMAL ? [] : Array.from({length:CFG.subFrames}, (_,i)=>SUB_FRAME(i))),
    loadList(GEM_URLS),
    loadList(NOTE_URLS),
  ]);
  if(NORMAL){
    // the normal sub stinger is one webm (VP9 with alpha), drawn into the stinger canvas
    subVideo = document.createElement('video');
    subVideo.muted = true; subVideo.playsInline = true; subVideo.preload = 'auto';
    subVideo.src = SUB_VIDEO;
  }
  // gem bodies follow each sprite's stroke outline, read from the SVG text. Needs
  // http(s) (GitHub Pages / a local server); if it can't be read, that gem is a circle.
  await Promise.all(GEM_URLS.map(async (url, i)=>{
    if(!gems[i]) return;
    try{
      const pts = gemOutline(await (await fetch(url)).text(), gems[i]);
      if(pts) gemShapes.set(gems[i], pts);
    }catch(err){ console.warn('[assets] no outline for ' + url + ', using a circle: ' + err.message); }
  }));
  fillImgs   = patchGaps(tipF).filter(Boolean);
  strokeImgs = patchGaps(tipS).filter(Boolean);
  subImgs    = patchGaps(subs).filter(Boolean);
  noteImgs   = notes.filter(Boolean);
  // a gem that won't load borrows another colour's sprite — a wrong-coloured bit
  // beats a crash in the draw loop
  const gemFallback = gems.find(Boolean);
  gemImgs = gems.map(im => im || gemFallback).filter(Boolean);
  GEM_COLORS.forEach((c,i)=>{ if(gemImgs[i]) gemByColor[c] = gemImgs[i]; });

  // donation stinger (paper bag) is optional. compact: Blender frames (they come filled);
  // normal: drawn in code, its receipt laid out in HTML (fonts, logo and icons embedded)
  try{
    if(NORMAL){
      const font = w => `${DONO_DIR}/fonts/inter-latin-${w}-normal.woff2`;
      await ReceiptHTML.init({ fonts: { 500: font(500), 600: font(600), 700: font(700) },
        logo: `${DONO_DIR}/ninos-cafe-logo.svg`, heart: `${DONO_DIR}/heart.svg`,
        icons: { twitch: `${DONO_DIR}/platforms/twitch.svg`, youtube: `${DONO_DIR}/platforms/youtube.svg` } });
      paperBag = new PaperBagStinger(document.createElement('canvas'));   // an offscreen layer, see playDonation
    }
    else donoImgs = (await loadSvgFrames(DONO_SVG)).imgs;
  }
  catch(err){ console.warn('[assets] no donation stinger: ' + err.message); }

  // raid bell is optional too
  try{
    let box;
    if(NORMAL) ({ intro: raidIntroImgs, clicks: raidClickImgs, box } = await buildNormalBell());
    else{
      const [intro, click] = await Promise.all([loadSvgFrames(RAID_INTRO), loadSvgFrames(RAID_CLICK)]);
      raidIntroImgs = await Promise.all(intro.imgs.map(withFill));
      raidClickImgs = await Promise.all(click.imgs.map(withFill));
      box = intro.box;
    }
    const r = overBox(box);   // notes rise from the resting bell's top, spread over its width
    raidNoteArcs = noteArcs(p => [p[0]*r.s + r.dx, p[1]*r.s + r.dy]);
  }
  catch(err){ console.warn('[assets] no raid bell: ' + err.message); }

  // the jar can't draw without its own frames; everything else degrades quietly
  if(!fillImgs.length || !strokeImgs.length) throw new Error('tip-jar frames failed to load');
}

/* ---------------- pre-rasterized frames ----------------
   OBS's browser source (CEF) re-rasterizes an <svg> image on every drawImage —
   the jar redraws its fill + stroke (twice) full-canvas plus every gem each frame,
   so that vector work is what makes it lag/glitch in OBS even though it's smooth in
   a real browser. Bake every frame/sprite to an offscreen raster canvas once, at the
   size it's actually drawn, so the per-frame draws become cheap bitmap blits. */
let fillBaked = [], strokeBaked = [];
const gemBaked = new Map();    // source img -> baked canvas
const noteBaked = new Map();
function bakeToCanvas(img, w, h){
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function bakeAssets(){
  // Only the CONTINUOUS jar animation is baked (drawn full-canvas 3x + gems, every
  // frame) — that's the hot path. The sub/donation frames play straight from their
  // SVGs (a short one-shot, one draw per frame) so we don't keep ~40MB of extra
  // canvases resident, which can push OBS's browser source into crashing & reloading.
  fillBaked   = fillImgs.map(im => bakeToCanvas(im, W, H));   // full-canvas: exact 1:1 blits
  strokeBaked = strokeImgs.map(im => bakeToCanvas(im, W, H));
  // gems: bake at the largest on-screen size (a bit's spawn size in flight) so both
  // the smaller settled gems and the larger flying ones stay crisp when scaled.
  const gemPx = Math.ceil(Math.max(GEM, NORMAL ? NORMAL_THROW_SIZE : THROW.sizeCenter * MAP.s));
  for(const im of gemImgs){
    const s = gemPx / Math.max(im.width, im.height);
    gemBaked.set(im, bakeToCanvas(im, im.width * s, im.height * s));
  }
  // notes grow to NOTE_S*1.26 (drawNotes) — bake at that so they're never upscaled
  const noteK = Math.max(1, NOTE_S * 1.26);
  for(const im of noteImgs) noteBaked.set(im, bakeToCanvas(im, im.width * noteK, im.height * noteK));
}

/* =========================================================================
   Collision / jar animation helpers (backBox smoothing, wall pairs,
   rigid jar transform for the settled-gem intro trick)
   ========================================================================= */
let smoothedBoxes = [];
function buildSmoothedBoxes(){
  smoothedBoxes = [];
  const N = collision.frames.length;
  for(let i=0; i<N; i++){
    const fr = collision.frames[i];
    if(!fr || !fr.backBox || fr.backBox.cx === undefined){ smoothedBoxes.push(null); continue; }
    let sumCx=0, sumCy=0, sumW=0, sumH=0, sumAng=0, count=0;
    for(let j=Math.max(0,i-2); j<=Math.min(N-1,i+2); j++){
      const b2 = collision.frames[j]?.backBox;
      if(b2 && b2.cx !== undefined){
        sumCx += b2.cx; sumCy += b2.cy; sumW += b2.w; sumH += b2.h;
        let ang = b2.angle || 0;
        if(count > 0){ // keep angle contiguous to avoid flip averaging
          const base = sumAng / count;
          while(ang - base >  Math.PI) ang -= Math.PI*2;
          while(ang - base < -Math.PI) ang += Math.PI*2;
        }
        sumAng += ang; count++;
      }
    }
    smoothedBoxes.push({ cx:(sumCx/count)*W, cy:(sumCy/count)*H,
                         w:(sumW/count)*W, h:(sumH/count)*H, angle:sumAng/count });
  }
}
function interpolatedBox(t){
  if(!smoothedBoxes.length) return null;
  const a = Math.floor(t), b2 = Math.min(a+1, smoothedBoxes.length-1), f = t-a;
  const A = smoothedBoxes[a], B = smoothedBoxes[b2];
  if(A && B){
    let da = B.angle - A.angle;
    if(da >  Math.PI) da -= 2*Math.PI;
    if(da < -Math.PI) da += 2*Math.PI;
    return { cx:A.cx+(B.cx-A.cx)*f, cy:A.cy+(B.cy-A.cy)*f,
             w:A.w+(B.w-A.w)*f, h:A.h+(B.h-A.h)*f, angle:A.angle+da*f };
  }
  return A || B;
}
// pad grows the box outward along its own axes (px), used to overlap the two
// stroke passes so their shared edge can't show a seam — see SEAM_OVERLAP.
function boxCornersAt(t, pad = 0){
  const bx = interpolatedBox(t);
  if(!bx) return null;
  const c = Math.cos(bx.angle), s = Math.sin(bx.angle), hw = bx.w/2 + pad, hh = bx.h/2 + pad;
  return [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([x,y])=>[bx.cx+x*c-y*s, bx.cy+x*s+y*c]);
}
function clipToCorners(ctx, corners){
  corners.forEach((p,i)=> i ? ctx.lineTo(p[0],p[1]) : ctx.moveTo(p[0],p[1]));
  ctx.closePath();
}

/* How far the BACK stroke pass reaches past the backBox, in canvas px.

   The jar's stroke is painted twice against complementary clips of the same
   box — inside it behind the gems, outside it in front of them — so together
   they should rebuild one whole stroke. Canvas clips are anti-aliased, though,
   so on the shared edge the back pass paints coverage a and the front pass
   1-a, and compositing those lands at 1-(1-a)*a, which never reaches opaque:
   the white fill underneath shows through as a hairline along the box's top
   and bottom edges. Letting the back pass run a pixel past the boundary makes
   it cover that line solidly. The front pass — the edge you actually see, and
   the one that decides which gems are occluded — is left exactly where it was,
   and it paints straight over the extra pixel. */
const SEAM_OVERLAP = 1;

/* Offscreen layer the jar is composited on before it's blitted at its current
   alpha — see the render loop. Allocated once and cleared per frame; sizing a
   canvas allocates a backing store, and doing that every frame would undo the
   point of baking the frames in the first place. */
let _jarLayer = null;
function jarLayer(){
  if(!_jarLayer){
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    _jarLayer = c.getContext('2d');
  }
  _jarLayer.clearRect(0, 0, W, H);
  return _jarLayer;
}

function pairsRaw(frameIdx){
  const fr = collision.frames[Math.min(frameIdx, collision.frames.length-1)];
  const pairs = [];
  if(fr.wallSegments){
    for(const poly of fr.wallSegments)
      for(let i=0; i<poly.length-1; i++)
        pairs.push([[poly[i][0]*W, poly[i][1]*H], [poly[i+1][0]*W, poly[i+1][1]*H]]);
  } else if(fr.sampled){
    for(let i=0; i<fr.sampled.length-1; i++)
      pairs.push([[fr.sampled[i][0]*W, fr.sampled[i][1]*H], [fr.sampled[i+1][0]*W, fr.sampled[i+1][1]*H]]);
  }
  return pairs;
}
function pairsAt(t){
  const a = Math.floor(t), b = Math.min(a+1, collision.frames.length-1), f = t-a;
  const A = pairsRaw(a), B = pairsRaw(b);
  if(!A.length) return B;
  if(!B.length || A.length !== B.length || f === 0) return A;
  return A.map((pa,i)=>{
    const pb = B[i];
    return [[pa[0][0]+(pb[0][0]-pa[0][0])*f, pa[0][1]+(pb[0][1]-pa[0][1])*f],
            [pa[1][0]+(pb[1][0]-pa[1][0])*f, pa[1][1]+(pb[1][1]-pa[1][1])*f]];
  });
}

// rigid transform for gem tracking, fitted to the CUP FLOOR ARC — the longest
// wallSegments polyline (7 tool-sampled points, stable correspondence every
// frame). It's the surface the gems sit on and it moves exactly with the art,
// so the gems neither twitch (hand-placed backBox wobble) nor lag (smoothing).
function cupArc(frameIdx){
  const fr = collision.frames[Math.min(frameIdx, collision.frames.length-1)];
  if(!fr.wallSegments || !fr.wallSegments.length) return null;
  let best = null;
  for(const poly of fr.wallSegments) if(!best || poly.length > best.length) best = poly;
  return best && best.length >= 3 ? best.map(p=>[p[0]*W, p[1]*H]) : null;
}
function cupArcAt(t){
  const a = Math.floor(t), b = Math.min(a+1, collision.frames.length-1), f = t-a;
  const A = cupArc(a), B = cupArc(b);
  if(!A) return B;
  if(!B || f === 0 || A.length !== B.length) return A;
  return A.map((pa,i)=>[pa[0]+(B[i][0]-pa[0])*f, pa[1]+(B[i][1]-pa[1])*f]);
}
function jarTransformBetween(tFrom, tTo){
  const A = cupArcAt(tFrom), B = cupArcAt(tTo);
  if(A && B && A.length === B.length && A.length >= 3){
    const ca = [A.reduce((s,p)=>s+p[0],0)/A.length, A.reduce((s,p)=>s+p[1],0)/A.length];
    const cb = [B.reduce((s,p)=>s+p[0],0)/B.length, B.reduce((s,p)=>s+p[1],0)/B.length];
    let sxx=0, sxy=0;
    for(let i=0; i<A.length; i++){
      const ax=A[i][0]-ca[0], ay=A[i][1]-ca[1];
      const bx=B[i][0]-cb[0], by=B[i][1]-cb[1];
      sxx += ax*bx + ay*by;
      sxy += ax*by - ay*bx;
    }
    return { ca, cb, dAng: Math.atan2(sxy, sxx), s:1 };
  }
  // fallback: smoothed backBox (frames without walls)
  const A2 = interpolatedBox(tFrom), B2 = interpolatedBox(tTo);
  if(!A2 || !B2) return null;
  let dAng = B2.angle - A2.angle;
  while(dAng >  Math.PI) dAng -= 2*Math.PI;
  while(dAng < -Math.PI) dAng += 2*Math.PI;
  return { ca:[A2.cx, A2.cy], cb:[B2.cx, B2.cy], dAng, s:1 };
}
function applyT(T, p){
  const dx=p[0]-T.ca[0], dy=p[1]-T.ca[1];
  const c=Math.cos(T.dAng), si=Math.sin(T.dAng);
  return [T.cb[0]+T.s*(dx*c-dy*si), T.cb[1]+T.s*(dx*si+dy*c)];
}

/* =========================================================================
   Tip jar runtime
   ========================================================================= */
let engine, walls=[], gems=[], prefill=[], flights=[], throwQueue=[], throwTimer=null;
let debug=false, gemDebug=false, arcDebug=false;
let playhead=0, playing=true, lastT=null, firstWallFrame=0, introHidden=true, introMs=0;
let jarState = 'IDLE'; // IDLE, INTRO, PLAYING, OUTRO
// the jar fades in over this; compact over its first 3 fall frames (same as before)
const JAR_FADE_IN_MS = NORMAL ? CFG.jarFadeInMs : 3/CFG.fps*1000;
let outroT = 0;
let lastWallKey = null; // skips rebuilding the static physics walls every frame once settled
let physicsAcc = 0;     // real-time physics accumulator (keeps gems at correct speed below 60fps)
let idleTime = 0;
const LAST = ()=>fillImgs.length-1;

function makeGem(x, y, im){
  im = im || gemImgs[Math.floor(Math.random()*gemImgs.length)];
  const scale = GEM/Math.max(im.width, im.height);
  const opts = {...LIVE, friction:0.02, frictionStatic:0.05, density:0.002};
  const shape = gemShapes.get(im);
  let b, off = [0, 0];
  if(shape){
    // body sits at the outline's centroid; off maps it back to the sprite centre
    const k = scale*BODY, verts = shape.map(p=>({x:p[0]*k, y:p[1]*k}));
    const c = Matter.Vertices.centre(verts);
    b = Bodies.fromVertices(x, y, [verts], opts);   // no poly-decomp: a concave outline becomes its hull
    Body.setPosition(b, {x, y});
    off = [c.x, c.y];
  } else {
    b = Bodies.circle(x, y, GEM*0.5*BODY, opts);
  }
  Body.setAngle(b, Math.random()*Math.PI);
  b.plugin = { im, scale, off };
  return b;
}

// how many gems physically fit in the cup at the final pose;
// CFG.maxJarGems is only the upper clamp
let JAR_CAP = CFG.maxJarGems;
function computeJarCapacity(){
  const pairs = pairsRaw(LAST());
  if(!pairs.length) return CFG.maxJarGems;
  let minX=1e9, maxX=-1e9, minY=1e9, maxY=-1e9;
  for(const [p,q] of pairs) for(const pt of [p,q]){
    minX=Math.min(minX,pt[0]); maxX=Math.max(maxX,pt[0]);
    minY=Math.min(minY,pt[1]); maxY=Math.max(maxY,pt[1]);
  }
  const eff = GEM*BODY;
  const cells = ((maxX-minX)-eff*0.5) * ((maxY-minY)-eff*0.5) / (eff*eff);
  return Math.max(4, Math.min(CFG.maxJarGems, Math.floor(cells*0.9)));
}

function boot(overridePrefillN = null){
  JAR_CAP = computeJarCapacity();
  
  let prefillGems = [...savedGems];
  if (overridePrefillN !== null && overridePrefillN < prefillGems.length) {
    prefillGems.sort((a,b) => (b.y || 0) - (a.y || 0));
    prefillGems.splice(0, prefillGems.length - overridePrefillN);
  } else if (prefillGems.length > JAR_CAP) {
    prefillGems.sort((a,b) => (b.y || 0) - (a.y || 0));
    prefillGems.splice(0, prefillGems.length - JAR_CAP);
  }

  const cv = $('jarCv'); cv.width = W; cv.height = H;

  walls=[]; gems=[]; prefill=[]; flights=[]; throwQueue=[];
  if(throwTimer){ clearInterval(throwTimer); throwTimer=null; }

  engine = Engine.create();
  engine.gravity.y = 5.35;
  engine.enableSleeping = true;
  engine.positionIterations = 16;
  engine.velocityIterations = 14;

  // compact: no ground, so gems fall off screen immediately. normal (v7): a ground
  // slab at groundY, so a missed gem lands beside the jar and fades (cullEscaped)
  if(NORMAL && collision.meta.groundY != null){
    Composite.add(engine.world, Bodies.rectangle(W/2, collision.meta.groundY*H + 20, W*4, 40,
      { isStatic:true, friction:.6, restitution:.05 }));
  }

  firstWallFrame = 0;
  for(let i=0; i<collision.frames.length; i++){ if(pairsRaw(i).length){ firstWallFrame=i; break; } }
  const nPairs = pairsRaw(firstWallFrame).length;
  for(let i=0; i<nPairs; i++){
    const b = Bodies.rectangle(0,-1000,10,10,{ isStatic:true, friction:.4, restitution:.05 });
    walls.push(b); Composite.add(engine.world, b);
  }

  positionWalls(pairsRaw(LAST()));
  
  for(let i=0; i<prefillGems.length; i++){
    const data = prefillGems[i];
    let im = data.c ? gemByColor[data.c] : null;
    // saved positions only fit the variant that saved them (old saves are compact)
    const here = data.x !== undefined && (data.v || 'compact') === window.VARIANT;
    let x = here ? data.x : W*0.38 + Math.random()*W*0.24;
    let y = here ? data.y : H*0.45 - i*GEM*0.45;
    let ang = here && data.ang !== undefined ? data.ang : Math.random()*Math.PI;
    
    const g = makeGem(x, y, im);
    Body.setAngle(g, ang);
    
    let colorStr = 'gray';
    for(const c of GEM_COLORS) { if (gemByColor[c] === g.plugin.im) colorStr = c; }
    g.plugin.color = colorStr;
    
    prefill.push(g); Composite.add(engine.world, g);
  }
  
  // always settle so gems rest properly inside the jar walls
  for(let i=0; i<400; i++) Engine.update(engine, 1000/60);
  captureAndFreeze(prefill);

  playhead=0; playing=true; introHidden=true; lastT=null; introMs=0;
  jarState = 'INTRO';
  idleTime = 0;
  lastWallKey = null;   // force a wall rebuild for the new run
}

function captureAndFreeze(list){
  for(const g of list){
    g.plugin.settled = { x:g.position.x, y:g.position.y, ang:g.angle };
    Body.setStatic(g, true);
  }
}
function unfreezeInto(t){
  const T = jarTransformBetween(LAST(), t);
  for(const g of prefill){
    const st = g.plugin.settled;
    const p = T ? applyT(T,[st.x,st.y]) : [st.x,st.y];
    Body.setPosition(g,{x:p[0],y:p[1]});
    Body.setAngle(g, st.ang + (T ? T.dAng : 0));
  }
}
function positionWalls(pairs){
  // each wall body fills the band between its drawn line and WALL_T inside it (v7):
  // its collision face is moved WALL_T toward the jar interior
  let ccx=0, ccy=0, cn=0;
  for(const [p,q] of pairs){ ccx+=p[0]+q[0]; ccy+=p[1]+q[1]; cn+=2; }
  if(cn){ ccx/=cn; ccy/=cn; }
  const inset = WALL_T;
  for(let i=0; i<walls.length; i++){
    if(i >= pairs.length){ Body.setPosition(walls[i],{x:-2000,y:-2000}); continue; }
    let [[x1,y1],[x2,y2]] = pairs[i];
    const len = Math.hypot(x2-x1, y2-y1) || 1;
    let nx = -(y2-y1)/len, ny = (x2-x1)/len;
    const mx0=(x1+x2)/2, my0=(y1+y2)/2;
    if(nx*(ccx-mx0) + ny*(ccy-my0) < 0){ nx=-nx; ny=-ny; }
    x1+=nx*inset; y1+=ny*inset; x2+=nx*inset; y2+=ny*inset;
    const ang = Math.atan2(y2-y1, x2-x1);
    const ht = WALL_T/2;
    // center the body OUTSIDE the line so its collision FACE sits exactly on
    // the (inset) segment — a centered rect would float gems half a wall
    // thickness off the drawn floor arc
    const mx=(x1+x2)/2 - nx*ht, my=(y1+y2)/2 - ny*ht;
    const hw=Math.max(1,len/2), c=Math.cos(ang), s=Math.sin(ang);
    const vs=[[-hw,-ht],[hw,-ht],[hw,ht],[-hw,ht]].map(([vx,vy])=>({x:mx+vx*c-vy*s, y:my+vx*s+vy*c}));
    Body.setPosition(walls[i],{x:mx,y:my});
    Body.setVertices(walls[i], vs);
  }
}

/* ---------------- bit throwing ---------------- */
function launchFlight(color){
  const u = Math.random();
  const path = throwPathFor(u);
  flights.push({
    ...path,
    im: (color && gemByColor[color]) || gemImgs[Math.floor(Math.random()*gemImgs.length)],
    start: performance.now(),
    dur: CFG.throwDurationMs,
    angle0: Math.random()*Math.PI*2,
    spin: (Math.random()*2-1)*0.9,
  });
}
function landFlight(fl){
  // hand over to physics part-way along the arc, so the gem really drops in
  const h = CFG.physicsHandoff;
  const p = cubic(fl, h);
  const g = makeGem(p[0], p[1], fl.im);
  Body.setAngle(g, fl.angle0 + fl.spin*h);
  const [dx, dy] = cubicTangent(fl, h);
  let vx = dx/fl.dur*16.667, vy = dy/fl.dur*16.667;
  const sp = Math.hypot(vx, vy), cap = 14;
  if(sp > cap){ vx *= cap/sp; vy *= cap/sp; }
  Body.setVelocity(g, {x:vx, y:vy});
  Body.setAngularVelocity(g, fl.spin*0.15);
  let colorStr = 'gray';
  for(const c of GEM_COLORS) { if (gemByColor[c] === fl.im) colorStr = c; }
  g.plugin.color = colorStr;
  gems.push(g); Composite.add(engine.world, g);
  updateHUDCount();
  spawnNote();
  // the jar is finite: merge bottom gems into higher tiers to free space
  if(prefill.length + gems.length > JAR_CAP){
    mergeBottomGems();
  }
}

/* ---------------- gem merging (jar overflow) ---------------- */
function removeGem(g){
  Composite.remove(engine.world, g);
  let idx = prefill.indexOf(g);
  if(idx >= 0){ prefill.splice(idx, 1); return; }
  idx = gems.indexOf(g);
  if(idx >= 0) gems.splice(idx, 1);
}

// The fused gem takes the place of the lowest gem it was made from: that spot was
// just vacated, so it doesn't spawn inside the pile (or a wall) and kick gems out.
// Built from its own sprite, so a normal-variant gem gets its own outline body.
function fuseInto(batch, color){
  const low = batch.reduce((a,b)=> b.position.y > a.position.y ? b : a);
  const x = low.position.x, y = low.position.y;
  for(const g of batch) removeGem(g);
  const ng = makeGem(x, y, gemByColor[color]);
  ng.plugin.color = color;
  gems.push(ng); Composite.add(engine.world, ng);
}

function mergeBottomGems(){
  let needed = (prefill.length + gems.length) - JAR_CAP;
  if(needed <= 0) return;

  // 1. Try strict merging: pick any gems of the right color from anywhere in the jar
  for(const rule of CFG.mergeUp){
    if(needed <= 0) break;
    while(needed > 0){
      // gather all gems of this color
      const matches = [...prefill, ...gems].filter(g => g.plugin.color === rule.from);
      if(matches.length < rule.count) break;   // not enough to merge

      // pick the first `count` (any, not position-dependent)
      fuseInto(matches.slice(0, rule.count), rule.to);
      needed -= (rule.count - 1);
    }
  }

  // 2. FORCE merge fallback if strict rules couldn't free enough space
  while(needed > 0){
    const all = [...prefill, ...gems];
    if (all.length < 2) break; // Needs at least 2 to merge

    // Visually make sense by merging the lowest tier gems first
    all.sort((a,b) => {
      let tA = GEM_COLORS.indexOf(a.plugin.color);
      let tB = GEM_COLORS.indexOf(b.plugin.color);
      if (tA === -1) tA = 4;
      if (tB === -1) tB = 4;
      return tB - tA;
    });

    const g1 = all[0];
    const g2 = all[1];

    let tier1 = GEM_COLORS.indexOf(g1.plugin.color);
    let tier2 = GEM_COLORS.indexOf(g2.plugin.color);
    if (tier1 === -1) tier1 = 4;
    if (tier2 === -1) tier2 = 4;
    
    let bestTier = Math.min(tier1, tier2);
    let nextTier = Math.max(0, bestTier - 1);
    fuseInto([g1, g2], GEM_COLORS[nextTier]);
    needed -= 1;
  }

  // Absolute fallback: if merging still couldn't free enough (e.g. only 1 gem left over 0 cap), delete
  if(needed > 0){
    const all = [...prefill, ...gems].sort((a,b) => b.position.y - a.position.y);
    for(let i = 0; i < needed && i < all.length; i++){
      removeGem(all[i]);
    }
  }

  // wake everything so the pile re-settles smoothly around the fused gems
  for(const g2 of prefill) Sleeping.set(g2, false);
  for(const g2 of gems)    Sleeping.set(g2, false);
}

// gems that bounce out land on the ground, rest a moment, then fade away
const OUTSIDE_X = NORMAL ? [0.2, 0.8] : [0.235, 0.765];   // jar's left / right edge, fraction of W
function cullEscaped(now){
  for(const list of [prefill, gems]){
    for(let i=list.length-1; i>=0; i--){
      const g = list[i], p = g.position;
      if(p.y > H+GEM || p.x < -GEM || p.x > W+GEM){        // fell off the world
        Composite.remove(engine.world, g); list.splice(i,1); continue;
      }
      const outside = p.y > H*0.6 && (p.x < W*OUTSIDE_X[0] || p.x > W*OUTSIDE_X[1]);
      if(!outside){ delete g.plugin.outsideSince; g.plugin.alpha = 1; continue; }
      if(g.plugin.outsideSince === undefined) g.plugin.outsideSince = now;
      const fadeIn = now - g.plugin.outsideSince - (CFG.outsideTTLMs - CFG.outsideFadeMs);
      g.plugin.alpha = 1 - Math.max(0, Math.min(1, fadeIn/CFG.outsideFadeMs));
      if(g.plugin.alpha <= 0){ Composite.remove(engine.world, g); list.splice(i,1); }
    }
  }
}

/* ---------------- music notes (middle plane, one at a time) ---------------- */
let activeNotes = [], raidNotes = [], noteOnRight = false;   // jar's notes / the raid bell's
const NOTE_S = MAP.s * (NORMAL ? CFG.noteScale : 1);   // note sprite scale (before the 1.26 grow)
function spawnNote(list = activeNotes, arcs = NOTE_ARCS){
  if(!noteImgs.length || !arcs) return;

  const now = performance.now();

  // If there is already a note playing, check how far along it is
  if (list.length > 0) {
    const lastNote = list[list.length - 1];
    const t = (now - lastNote.start) / lastNote.dur;
    
    // If the newest note hasn't reached our "almost done" point (e.g., 60%), don't spawn a new one
    if (t < CFG.noteOverlapThreshold) return;
  }

  noteOnRight = !noteOnRight;
  list.push({
    im: noteImgs[Math.random() < 0.75 ? 0 : 1],   // 75% eighth, 25% quaver
    arc: noteOnRight ? arcs.right : arcs.left,
    dir: noteOnRight ? 1 : -1,
    start: now,
    dur: CFG.noteDurationMs,
  });
}

function drawNotes(ctx, now, list = activeNotes){
  // Loop backward to safely remove notes that have fully finished their arc
  for(let i = list.length - 1; i >= 0; i--) {
    const n = list[i];
    const t = (now - n.start) / n.dur;

    if(t >= 1){
      list.splice(i, 1); // Note is 100% done, remove from array
      continue; 
    }
    
    const e = 1-(1-t)*(1-t);                        // ease-out along the arc
    const p = cubic(n.arc, e);
    const scale = NOTE_S * lerp(1, 1.26, e);        // grows toward the camera
    const rot = n.dir * e * 4 * Math.PI/180;        // slight outward tilt
    const alpha = Math.min(1, t/0.12) * (1 - smooth(Math.max(0, (t-0.7)/0.3)));
    
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(p[0], p[1]); ctx.rotate(rot); ctx.scale(scale, scale);
    ctx.drawImage(noteBaked.get(n.im) || n.im, -n.im.width/2, -n.im.height/2, n.im.width, n.im.height);
    ctx.restore();
  }
}

function pumpThrowQueue(){
  if(throwTimer || !throwQueue.length) return;
  throwTimer = setInterval(()=>{
    if(jarState !== 'PLAYING' || !throwQueue.length){     // wait out the intro
      if(!throwQueue.length){ clearInterval(throwTimer); throwTimer=null; }
      return;
    }
    launchFlight(throwQueue.shift());
    if(!throwQueue.length){ clearInterval(throwTimer); throwTimer=null; }
  }, CFG.throwStaggerMs);
}
// merge savedGems data so N low-tier gems become 1 higher-tier gem
function mergeSavedGems(targetCount){
  // 1. Sanitize: ensure any uncolored gems are marked as 'gray' so merging doesn't break
  for(let i=0; i<savedGems.length; i++){
    if(!savedGems[i].c) savedGems[i].c = 'gray';
  }

  // 2. Strict merge (e.g. 10 gray -> 1 purple)
  while(savedGems.length > targetCount){
    let merged = false;
    for(const rule of CFG.mergeUp){
      const indices = [];
      for(let i = 0; i < savedGems.length; i++){
        if(savedGems[i].c === rule.from) indices.push(i);
        if(indices.length >= rule.count) break;
      }
      if(indices.length >= rule.count){
        // remove matched gems (reverse order to keep indices valid)
        for(let j = indices.length - 1; j >= 0; j--) savedGems.splice(indices[j], 1);
        // add the upgraded gem (no position — physics will settle it)
        savedGems.push({ c: rule.to });
        merged = true;
        break;
      }
    }
    if(!merged) break;  // can't merge anymore with strict rules, stop
  }

  // 3. Force merge: If STILL over limit, fuse the lowest value gems to forcefully reduce count
  while(savedGems.length > targetCount && savedGems.length >= 2){
    // Sort by tier, lowest tier first ('gray' is highest index 4, 'red' is 0)
    savedGems.sort((a, b) => {
      let tA = GEM_COLORS.indexOf(a.c);
      let tB = GEM_COLORS.indexOf(b.c);
      if (tA === -1) tA = 4;
      if (tB === -1) tB = 4;
      return tB - tA; 
    });

    let g1 = savedGems[0];
    let g2 = savedGems[1];

    let tier1 = GEM_COLORS.indexOf(g1.c);
    let tier2 = GEM_COLORS.indexOf(g2.c);
    if (tier1 === -1) tier1 = 4;
    if (tier2 === -1) tier2 = 4;

    // Upgrade to the next tier above the highest of the two fused gems
    let bestTier = Math.min(tier1, tier2);
    let nextTier = Math.max(0, bestTier - 1); // Cap at 'red' (0)

    savedGems.splice(0, 2);
    savedGems.push({ c: GEM_COLORS[nextTier] });
  }
}

function startCheerSequence(throws) {
  if (jarState === 'IDLE' || jarState === 'OUTRO') {
    JAR_CAP = computeJarCapacity();
    let targetPrefill = Math.max(0, JAR_CAP - throws.length);
    // merge saved gems to make room instead of deleting them
    if(savedGems.length > targetPrefill){
      mergeSavedGems(targetPrefill);
      saveBits(savedGems);
    }
    boot();
  }
  
  for(let c of throws) {
    if (throwQueue.length < CFG.maxQueuedThrows) {
      throwQueue.push(c);
    }
  }
  
  if (jarState === 'PLAYING') {
    pumpThrowQueue();
  }
  idleTime = 0;
}

function throwBits(n=1, color=null){
  let arr = [];
  for(let i=0; i<Math.max(1, n|0) && arr.length<CFG.maxQueuedThrows; i++)
    arr.push(color);
  startCheerSequence(arr);
}
// decompose a cheered bits amount into typed gem throws (see CFG.bitTiers)
function cheer(bits){
  let rest = Math.max(0, bits|0);
  if(!rest) return;

  let newThrows = [];
  for(const tier of CFG.bitTiers){
    if(rest <= 0) break;
    const n = Math.floor(rest / tier.min);
    if(n <= 0) continue;
    rest -= n * tier.min;
    for(let i = 0; i < n; i++) newThrows.push(tier.gem);
  }
  // minimum 1 gray for any nonzero cheer below the smallest tier
  if(!newThrows.length) newThrows.push('gray');
  
  startCheerSequence(newThrows);
}

function drawGem(ctx, g){
  const { im, scale, off } = g.plugin;
  const src = gemBaked.get(im) || im;   // baked raster (falls back to the svg pre-bake)
  ctx.save();
  if(g.plugin.alpha !== undefined) ctx.globalAlpha *= g.plugin.alpha;
  ctx.translate(g.position.x, g.position.y); ctx.rotate(g.angle);
  ctx.drawImage(src, -off[0]-im.width*scale/2, -off[1]-im.height*scale/2, im.width*scale, im.height*scale);
  ctx.restore();
}
function drawFlight(ctx, fl, now){
  const t = Math.min(1, (now-fl.start)/fl.dur);
  const p = cubic(fl, t);
  const size = lerp(fl.size0, GEM, smooth(Math.min(1, t/THROW.shrinkEnd)));
  const scale = size/Math.max(fl.im.width, fl.im.height);
  const src = gemBaked.get(fl.im) || fl.im;
  ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(fl.angle0 + fl.spin*t);
  ctx.drawImage(src, -fl.im.width*scale/2, -fl.im.height*scale/2,
                fl.im.width*scale, fl.im.height*scale);
  ctx.restore();
}

/* ---------------- main loop ---------------- */
function loop(ts){
  pumpStingerQueue(performance.now());   // start the next queued stinger once the screen is clear
  if (jarState === 'IDLE') {
    lastT = ts;
    const ctx = $('jarCv').getContext('2d');
    ctx.clearRect(0,0,W,H);
    renderFramePlayer(performance.now());   // a sub/dono can play over the idle (blank) jar
    requestAnimationFrame(loop);
    return;
  }

  if (lastT === null) lastT = ts;
  const dt = ts - lastT;
  lastT = ts;

  if (jarState === 'OUTRO') {
    outroT += dt;
    if (outroT > CFG.fadeOutMs) {
      jarState = 'IDLE';
      const ctx = $('jarCv').getContext('2d');
      ctx.clearRect(0,0,W,H);
      requestAnimationFrame(loop);
      return;
    }
  }

  if(playing){
    // clamp the frame delta: if the browser source stalls (OBS throttling,
    // tab hidden), the intro pauses instead of teleporting to the end with
    // the gems left hanging mid-air
    playhead = Math.min(playhead + Math.min(dt, 100)/1000*CFG.fps, LAST());
    introMs += Math.min(dt, 100);
    if(introHidden && playhead >= firstWallFrame){
      introHidden = false;
      unfreezeInto(playhead);
    }
    // the intro ends with the jar's last frame, and not before it has faded in
    // (normal has one frame, so its intro is just the fade)
    if(playhead >= LAST() && introMs >= JAR_FADE_IN_MS){
      playing = false;
      jarState = 'PLAYING';
      pumpThrowQueue();
      for(const g of prefill){
        Body.setStatic(g, false);
        Body.setVelocity(g,{x:0,y:0}); Body.setAngularVelocity(g,0);
        g.frictionAir = LIVE.frictionAir; g.restitution = LIVE.restitution;
      }
    }
  }

  // While the jar is moving (intro) the walls track it every frame; once it's
  // settled into PLAYING the pose is constant, so rebuild them once and then skip
  // — Body.setVertices on every wall each frame was pure waste during throwing.
  if(playing){
    positionWalls(pairsAt(playhead));
    lastWallKey = null;
  } else if(lastWallKey !== 'settled'){
    positionWalls(pairsAt(LAST()));
    lastWallKey = 'settled';
  }

  if(playing && !introHidden){
    const T = jarTransformBetween(LAST(), playhead);
    if(T){
      for(const g of prefill){
        const st = g.plugin.settled;
        const p = applyT(T,[st.x,st.y]);
        Body.setPosition(g,{x:p[0],y:p[1]});
        Body.setAngle(g, st.ang + T.dAng);
      }
    }
  }

  // Real-time fixed-step physics. The old code ran exactly 4 sub-steps per frame,
  // which advances the simulation a fixed 16.7ms regardless of the real frame time —
  // so whenever OBS dips below 60fps the gems fall in slow-motion and desync from the
  // (real-time) bit flights, which reads as "glitchy". Drive the same 240Hz sub-step
  // off real elapsed time instead: identical to before at 60fps, correct below it.
  const STEP = 1000/240;
  physicsAcc += Math.min(dt, 100);              // clamp so a stall can't spiral
  let pSteps = 0;
  while(physicsAcc >= STEP && pSteps < 24){ Engine.update(engine, STEP); physicsAcc -= STEP; pSteps++; }
  if(pSteps >= 24) physicsAcc = 0;              // fell far behind — drop the backlog

  // hand flights to physics part-way (pure animation until this moment)
  const now = performance.now();
  for(let i=flights.length-1; i>=0; i--){
    if(now - flights[i].start >= flights[i].dur*CFG.physicsHandoff){
      landFlight(flights[i]);
      flights.splice(i,1);
    }
  }
  if(!playing) cullEscaped(now);

  if (jarState === 'PLAYING') {
    if (throwQueue.length === 0 && flights.length === 0 && activeNotes.length === 0) {
      idleTime += dt;
      if (idleTime > CFG.waitBeforeFadeMs) {
        saveJarState();
        jarState = 'OUTRO';
        outroT = 0;
      }
    } else {
      idleTime = 0;
    }
  }

  const ctx = $('jarCv').getContext('2d');
  ctx.clearRect(0,0,W,H);
  const fi = Math.round(playing ? playhead : LAST());
  let alpha = 1;
  if (jarState === 'OUTRO') {
    alpha = 1 - Math.min(1, outroT / CFG.fadeOutMs);
  } else {
    alpha = playing ? Math.min(1, introMs / JAR_FADE_IN_MS) : 1;
  }
  const fillImg = fillBaked[fi] || fillImgs[fi], strokeImg = strokeBaked[fi] || strokeImgs[fi];

  /* The jar is assembled opaque on its own layer and blitted once at `alpha`.

     Fading each pass individually instead is what made the fade look wrong: the
     stroke is painted twice against complementary clips (see SEAM_OVERLAP), and
     wherever those two passes overlap, two draws at alpha a composite to
     1-(1-a)^2 — darker than the single draw everywhere else, so the overlap
     surfaced as a dark hairline the moment the jar started fading. Any two
     overlapping pieces had the same problem; a gem crossing the stroke was
     quietly denser than the rest of it all the way through the fade.

     Compositing first and fading once means every overlap resolves at full
     opacity, exactly as it looks when the jar is solid, and `alpha` then dims a
     finished picture. Costs one extra 400x400 blit per frame. */
  const lx = jarLayer();
  lx.drawImage(fillImg, 0, 0, W, H);

  const boxT = playing ? playhead : LAST();
  const corners = boxCornersAt(boxT);
  if(corners){
    lx.save();
    // grown by SEAM_OVERLAP so this pass covers the boundary the front pass
    // will only half-cover; the overlap ends up hidden under that pass
    lx.beginPath(); clipToCorners(lx, boxCornersAt(boxT, SEAM_OVERLAP)); lx.clip();
    lx.drawImage(strokeImg, 0, 0, W, H);
    lx.restore();
  }

  drawNotes(lx, now);   // middle ground: behind the gems, in front of the back art

  if(!introHidden) for(const g of prefill) drawGem(lx, g);
  for(const g of gems) drawGem(lx, g);

  if(corners){
    lx.save();
    lx.beginPath();
    lx.rect(0,0,W,H);
    clipToCorners(lx, corners);
    lx.clip('evenodd');
    lx.drawImage(strokeImg, 0, 0, W, H);
    lx.restore();
  } else if(NORMAL){
    // normal has no separate stroke art: the whole jar again, multiplied. Its white
    // fill leaves the gems untouched and its black stroke lands on top of them —
    // the same picture as v7's fill/stroke split, with no split files.
    // ponytail: only exact for black-on-white art; a coloured jar needs fill/ +
    // stroke/ exports like compact (and the clip passes above).
    lx.globalCompositeOperation = 'multiply';
    lx.drawImage(strokeImg, 0, 0, W, H);
    lx.globalCompositeOperation = 'source-over';
  } else {
    lx.drawImage(strokeImg, 0, 0, W, H);
  }

  // front-most plane: flying bits, over the jar stroke
  for(const fl of flights) drawFlight(lx, fl, now);

  ctx.globalAlpha = alpha;
  ctx.drawImage(lx.canvas, 0, 0);
  ctx.globalAlpha = 1;

  if(debug){
    ctx.fillStyle='rgba(58,123,255,.25)';   // the wall bodies themselves, WALL_T thick
    for(const w of walls){ ctx.beginPath(); clipToCorners(ctx, w.vertices.map(v=>[v.x, v.y])); ctx.fill(); }
    ctx.strokeStyle='#3a7bff'; ctx.lineWidth=2;
    ctx.beginPath();
    for(const [p,q] of pairsAt(playing ? playhead : LAST())){ ctx.moveTo(p[0],p[1]); ctx.lineTo(q[0],q[1]); }
    ctx.stroke();
    if(corners){ ctx.strokeStyle='#ff8a00'; ctx.beginPath(); clipToCorners(ctx,corners); ctx.stroke(); }
  }
  if(gemDebug){
    ctx.strokeStyle='#00b34d'; ctx.lineWidth=2;
    for(const g of [...prefill, ...gems]){   // the body itself (Matter circles are polygons too)
      ctx.beginPath(); clipToCorners(ctx, g.vertices.map(v=>[v.x, v.y])); ctx.stroke();
    }
  }
  if(arcDebug){
    ctx.lineWidth=1.5;
    for(let k=0; k<=10; k++){
      const p = throwPathFor(k/10);
      ctx.strokeStyle='rgba(255,0,80,.5)';
      ctx.beginPath(); ctx.moveTo(p.P0[0], p.P0[1]);
      ctx.bezierCurveTo(p.P1[0],p.P1[1], p.P2[0],p.P2[1], p.P3[0],p.P3[1]);
      ctx.stroke();
    }
  }
  renderFramePlayer(now);   // sub/dono overlay, drawn by this same loop
  requestAnimationFrame(loop);
}

/* =========================================================================
   Full-screen frame stingers (sub / donation)
   Driven by the SAME main loop that renders the jar (renderFramePlayer, called
   every frame from loop()). The old version ran its own requestAnimationFrame on
   a position:fixed canvas — that combination dropped out of the render in OBS's
   browser source (the sub never showed there, though it did in a real browser).
   It fades itself IN and OUT on its real timeline, so nothing else has to time it.
   ========================================================================= */
const stingerCv = ()=>$('stingerCv');
let stingerBusy = false;         // a sub/dono sequence is on screen
let framePlay = null;            // { imgs | video | live, type, t0, endAt?, failed? }

// src: an array of frame images/canvases (25fps), a <video> (the normal sub stinger), or
// a live one { ms, scale, draw(ms) -> canvas } that paints its own frame (the normal paper
// bag) at `scale` device px per px — the canvas gets that many, so it's shown 1:1, not resampled
function playFrames(src, type, fadeInMs = CFG.subFadeInMs){
  const video = src instanceof HTMLVideoElement ? src : null, live = src.draw ? src : null;
  if(!(video || live || src.length) || stingerBusy) return;
  stingerBusy = true;
  const cv = stingerCv();
  cv.width  = video ? (video.videoWidth  || W) : live ? W * live.scale : src[0].width;
  cv.height = video ? (video.videoHeight || H) : live ? H * live.scale : src[0].height;
  cv.style.display = 'block';
  const fp = framePlay = { imgs: video || live ? null : src, video, live, type, fadeInMs, t0: performance.now() };
  if(video){
    video.currentTime = 0;
    // a video that can't play must still end, or stingerBusy would block every later sub
    video.play().catch(err => { console.warn('[stinger] sub video: ' + err.message); fp.failed = true; });
  }
}
function playSub(){ playFrames(subVideo || subImgs, 'sub'); }

// What the HUD / D key play. d (from Streamer.bot, see connectStreamerbot):
// { name, amount, message, platform: 'twitch'|'youtube', avatar?: url, at: when the event came in }
const DEMO_DONATION = { name: 'ALongDisplayName_ForTheReceipt', amount: '$20.00', platform: 'twitch',
  message: 'Keep up the great streams, this one is for the coffee fund!' };

async function playDonation(d = DEMO_DONATION){
  if(!NORMAL){
    if(!donoImgs.length){ console.warn('[stinger] donation stinger not found — add ' + DONO_SVG); return; }
    return playFrames(donoImgs, 'dono');   // fades in and out like the sub stinger
  }
  if(!paperBag){ console.warn('[stinger] donation stinger not loaded — see the [assets] warning'); return; }
  if(stingerBusy || donoBuilding) return;  // one stinger at a time (playFrames would drop it anyway)
  donoBuilding = true;

  // the receipt: the donor's colour and avatar, given until DONOR_WAIT_MS after the event
  const left = Math.max(0, (d.at ?? performance.now()) + DONOR_WAIT_MS - performance.now());
  const [color, avatar] = await Promise.all(donorLookups(d).map(p => Promise.race([p, sleep(left).then(() => null)])));
  const anon = isAnonymous(d.name);
  // The receipt is rendered at the bag canvas's own pixel density (1 in OBS) and, below,
  // put down on whole pixels, so once the bag lands its text is copied 1:1 — exactly as
  // the HTML laid it out — instead of resampled (it rested at y 203.4 from a 2x texture,
  // which smeared every line across two pixel rows).
  const bag = paperBag, R = bag.dpr;
  let tex = null, sim = null;
  try{
    tex = await ReceiptHTML.build({ ...d, platform: anon ? null : d.platform, avatar,
      color: usernameCardColor(color || (d.platform === 'youtube' ? '#FF0000' : '#9146FF')) }, R);
    sim = new ReceiptSim(bag.track(), d, { stroke: bag.o.stroke, texture: tex, ...bag.o.receipt, resolution: R });
  }catch(err){ console.warn('[stinger] no receipt, the bag plays alone: ' + err.message); }
  donoBuilding = false;

  // drawn at full opacity on the bag's own canvas; the frame player fades that as one picture
  const last = Math.ceil(bag.o.duration * 60);   // the bag runs at 60fps
  const onPixel = v => Math.round(v * R) / R;
  playFrames({ ms: last / 60 * 1000, scale: R, draw(ms){
    const f = Math.min(last, Math.floor(ms / 1000 * 60)), x = bag.ctx;
    x.setTransform(R, 0, 0, R, 0, 0); x.clearRect(0, 0, bag.o.size, bag.o.size);
    bag.drawBag(bag.state(f / 60));
    if(sim){
      sim.step(f);
      const a = sim.anchor(f), left = a.x - a.hw;   // the receipt's left edge and top, onto whole pixels
      x.translate(onPixel(left) - left, onPixel(a.y) - a.y);
      sim.draw(x);
    }
    return bag.canvas;
  } }, 'dono');
}

/* The donor on the normal receipt, found the way the chat box finds them for its cards:
   Twitch name colour = the colour they chat in (learnt from chat, else ivr.fi), then
   tamed for white paper; YouTube = red; avatar from decapi.me, else a dicebear face.
   Cached per name, and started as the event comes in (connectStreamerbot), so they've
   had the chat's fade to arrive before the receipt is built.
   ponytail: a lookup slower than DONOR_WAIT_MS leaves the receipt without the avatar
   (and the name in the platform colour); raise it if that happens often — every ms past
   the chat's fade makes the bag start that much late. */
const DONOR_WAIT_MS = 800;
const isAnonymous = name => !name || /^anonymous$/i.test(name);
const twitchColors = new Map(), colorFetches = new Map(), avatarFetches = new Map();
function rememberTwitchColor(color, ...keys){
  if(typeof color !== 'string' || !color.startsWith('#')) return;
  keys.forEach(k => { if(k) twitchColors.set(String(k).toLowerCase(), color); });
}
function donorColor(d){
  const login = String(d.name || '').toLowerCase();
  if(d.platform !== 'twitch' || isAnonymous(login)) return Promise.resolve(null);
  if(twitchColors.has(login)) return Promise.resolve(twitchColors.get(login));
  if(!colorFetches.has(login)) colorFetches.set(login,
    fetch('https://api.ivr.fi/v2/twitch/user?login=' + encodeURIComponent(login))
      .then(r => r.ok ? r.json() : null).then(j => (Array.isArray(j) && j[0] && j[0].chatColor) || null).catch(() => null));
  return colorFetches.get(login);
}
function donorAvatar(d){
  const name = d.name, key = d.platform + ':' + name;   // a Twitch and a YouTube "Bob" are different people
  if(!avatarFetches.has(key)) avatarFetches.set(key, (async () => {
    let url = d.avatar;
    if(!url && d.platform === 'twitch'){
      try{ const r = await fetch('https://decapi.me/twitch/avatar/' + encodeURIComponent(name)); const t = r.ok ? (await r.text()).trim() : '';
           if(t.startsWith('http')) url = t; }catch(e){}
    }
    url = url || `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(name)}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
    const data = await ReceiptHTML.toDataURL(url).catch(() => null);   // the host must allow CORS (Twitch's CDN does)
    if(!data) avatarFetches.delete(key);                                // try again next time
    return data;
  })());
  return avatarFetches.get(key);
}
// [colour, avatar] promises; starting them twice reuses the first
const donorLookups = d => [donorColor(d), isAnonymous(d.name) ? Promise.resolve(null) : donorAvatar(d)];

// The chat box's username colours (its script.js tameUsernameColor / usernameCardColor,
// for a name with no outline, as on the receipt): a name too light for white paper is
// taken down to 3:1, a near-black one lifted a little. Keep in step with the chat box.
function tameUsernameColor(color, maxLum, minLum){
  if(!color || !color.startsWith('#')) return color;
  let h = color.slice(1); if(h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i+2), 16));
  const lin = c => { const s = c/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); };
  const lum = (r, g, b) => 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
  const L = lum(r, g, b);
  if(L > maxLum){
    let f = 1; while(lum(r*f, g*f, b*f) > maxLum && f > 0.05) f -= 0.02;
    return `rgb(${Math.round(r*f)}, ${Math.round(g*f)}, ${Math.round(b*f)})`;
  }
  if(L < minLum){
    let t = 0; while(lum(r+(255-r)*t, g+(255-g)*t, b+(255-b)*t) < minLum && t < 0.95) t += 0.02;
    return `rgb(${Math.round(r+(255-r)*t)}, ${Math.round(g+(255-g)*t)}, ${Math.round(b+(255-b)*t)})`;
  }
  return color;
}
function usernameCardColor(color){
  const onWhite = tameUsernameColor(color, 0.30, 0);
  return onWhite === color ? tameUsernameColor(color, 0.30, 0.04) : onWhite;
}
// the bell's intro (normal: resting while it fades in, like the jar), a short rest on
// its last frame, then its click loop once per raider: 1-10 viewers click that many
// times, more than that clicks CFG.raidMaxClicks times
function playRaid(viewers){
  if(!raidIntroImgs.length || !raidClickImgs.length){
    console.warn('[stinger] raid bell art not found — add ' + (NORMAL ? RAID_BODY + ' and ' + RAID_BUTTON : RAID_INTRO + ' and ' + RAID_CLICK));
    return;
  }
  const rest = Array(CFG.raidPauseFrames).fill(raidIntroImgs[raidIntroImgs.length - 1]);
  const n = raidClicks(viewers), clicks = Array.from({length: n}, () => raidClickImgs).flat();
  playFrames([...raidIntroImgs, ...rest, ...clicks], 'raid', NORMAL ? CFG.jarFadeInMs : CFG.subFadeInMs);
  // a music note per click (as the jar gives one per landing), on CFG.raidNoteFrame of each
  const first = raidIntroImgs.length + rest.length + CFG.raidNoteFrame;
  if(framePlay && framePlay.type === 'raid' && !framePlay.noteFrames)   // not if another stinger was busy
    framePlay.noteFrames = Array.from({length: n}, (_, k) => first + k*raidClickImgs.length);
}
const raidClicks = viewers => Math.min(CFG.raidMaxClicks, Math.max(1, Math.floor(viewers) || 1));

// Advance + draw the active sub/dono frame. Called once per frame by loop().
function renderFramePlayer(now){
  if(!framePlay) return;
  const { imgs, video, live, t0 } = framePlay;
  const cv = stingerCv(), ctx = cv.getContext('2d');
  const elapsed = now - t0;
  const ended = video ? (video.ended || !!video.error || framePlay.failed)
              : live  ? elapsed >= live.ms
                      : elapsed >= imgs.length / CFG.fps * 1000;
  if (ended && framePlay.endAt === undefined) framePlay.endAt = now;

  let alpha = 1, isFinished = false;
  if (ended) {                                  // hold the last frame (a video stays on it)
    const fo = now - framePlay.endAt - CFG.waitBeforeFadeMs;
    if (fo >= CFG.fadeOutMs) isFinished = true;
    else if (fo > 0) alpha = 1 - fo/CFG.fadeOutMs;             // real outro fade
  }
  if (elapsed < framePlay.fadeInMs) alpha = Math.min(alpha, elapsed / framePlay.fadeInMs);  // ease in

  if (isFinished) { ctx.clearRect(0,0,cv.width,cv.height); cv.style.display = 'none'; framePlay = null; stingerBusy = false; raidNotes.length = 0; return; }

  const fi = imgs && Math.min(imgs.length-1, Math.floor(elapsed/1000*CFG.fps));
  if (framePlay.noteFrames) {                   // raid bell: a note on each click (frames can be skipped)
    for (const f of framePlay.noteFrames) if (f > (framePlay.lastFi ?? -1) && f <= fi) spawnNote(raidNotes, raidNoteArcs);
    framePlay.lastFi = fi;
  }

  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.globalAlpha = alpha;
  drawNotes(ctx, now, raidNotes);               // behind the bell, as the jar's are behind its front stroke
  ctx.drawImage(video || (live ? live.draw(elapsed) : imgs[fi]), 0, 0, cv.width, cv.height);
  ctx.globalAlpha = 1;
}

/* =========================================================================
   Public API + Streamer.bot hookup point
   ========================================================================= */
window.stinger = {
  cheer,                           // stinger.cheer(1234) — cheered amount -> tiered gems
  throwBits,                       // stinger.throwBits(5, 'red'?) — raw throws (color optional)
  playSub,                         // stinger.playSub()
  playDonation,                    // stinger.playDonation({ name, amount, message, platform }?) — no data: a demo receipt
  playRaid,                        // stinger.playRaid(viewers) — raid bell, one click per raider (max 10)
  replayIntro: ()=>boot(Math.min(savedGems.length, computeJarCapacity())),
  setBits: n => { setBitCount(n); boot(Math.min(n, computeJarCapacity())); },
  resetBits: ()=> { setBitCount(0); boot(0); },
  get bits(){ return savedGems.length; },
};

/* =========================================================================
   Chat-overlay sync
   -------------------------------------------------------------------------
   The chat overlay (MultichatOverlayEseninocafe) and this stinger are two
   SEPARATE OBS browser sources layered over each other. OBS isolates browser
   sources (no shared localStorage / BroadcastChannel), so they can't talk to
   each other directly — instead they BOTH subscribe to the same Streamer.bot
   events and react on their own.

   This source drives NO fixed timing: the jar and the sub each fade themselves in
   and out on their real completion (the jar via its own intro/outro, the sub via
   renderFramePlayer). All triggerStinger does is hold the effect back by chatFadeMs
   so the chat has faded out first. Because there is no forced duration here, the
   jar can never "false fade" mid-throw.

   stingerContentMs() only *predicts* how long a stinger will run, so the overlay
   knows roughly when to fade its chat back in. It must stay identical to the copy
   in the overlay's script.js. It errs slightly long; and since this stinger is
   layered on top, a small mismatch is hidden behind it anyway.
   ========================================================================= */
const STINGER_SYNC = {
  chatFadeMs:     350,  // how long the overlay's chat fade takes (we just wait it out)
  // --- tip-jar timing model (mirrors CFG in this file) so the overlay can predict
  //     a cheer's length from the bit amount. Keep in step with CFG if you retune. ---
  fps:            25,   // CFG.fps
  // compact: collision.frames.length, the jar falls in; normal: JAR_FADE_IN_MS (400ms) of frames
  jarIntroFrames: { compact: 36, normal: 10 },
  throwStaggerMs: 170,  // CFG.throwStaggerMs — gap between queued throws
  throwFlightMs:  780,  // CFG.throwDurationMs — a gem's flight time
  noteTailMs:     850,  // CFG.noteDurationMs — the last note lingers after the last landing
  jarIdleMs:      800,  // CFG.waitBeforeFadeMs — idle the jar/sub holds before it fades out
  maxThrows:      40,   // CFG.maxQueuedThrows — the jar clamps a cheer to this many
  subFrames:      { compact: 65, normal: 146 },   // compact: subImgs.length; normal: the 5.84s webm (frames 0-145)
  // raid bell: intro frames, then the click loop once per raider (max raidMaxClicks).
  // compact: the Blender intro; normal: the 400ms fade-in on the resting bell
  raidIntroFrames: { compact: 35, normal: 10 },  // raidIntroImgs.length
  raidClickFrames: { compact: 7,  normal: 7 },   // raidClickImgs.length
  raidMaxClicks:  10,   // CFG.raidMaxClicks
  raidPauseFrames: 8,   // CFG.raidPauseFrames — rest between the intro and the first click
  // donation stinger (paper bag). compact: donoImgs.length; normal: the live bag's 2.4s
  // (PaperBagStinger's duration) in 25fps frames
  donoFrames:     { compact: 53, normal: 60 },
  marginMs:       250,  // small pad so the chat's card lands as the stinger clears, not before
  fadeOutMs:      400,  // CFG.fadeOutMs — a stinger's own fade out; the next queued one waits for it
  cardHoldMs:     2000, // between queued stingers: the chat is back showing the last one's card this long
};
// the chat's copy picks this from its own size (receipt = normal); here it's the variant
const stingerSize = () => NORMAL ? 'normal' : 'compact';

// How many gems a cheer throws — mirrors CFG.bitTiers decomposition (biggest tier
// first, one gem per full tier amount, remainder flows down), clamped like the jar.
function stingerCheerThrows(bits){
  const mins = [10000, 5000, 1000, 100, 10];
  let rest = Math.max(0, Math.floor(bits) || 0), n = 0;
  for(const m of mins){ const c = Math.floor(rest / m); if(c > 0){ rest -= c * m; n += c; } }
  if(n === 0) n = 1;                       // any nonzero cheer throws at least one gray
  return Math.min(n, STINGER_SYNC.maxThrows);
}

// Predicted on-screen time (ms), from the effect firing to it starting to fade out.
// Shared verbatim with the overlay so its chat returns as the stinger clears.
function stingerContentMs(kind, data){
  const S = STINGER_SYNC;
  if(kind === 'cheer'){
    const n = stingerCheerThrows(data && data.bits);
    const introMs  = S.jarIntroFrames[stingerSize()] / S.fps * 1000;   // jar falls in / fades in
    const throwsMs = (n - 1) * S.throwStaggerMs + S.throwFlightMs;      // launch all + last flight
    return Math.round(introMs + throwsMs + S.noteTailMs + S.jarIdleMs + S.marginMs);
  }
  if(kind === 'raid'){
    // bell intro, then one click per raider (1-10 viewers -> that many, more -> max)
    const clicks = Math.min(S.raidMaxClicks, Math.max(1, Math.floor(data && data.viewers) || 1));
    const frames = S.raidIntroFrames[stingerSize()] + S.raidPauseFrames + clicks * S.raidClickFrames[stingerSize()];
    return Math.round(frames / S.fps * 1000 + S.jarIdleMs + S.marginMs);
  }
  // donation / tip — the paper bag plays, then holds jarIdleMs, then fades
  if(kind === 'dono') return Math.round(S.donoFrames[stingerSize()] / S.fps * 1000 + S.jarIdleMs + S.marginMs);
  // sub / resub / gift / bomb — frames play, then hold jarIdleMs, then fade
  return Math.round(S.subFrames[stingerSize()] / S.fps * 1000 + S.jarIdleMs + S.marginMs);
}

// The stinger queue — identical to the chat box's copy. Both sources run it on the same
// events at the same moment, so they agree on when every stinger plays without talking.
// Each stinger gets a turn of its own: the chat fades out, the stinger plays, the chat
// comes back with that event's card and holds it cardHoldMs, and only then does the
// chat fade out for the next one, so stingers never overlap and each card follows its
// own stinger. A sub that lands while a sub stinger is still coming or on screen is
// part of that burst (a gift bomb) and adds no stinger. Returns { start, contentMs }
// (performance.now() ms), or null for such a sub.
let stingerQueueEnd = 0, stingerSubEnd = 0;   // when the next stinger may start / the last sub stinger is gone
function stingerSchedule(kind, data) {
  const S = STINGER_SYNC, now = performance.now();
  if (kind === 'sub' && now < stingerSubEnd) return null;
  const contentMs = stingerContentMs(kind, data);
  const start = Math.max(now + S.chatFadeMs, stingerQueueEnd);
  stingerQueueEnd = start + contentMs + S.chatFadeMs + S.cardHoldMs + S.chatFadeMs;   // chat back, card, chat out
  if (kind === 'sub') stingerSubEnd = start + contentMs - S.marginMs + S.fadeOutMs;
  return { start, contentMs };
}

// Route a Streamer.bot event to the stinger: queue its effect for its scheduled start.
// pumpStingerQueue (every frame, from loop) plays it then, and never while another
// stinger is still on screen — the jar included — so a late one waits rather than overlaps.
const stingerQueue = [];   // { start, effect }, in order
function triggerStinger(kind, effect, data){
  const slot = stingerSchedule(kind, data);
  if(slot) stingerQueue.push({ start: slot.start, effect });
}
function pumpStingerQueue(now){
  const next = stingerQueue[0];
  if(!next || now < next.start || stingerBusy || donoBuilding || jarState !== 'IDLE') return;
  stingerQueue.shift();
  next.effect();
}

// The label at the bottom (the chat box's): NOT CONNECTED until Streamer.bot connects,
// then CONNECTED for a moment before it fades. Built here rather than in index.html,
// so a cached old page paired with this script can't break it.
const connectionLabel = document.createElement('div');
connectionLabel.id = 'connectionLabel';
connectionLabel.textContent = 'NOT CONNECTED';
document.body.appendChild(connectionLabel);
let connectionHideTimer = 0;
function setConnectionStatus(connected){
  clearTimeout(connectionHideTimer);
  connectionLabel.textContent = connected ? 'CONNECTED' : 'NOT CONNECTED';
  connectionLabel.classList.remove('hidden');
  if(connected) connectionHideTimer = setTimeout(() => connectionLabel.classList.add('hidden'), 2000);
}

/* =========================================================================
   Streamer.bot connection
   Uses the official @streamerbot/client (loaded in index.html). It connects
   to the Streamer.bot WebSocket server running on the same machine as OBS
   (default 127.0.0.1:8080), auto-reconnects, and maps events to the stinger.

   OBS browser source: just point it at the deployed index.html at 400x400
   (compact) or 596x596 (normal).
   Optional URL params (all have sensible defaults):
     ?variant=compact|normal   force a variant instead of picking it by size
     ?address=127.0.0.1   Streamer.bot host
     ?port=8080           Streamer.bot WebSocket port
     ?showCheers=false    disable the cheer -> tip-jar reaction
     ?showSubs=false      disable the sub/resub/giftsub + YouTube membership/gifted -> sub stinger
     ?showRaids=false     disable the raid -> raid bell
     ?showDonations=false disable the Streamlabs donation / StreamElements tip / Super Chat -> paper bag
   ========================================================================= */
function connectStreamerbot(){
  const p = new URLSearchParams(location.search);
  const boolParam = (k, def) => {
    const v = p.get(k);
    if(v === null) return def;
    return v !== 'false' && v !== '0';
  };
  const address    = p.get('address') || '127.0.0.1';
  const port       = p.get('port')    || '8080';
  const showCheers = boolParam('showCheers', true);
  const showSubs   = boolParam('showSubs', true);
  const showRaids  = boolParam('showRaids', true);
  const showDonations = boolParam('showDonations', true);

  if(typeof StreamerbotClient === 'undefined'){
    console.warn('[stinger] @streamerbot/client not loaded — running in manual/HUD mode only');
    return;
  }

  const client = new StreamerbotClient({
    host: address,
    port: port,
    onConnect: () => setConnectionStatus(true),
    onDisconnect: () => setConnectionStatus(false),
  });

  // Cheer -> tiered bit gems in the tip jar (delayed so the chat fades out first)
  if(showCheers){
    client.on('Twitch.Cheer', ({ data }) => {
      const bits = Number(data?.bits ?? data?.message?.bits ?? 0);
      console.log('[stinger] Twitch.Cheer received — bits:', bits);
      if(bits > 0) triggerStinger('cheer', () => stinger.cheer(bits), { bits });
    });
  }

  // Sub / Resub / Gift sub, and YouTube's memberships -> full-screen sub stinger.
  // A gift-sub bomb fires many GiftSub events; triggerStinger collapses them into one.
  if(showSubs){
    const onSub = (name) => () => {
      console.log('[stinger] ' + name + ' received → sub stinger');
      triggerStinger('sub', () => stinger.playSub());
    };
    client.on('Twitch.Sub',     onSub('Twitch.Sub'));
    client.on('Twitch.ReSub',   onSub('Twitch.ReSub'));
    client.on('Twitch.GiftSub', onSub('Twitch.GiftSub'));
    client.on('YouTube.NewSponsor',     onSub('YouTube.NewSponsor'));       // new member
    client.on('YouTube.MembershipGift', onSub('YouTube.MembershipGift'));   // gifted memberships
  }

  // Raid -> the raid bell, one click per raider (the chat box reads the same data.viewers)
  if(showRaids){
    client.on('Twitch.Raid', ({ data }) => {
      const viewers = Number(data?.viewers ?? 0);
      console.log('[stinger] Twitch.Raid received — viewers:', viewers);
      triggerStinger('raid', () => stinger.playRaid(viewers), { viewers });
    });
  }

  // Donation / tip / Super Chat -> the paper-bag donation stinger (cheers stay with the tip
  // jar). The receipt reads the payload as the chat box's card does (a Twitch user,
  // Streamlabs' formatted amount / StreamElements' $amount; a Super Chat's own user and amount).
  if(showDonations){
    const onDono = (name, receipt) => ({ data = {} }) => {
      console.log('[stinger] ' + name + ' received → donation stinger');
      const d = { platform: 'twitch', message: data.message, ...receipt(data), at: performance.now() };
      if(NORMAL) donorLookups(d);   // colour + avatar start now, while the chat fades
      triggerStinger('dono', () => stinger.playDonation(d));
    };
    client.on('Streamlabs.Donation', onDono('Streamlabs.Donation', x => ({ name: x.from, amount: x.formattedAmount })));
    client.on('StreamElements.Tip',  onDono('StreamElements.Tip',  x => ({ name: x.username, amount: x.formattedAmount || `$${x.amount}` })));
    client.on('YouTube.SuperChat',   onDono('YouTube.SuperChat',   x => ({ name: x.user?.name || 'YouTube Fan', amount: x.amount,
      platform: 'youtube', avatar: x.user?.profileImageUrl })));
    // the receipt's name colour: every chatter's colour as it goes by, as the chat box keeps them
    if(NORMAL) client.on('Twitch.ChatMessage', ({ data }) => rememberTwitchColor(data?.message?.color,
      data?.message?.userId, data?.message?.username, data?.message?.displayName, data?.user?.id, data?.user?.login, data?.user?.name));
  }

  // Empty the tip jar at the start of each stream. Streamer.bot fires StreamOnline
  // when you go live; setBitCount(0) clears the saved gems silently (no animation —
  // the jar just stays blank until the first cheer). The jar still persists across
  // reloads DURING a stream, so a scene switch or accidental refresh won't wipe it.
  // Disable with ?resetEachStream=false.
  if(boolParam('resetEachStream', true)){
    client.on('Twitch.StreamOnline', () => {
      console.log('[stinger] Twitch.StreamOnline — emptying the tip jar for the new stream');
      setBitCount(0);
    });
  }
}
connectStreamerbot();

/* ---------------- HUD / keys / boot ---------------- */
function wireHud(){
  $('throw1Btn').onclick  = ()=>throwBits(1);
  $('throw10Btn').onclick = ()=>throwBits(10);
  $('cheerBtn').onclick   = ()=>cheer(parseInt($('cheerAmt').value, 10) || 0);
  $('subBtn').onclick     = ()=>playSub();
  $('donoBtn').onclick    = ()=>playDonation();
  $('raidBtn').onclick    = ()=>playRaid(parseInt($('raidAmt').value, 10) || 1);
  $('replayBtn').onclick  = ()=>stinger.replayIntro();
  $('demoBtn').onclick    = ()=>stinger.setBits(CFG.defaultBits);
  $('resetBtn').onclick   = ()=>stinger.resetBits();
  $('debugChk').onchange    = e=>{ debug = e.target.checked; };
  $('gemDebugChk').onchange = e=>{ gemDebug = e.target.checked; };
  $('arcDebugChk').onchange = e=>{ arcDebug = e.target.checked; };

  addEventListener('keydown', e=>{
    if(e.repeat) return;
    switch(e.key.toLowerCase()){
      case 'h': $('hud').hidden = !$('hud').hidden; break;
      case 't': throwBits(1); break;
      case 'y': throwBits(10); break;
      case 's': playSub(); break;
      case 'd': playDonation(); break;
      case 'b': playRaid(5); break;
      case 'r': stinger.replayIntro(); break;
    }
  });
}

(async ()=>{
  const params = new URLSearchParams(location.search);
  // Asset errors go to the console only: a red bar burned into the stream is worse
  // than the missing frame it's reporting, and the loader already retries and
  // patches over the frames it couldn't get.
  try{
    await loadAssets();
  }catch(err){
    console.error('[assets] ' + err.message);
    return;
  }

  bakeAssets();          // pre-rasterize every SVG frame/sprite so OBS isn't re-rasterizing them each frame
  buildSmoothedBoxes();
  if (params.has('bits')) {
    setBitCount(parseInt(params.get('bits'),10) || 0);
  } else {
    savedGems = loadBits();
    updateHUDCount();
  }
  if(params.has('debug')) $('hud').hidden = false;

  wireHud();
  // We don't boot() here so it starts visually empty (IDLE)
  jarState = 'IDLE';
  requestAnimationFrame(loop);
})();