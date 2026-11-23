import Phaser from 'phaser';
import { COURT, type Hoop } from '../config';
import { lighten, mixColor, pick, rand } from '../core/math';
import { cam, panShift, project, scaleAt, Z_SCALE } from '../core/projection';

function screenYOfGround(y: number): number {
  const saved = { ...cam };
  cam.ox = 0; cam.oy = 0;
  const v = project(cam.x, y, 0).y;
  Object.assign(cam, saved);
  return v;
}
import type { HairStyle, PlayerDef, TeamDef } from '../data/teams';
import { Ball } from '../sim/Ball';
import { Player } from '../sim/Player';
import { BG_COURTS, BG_HOOP_DEPTH, BG_RECT, type BgCourt } from './floor';
import type { PlayerRenderer } from './PlayerRenderer';

/** Depth for an object at world y (painter's algorithm; larger y is nearer the camera). */
export const depthOf = (y: number) => 100 + y * 10;

/** Camera x that static scenery is pre-drawn for; it is shifted as the camera pans. */
const REF_X = 47;

const SHIRTS = [0x2d3a5a, 0x7a2d3d, 0x3a3a3a, 0xd9d9d9, 0x6b5a3a, 0x2d6a5a, 0x7a6a9a, 0xb07a3a, 0x1f8fb0, 0xe0c040, 0xf0f0f0, 0x202020];
const SKINS = [0x3b2219, 0x5a3825, 0x7a4b2e, 0x9c6644, 0xc68863, 0xe0ac86, 0xf1c9a5];

interface Anchored { obj: Phaser.GameObjects.Graphics | Phaser.GameObjects.Container; y: number }
interface Fan { img: Phaser.GameObjects.Image; x: number; y: number; phase: number; side: 0 | 1; sit: string; cheer: string }

/** Rim and net springs for one hoop. */
class HoopFx {
  net = [0, 1, 2, 3].map(() => ({ drop: 0, vdrop: 0, sq: 0, vsq: 0, sx: 0, vsx: 0, sy: 0, vsy: 0 }));
  dip = 0;
  dipV = 0;
  step(dt: number) {
    this.dipV += (-120 * this.dip - 9 * this.dipV) * dt;
    this.dip += this.dipV * dt;
    for (const n of this.net) {
      n.vdrop += (-90 * n.drop - 7 * n.vdrop) * dt; n.drop += n.vdrop * dt;
      n.vsq += (-110 * n.sq - 8 * n.vsq) * dt; n.sq += n.vsq * dt;
      n.vsx += (-60 * n.sx - 5 * n.vsx) * dt; n.sx += n.vsx * dt;
      n.vsy += (-60 * n.sy - 5 * n.vsy) * dt; n.sy += n.vsy * dt;
    }
  }
}

/** A pickup game on a background court: a few players shooting around. */
class PickupGame {
  readonly court: BgCourt;
  readonly players: Player[] = [];
  readonly ball = new Ball();
  readonly hoop: { x: number; y: number; z: number };
  private holder = 0;
  private holdT = rand(0.5, 2);
  private target: { x: number; y: number }[] = [];
  private made = false;
  fx = new HoopFx();

  constructor(court: BgCourt, idx: number) {
    this.court = court;
    this.hoop = { x: court.cx, y: court.y0 + BG_HOOP_DEPTH, z: 10 };
    const n = 3 + (idx % 2);
    const team = randomTeam();
    for (let i = 0; i < n; i++) {
      const p = new Player(1000 + idx * 10 + i, randomPlayerDef(), (i % 2) as 0 | 1, team);
      p.x = court.cx + rand(-14, 14);
      p.y = rand(court.y0 + 6, court.y1 - 3);
      this.players.push(p);
      this.target.push({ x: p.x, y: p.y });
    }
    this.ball.state = 'held';
    this.ball.owner = this.players[0];
  }

  private randomSpot() {
    return { x: this.court.cx + rand(-16, 16), y: rand(this.court.y0 + 5, this.court.y1 - 2) };
  }

