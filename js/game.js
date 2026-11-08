'use strict';
/* Coil — a slither-style snake game. Canvas 2D, no dependencies. */

/* ------------------------------------------------------------------ *
 * Math helpers
 * ------------------------------------------------------------------ */
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick = arr => arr[(Math.random() * arr.length) | 0];
function angleDiff(a, b) {           // shortest signed turn from a to b
  let d = (b - a + Math.PI) % TAU;
  if (d < 0) d += TAU;
  return d - Math.PI;
}

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */
const CFG = {
  startLen:      180,    // body length at spawn
  baseSpeed:     160,
  boostSpeed:    305,
  turnRate:      10.8,   // rad/s, player — turns on a sixpence
  botTurnRate:   3.0,    // rivals are deliberately clumsier than you

  // The world has no edge. Food is generated per chunk around you and
  // thrown away once you are far enough that you could never see it.
  chunk:         500,    // world units per chunk
  chunkRadius:   3,      // chunks loaded either side of you -> 7x7
  foodPerChunk:  12,

  // Rivals are kept topped up around you rather than living in a fixed arena.
  botCount:      13,     // nearby rivals at the start
  botsMax:       24,     // ...rising to this the further you roam
  botsPerUnit:   2600,   // one extra rival per this much distance explored
  spawnRingMin:  950,    // new rivals appear off-screen, never on top of you
  spawnRingMax:  1700,
  despawnR:      4200,   // rivals further than this are forgotten

  // Anti-circling: how long a bot's winding is remembered, and how far it may
  // wind one way before it is forced to straighten out.
  coilHalfLife:  2.2,    // seconds
  coilLimit:     4.2,    // radians of accumulated same-way turning

  radarRange:    2200,   // world units shown by the radar in the corner
  boostDrain:    40,     // length lost per second of sprinting
  boostMinLen:   150,    // can't sprint below this (startLen is 180, so you start with a little in the tank)
  deathYield:    0.55,   // fraction of length that becomes food on death
  pathStep:      3,      // world units between recorded trail points
  girth:         7,      // body radius, the same at every length
};

const NAMES = ['Viper','Mamba','Noodle','Zigzag','Cobra','Slinky','Taipan','Krait',
               'Python','Racer','Adder','Boa','Sidewinder','Ribbon','Garter','Rattler'];

/* Thickness never changes. Growing makes you longer, not fatter — so the
 * camera must hold still too, or zooming out to fit a bigger snake would make
 * it look thinner anyway, which is the very thing we are avoiding. */
const radiusFor = () => CFG.girth;

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
let W = 0, H = 0, DPR = 1;

const safeInset = { l: 0, b: 0 };
function readSafeInsets() {
  const cs = getComputedStyle(document.documentElement);
  safeInset.l = parseFloat(cs.getPropertyValue("--safe-l")) || 0;
  safeInset.b = parseFloat(cs.getPropertyValue("--safe-b")) || 0;
}

function resize() {
  readSafeInsets();
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 120));

/* ------------------------------------------------------------------ *
 * Spatial hash — bodies and food each get one
 * ------------------------------------------------------------------ */
class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  clear() { this.map.clear(); }
  _key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }
  insert(x, y, item) {
    const k = this._key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const b = this.map.get(k);
    if (b) b.push(item); else this.map.set(k, [item]);
  }
  query(x, y, r, out) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const b = this.map.get(this._key(cx, cy));
        if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    return out;
  }
}
const bodyGrid = new Grid(80);
const foodGrid = new Grid(120);
const scratch = [];

/* ------------------------------------------------------------------ *
 * Snake
 * ------------------------------------------------------------------ */
class Snake {
  constructor(x, y, angle, hue, isPlayer, name) {
    this.x = x; this.y = y;
    this.angle = angle; this.targetAngle = angle;
    this.hue = hue;
    this.isPlayer = !!isPlayer;
    this.name = name;
    this.len = CFG.startLen;
    this.r = radiusFor(this.len);
    this.alive = true;
    this.boosting = false;
    this.kills = 0;
    this.path = [{ x, y, s: 0 }];   // newest first; s = distance to previous point
    this.pathLen = 0;
    this.segments = [];             // resampled collision/draw circles
    this.think = 0;
    this.targetFood = null;
    this.boostUrge = 0;
    this.shimmer = Math.random() * TAU;
    this.coil = 0;                  // running total of same-direction turning
    this.unwind = false;            // forced to straighten out
    this.wander = Math.random() * TAU;
  }

  get speed() { return this.boosting ? CFG.boostSpeed : CFG.baseSpeed; }

