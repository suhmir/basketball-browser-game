import Phaser from 'phaser';
import { COURT, VIEW } from '../config';
import { clamp, hex, lighten, pick } from '../core/math';
import { cam, project, unproject, Z_SCALE } from '../core/projection';
import { TEAMS } from '../data/teams';
import { Sound } from '../audio/AudioManager';
import { Floor } from '../render/floor';
import { Fx } from '../render/Fx';
import { depthOf, Park } from '../render/Park';
import { PlayerRenderer } from '../render/PlayerRenderer';
import { Match, NO_INPUT, type InputState, type MatchConfig, type MatchEvents } from '../sim/Match';
import type { Player } from '../sim/Player';
import { bridge } from '../ui/bridge';

export interface GameSceneData {
  cfg?: MatchConfig;
  demo?: boolean;
}

type KeyName = 'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SPACE' | 'E' | 'Q' | 'F' | 'R' | 'SHIFT';
type KeyMap = Record<KeyName, Phaser.Input.Keyboard.Key>;

/** Camera pan limits (world x at the screen center). */
const CAM_MIN = 28;
const CAM_MAX = COURT.L - 28;

export class GameScene extends Phaser.Scene {
  match!: Match;
  demo = true;
  paused = false;
  private cfg!: MatchConfig;
  private park!: Park;
  private floor!: Floor;
  private fx!: Fx;
  private rig = new PlayerRenderer();
  private playerGs: Phaser.GameObjects.Graphics[] = [];
  private reflectG!: Phaser.GameObjects.Graphics;
  private shadowG!: Phaser.GameObjects.Graphics;
  private floorG!: Phaser.GameObjects.Graphics;
  private overG!: Phaser.GameObjects.Graphics;
  private keys!: KeyMap;
  private aim: { x: number; y: number; t: number } | null = null;
  private pointerShoot = { down: false, pressed: false, released: false };
  private meterFreeze: { p: Player; value: number; color: number; t: number } | null = null;
  private demoRestartT = 0;
  private lastInput: InputState = NO_INPUT;
  private shake = { t: 0, dur: 0, amt: 0 };

  constructor() { super('Game'); }

  init(data: GameSceneData) {
    this.demo = data.demo ?? !data.cfg;
    this.cfg = data.cfg ?? randomDemoConfig();
    this.paused = false;
    this.meterFreeze = null;
    this.demoRestartT = 0;
    this.shake = { t: 0, dur: 0, amt: 0 };
  }