  update(dt: number) {
    const b = this.ball;
    this.fx.step(dt);
    this.players.forEach((p, i) => {
      const t = this.target[i];
      const chase = b.state === 'loose' && i === this.nearestToBall();
      const tx = chase ? b.x : t.x;
      const ty = chase ? b.y : t.y;
      const dx = tx - p.x; const dy = ty - p.y; const d = Math.hypot(dx, dy);
      const sp = chase ? 13 : 7;
      if (d > 0.4) {
        const s = Math.min(sp, d * 3);
        p.vx += ((dx / d) * s - p.vx) * Math.min(1, dt * 6);
        p.vy += ((dy / d) * s - p.vy) * Math.min(1, dt * 6);
      } else { p.vx *= 0.8; p.vy *= 0.8; if (Math.random() < dt * 0.4) this.target[i] = this.randomSpot(); }
      p.x += p.vx * dt; p.y += p.vy * dt;
      const sp2 = Math.hypot(p.vx, p.vy);
      if (sp2 > 1) p.facing = Math.atan2(p.vy, p.vx);
      else p.facing = Math.atan2(this.hoop.y - p.y, this.hoop.x - p.x);
      p.animPhase += dt * (2 + sp2 * 0.75);
      if (p.z > 0 || p.vz > 0) { p.vz -= 44 * dt; p.z = Math.max(0, p.z + p.vz * dt); if (p.z === 0) { p.vz = 0; if (p.action === 'jumpshot') p.setAction('none'); } }
      p.actionT += dt;
    });

    if (b.state === 'held' && b.owner) {
      const p = b.owner;
      this.holdT -= dt;
      b.dribblePhase += dt * 3.8 * Math.PI;
      const fx = Math.cos(p.facing); const fy = Math.sin(p.facing);
      b.x = p.x + fx * 0.7 - fy * 0.9; b.y = p.y + fy * 0.7 + fx * 0.9;
      b.z = 0.4 + Math.abs(Math.cos(b.dribblePhase)) * 2.6;
      if (this.holdT <= 0) {
        // shoot
        p.setAction('jumpshot'); p.vz = 13; p.released = true;
        b.state = 'shot';
        b.owner = null;
        b.z = 7.5;
        this.made = Math.random() < 0.45;
        const h = this.hoop;
        const ang = Math.random() * Math.PI * 2;
        const tx = this.made ? h.x : h.x + Math.cos(ang) * 1.15;
        const ty = this.made ? h.y : h.y + Math.abs(Math.sin(ang)) * 1.15;
        const dist = Math.hypot(b.x - h.x, b.y - h.y);
        b.aimAt(tx, ty, h.z + 0.1, Ball.flightTime(b.z, h.z, 2.5 + dist * 0.12));
      }
    } else if (b.state === 'shot') {
      b.integrate(dt);
      if (b.vz < 0 && b.z <= this.hoop.z + 0.1) {
        b.state = 'loose';
        if (this.made) {
          b.x = this.hoop.x; b.y = this.hoop.y; b.vx *= 0.1; b.vy = 1; b.vz = -6;
          for (let l = 1; l < 4; l++) { this.fx.net[l].vdrop += 9; this.fx.net[l].vsq += 5; }
        } else {
          b.vx = rand(-6, 6); b.vy = rand(3, 8); b.vz = rand(5, 9);
          this.fx.dipV -= 4;
        }
      }
    } else if (b.state === 'loose') {
      b.integrate(dt);
      if (b.z < 0.39) { b.z = 0.39; b.vz = Math.abs(b.vz) > 2 ? -b.vz * 0.6 : 0; b.vx *= 0.85; b.vy *= 0.85; }
      // keep it on this court
      const c = this.court;
      if (b.x < c.cx - c.w / 2 || b.x > c.cx + c.w / 2) b.vx = -b.vx * 0.5;
      if (b.y < c.y0 || b.y > c.y1) b.vy = -b.vy * 0.5;
      b.x = Math.max(c.cx - c.w / 2, Math.min(c.cx + c.w / 2, b.x));
      b.y = Math.max(c.y0, Math.min(c.y1, b.y));
      const i = this.nearestToBall();
      const p = this.players[i];
      if (Math.hypot(p.x - b.x, p.y - b.y) < 1.6 && b.z < 6) {
        b.state = 'held'; b.owner = p; this.holder = i; this.holdT = rand(1, 3);
        this.target[i] = this.randomSpot();
      }
    }
  }