  steer(dt) {
    const rate = this.isPlayer ? CFG.turnRate : CFG.botTurnRate;
    const d = angleDiff(this.angle, this.targetAngle);
    const turn = clamp(d, -rate * dt, rate * dt);
    this.angle += turn;
    if (this.angle > Math.PI) this.angle -= TAU;
    else if (this.angle < -Math.PI) this.angle += TAU;

    // Winding one way adds up and fades; a snake going round and round keeps
    // pushing this away from zero, while ordinary weaving cancels itself out.
    this.coil = this.coil * Math.pow(0.5, dt / CFG.coilHalfLife) + turn;
  }

  update(dt, world) {
    this.steer(dt);

    if (this.boosting && this.len > CFG.boostMinLen) {
      const burn = CFG.boostDrain * dt;
      this.len -= burn;
      this.shimmer += dt * 14;
      // sprinting sheds length as food behind the tail
      this.burnAccum = (this.burnAccum || 0) + burn;
      if (this.burnAccum > 9) {
        this.burnAccum = 0;
        const tail = this.segments[this.segments.length - 1];
        if (tail) world.addFood(tail.x + rand(-5, 5), tail.y + rand(-5, 5), 6, this.hue);
      }
    } else {
      this.boosting = false;
    }

    const v = this.speed;
    this.x += Math.cos(this.angle) * v * dt;
    this.y += Math.sin(this.angle) * v * dt;

    const head = this.path[0];
    const dx = this.x - head.x, dy = this.y - head.y;
    const dist = Math.hypot(dx, dy);
    if (dist >= CFG.pathStep) {
      this.path.unshift({ x: this.x, y: this.y, s: dist });
      this.pathLen += dist;
    }
    // trim trail we no longer need
    const keep = this.len + 40;
    while (this.path.length > 2) {
      const last = this.path[this.path.length - 1];
      if (this.pathLen - last.s < keep) break;
      this.pathLen -= last.s;
      this.path.pop();
    }

    this.r = radiusFor(this.len);
    this.resample();
  }

  /* Walk the trail, dropping evenly spaced circles along it. */
  resample() {
    const r = this.r;
    // Girth no longer grows, so this spacing alone decides how many circles a
    // long snake costs. 0.9r still overlaps neighbours (round caps, radius r),
    // so the body stays gap-free for collision while halving the count.
    const spacing = Math.max(5, r * 0.9);
    const total = this.len;
    const segs = this.segments;
    segs.length = 0;
    segs.push({ x: this.x, y: this.y, r, owner: this });

    let px = this.x, py = this.y;
    let travelled = 0, next = spacing, i = 0;
    const path = this.path;
    while (i < path.length && next <= total) {
      const p = path[i];
      const dx = p.x - px, dy = p.y - py;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        while (travelled + d >= next && next <= total) {
          const t = (next - travelled) / d;
          segs.push({ x: px + dx * t, y: py + dy * t, r, owner: this });
          next += spacing;
        }
        travelled += d;
      }
      px = p.x; py = p.y; i++;
    }
  }

  grow(amount) { this.len += amount; }
}

/* ------------------------------------------------------------------ *
 * World
 * ------------------------------------------------------------------ */