  create() {
    const [home, away] = this.cfg.teams;
    this.match = new Match(this.cfg);
    const star = home.players[this.cfg.starIndex] ?? home.players[0];
    const handler = this.match.ball.owner;
    cam.x = clamp(handler ? handler.x : 47, CAM_MIN, CAM_MAX);
    cam.ox = 0; cam.oy = 0;

    this.floor = new Floor(this, home);
    this.reflectG = this.add.graphics().setDepth(-2900).setVisible(false);
    this.shadowG = this.add.graphics().setDepth(-2800);
    this.floorG = this.add.graphics().setDepth(-2700);
    this.park = new Park(this, home, away, star);
    this.fx = new Fx(this);
    this.overG = this.add.graphics().setDepth(5500);
    if (!this.textures.exists('vignette')) this.textures.addCanvas('vignette', buildVignette());
    this.add.image(0, 0, 'vignette').setOrigin(0, 0).setDepth(5400);
    this.playerGs = this.match.players.map(() => this.add.graphics());
    this.cameras.main.setBackgroundColor(0x07080c);

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,E,Q,F,R,SHIFT', true, false) as KeyMap;
    kb.addCapture('SPACE,UP,DOWN,LEFT,RIGHT');
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const w = unproject(p.worldX, p.worldY);
      this.aim = { x: w.x, y: w.y, t: this.time.now };
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.leftButtonDown()) { this.pointerShoot.down = true; this.pointerShoot.pressed = true; }
    });
    this.input.on('pointerup', () => {
      if (this.pointerShoot.down) { this.pointerShoot.down = false; this.pointerShoot.released = true; }
    });

    this.wireEvents();
    Sound.setCrowdBase(this.demo ? 0.08 : 0.14);
    bridge.hooks?.onMatchStart(this.match, this.demo);
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) for (const k of Object.values(this.keys)) k.reset();
  }

  private startShake(amount: number, ms: number) {
    if (!bridge.settings.shake) return;
    this.shake = { t: ms / 1000, dur: ms / 1000, amt: Math.max(this.shake.amt * (this.shake.t > 0 ? 1 : 0), amount * VIEW.W) };
  }

  // ---------------------------------------------------------------- events -> fx / audio / ui

  private wireEvents() {
    const m = this.match;
    const ev = m.ev;
    const forward = <K extends keyof MatchEvents>(name: K) => ev.on(name, (payload) => bridge.hooks?.onEvent(name, payload, m, this.demo));
    (['score', 'steal', 'block', 'turnover', 'banner', 'possession', 'gameover', 'release', 'rebound', 'buzzer', 'ankles'] as const).forEach((n) => forward(n));

    ev.on('release', ({ p, grade, q }) => {
      Sound.whoosh(0.8);
      const ball = m.ball;
      const color = q >= 1 ? 0x5cff7a : q >= 0.7 ? 0xffd24a : 0xff5a3c;
      this.fx.ring(ball.x, ball.y, ball.z, color, 46, 0.4);
      if (grade && (p.isUser || (!this.demo && p.side === m.cfg.userSide))) {
        this.fx.popText(p.x, p.y, p.z + 8.5, grade, hex(color), grade === 'PERFECT' ? 46 : 36, 60, 450);
        if (grade === 'PERFECT') Sound.perfect();
      }
      if (p.isUser && grade) this.meterFreeze = { p, value: p.charge, color, t: 0.8 };
    });
    ev.on('score', ({ side, pts, kind }) => {
      const H = m.cfg.teams[side] && (side === 0 ? COURT.HOOPS[1] : COURT.HOOPS[0]);
      const team = m.cfg.teams[side];
      if (kind !== 'dunk') Sound.swish();
      const label = kind === 'dunk' ? 'SLAM!' : kind === 'swish' && pts === 3 ? 'SPLASH!' : kind === 'swish' ? 'SWISH!' : kind === 'putback' ? 'PUT-BACK' : kind === 'layupIn' ? 'LAYUP' : 'BUCKET';
      this.fx.popText(H.x, H.y, H.z + 3.2, `+${pts}`, hex(lighten(team.primary, 0.45)), 92, 110, 700);
      this.fx.popText(H.x, H.y, H.z + 0.6, label, '#ffffff', 48, 80, 600);
      this.fx.burst(H.x, H.y, H.z, [team.primary, team.secondary, 0xffffff], pts === 3 || kind === 'dunk' ? 70 : 36);
      this.park.cheer(side, pts === 3 || kind === 'dunk' ? 1.2 : 0.75);
      Sound.crowdRoar(pts === 3 || kind === 'dunk' ? 0.55 : 0.35);
    });
    ev.on('rim', ({ strength, hoop }) => {
      Sound.rim(Math.min(1.4, strength));
      this.park.rimHit(hoop, strength);
      if (strength > 0.5) this.fx.spark(m.ball.x, m.ball.y, m.ball.z, 0xffa040, 8);
    });
    ev.on('board', () => Sound.board());
    ev.on('bounce', ({ strength }) => Sound.bounce(strength));
    ev.on('dribble', () => Sound.bounce(0.5));
    ev.on('net', ({ strength, hoop }) => this.park.swish(hoop, strength, m.ball.vx * 0.2, m.ball.vy * 0.2));
    ev.on('steal', ({ p }) => {
      Sound.steal();
      this.fx.popText(p.x, p.y, 9, 'STEAL!', '#7fe3ff', 52, 80, 500);
      this.fx.ring(p.x, p.y, 3, 0x7fe3ff, 70, 0.5);
      this.park.cheer(p.side, 0.5);
      Sound.crowdRoar(0.25);
    });
    ev.on('block', ({ p }) => {
      Sound.board();
      Sound.rim(0.3);
      this.fx.popText(p.x, p.y, 10, 'REJECTED!', '#ff7a5c', 56, 80, 600);
      this.fx.spark(m.ball.x, m.ball.y, m.ball.z, 0xffffff, 18);
      this.park.cheer(p.side, 0.8);
      Sound.crowdRoar(0.4);
    });
    ev.on('crossover', ({ p }) => {
      Sound.squeak();
      this.fx.dustAt(p.x, p.y, 4);
    });
    ev.on('ankles', ({ p, by }) => {
      Sound.squeak();
      Sound.crowdRoar(0.5);
      this.fx.popText(p.x, p.y, 7, 'ANKLES!', '#ffd24a', 60, 90, 650);
      this.fx.dustAt(p.x, p.y, 10);
      this.park.cheer(by.side, 1.1);
    });
    ev.on('dunk', ({ p }) => {
      Sound.dunk();
      this.fx.spark(p.hoop.x, p.hoop.y, p.hoop.z, 0xffc060, 26);
      this.time.delayedCall(420, () => this.fx.dustAt(p.x, p.y, 10));
      if (bridge.settings.shake) this.cameras.main.flash(120, 255, 240, 220, false);
    });
    ev.on('shake', ({ amount, ms }) => this.startShake(amount, ms));
    ev.on('squeak', () => Sound.squeak());
    ev.on('jump', ({ p }) => { if (p.speed > 5) Sound.squeak(); });
    ev.on('whistle', () => Sound.whistle());
    ev.on('buzzer', () => Sound.buzzer());
    ev.on('gameover', () => { Sound.crowdRoar(0.6); this.park.cheer(m.score[0] > m.score[1] ? 0 : 1, 1.4); });
  }

  // ---------------------------------------------------------------- input

  private readInput(): InputState {
    if (this.demo) return NO_INPUT;
    const k = this.keys;
    const JD = Phaser.Input.Keyboard.JustDown;
    const JU = Phaser.Input.Keyboard.JustUp;
    let mx = 0; let my = 0;
    if (k.A.isDown || k.LEFT.isDown) mx -= 1;
    if (k.D.isDown || k.RIGHT.isDown) mx += 1;
    if (k.W.isDown || k.UP.isDown) my -= 1;
    if (k.S.isDown || k.DOWN.isDown) my += 1;
    const l = Math.hypot(mx, my);
    if (l > 0) { mx /= l; my /= l; }
    const ps = this.pointerShoot;
    const input: InputState = {
      mx, my,
      sprint: k.SHIFT.isDown,
      shootHeld: k.SPACE.isDown || ps.down,
      shootPressed: JD(k.SPACE) || ps.pressed,
      shootReleased: JU(k.SPACE) || ps.released,
      passPressed: JD(k.E),
      switchPressed: JD(k.Q),
      crossPressed: JD(k.F),
      stealPressed: JD(k.R),
      aim: this.aim && this.time.now - this.aim.t < 2500 ? { x: this.aim.x, y: this.aim.y } : null,
    };
    ps.pressed = false; ps.released = false;
    return input;
  }

  // ---------------------------------------------------------------- loop

  update(_time: number, _deltaMs: number) {
    // Phaser's smoothed delta is clamped to the target frame time, which would
    // turn low frame rates into slow motion. Use real elapsed time and step the
    // simulation in fixed-size slices instead.
    const dt = Math.min(0.1, this.game.loop.rawDelta / 1000);
    const m = this.match;
    if (!this.paused) {
      const input = this.readInput();
      this.lastInput = input;
      const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
      const later = { ...input, shootPressed: false, shootReleased: false, passPressed: false, switchPressed: false, crossPressed: false, stealPressed: false };
      for (let i = 0; i < steps; i++) m.update(dt / steps, i === 0 ? input : later);
      if (this.meterFreeze) { this.meterFreeze.t -= dt; if (this.meterFreeze.t <= 0) this.meterFreeze = null; }
      if (this.demo && m.phase === 'over') {
        this.demoRestartT += dt;
        if (this.demoRestartT > 4) this.scene.restart({ demo: true });
      }
      this.updateCamera(dt);
    }
    Sound.update(dt);
    this.render(this.paused ? 0 : dt);
    bridge.hooks?.onFrame(m, this.demo);
  }

  private updateCamera(dt: number) {
    const m = this.match;
    const b = m.ball;
    // Lead the play toward the basket being attacked
    const H = m.targetHoop;
    let target = b.x + (H.dir === 1 ? -6 : 6);
    if (b.state === 'shot' && b.shot) target = b.shot.hoop.x + (b.shot.hoop.dir === 1 ? 14 : -14);
    target = clamp(target, CAM_MIN, CAM_MAX);
    const k = Math.min(1, dt * (m.phase === 'live' ? 3.2 : 2));
    cam.x += (target - cam.x) * k;

    if (this.shake.t > 0) {
      this.shake.t -= dt;
      const a = this.shake.amt * Math.max(0, this.shake.t / this.shake.dur);
      cam.ox = (Math.random() * 2 - 1) * a;
      cam.oy = (Math.random() * 2 - 1) * a;
    } else { cam.ox = 0; cam.oy = 0; this.shake.amt = 0; }
  }

  private render(dt: number) {
    const m = this.match;
    const t = this.time.now / 1000;
    this.floor.update();
    this.shadowG.clear();
    this.floorG.clear();
    this.overG.clear();
    this.reflectG.clear();

    const live = m.phase === 'live';
    m.players.forEach((p, i) => {
      const g = this.playerGs[i];
      g.clear();
      g.setDepth(depthOf(p.y));
      const opts = { onDefense: live && p.side === m.defense && m.ball.state !== 'loose', time: t };
      this.rig.drawShadow(this.shadowG, p);
      this.rig.draw(g, p, m.ball, opts);
    });

    this.fx.drawBall(m.ball, this.shadowG, this.reflectG, null);
    this.fx.updateRings(dt);
    this.park.update(dt, t, this.rig);

    if (!this.demo) this.drawIndicators(t);
  }

  private drawIndicators(t: number) {
    const m = this.match;
    const u = m.user;
    const fg = this.floorG;
    const og = this.overG;
    if (!u) return;
    const col = lighten(u.team.primary, 0.35);

    const base = project(u.x, u.y, 0);
    const pulse = 1 + Math.sin(t * 6) * 0.05;
    fg.lineStyle(4, col, 0.95);
    fg.strokeEllipse(base.x, base.y, 2.8 * base.k * pulse, 2.8 * base.k * Z_SCALE * 0.82 * pulse);
    fg.lineStyle(2, 0xffffff, 0.5);
    fg.strokeEllipse(base.x, base.y, 2.25 * base.k, 2.25 * base.k * Z_SCALE * 0.82);

    const head = project(u.x, u.y, u.z + u.def.height * 1.42);
    const bob = Math.sin(t * 5) * 3;
    og.fillStyle(0x0b0d14, 0.9);
    og.fillTriangle(head.x - 13, head.y - 22 + bob, head.x + 13, head.y - 22 + bob, head.x, head.y - 4 + bob);
    og.fillStyle(col, 1);
    og.fillTriangle(head.x - 9, head.y - 20 + bob, head.x + 9, head.y - 20 + bob, head.x, head.y - 8 + bob);
    if (u.stamina < 0.985) {
      const w = 46;
      og.fillStyle(0x0b0d14, 0.85);
      og.fillRoundedRect(head.x - w / 2 - 2, head.y - 34 + bob, w + 4, 8, 3);
      og.fillStyle(u.stamina < 0.25 ? 0xff5a3c : 0x5cff7a, 1);
      og.fillRoundedRect(head.x - w / 2, head.y - 32 + bob, w * u.stamina, 4, 2);
    }

    if (m.ball.owner === u && m.ball.state === 'held' && m.phase === 'live') {
      const target = m.choosePassTarget(u, this.lastInput);
      if (target) {
        const tp = project(target.x, target.y, 0);
        fg.lineStyle(3, 0xffffff, 0.55 + Math.sin(t * 8) * 0.2);
        const rx = 1.5 * tp.k; const ry = rx * Z_SCALE * 0.82;
        for (let a = 0; a < 8; a++) {
          const a0 = (a / 8) * Math.PI * 2 + t * 1.5;
          fg.lineBetween(tp.x + Math.cos(a0) * rx, tp.y + Math.sin(a0) * ry, tp.x + Math.cos(a0 + 0.42) * rx, tp.y + Math.sin(a0 + 0.42) * ry);
        }
        const tl = project(target.x, target.y, target.def.height * 1.45);
        og.fillStyle(0xffffff, 0.9);
        og.fillCircle(tl.x, tl.y - 8, 5);
      }
    }

    // Shot meter under the shooter's feet
    if (u.charging) this.fx.drawMeter(og, u, null, 0);
    else if (this.meterFreeze && this.meterFreeze.p === u) this.fx.drawMeter(og, u, this.meterFreeze.value, this.meterFreeze.color);

    for (const p of m.players) {
      if (p === u || p.side !== u.side) continue;
      const pp = project(p.x, p.y, 0);
      fg.lineStyle(2, col, 0.35);
      fg.strokeEllipse(pp.x, pp.y, 2.2 * pp.k, 2.2 * pp.k * Z_SCALE * 0.82);
    }

    // Off-screen arrow for the controlled player
    if (base.x < 30 || base.x > VIEW.W - 30) {
      const left = base.x < 30;
      const ax = left ? 34 : VIEW.W - 34;
      const ay = clamp(base.y - 60, 80, VIEW.H - 80);
      og.fillStyle(col, 0.95);
      og.fillTriangle(ax + (left ? -22 : 22), ay, ax + (left ? 6 : -6), ay - 18, ax + (left ? 6 : -6), ay + 18);
    }
  }
}

export function randomDemoConfig(): MatchConfig {
  const a = pick(TEAMS);
  let b = pick(TEAMS);
  while (b === a) b = pick(TEAMS);
  return { teams: [a, b], userSide: null, starIndex: 0, difficulty: 'pro', gameTime: 150 };
}

/** Night-time vignette: darkens the edges and the far background. */
function buildVignette(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = VIEW.W; c.height = VIEW.H;
  const g = c.getContext('2d')!;
  const rg = g.createRadialGradient(VIEW.W / 2, VIEW.H * 0.62, VIEW.H * 0.3, VIEW.W / 2, VIEW.H * 0.62, VIEW.W * 0.68);
  rg.addColorStop(0, 'rgba(6,6,20,0)');
  rg.addColorStop(1, 'rgba(6,6,20,0.62)');
  g.fillStyle = rg;
  g.fillRect(0, 0, VIEW.W, VIEW.H);
  const top = g.createLinearGradient(0, 0, 0, VIEW.H * 0.4);
  top.addColorStop(0, 'rgba(10,8,30,0.25)');
  top.addColorStop(1, 'rgba(10,8,30,0)');
  g.fillStyle = top;
  g.fillRect(0, 0, VIEW.W, VIEW.H * 0.4);
  return c;
}