  private nearestToBall(): number {
    let best = 0; let bd = 1e9;
    this.players.forEach((p, i) => { const d = Math.hypot(p.x - this.ball.x, p.y - this.ball.y); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  get holderIdx() { return this.holder; }
}

function randomTeam(): TeamDef {
  const shirt = pick(SHIRTS);
  return { id: 'npc', city: '', name: '', abbr: '', primary: shirt, secondary: lighten(shirt, -0.4), text: 0xffffff, paint: shirt, icon: 'sun', players: [] };
}

function randomPlayerDef(): PlayerDef {
  const hair: HairStyle[] = ['short', 'afro', 'buzz', 'braids', 'bald', 'curly', 'bun'];
  const r = 70;
  return {
    name: 'Local', number: Math.floor(rand(0, 55)), pos: 'W', height: rand(6.0, 6.9),
    ratings: { speed: r, shooting: r, three: r, finishing: r, dunk: r, passing: r, handling: r, defense: r, steal: r, block: r, rebound: r, stamina: r },
    look: { skin: pick(SKINS), hair: pick(hair), hairColor: pick([0x120c0a, 0x2a1a12, 0x6a4a2a, 0x0d0907]), shoes: pick([0xffffff, 0x202020, 0xe04040, 0x2050d0]), headband: Math.random() < 0.2 ? 0xffffff : undefined },
  };
}

export class Park {
  private scene: Phaser.Scene;
  private sky: Phaser.GameObjects.Image;
  private skyBase = 0;
  private anchored: Anchored[] = [];
  private fans: Fan[] = [];
  private excitement = [0, 0];
  private hoopG: Phaser.GameObjects.Graphics[] = [];
  private rimBackG: Phaser.GameObjects.Graphics[] = [];
  private rimFrontG: Phaser.GameObjects.Graphics[] = [];
  private netG: Phaser.GameObjects.Graphics[] = [];
  private hoopFx = [new HoopFx(), new HoopFx()];
  private pickup: PickupGame[];
  private pickupG: Phaser.GameObjects.Graphics;
  private bgHoopG: Phaser.GameObjects.Graphics;
  private flashG: Phaser.GameObjects.Graphics;
  private flashes: { x: number; y: number; t: number }[] = [];
  private home: TeamDef;

  constructor(scene: Phaser.Scene, home: TeamDef, away: TeamDef, star: PlayerDef) {
    this.scene = scene;
    this.home = home;
    const skyKey = 'park_sky';
    if (scene.textures.exists(skyKey)) scene.textures.remove(skyKey);
    scene.textures.addCanvas(skyKey, buildSky(home, star));
    // Bottom of the skyline sits just below where the park ground fades out.
    this.skyBase = screenYOfGround(BG_RECT.y0) + 40;
    this.sky = scene.add.image(0, this.skyBase, skyKey).setOrigin(0.5, 1).setDepth(-4000);

    this.makeFanTextures(home, away);
    this.buildPalms();
    this.buildLights();
    this.buildFans(home, away);

    this.pickup = BG_COURTS.map((c, i) => new PickupGame(c, i));
    this.bgHoopG = scene.add.graphics().setDepth(depthOf(-32));
    this.anchored.push({ obj: this.bgHoopG, y: -30 });
    for (const pg of this.pickup) this.drawBgStanchion(this.bgHoopG, pg.court);
    this.pickupG = scene.add.graphics().setDepth(depthOf(-14));

    for (let i = 0; i < 2; i++) {
      const H = COURT.HOOPS[i];
      this.hoopG.push(scene.add.graphics().setDepth(depthOf(H.y - 2)));
      this.rimBackG.push(scene.add.graphics().setDepth(depthOf(H.y - 0.6)));
      this.netG.push(scene.add.graphics().setDepth(depthOf(H.y + 0.05)));
      this.rimFrontG.push(scene.add.graphics().setDepth(depthOf(H.y + 0.7)));
    }
    this.flashG = scene.add.graphics().setDepth(depthOf(-2)).setBlendMode(Phaser.BlendModes.ADD);
  }

  // ------------------------------------------------------------- static scenery (drawn once, panned)

  private anchoredGraphics(y: number, depthY = y): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics().setDepth(depthOf(depthY));
    this.anchored.push({ obj: g, y });
    return g;
  }

  /** Projected point for static scenery (camera at REF_X). */
  private P(x: number, y: number, z: number) {
    const saved = cam.x; const ox = cam.ox; const oy = cam.oy;
    cam.x = REF_X; cam.ox = 0; cam.oy = 0;
    const p = project(x, y, z);
    cam.x = saved; cam.ox = ox; cam.oy = oy;
    return p;
  }

  private buildPalms() {
    const spots: [number, number, number][] = [];
    for (let x = -88; x < 190; x += 17) spots.push([x + rand(-3, 3), -33.5 + rand(-0.5, 0.5), rand(24, 32)]);
    for (let x = -75; x < 180; x += 50) spots.push([x + 25, -10.2, rand(22, 28)]);
    for (const y of [6, 20, 34, 46]) { spots.push([-9, y, rand(22, 30)]); spots.push([COURT.L + 9, y, rand(22, 30)]); }
    for (const [x, y, h] of spots) {
      const g = this.anchoredGraphics(y);
      const k = scaleAt(y);
      const base = this.P(x, y, 0);
      const lean = rand(-2.5, 2.5);
      // trunk
      const segs = 10;
      let prev = base;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const p = this.P(x + lean * t * t, y, h * t);
        g.lineStyle(k * (0.75 - t * 0.35), mixColor(0x3a2a20, 0x5a4030, t), 1);
        g.lineBetween(prev.x, prev.y, p.x, p.y);
        prev = p;
      }
      // fronds
      const top = prev;
      const n = 9;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
        const len = rand(7, 10) * k * 0.55;
        const dx = Math.cos(a) * len;
        const droop = len * (0.35 + Math.abs(Math.cos(a)) * 0.25);
        const midx = top.x + dx * 0.55; const midy = top.y - len * 0.25 + Math.sin(a) * len * 0.25;
        const endx = top.x + dx; const endy = top.y + droop + Math.sin(a) * len * 0.35;
        const col = i % 2 ? 0x1f4a2e : 0x2a5c38;
        g.lineStyle(k * 0.35, col, 1);
        const curve = new Phaser.Curves.QuadraticBezier(new Phaser.Math.Vector2(top.x, top.y), new Phaser.Math.Vector2(midx, midy), new Phaser.Math.Vector2(endx, endy));
        curve.draw(g, 12);
        // leaflets
        const pts = curve.getPoints(8);
        g.lineStyle(k * 0.12, col, 1);
        for (let j = 2; j < pts.length; j++) {
          const pp = pts[j];
          g.lineBetween(pp.x, pp.y, pp.x - Math.sin(a) * k * 0.9, pp.y + k * 0.9);
          g.lineBetween(pp.x, pp.y, pp.x + Math.sin(a) * k * 0.6, pp.y + k * 1.1);
        }
      }
      g.fillStyle(0x3a2a1a, 1);
      g.fillCircle(top.x, top.y, k * 0.5);
    }
  }