const world = {
  snakes: [],
  food: [],
  chunks: new Set(),
  lastChunk: null,
  explored: 0,
  nextSpawnAt: 0,
  player: null,
  time: 0,
  running: false,
  paused: false,
  pendingReload: false,

  addFood(x, y, value, hue, drifting, ck = null) {
    this.food.push({
      x, y, value, ck,
      r: clamp(3.2 + value * 0.42, 3.2, 13),
      hue: hue === undefined ? randInt(0, 359) : hue,
      ph: Math.random() * TAU,
      vx: drifting ? rand(-18, 18) : 0,
      vy: drifting ? rand(-18, 18) : 0,
    });
  },

  /* Somewhere clear, out past the edge of the screen, measured from you. */
  spawnPoint(minR, maxR) {
    const base = this.player || { x: 0, y: 0 };
    for (let a = 0; a < 24; a++) {
      const ang = rand(0, TAU), rad = rand(minR, maxR);
      const x = base.x + Math.cos(ang) * rad, y = base.y + Math.sin(ang) * rad;
      let ok = true;
      for (const s of this.snakes) {
        if (!s.alive) continue;
        for (const seg of s.segments) {
          if ((seg.x - x) ** 2 + (seg.y - y) ** 2 < 170 * 170) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (ok) return { x, y };
    }
    const ang = rand(0, TAU);
    return { x: base.x + Math.cos(ang) * maxR, y: base.y + Math.sin(ang) * maxR };
  },

  addBot(minR = CFG.spawnRingMin, maxR = CFG.spawnRingMax) {
    const p = this.spawnPoint(minR, maxR);
    const hue = (205 + Math.random() * 255) % 360;   // keep green for the player
    const s = new Snake(p.x, p.y, rand(0, TAU), hue, false, pick(NAMES));
    s.len = CFG.startLen + rand(0, 150);
    s.resample();
    this.snakes.push(s);
    return s;
  },

  reset() {
    this.snakes.length = 0;
    this.food.length = 0;
    this.chunks.clear();
    this.lastChunk = null;
    this.explored = 0;
    this.nextSpawnAt = 0;
    this.time = 0;

    // you always start at the origin of a world that has no middle and no edge
    const player = new Snake(0, 0, rand(0, TAU), 135, true, 'You');
    this.player = player;
    this.snakes.push(player);
    player.resample();

    this.updateChunks();
    for (let i = 0; i < CFG.botCount; i++) this.addBot(450, 1800);

    camera.x = player.x; camera.y = player.y;
    camera.scale = targetScale(player);
  },

  /* ---- endless world ------------------------------------------------ *
   * Food belongs to a chunk. Chunks within reach of you are filled in as
   * you travel and dropped once you leave, so the world is unbounded but
   * only ever a few hundred pellets wide in memory. Walk away and come
   * back and the pellets are freshly scattered — you can't see far enough
   * to tell, and it means there is no global state to grow forever.
   * ------------------------------------------------------------------- */
  updateChunks() {
    const p = this.player;
    if (!p) return;
    const C = CFG.chunk;
    const cx0 = Math.floor(p.x / C), cy0 = Math.floor(p.y / C);
    const here = cx0 + ',' + cy0;
    if (here === this.lastChunk) return;        // only on crossing a border
    this.lastChunk = here;

    const R = CFG.chunkRadius;
    const want = new Set();
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        const cx = cx0 + dx, cy = cy0 + dy, k = cx + ',' + cy;
        want.add(k);
        if (this.chunks.has(k)) continue;
        this.chunks.add(k);
        for (let i = 0; i < CFG.foodPerChunk; i++) {
          this.addFood((cx + Math.random()) * C, (cy + Math.random()) * C,
                       rand(3, 7), randInt(0, 359), false, k);
        }
      }
    }

    let dropped = false;
    for (const k of this.chunks) if (!want.has(k)) { this.chunks.delete(k); dropped = true; }
    if (dropped) {
      // loose food (from deaths and sprinting) belongs to no chunk, so it is
      // culled by distance instead
      const reach = (R + 1) * C * 1.5;
      this.food = this.food.filter(f => f.ck
        ? want.has(f.ck)
        : Math.abs(f.x - p.x) < reach && Math.abs(f.y - p.y) < reach);
    }
  },

  /* The further you stray, the busier it gets. */
  populationTarget() {
    const p = this.player;
    this.explored = Math.max(this.explored, Math.hypot(p.x, p.y));
    return CFG.botCount +
           Math.min(CFG.botsMax - CFG.botCount, Math.floor(this.explored / CFG.botsPerUnit));
  },

  maintainPopulation() {
    const p = this.player;
    if (!p) return;
    const far = CFG.despawnR * CFG.despawnR;
    this.snakes = this.snakes.filter(s =>
      s.isPlayer || ((s.x - p.x) ** 2 + (s.y - p.y) ** 2) < far);

    let rivals = 0;
    for (const s of this.snakes) if (s.alive && !s.isPlayer) rivals++;
    const deficit = this.populationTarget() - rivals;
    if (deficit > 0 && this.time > this.nextSpawnAt) {
      this.addBot();
      // a lone replacement drifts in; a big shortfall (you have covered a lot
      // of ground, or left everyone behind) fills in much faster
      this.nextSpawnAt = this.time + rand(0.8, 2.2) / Math.max(1, deficit * 0.6);
    }
  },

  /* A dead snake becomes food — longer snake, more food. */
  scatter(snake) {
    const segs = snake.segments;
    const pellets = clamp(Math.floor(snake.len / 24), 6, 160);
    const totalValue = snake.len * CFG.deathYield;
    const per = totalValue / pellets;
    for (let i = 0; i < pellets; i++) {
      const seg = segs[Math.min(segs.length - 1, Math.floor(i / pellets * segs.length))];
      if (!seg) break;
      this.addFood(seg.x + rand(-7, 7), seg.y + rand(-7, 7), per, snake.hue, true);   // loose: no chunk
    }
  },

  kill(snake, killer) {
    if (!snake.alive) return;
    snake.alive = false;
    this.scatter(snake);
    if (killer && killer !== snake) killer.kills++;
    if (snake.isPlayer) {
      shake = 18;
      endGame();
    }
    // rivals are replaced by maintainPopulation, near wherever you are now
  },
};

/* ------------------------------------------------------------------ *
 * Bot brains
 * ------------------------------------------------------------------ */
function nearestFood(s, radius) {
  foodGrid.query(s.x, s.y, radius, scratch);
  let best = null, bestD = Infinity;
  for (let i = 0; i < scratch.length; i++) {
    const f = scratch[i];
    const d = (f.x - s.x) ** 2 + (f.y - s.y) ** 2;
    // prefer fat pellets
    const score = d / (1 + f.value * 0.5);
    if (score < bestD) { bestD = score; best = f; }
  }
  return best;
}

function pathBlocked(s, x, y, pad) {
  bodyGrid.query(x, y, pad + 32, scratch);
  for (let i = 0; i < scratch.length; i++) {
    const seg = scratch[i];
    if (seg.owner === s) continue;
    const dr = pad + seg.r;
    if ((seg.x - x) ** 2 + (seg.y - y) ** 2 < dr * dr) return true;
  }
  return false;
}

function botThink(s, dt) {
  s.think -= dt;
  if (s.think > 0) return;
  s.think = rand(0.07, 0.13);

  if (!s.targetFood || s.targetFood.dead || Math.random() < 0.12) {
    s.targetFood = nearestFood(s, 620);
  }
  const tf = s.targetFood;

  s.wander += rand(-0.5, 0.5) * s.think;

  /* A snake that only ever optimises the next heading settles happily into a
   * perfect circle — nothing in a chase says "stop orbiting". So track how far
   * it has wound one way and, past a limit, refuse to wind any further until
   * it has straightened out. */
  const wind = Math.sign(s.coil);
  if (Math.abs(s.coil) > CFG.coilLimit) s.unwind = true;
  if (s.unwind && Math.abs(s.coil) < CFG.coilLimit * 0.35) s.unwind = false;

  const look = 70 + s.r * 3.4 + (s.boosting ? 70 : 0);
  const offsets = [0, 0.2, -0.2, 0.45, -0.45, 0.8, -0.8, 1.3, -1.3, 1.9, -1.9];
  let best = s.angle, bestCost = Infinity;

  for (const off of offsets) {
    // while unwinding, turning further the same way is simply not on offer
    if (s.unwind && off * wind > 0.2) continue;

    const a = s.angle + off;
    const ca = Math.cos(a), sa = Math.sin(a);
    let cost = Math.abs(off) * 6;

    // the more it has wound up, the dearer another turn the same way becomes
    cost += Math.max(0, off * wind) * Math.abs(s.coil) * 14;

    for (let step = 1; step <= 3; step++) {
      const d = look * (step / 3);
      const px = s.x + ca * d, py = s.y + sa * d;
      if (pathBlocked(s, px, py, s.r + 4)) { cost += 4000 / step; break; }
    }
    const px = s.x + ca * look, py = s.y + sa * look;
    if (tf) cost += Math.hypot(tf.x - px, tf.y - py) * 0.6;          // chase the pellet
    else cost += Math.hypot(s.x + Math.cos(s.wander) * look - px,    // or just roam
                            s.y + Math.sin(s.wander) * look - py) * 0.5;

    if (cost < bestCost) { bestCost = cost; best = a; }
  }
  s.targetAngle = best;

  // occasional sprint when well fed and chasing something worthwhile
  s.boostUrge -= s.think;
  if (s.boostUrge <= 0) {
    s.boostUrge = rand(1.5, 5);
    s.boosting = s.len > 420 && Math.random() < 0.3;
  }
  if (s.len <= CFG.boostMinLen) s.boosting = false;
}

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */
const camera = { x: 0, y: 0, scale: 1 };
let shake = 0;