  private buildLights() {
    // Floodlight towers at the corners of the main court
    for (const x of [-9, COURT.L + 9]) {
      const g = this.anchoredGraphics(-6);
      const b = this.P(x, -6, 0); const t = this.P(x, -6, 34);
      g.lineStyle(b.k * 0.6, 0x2a2d38, 1); g.lineBetween(b.x, b.y, t.x, t.y);
      g.fillStyle(0x1a1c24, 1); g.fillRect(t.x - b.k * 2.4, t.y - b.k * 1.4, b.k * 4.8, b.k * 2);
      for (let i = 0; i < 4; i++) {
        const lx = t.x - b.k * 1.8 + i * b.k * 1.2;
        g.fillStyle(0xfff4d8, 1); g.fillCircle(lx, t.y - b.k * 0.4, b.k * 0.42);
        g.fillStyle(0xfff0c0, 0.15); g.fillCircle(lx, t.y - b.k * 0.4, b.k * 1.6);
      }
    }
    // String lights along the walkway and behind the pickup courts
    for (const [y, poleH, sag] of [[-8, 17, 3.2], [-32.5, 19, 3.5]] as const) {
      const g = this.anchoredGraphics(y);
      g.setBlendMode(Phaser.BlendModes.NORMAL);
      const glow = this.anchoredGraphics(y);
      glow.setBlendMode(Phaser.BlendModes.ADD);
      const step = 26;
      for (let x0 = -92; x0 < 188; x0 += step) {
        const pb = this.P(x0, y, 0); const pt = this.P(x0, y, poleH);
        g.lineStyle(pb.k * 0.3, 0x22252e, 1); g.lineBetween(pb.x, pb.y, pt.x, pt.y);
        // catenary-ish strand to the next pole
        let prev = pt;
        const n = 16;
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const z = poleH - sag * 4 * t * (1 - t);
          const p = this.P(x0 + step * t, y, z);
          g.lineStyle(1.2, 0x1a1a1a, 0.9); g.lineBetween(prev.x, prev.y, p.x, p.y);
          prev = p;
          if (i < n) {
            const col = [0xffd27a, 0xffb060, 0xfff0b0, 0xff8a6a][i % 4];
            glow.fillStyle(col, 0.18); glow.fillCircle(p.x, p.y + 3, p.k * 0.55);
            glow.fillStyle(col, 1); glow.fillCircle(p.x, p.y + 3, p.k * 0.13);
          }
        }
      }
    }
  }

  private makeFanTextures(home: TeamDef, away: TeamDef) {
    const shirts = [...SHIRTS, home.primary, home.primary, away.primary];
    for (const shirt of shirts) {
      for (let si = 0; si < 3; si++) {
        const skin = SKINS[(shirt + si * 3) % SKINS.length];
        for (const cheer of [false, true]) {
          const key = `pf_${shirt.toString(16)}_${si}_${cheer ? 1 : 0}`;
          if (this.scene.textures.exists(key)) continue;
          const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
          const pants = [0x2a3248, 0x3a3a3a, 0x5a4a3a][si];
          // legs
          g.fillStyle(0x111111); g.fillRect(8, 38, 6, 22); g.fillRect(16, 38, 6, 22);
          g.fillStyle(pants); g.fillRect(9, 38, 4, 20); g.fillRect(17, 38, 4, 20);
          g.fillStyle(0xeeeeee); g.fillRect(8, 57, 6, 3); g.fillRect(16, 57, 6, 3);
          // arms
          g.lineStyle(5, skin);
          if (cheer) { g.lineBetween(7, 22, 2, 4); g.lineBetween(23, 22, 28, 4); }
          else { g.lineBetween(6, 21, 4, 36); g.lineBetween(24, 21, 26, 36); }
          // torso
          g.fillStyle(0x111111); g.fillRoundedRect(4, 18, 22, 23, 6);
          g.fillStyle(shirt); g.fillRoundedRect(5.5, 19.5, 19, 20, 5);
          g.fillStyle(0x000000, 0.2); g.fillRect(17, 20, 7, 19);
          // head
          g.fillStyle(0x111111); g.fillCircle(15, 11, 8.5);
          g.fillStyle(skin); g.fillCircle(15, 11, 7.2);
          g.fillStyle([0x1a1210, 0x3b2a1a, 0x101010][si]); g.slice(15, 11, 7.4, Math.PI * 1.05, Math.PI * 1.95, false); g.fillPath();
          g.generateTexture(key, 30, 61);
          g.destroy();
        }
      }
    }
  }

  private buildFans(home: TeamDef, away: TeamDef) {
    const spots: { x: number; y: number }[] = [];
    for (let x = -70; x < 165; x += rand(1.6, 3.2)) {
      if (Math.random() < 0.12) x += rand(4, 10);
      spots.push({ x, y: rand(-7, -3.8) });
      if (Math.random() < 0.35) spots.push({ x: x + rand(-0.6, 0.6), y: rand(-7.8, -6.5) });
    }
    for (let y = 1; y < 49; y += rand(2.2, 3.6)) {
      spots.push({ x: rand(-7.5, -5), y });
      spots.push({ x: COURT.L + rand(5, 7.5), y });
    }
    spots.sort((a, b) => a.y - b.y);
    for (const s of spots) {
      const supportsHome = Math.random() < 0.65;
      const r = Math.random();
      const shirt = supportsHome && r < 0.35 ? home.primary : !supportsHome && r < 0.35 ? away.primary : pick(SHIRTS);
      const si = Math.floor(Math.random() * 3);
      const sit = `pf_${shirt.toString(16)}_${si}_0`;
      const cheer = `pf_${shirt.toString(16)}_${si}_1`;
      const img = this.scene.add.image(0, 0, sit).setOrigin(0.5, 0.97).setDepth(depthOf(s.y));
      img.setScale((scaleAt(s.y) / 22) * 0.88 * rand(0.92, 1.08));
      img.setTint(mixColor(0xffffff, 0x8088b0, 0.25));
      this.fans.push({ img, x: s.x, y: s.y, phase: Math.random() * 10, side: supportsHome ? 0 : 1, sit, cheer });
    }
  }

  private drawBgStanchion(g: Phaser.GameObjects.Graphics, c: BgCourt) {
    const hy = c.y0 + BG_HOOP_DEPTH;
    const by = hy - 1.25;
    const P = (x: number, y: number, z: number) => this.P(x, y, z);
    const pole0 = P(c.cx, c.y0 - 2.5, 0); const pole1 = P(c.cx, c.y0 - 2.5, 11.5);
    g.lineStyle(pole0.k * 0.5, 0x30343f, 1); g.lineBetween(pole0.x, pole0.y, pole1.x, pole1.y);
    const arm = P(c.cx, by, 11);
    g.lineStyle(pole0.k * 0.35, 0x30343f, 1); g.lineBetween(pole1.x, pole1.y, arm.x, arm.y);
    const q = [P(c.cx - 3, by, 9.4), P(c.cx + 3, by, 9.4), P(c.cx + 3, by, 13), P(c.cx - 3, by, 13)];
    g.fillStyle(0xdfe8f0, 0.85);
    g.fillRect(q[3].x, q[3].y, q[1].x - q[3].x, q[1].y - q[3].y);
    g.lineStyle(2, 0xb83a17, 1);
    g.strokeRect(q[3].x + (q[1].x - q[3].x) * 0.35, q[3].y + (q[1].y - q[3].y) * 0.45, (q[1].x - q[3].x) * 0.3, (q[1].y - q[3].y) * 0.4);
  }

  // ------------------------------------------------------------- per frame

  update(dt: number, time: number, rig: PlayerRenderer) {
    // Sky parallax
    this.sky.x = 960 - (cam.x - REF_X) * 3 + cam.ox * 0.3;
    this.sky.y = this.skyBase + cam.oy * 0.3;
    for (const a of this.anchored) {
      a.obj.x = panShift(a.y, REF_X);
      a.obj.y = cam.oy;
    }

    // Fans
    for (let s = 0; s < 2; s++) this.excitement[s] = Math.max(0, this.excitement[s] - dt * 0.35);
    for (const f of this.fans) {
      const p = project(f.x, f.y, 0);
      const e = this.excitement[f.side];
      const bob = Math.max(0, Math.sin(time * (1.6 + e * 5) + f.phase)) * (0.8 + e * 7);
      f.img.x = p.x;
      f.img.y = p.y - bob;
      f.img.visible = p.x > -60 && p.x < 1980;
      const tex = e > 0.35 && Math.sin(f.phase * 7.3) > -0.2 ? f.cheer : f.sit;
      if (f.img.texture.key !== tex) f.img.setTexture(tex);
    }

    // Pickup games
    const g = this.pickupG;
    g.clear();
    for (const pg of this.pickup) {
      pg.update(dt);
      const order = [...pg.players].sort((a, b) => a.y - b.y);
      for (const p of order) {
        rig.drawShadow(g, p);
        rig.draw(g, p, pg.ball, { onDefense: false, time, outline: 0.7 });
      }
      drawSmallBall(g, pg.ball);
      this.drawBgRimNet(g, pg);
    }

    // Main hoops
    for (let i = 0; i < 2; i++) {
      this.hoopFx[i].step(dt);
      this.drawMainHoop(i);
    }

    // Camera flashes
    this.flashG.clear();
    this.flashes = this.flashes.filter((fl) => (fl.t -= dt) > 0);
    for (const fl of this.flashes) {
      const p = project(fl.x, fl.y, 5.5);
      this.flashG.fillStyle(0xffffff, Math.min(1, fl.t * 8));
      this.flashG.fillCircle(p.x, p.y, 3 + fl.t * 26);
    }
  }

  private drawBgRimNet(g: Phaser.GameObjects.Graphics, pg: PickupGame) {
    const h = pg.hoop;
    const rimZ = 10 - pg.fx.dip;
    g.lineStyle(2.5, 0xe2471b, 1);
    g.beginPath();
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const p = project(h.x + Math.cos(a) * 0.85, h.y + Math.sin(a) * 0.85, rimZ);
      if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
    }
    g.strokePath();
    g.lineStyle(1.2, 0xffffff, 0.7);
    const drop = pg.fx.net[3].drop;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const t = project(h.x + Math.cos(a) * 0.85, h.y + Math.sin(a) * 0.85, rimZ);
      const b = project(h.x + Math.cos(a + 0.3) * 0.5, h.y + Math.sin(a + 0.3) * 0.5, rimZ - 1.7 - drop * 0.5);
      g.lineBetween(t.x, t.y, b.x, b.y);
    }
  }

  private drawMainHoop(i: number) {
    const H = COURT.HOOPS[i];
    const fx = this.hoopFx[i];
    const g = this.hoopG[i]; const back = this.rimBackG[i]; const front = this.rimFrontG[i]; const net = this.netG[i];
    g.clear(); back.clear(); front.clear(); net.clear();
    const B = COURT.BOARD;
    const bx = H.dir === 1 ? B.inset : COURT.L - B.inset;
    const px = bx - H.dir * 5.5; // stanchion behind the baseline
    const pad = mixColor(this.home.secondary, 0x111111, 0.4);

    // base pad box
    const box = (x0: number, x1: number, y0: number, y1: number, z1: number) => {
      const t = [project(x0, y0, z1), project(x1, y0, z1), project(x1, y1, z1), project(x0, y1, z1)];
      const f = [project(x0, y1, 0), project(x1, y1, 0), project(x1, y1, z1), project(x0, y1, z1)];
      g.fillStyle(lighten(pad, 0.18), 1);
      g.beginPath(); g.moveTo(t[0].x, t[0].y); t.slice(1).forEach((p) => g.lineTo(p.x, p.y)); g.closePath(); g.fillPath();
      g.fillStyle(pad, 1);
      g.beginPath(); g.moveTo(f[0].x, f[0].y); f.slice(1).forEach((p) => g.lineTo(p.x, p.y)); g.closePath(); g.fillPath();
      const s0 = project(x0, y1, z1 * 0.75); const s1 = project(x1, y1, z1 * 0.75);
      g.lineStyle(3, this.home.primary, 1); g.lineBetween(s0.x, s0.y, s1.x, s1.y);
    };
    box(px - 1.4, px + 1.4, H.y - 1.8, H.y + 1.8, 2.2);
    const p0 = project(px, H.y, 2.2); const p1 = project(px, H.y, 12.2);
    g.lineStyle(p0.k * 0.7, 0x2b2f3a, 1); g.lineBetween(p0.x, p0.y, p1.x, p1.y);
    g.lineStyle(p0.k * 0.3, 0x3d4352, 1); g.lineBetween(p0.x - p0.k * 0.15, p0.y, p1.x - p0.k * 0.15, p1.y);
    const arm = project(bx - H.dir * 0.3, H.y, 11.2);
    g.lineStyle(p0.k * 0.45, 0x2b2f3a, 1); g.lineBetween(p1.x, p1.y, arm.x, arm.y);
    const brace = project(px, H.y, 8.5);
    g.lineStyle(p0.k * 0.28, 0x2b2f3a, 1); g.lineBetween(brace.x, brace.y, arm.x, arm.y);

    // Backboard (plane x = bx)
    const c = [project(bx, B.y0, B.z0), project(bx, B.y1, B.z0), project(bx, B.y1, B.z1), project(bx, B.y0, B.z1)];
    const quad = (gg: Phaser.GameObjects.Graphics, pts: { x: number; y: number }[]) => {
      gg.beginPath(); gg.moveTo(pts[0].x, pts[0].y); pts.slice(1).forEach((p) => gg.lineTo(p.x, p.y)); gg.closePath();
    };
    g.fillStyle(0xbfe3ff, 0.28); quad(g, c); g.fillPath();
    g.lineStyle(Math.max(3, c[0].k * 0.17), 0xffffff, 0.95); quad(g, c); g.strokePath();
    const sq = [project(bx, 23.75, 10), project(bx, 26.25, 10), project(bx, 26.25, 11.8), project(bx, 23.75, 11.8)];
    g.lineStyle(Math.max(2, c[0].k * 0.1), 0xffffff, 0.9); quad(g, sq); g.strokePath();
    g.lineStyle(c[0].k * 0.22, pad, 1); g.lineBetween(c[0].x, c[0].y, c[1].x, c[1].y);

    // Rim
    const rimZ = H.z - fx.dip;
    const pts: { x: number; y: number; k: number; wy: number }[] = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const wy = H.y + Math.sin(a) * COURT.RIM_R;
      const p = project(H.x + Math.cos(a) * COURT.RIM_R, wy, rimZ);
      pts.push({ x: p.x, y: p.y, k: p.k, wy });
    }
    const br0 = project(bx, H.y, rimZ - 0.1); const br1 = project(H.x - H.dir * COURT.RIM_R, H.y, rimZ);
    back.lineStyle(br0.k * 0.22, 0xb83a17, 1); back.lineBetween(br0.x, br0.y, br1.x, br1.y);
    for (let k = 0; k < 32; k++) {
      const a = pts[k]; const b = pts[k + 1];
      const gg = a.wy < H.y ? back : front;
      gg.lineStyle(a.k * 0.2, 0xe2471b, 1);
      gg.lineBetween(a.x, a.y, b.x, b.y);
    }

    // Net lattice
    const levels = [
      { r: COURT.RIM_R, z: 0 }, { r: COURT.RIM_R * 0.86, z: -0.7 }, { r: COURT.RIM_R * 0.74, z: -1.4 }, { r: COURT.RIM_R * 0.62, z: -2.05 },
    ];
    const N = 14;
    const ring = (l: number, k: number) => {
      const s = fx.net[l];
      const a = ((k + l * 0.5) / N) * Math.PI * 2;
      const r = levels[l].r * (1 - s.sq * 0.4);
      return project(H.x + Math.cos(a) * r + s.sx * l * 0.25, H.y + Math.sin(a) * r + s.sy * l * 0.25, rimZ + levels[l].z - s.drop * l * 0.35);
    };
    net.lineStyle(2, 0xffffff, 0.9);
    for (let l = 0; l < 3; l++) {
      for (let k = 0; k < N; k++) {
        const a = ring(l, k); const b1 = ring(l + 1, k); const b0 = ring(l + 1, k - 1);
        net.lineBetween(a.x, a.y, b1.x, b1.y);
        net.lineBetween(a.x, a.y, b0.x, b0.y);
      }
    }
  }

  // ------------------------------------------------------------- reactions

  private fxFor(h: Hoop) { return this.hoopFx[COURT.HOOPS.indexOf(h)] ?? this.hoopFx[0]; }

  swish(h: Hoop, strength: number, vx = 0, vy = 0) {
    for (let l = 1; l < 4; l++) {
      const n = this.fxFor(h).net[l];
      n.vdrop += 9 * strength; n.vsq += 5 * strength; n.vsx += vx * 0.6; n.vsy += vy * 0.6;
    }
  }

  rimHit(h: Hoop, strength: number) {
    const f = this.fxFor(h);
    f.dipV -= 6 * strength;
    for (let l = 1; l < 4; l++) { f.net[l].vsx += (Math.random() - 0.5) * 6 * strength; f.net[l].vsy += (Math.random() - 0.5) * 4 * strength; }
  }

  cheer(side: 0 | 1, amount: number) {
    this.excitement[side] = Math.min(1.4, this.excitement[side] + amount);
    this.excitement[1 - side] = Math.min(1.4, this.excitement[1 - side] + amount * 0.15);
    const visible = this.fans.filter((f) => f.img.visible);
    const n = Math.round(amount * 10);
    for (let i = 0; i < n && visible.length; i++) {
      const f = visible[Math.floor(Math.random() * visible.length)];
      this.flashes.push({ x: f.x, y: f.y, t: 0.12 + Math.random() * 0.1 });
    }
  }

  static zScale = Z_SCALE;
}