function targetScale(p) {
  const viewR = 176 + CFG.girth * 4.6;   // fixed: thickness on screen never drifts
  return clamp(Math.min(W, H) / 2 / viewR, 0.5, 1.6);
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */
const stick = {
  active: false, id: null,
  ox: 0, oy: 0, x: 0, y: 0,
  downAt: 0, moved: 0, sprinting: false,
};
const LEASH = 64;

/* Double-tap-and-hold to sprint: a quick tap, then press again and keep the
 * finger down. The second press steers as usual, so you can keep turning
 * while you burn. A tap counts only if it was short and barely moved. */
const TAP_MS = 260, TAP_SLOP = 16, DOUBLE_MS = 330, DOUBLE_SLOP = 90;
let lastTapEnd = 0, lastTapX = 0, lastTapY = 0;

let boostFromSecondFinger = false, boostFromKey = false, boostFromMouse = false;
const sprinting = () => stick.sprinting || boostFromSecondFinger || boostFromKey || boostFromMouse;

function setStickTarget() {
  const dx = stick.x - stick.ox, dy = stick.y - stick.oy;
  const d = Math.hypot(dx, dy);
  if (d < 8) return;
  if (d > LEASH) {                       // let the origin trail the finger
    stick.ox = stick.x - dx / d * LEASH;
    stick.oy = stick.y - dy / d * LEASH;
  }
  if (world.player) world.player.targetAngle = Math.atan2(dy, dx);
}

canvas.addEventListener('pointerdown', e => {
  if (!world.running || world.paused) return;
  try { canvas.setPointerCapture?.(e.pointerId); } catch (err) {}

  if (e.pointerType === 'mouse') { boostFromMouse = true; return; }

  if (stick.active) { boostFromSecondFinger = true; return; }   // second finger also sprints

  const now = performance.now();
  const isDouble = now - lastTapEnd < DOUBLE_MS &&
                   Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < DOUBLE_SLOP;

  stick.active = true; stick.id = e.pointerId;
  stick.ox = stick.x = e.clientX; stick.oy = stick.y = e.clientY;
  stick.downAt = now; stick.moved = 0;
  stick.sprinting = isDouble;
  lastTapEnd = 0;
}, { passive: true });

canvas.addEventListener('pointermove', e => {
  if (!world.running || world.paused) return;
  if (e.pointerType === 'mouse') {
    if (!world.player) return;
    world.player.targetAngle = Math.atan2(e.clientY - H / 2, e.clientX - W / 2);
    return;
  }
  if (!stick.active || e.pointerId !== stick.id) return;
  stick.moved += Math.hypot(e.clientX - stick.x, e.clientY - stick.y);
  stick.x = e.clientX; stick.y = e.clientY;
  setStickTarget();
}, { passive: true });

function endPointer(e) {
  if (e.pointerType === 'mouse') { boostFromMouse = false; return; }
  if (!stick.active || e.pointerId !== stick.id) { boostFromSecondFinger = false; return; }

  const now = performance.now();
  const wasTap = !stick.sprinting &&
                 now - stick.downAt < TAP_MS &&
                 stick.moved < TAP_SLOP;
  if (wasTap) { lastTapEnd = now; lastTapX = stick.x; lastTapY = stick.y; }
  else lastTapEnd = 0;

  stick.active = false; stick.id = null; stick.sprinting = false;
}
canvas.addEventListener('pointerup', endPointer, { passive: true });
canvas.addEventListener('pointercancel', endPointer, { passive: true });

addEventListener('keydown', e => {
  if (e.code === 'Space' && !world.paused) { boostFromKey = true; e.preventDefault(); }
  if (e.code === 'Enter' && !world.running) startGame();
  if (e.code === 'Escape' || e.code === 'KeyP') {
    e.preventDefault();
    if (world.paused) resumeGame(); else pauseGame();
  }
});
addEventListener('keyup', e => { if (e.code === 'Space') boostFromKey = false; });
addEventListener('contextmenu', e => e.preventDefault());

addEventListener('keydown', e => {
  if (e.code === 'Space') { boostFromKey = true; e.preventDefault(); }
  if (e.code === 'Enter' && !world.running) startGame();
});
addEventListener('keyup', e => { if (e.code === 'Space') boostFromKey = false; });
addEventListener('contextmenu', e => e.preventDefault());

/* ------------------------------------------------------------------ *
 * Simulation step
 * ------------------------------------------------------------------ */
function step(dt) {
  const player = world.player;

  if (player.alive) {
    player.boosting = world.running && sprinting() && player.len > CFG.boostMinLen;
  }

  for (const s of world.snakes) if (s.alive && !s.isPlayer) botThink(s, dt);
  for (const s of world.snakes) if (s.alive) s.update(dt, world);

  // drifting death-food slows to a stop
  for (const f of world.food) {
    if (f.vx || f.vy) {
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.vx *= 0.92; f.vy *= 0.92;
      if (Math.abs(f.vx) < 1) { f.vx = 0; f.vy = 0; }
    }
  }

  // rebuild hashes
  bodyGrid.clear();
  for (const s of world.snakes) {
    if (!s.alive) continue;
    const segs = s.segments;
    for (let i = 0; i < segs.length; i++) bodyGrid.insert(segs[i].x, segs[i].y, segs[i]);
  }
  foodGrid.clear();
  for (const f of world.food) foodGrid.insert(f.x, f.y, f);

  // collisions: head against every other snake's body
  const deaths = [];
  for (const s of world.snakes) {
    if (!s.alive) continue;
    bodyGrid.query(s.x, s.y, s.r + 34, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const seg = scratch[i];
      if (seg.owner === s) continue;           // your own tail is safe
      const rr = s.r * 0.86 + seg.r;
      if ((seg.x - s.x) ** 2 + (seg.y - s.y) ** 2 < rr * rr) { deaths.push([s, seg.owner]); break; }
    }
  }
  for (const [s, killer] of deaths) world.kill(s, killer);

  // eating
  for (const s of world.snakes) {
    if (!s.alive) continue;
    const reach = s.r + 16;
    foodGrid.query(s.x, s.y, reach + 14, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const f = scratch[i];
      if (f.dead) continue;
      const rr = reach + f.r;
      if ((f.x - s.x) ** 2 + (f.y - s.y) ** 2 < rr * rr) {
        f.dead = true;
        s.grow(f.value);
        if (s.isPlayer) pops.push({ x: f.x, y: f.y, t: 0, hue: f.hue });
      }
    }
  }
  if (world.food.some(f => f.dead)) world.food = world.food.filter(f => !f.dead);

  world.snakes = world.snakes.filter(s => s.alive || s.isPlayer);
  world.updateChunks();        // scatter food into newly reachable ground
  world.maintainPopulation();  // and keep rivals around you as you travel
  world.time += dt;

  // camera
  const cx = player.x, cy = player.y;
  const k = 1 - Math.pow(0.0016, dt);
  camera.x += (cx - camera.x) * k;
  camera.y += (cy - camera.y) * k;
  camera.scale += (targetScale(player) - camera.scale) * (1 - Math.pow(0.08, dt));
  if (shake > 0) shake = Math.max(0, shake - dt * 40);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
const pops = [];

function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#070a12';
  ctx.fillRect(0, 0, W, H);

  const sc = camera.scale;
  let ox = W / 2 - camera.x * sc, oy = H / 2 - camera.y * sc;
  if (shake > 0) { ox += rand(-shake, shake); oy += rand(-shake, shake); }

  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.translate(ox, oy);
  ctx.scale(sc, sc);

  // visible world rect
  const vx0 = (0 - ox) / sc, vy0 = (0 - oy) / sc;
  const vx1 = (W - ox) / sc, vy1 = (H - oy) / sc;

  drawBackground(vx0, vy0, vx1, vy1);
  drawFood(vx0, vy0, vx1, vy1);
  for (const s of world.snakes) if (s.alive && !s.isPlayer) drawSnake(s, vx0, vy0, vx1, vy1);
  if (world.player.alive) drawSnake(world.player, vx0, vy0, vx1, vy1);
  drawPops();

  ctx.restore();

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (stick.active) drawStick();
  drawRadar();
}

function drawBackground(vx0, vy0, vx1, vy1) {
  const G = 110;
  ctx.lineWidth = 1 / camera.scale;
  ctx.strokeStyle = 'rgba(99,122,196,0.07)';
  ctx.beginPath();
  for (let x = Math.floor(vx0 / G) * G; x < vx1; x += G) { ctx.moveTo(x, vy0); ctx.lineTo(x, vy1); }
  for (let y = Math.floor(vy0 / G) * G; y < vy1; y += G) { ctx.moveTo(vx0, y); ctx.lineTo(vx1, y); }
  ctx.stroke();
}

function drawFood(vx0, vy0, vx1, vy1) {
  const t = world.time;
  for (const f of world.food) {
    if (f.x < vx0 - 20 || f.x > vx1 + 20 || f.y < vy0 - 20 || f.y > vy1 + 20) continue;
    const pulse = 0.78 + 0.22 * Math.sin(t * 3 + f.ph);
    const r = f.r * pulse;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r * 2.6, 0, TAU);
    ctx.fillStyle = `hsla(${f.hue},90%,62%,0.13)`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, TAU);
    ctx.fillStyle = `hsl(${f.hue},92%,66%)`;
    ctx.fill();
  }
}

function drawSnake(s, vx0, vy0, vx1, vy1) {
  const segs = s.segments;
  if (segs.length < 2) return;
  // cheap off-screen cull on the head and tail
  const pad = 200;
  const tail = segs[segs.length - 1];
  if ((s.x < vx0 - pad && tail.x < vx0 - pad) || (s.x > vx1 + pad && tail.x > vx1 + pad) ||
      (s.y < vy0 - pad && tail.y < vy0 - pad) || (s.y > vy1 + pad && tail.y > vy1 + pad)) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(segs[0].x, segs[0].y);
  for (let i = 1; i < segs.length; i++) ctx.lineTo(segs[i].x, segs[i].y);

  const lit = s.boosting ? 14 : 0;
  ctx.strokeStyle = `hsla(${s.hue},95%,${62 + lit}%,${s.boosting ? 0.3 : 0.16})`;
  ctx.lineWidth = s.r * 2 + 12;
  ctx.stroke();

  ctx.strokeStyle = `hsl(${s.hue},72%,${44 + lit}%)`;
  ctx.lineWidth = s.r * 2;
  ctx.stroke();

  ctx.strokeStyle = `hsl(${s.hue},92%,${66 + lit}%)`;
  ctx.lineWidth = s.r * 0.95;
  ctx.stroke();

  drawHead(s);
}