function drawSmallBall(g: Phaser.GameObjects.Graphics, b: Ball) {
  const s = project(b.x, b.y, 0);
  g.fillStyle(0x000000, 0.3);
  g.fillEllipse(s.x, s.y, s.k * 0.8, s.k * 0.3);
  const p = project(b.x, b.y, b.z);
  g.fillStyle(0x2a140a, 1); g.fillCircle(p.x, p.y, p.k * 0.5 + 1);
  g.fillStyle(0xe8742c, 1); g.fillCircle(p.x, p.y, p.k * 0.5);
}

/** Night sky, hotel skyline and a big screen, painted once per match. */
function buildSky(home: TeamDef, star: PlayerDef): HTMLCanvasElement {
  const W = 3800; const H = 560;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  const sky = c.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#070818');
  sky.addColorStop(0.55, '#1a1638');
  sky.addColorStop(1, '#3a2850');
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    c.fillStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.6})`;
    c.fillRect(Math.random() * W, Math.random() * H * 0.6, 1.5, 1.5);
  }
  // Distant buildings
  const building = (x: number, w: number, h: number, color: string, win: string, curve = 0) => {
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x, H);
    c.lineTo(x, H - h + curve);
    c.quadraticCurveTo(x + w / 2, H - h - curve, x + w, H - h + curve);
    c.lineTo(x + w, H);
    c.fill();
    for (let yy = H - h + 18 + Math.abs(curve); yy < H - 10; yy += 14) {
      for (let xx = x + 8; xx < x + w - 10; xx += 12) {
        if (Math.random() < 0.55) {
          c.fillStyle = Math.random() < 0.8 ? win : 'rgba(255,220,150,0.8)';
          c.fillRect(xx, yy, 7, 6);
        }
      }
    }
  };
  for (let x = 0; x < W; x += 140 + Math.random() * 120) {
    building(x, 90 + Math.random() * 120, 120 + Math.random() * 180, '#141530', 'rgba(140,160,255,0.25)');
  }
  // The big curved hotel towers with glowing cyan floors
  for (const [x, w, h] of [[900, 420, 440], [1400, 360, 380], [2500, 460, 460]] as const) {
    c.fillStyle = '#1c2140';
    c.fillRect(x, H - h, w, h);
    for (let yy = H - h + 10; yy < H; yy += 16) {
      const g = c.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, 'rgba(90,220,255,0.15)');
      g.addColorStop(0.5, 'rgba(140,240,255,0.75)');
      g.addColorStop(1, 'rgba(90,220,255,0.15)');
      c.fillStyle = g;
      c.fillRect(x, yy, w, 4);
    }
    c.fillStyle = 'rgba(200,140,255,0.5)';
    c.fillRect(x, H - h, w, 5);
  }
  // Big screen
  const sx = 1950; const sy = H - 330; const sw = 420; const sh = 230;
  c.fillStyle = '#0a0b14'; c.fillRect(sx - 12, sy - 12, sw + 24, sh + 24);
  c.fillStyle = '#20263a'; c.fillRect(sx - 4, sy + sh + 12, 20, 200); c.fillRect(sx + sw - 16, sy + sh + 12, 20, 200);
  const scr = c.createLinearGradient(sx, sy, sx, sy + sh);
  scr.addColorStop(0, '#16304a'); scr.addColorStop(1, '#0c1828');
  c.fillStyle = scr; c.fillRect(sx, sy, sw, sh);
  c.fillStyle = `#${home.primary.toString(16).padStart(6, '0')}`;
  c.fillRect(sx, sy, sw, 46);
  c.font = '600 34px Teko, Impact, sans-serif';
  c.fillStyle = '#ffffff'; c.textAlign = 'center';
  c.fillText('PLAYER OF THE WEEK', sx + sw / 2, sy + 34);
  c.font = '700 56px Teko, Impact, sans-serif';
  c.fillText(star.name.toUpperCase(), sx + sw / 2, sy + 112);
  c.font = '500 30px Teko, Impact, sans-serif';
  c.fillStyle = '#9fe6ff';
  const r = star.ratings;
  c.fillText(`SHOOT ${r.shooting}  ·  3PT ${r.three}  ·  DUNK ${r.dunk}`, sx + sw / 2, sy + 160);
  c.fillStyle = '#ffb547';
  c.fillText(`#${star.number}  ${home.city.toUpperCase()} ${home.name.toUpperCase()}`, sx + sw / 2, sy + 202);
  // scanline sheen
  c.fillStyle = 'rgba(255,255,255,0.04)';
  for (let yy = sy; yy < sy + sh; yy += 4) c.fillRect(sx, yy, sw, 1);
  // Palm silhouettes along the horizon
  c.fillStyle = '#0c0f1c';
  for (let x = 30; x < W; x += 90 + Math.random() * 140) {
    const h = 90 + Math.random() * 90;
    c.fillRect(x, H - h, 5, h);
    for (let i = 0; i < 7; i++) {
      c.save(); c.translate(x + 2, H - h); c.rotate(-Math.PI / 2 + (i - 3) * 0.5);
      c.beginPath(); c.ellipse(26, 0, 28, 6, 0.25, 0, Math.PI * 2); c.fill();
      c.restore();
    }
  }
  return cv;
}