function drawHead(s) {
  const r = s.r;
  const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
  const px = -sa, py = ca;                       // perpendicular
  const ex = s.x + ca * r * 0.34, ey = s.y + sa * r * 0.34;
  const off = r * 0.52, eyeR = r * 0.40, pupR = r * 0.21;

  for (const side of [1, -1]) {
    const x = ex + px * off * side, y = ey + py * off * side;
    ctx.beginPath(); ctx.arc(x, y, eyeR, 0, TAU);
    ctx.fillStyle = '#fdfdff'; ctx.fill();
    ctx.beginPath();
    ctx.arc(x + ca * eyeR * 0.42, y + sa * eyeR * 0.42, pupR, 0, TAU);
    ctx.fillStyle = '#0a0d16'; ctx.fill();
  }
}

function drawPops() {
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.t += 0.06;
    if (p.t >= 1) { pops.splice(i, 1); continue; }
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 + p.t * 22, 0, TAU);
    ctx.strokeStyle = `hsla(${p.hue},95%,70%,${(1 - p.t) * 0.5})`;
    ctx.lineWidth = 2.5 * (1 - p.t);
    ctx.stroke();
  }
}

function drawStick() {
  ctx.save();
  ctx.beginPath();
  ctx.arc(stick.ox, stick.oy, LEASH, 0, TAU);
  ctx.strokeStyle = stick.sprinting ? 'rgba(250,204,21,0.3)' : 'rgba(232,237,255,0.16)';
  ctx.lineWidth = 2;
  ctx.stroke();
  const dx = stick.x - stick.ox, dy = stick.y - stick.oy;
  const d = Math.min(LEASH, Math.hypot(dx, dy)) || 0;
  const a = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.arc(stick.ox + Math.cos(a) * d, stick.oy + Math.sin(a) * d, 20, 0, TAU);
  ctx.fillStyle = stick.sprinting ? 'rgba(250,204,21,0.34)' : 'rgba(74,222,128,0.28)';
  ctx.fill();
  ctx.strokeStyle = stick.sprinting ? 'rgba(250,204,21,0.75)' : 'rgba(74,222,128,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/* No map without a world: a radar of who is near you instead, with distant
 * rivals pinned to the rim so you can still tell which way trouble is. */
function drawRadar() {
  const size = Math.min(104, Math.min(W, H) * 0.26);
  const pad = 16;
  const cx = pad + safeInset.l + size / 2;
  const cy = H - pad - safeInset.b - size / 2;
  const R = size / 2;
  const k = R / CFG.radarRange;
  const p = world.player;
  if (!p) return;

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU);
  ctx.fillStyle = 'rgba(10,14,26,0.55)'; ctx.fill();
  ctx.strokeStyle = 'rgba(148,163,214,0.3)'; ctx.lineWidth = 1; ctx.stroke();

  for (const s of world.snakes) {
    if (!s.alive || s.isPlayer) continue;
    let dx = (s.x - p.x) * k, dy = (s.y - p.y) * k;
    const d = Math.hypot(dx, dy);
    const offEdge = d > R - 3;
    if (offEdge && d > 0.001) { dx = dx / d * (R - 3); dy = dy / d * (R - 3); }
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, offEdge ? 1.5 : 2.4, 0, TAU);
    ctx.fillStyle = `hsla(${s.hue},80%,65%,${offEdge ? 0.4 : 0.85})`;
    ctx.fill();
  }

  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, TAU);
  ctx.fillStyle = '#4ade80'; ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */
const hud = document.getElementById('hud');
const statLen = document.getElementById('statLen');
const statBest = document.getElementById('statBest');
const bestStat = document.getElementById('bestStat');
let hudTimer = 0;

/* Your record lives in localStorage and nowhere else. It is held in memory
 * while you play so the HUD can show it being beaten in real time, and
 * written back occasionally rather than on every frame. */
let bestLen = 0;
try { bestLen = +(localStorage.getItem('coil.best') || 0) || 0; } catch (e) {}
let bestDirty = false, bestSavedAt = performance.now();

function saveBest() {
  bestDirty = false;
  try { localStorage.setItem('coil.best', Math.floor(bestLen)); } catch (e) {}
}

function updateHud(dt) {
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.12;

  const p = world.player;
  statLen.textContent = Math.floor(p.len);

  if (p.len > bestLen) {
    bestLen = p.len;
    bestDirty = true;
    bestStat.classList.add('record');       // you are writing it right now
  }
  statBest.textContent = Math.floor(bestLen);

  // survive the app being killed mid-run without hammering storage. Wall
  // clock, not world time: world time restarts with every run, which would
  // push the next save further and further out.
  const now = performance.now();
  if (bestDirty && now - bestSavedAt > 5000) { bestSavedAt = now; saveBest(); }
}

/* ------------------------------------------------------------------ *
 * Game flow
 * ------------------------------------------------------------------ */
const overlay = document.getElementById('overlay');
const results = document.getElementById('results');
const playBtn = document.getElementById('playBtn');
const tagline = document.getElementById('tagline');

function startGame() {
  // an update that arrived mid-run is swapped in between games, never during
  if (world.pendingReload) { location.reload(); return; }
  bestStat.classList.remove('record');
  resize();
  world.reset();
  world.running = true;
  stick.active = false; stick.sprinting = false;
  boostFromSecondFinger = boostFromKey = boostFromMouse = false;
  lastTapEnd = 0;
  world.paused = false;
  pauseOverlay.classList.add('hidden');
  overlay.classList.add('hidden');
  hud.classList.remove('hidden');
  pauseBtn.classList.remove('hidden');
  last = performance.now();
}

function endGame() {
  world.running = false;
  world.paused = false;
  pauseOverlay.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  const p = world.player;
  const len = Math.floor(p.len);
  if (p.len > bestLen) { bestLen = p.len; bestDirty = true; }
  saveBest();

  document.getElementById('finalLen').textContent = len;
  document.getElementById('bestLen').textContent = Math.floor(bestLen);
  document.getElementById('finalKills').textContent = p.kills;
  results.classList.remove('hidden');
  tagline.textContent = p.kills > 0
    ? `You took down ${p.kills} ${p.kills === 1 ? 'rival' : 'rivals'} before someone cut you off.`
    : 'You ran into someone else’s tail.';
  playBtn.textContent = 'Play again';
  if (len >= Math.floor(bestLen) && len > 0) tagline.textContent = 'A new best. ' + tagline.textContent;
  setTimeout(() => {
    overlay.classList.remove('hidden');
    hud.classList.add('hidden');
  }, 700);
}

/* ------------------------------------------------------------------ *
 * Pause
 * ------------------------------------------------------------------ */
const pauseBtn = document.getElementById('pauseBtn');
const pauseOverlay = document.getElementById('pauseOverlay');

function pauseGame() {
  if (!world.running || world.paused) return;
  world.paused = true;

  // drop every held input, so a finger still down when you paused cannot
  // resume you mid-sprint or mid-turn
  stick.active = false; stick.id = null; stick.sprinting = false;
  lastTapEnd = 0;
  boostFromSecondFinger = boostFromKey = boostFromMouse = false;
  const p = world.player;
  if (p) p.boosting = false;

  document.getElementById('pauseLen').textContent = Math.floor(p.len);
  document.getElementById('pauseBest').textContent = Math.floor(bestLen);
  document.getElementById('pauseKills').textContent = p.kills;

  pauseOverlay.classList.remove('hidden');
  pauseBtn.classList.add('hidden');
  hud.classList.add('hidden');
}

function resumeGame() {
  if (!world.paused) return;
  world.paused = false;
  pauseOverlay.classList.add('hidden');
  pauseBtn.classList.remove('hidden');
  hud.classList.remove('hidden');
  last = performance.now();          // don't hand the world one huge frame
}

pauseBtn.addEventListener('click', pauseGame);
document.getElementById('resumeBtn').addEventListener('click', resumeGame);
document.getElementById('quitBtn').addEventListener('click', () => {
  world.paused = false;
  pauseOverlay.classList.add('hidden');
  last = performance.now();
  // ending a run feeds the rivals, same as dying
  if (world.player && world.player.alive) world.kill(world.player, null);
  else endGame();
});

playBtn.addEventListener('click', startGame);

/* ------------------------------------------------------------------ *
 * Main loop
 * ------------------------------------------------------------------ */
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.034, (now - last) / 1000);
  last = now;
  if (world.player) {
    if (!world.paused) {
      step(dt);                    // keeps running behind the menu as an attract loop
      if (world.running) updateHud(dt);
    }
    draw();                        // still redraw, so a resize while paused is handled
  }
}

/* Switching apps, locking the phone or taking a call pauses the run rather
 * than leaving you steering blind into someone's tail. */
document.addEventListener('visibilitychange', () => {
  last = performance.now();
  if (document.hidden) pauseGame();
});
addEventListener('blur', () => { if (world.running) pauseGame(); });

/* ------------------------------------------------------------------ *
 * Install prompt
 * ------------------------------------------------------------------ */
const installBtn = document.getElementById('installBtn');
let deferredPrompt = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove('hidden');
});
installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.classList.add('hidden');
});

/* A new service worker has taken control. Reloading mid-run would throw away
 * the game you are playing, so wait for the gap between runs. */
window.__coilApplyUpdate = () => {
  if (world.running && !world.paused) world.pendingReload = true;
  else location.reload();
};

/* boot */
resize();
world.reset();
world.running = false;
document.getElementById('bestLen').textContent = Math.floor(bestLen);
requestAnimationFrame(frame);
