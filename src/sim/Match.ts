import { CHAR_VIS, COURT, DIFFICULTY, MOVES, PHYS, RULES, SHOT, type Difficulty, type DifficultyTuning, type Hoop } from '../config';
import { Emitter } from '../core/Emitter';
import { chance, clamp, rand } from '../core/math';
import type { TeamDef } from '../data/teams';
import { runAI } from '../ai/brain';
import { Ball, type ShotResult } from './Ball';
import { attackHoop, defendHoop, depthFrom, hoopDist, inBounds, isThree, MID_X, rel } from './court';
import { Player, type Side } from './Player';
import { jumpShotChance, layupChance, releaseQuality, type ReleaseGrade } from './shooting';

export interface MatchConfig {
  teams: [TeamDef, TeamDef];
  userSide: Side | null;
  starIndex: number;
  difficulty: Difficulty;
  gameTime: number;
}

export interface InputState {
  mx: number;
  my: number;
  sprint: boolean;
  shootHeld: boolean;
  shootPressed: boolean;
  shootReleased: boolean;
  passPressed: boolean;
  switchPressed: boolean;
  crossPressed: boolean;
  stealPressed: boolean;
  aim: { x: number; y: number } | null;
}

export const NO_INPUT: InputState = {
  mx: 0, my: 0, sprint: false, shootHeld: false, shootPressed: false, shootReleased: false,
  passPressed: false, switchPressed: false, crossPressed: false, stealPressed: false, aim: null,
};

export type Phase = 'intro' | 'check' | 'live' | 'dead' | 'over';

export interface MatchEvents extends Record<string, unknown> {
  release: { p: Player; grade: ReleaseGrade | null; q: number; three: boolean; chance: number };
  score: { side: Side; pts: number; p: Player | null; kind: ShotResult | 'putback'; assist: Player | null };
  miss: { p: Player };
  rim: { strength: number; hoop: Hoop };
  board: { strength: number };
  bounce: { strength: number; x: number; y: number };
  dribble: { x: number; y: number };
  steal: { p: Player; from: Player | null; intercept: boolean };
  block: { p: Player; shooter: Player };
  pass: { from: Player; to: Player };
  catch: { p: Player };
  crossover: { p: Player };
  ankles: { p: Player; by: Player };
  turnover: { side: Side; reason: string };
  whistle: null;
  buzzer: null;
  banner: { text: string; sub?: string; tone?: 'home' | 'away' | 'neutral' | 'warn' };
  possession: { side: Side };
  shake: { amount: number; ms: number };
  net: { strength: number; hoop: Hoop };
  dunk: { p: Player };
  jump: { p: Player };
  squeak: { p: Player };
  gameover: null;
  rebound: { p: Player; offensive: boolean };
}

type Restart = 'backcourt' | 'frontcourt';

/** Hoop-relative (u from baseline, v lateral) spots for restarts. Index 0 is the ball handler. */
const BACKCOURT_OFF = [{ u: 14, v: -4 }, { u: 30, v: 16 }, { u: 30, v: -16 }, { u: 40, v: 7 }, { u: 22, v: 10 }];
const BACKCOURT_DEF = [{ u: 34, v: -2 }, { u: 24, v: 13 }, { u: 24, v: -13 }, { u: 12, v: 5 }, { u: 10, v: -6 }];
const FRONT_OFF = [{ u: 31, v: 0 }, { u: 20, v: 17 }, { u: 20, v: -17 }, { u: 7, v: -10 }, { u: 6, v: 11 }];

export class Match {
  readonly ev = new Emitter<MatchEvents>();
  readonly cfg: MatchConfig;
  readonly tune: DifficultyTuning;
  readonly players: Player[] = [];
  readonly ball = new Ball();

  time = 0;
  phase: Phase = 'intro';
  phaseT = 0;
  gameClock: number;
  shotClock: number = RULES.SHOT_CLOCK;
  score: [number, number] = [0, 0];
  offense: Side = 0;
  nextOffense: Side = 1;
  nextRestart: Restart = 'backcourt';
  overtime = false;
  buzzerPending = false;
  ended = false;
  /** Who each defender is guarding, keyed by defender id. */
  assign = new Map<number, Player>();
  /** Formation targets during check / dead ball. */
  formation = new Map<number, { x: number; y: number; face: { x: number; y: number } | null }>();
  user: Player | null = null;
  private prevSprint = new Map<number, boolean>();
  /** A poked-loose ball only counts as a steal if the defense recovers it. */
  private pendingSteal: { d: Player; h: Player } | null = null;

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.tune = DIFFICULTY[cfg.difficulty];
    this.gameClock = cfg.gameTime;
    let id = 0;
    for (const side of [0, 1] as Side[]) {
      for (const def of cfg.teams[side].players) this.players.push(new Player(id++, def, side, cfg.teams[side]));
    }
    const first: Side = cfg.userSide ?? (chance(0.5) ? 0 : 1);
    this.setupCheck(first, 'backcourt', true);
  }

  team(side: Side): Player[] { return this.players.filter((p) => p.side === side); }
  opponents(p: Player): Player[] { return this.players.filter((o) => o.side !== p.side); }
  teammates(p: Player): Player[] { return this.players.filter((o) => o.side === p.side && o !== p); }
  get handler(): Player | null { return this.ball.state === 'held' ? this.ball.owner : null; }
  get defense(): Side { return (1 - this.offense) as Side; }
  /** The basket the current offense is attacking. */
  get targetHoop(): Hoop { return attackHoop(this.offense); }

  // ------------------------------------------------------------------ setup

  private setupCheck(side: Side, restart: Restart, intro = false) {
    this.phase = intro ? 'intro' : 'check';
    this.phaseT = 0;
    this.offense = side;
    this.shotClock = RULES.SHOT_CLOCK;
    const off = this.team(side);
    const def = this.team((1 - side) as Side);
    const H = attackHoop(side);
    const own = defendHoop(side);

    let handler: Player;
    if (this.cfg.userSide === side) handler = off[this.cfg.starIndex] ?? off[0];
    else handler = [...off].sort((a, b) => b.r.handling + b.r.passing - (a.r.handling + a.r.passing))[0];
    const order = [handler, ...off.filter((p) => p !== handler)];

    this.assign.clear();
    this.formation.clear();
    order.forEach((p, i) => {
      const s = restart === 'backcourt' ? rel(own, BACKCOURT_OFF[i % 5].u, BACKCOURT_OFF[i % 5].v) : rel(H, FRONT_OFF[i % 5].u, FRONT_OFF[i % 5].v);
      this.formation.set(p.id, { x: s.x, y: s.y, face: { x: H.x, y: H.y } });
    });
    def.forEach((d, i) => {
      const man = off[i] ?? off[0];
      this.assign.set(d.id, man);
      let tx: number; let ty: number;
      if (restart === 'backcourt') {
        const s = rel(H, BACKCOURT_DEF[i % 5].u, BACKCOURT_DEF[i % 5].v);
        tx = s.x; ty = s.y;
      } else {
        const ms = this.formation.get(man.id)!;
        tx = ms.x + (H.x - ms.x) * 0.16;
        ty = ms.y + (H.y - ms.y) * 0.16;
      }
      this.formation.set(d.id, { x: tx, y: ty, face: { x: own.x, y: own.y } });
    });

    this.giveBallRaw(handler);
    if (intro) {
      for (const p of this.players) {
        const f = this.formation.get(p.id)!;
        p.x = f.x + (MID_X - f.x) * 0.25; p.y = f.y; p.vx = 0; p.vy = 0; p.z = 0; p.vz = 0;
      }
    }

    if (this.cfg.userSide !== null) {
      if (this.cfg.userSide === side) this.setUser(handler);
      else this.setUser(def.find((d) => this.assign.get(d.id) === handler) ?? def[0]);
    }
    for (const p of this.players) { p.setAction('none'); p.charging = false; p.released = false; }
  }

  private setUser(p: Player | null) {
    if (this.user) this.user.isUser = false;
    this.user = p;
    if (p) p.isUser = true;
  }

  // ------------------------------------------------------------------ main loop

  update(rawDt: number, input: InputState) {
    const dt = Math.min(rawDt, 1 / 30);
    this.time += dt;
    this.phaseT += dt;

    switch (this.phase) {
      case 'intro':
      case 'check':
        this.formationStep();
        if (this.phaseT > (this.phase === 'intro' ? 2.6 : RULES.CHECK_TIME)) this.goLive();
        break;
      case 'live':
        this.liveStep(dt, input);
        break;
      case 'dead':
        this.formationStep();
        if (this.phaseT > RULES.DEAD_TIME) {
          if (this.ended) { this.finish(); break; }
          this.setupCheck(this.nextOffense, this.nextRestart);
        }
        break;
      case 'over':
        for (const p of this.players) { p.mx = 0; p.my = 0; p.sprint = false; }
        break;
    }

    for (const p of this.players) {
      if (p.sprint && !this.prevSprint.get(p.id) && p.speed > 6) this.ev.emit('squeak', { p });
      this.prevSprint.set(p.id, p.sprint);
      const speedMult = p.side === this.defense && !p.isUser && this.cfg.userSide !== null ? this.tune.defSpeed : 1;
      p.update(dt, this.ball.owner === p && this.ball.state === 'held', speedMult);
    }
    this.separatePlayers();
    if (this.phase === 'live') this.updateActions(dt);
    this.updateBall(dt);
  }

  private goLive() {
    this.phase = 'live';
    this.phaseT = 0;
    this.formation.clear();
    this.reassignDefense(true);
    if (this.overtime) this.ev.emit('banner', { text: 'NEXT BUCKET WINS', tone: 'neutral' });
    this.ev.emit('whistle', null);
  }

  private formationStep() {
    for (const p of this.players) {
      const f = this.formation.get(p.id);
      p.sprint = false;
      if (!f) { p.mx = 0; p.my = 0; continue; }
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.35) { p.mx = 0; p.my = 0; }
      else { const s = Math.min(1, d / 3) * 0.9; p.mx = (dx / d) * s; p.my = (dy / d) * s; }
      p.sprint = d > 12;
      p.faceTarget = d < 3 ? f.face : null;
    }
  }

  private liveStep(dt: number, input: InputState) {
    if (!this.overtime && this.gameClock > 0) {
      this.gameClock = Math.max(0, this.gameClock - dt);
      if (this.gameClock === 0) this.onBuzzer();
    }
    const b = this.ball;
    const shotClockRuns = b.state !== 'dead' && !(b.state === 'loose' && b.touchedRim) && b.state !== 'shot';
    if (shotClockRuns && this.phase === 'live') {
      this.shotClock = Math.max(0, this.shotClock - dt);
      if (this.shotClock === 0) { this.turnover(this.offense, 'SHOT CLOCK'); return; }
    }
    if (this.phase !== 'live') return;
    if (this.buzzerPending && b.state !== 'shot') { this.resolveBuzzer(); return; }

    if (input.switchPressed) this.switchUser();
    for (const p of this.players) {
      p.faceTarget = null;
      if (p === this.user) this.applyUserInput(p, input);
      else runAI(this, p, dt);
    }
  }

  // ------------------------------------------------------------------ user input

  private applyUserInput(p: Player, input: InputState) {
    p.mx = input.mx;
    p.my = input.my;
    p.sprint = input.sprint;
    const b = this.ball;
    const hasBall = b.owner === p && b.state === 'held';

    if (hasBall) {
      if (input.crossPressed) this.crossover(p, input.mx, input.my);
      if (input.shootPressed) this.beginShot(p);
      if (p.charging && (input.shootReleased || !input.shootHeld) && p.actionT > 0.04) this.releaseJumper(p);
      if (input.passPressed && !p.locked) {
        const target = this.choosePassTarget(p, input);
        if (target) this.passBall(p, target);
      }
      if (Math.hypot(input.mx, input.my) < 0.1) p.faceTarget = { x: p.hoop.x, y: p.hoop.y };
      return;
    }
    if (input.stealPressed) this.attemptSteal(p);
    if (p.side !== this.offense || b.state === 'loose' || b.state === 'shot') {
      if (input.shootPressed) this.contestJump(p);
      if (p.side !== this.offense && Math.hypot(input.mx, input.my) < 0.1) p.faceTarget = { x: b.x, y: b.y };
    } else {
      // Offense without the ball: E calls for the pass
      if (input.passPressed) {
        const h = this.handler;
        if (h && h.side === p.side && !h.locked) this.passBall(h, p);
      }
    }
  }

  switchUser() {
    const cur = this.user;
    if (!cur || this.cfg.userSide === null) return;
    if (this.ball.owner === cur && this.ball.state === 'held') return;
    const ref = { x: this.ball.x, y: this.ball.y };
    const sorted = this.team(cur.side).filter((m) => m !== cur).sort((a, b) => a.distTo(ref) - b.distTo(ref));
    if (sorted[0]) {
      cur.charging = false;
      this.setUser(sorted[0]);
    }
  }

  choosePassTarget(p: Player, input: InputState): Player | null {
    const mates = this.teammates(p);
    let dir: { x: number; y: number } | null = null;
    if (Math.hypot(input.mx, input.my) > 0.3) dir = { x: input.mx, y: input.my };
    else if (input.aim) dir = { x: input.aim.x - p.x, y: input.aim.y - p.y };
    if (dir) {
      const dl = Math.hypot(dir.x, dir.y) || 1;
      let best: Player | null = null;
      let bestScore = -Infinity;
      for (const m of mates) {
        const mx = m.x - p.x; const my = m.y - p.y;
        const ml = Math.hypot(mx, my) || 1;
        const cos = (mx * dir.x + my * dir.y) / (ml * dl);
        const score = cos * 2 - ml / 80;
        if (cos > -0.2 && score > bestScore) { bestScore = score; best = m; }
      }
      if (best) return best;
    }
    return this.mostOpen(mates);
  }

  mostOpen(list: Player[]): Player | null {
    let best: Player | null = null;
    let bestD = -1;
    for (const m of list) {
      const d = this.nearestOpponentDist(m);
      if (d > bestD) { bestD = d; best = m; }
    }
    return best;
  }

  nearestOpponentDist(p: Player): number {
    let best = 99;
    for (const o of this.players) if (o.side !== p.side) best = Math.min(best, p.distTo(o));
    return best;
  }

  // ------------------------------------------------------------------ actions

  beginShot(p: Player): boolean {
    if (this.ball.owner !== p || this.ball.state !== 'held' || p.locked || p.airborne) return false;
    const d = p.distToHoop();
    const canDunk = p.r.dunk >= 55 && p.stamina > 0.12 && (d < 3.6 || (d < SHOT.DUNK_RANGE && p.sprint && p.speed > 9));
    const H = p.hoop;
    if (d < SHOT.LAYUP_RANGE || canDunk) {
      p.setAction(canDunk ? 'dunk' : 'layup');
      const tgt = this.attackPoint(p);
      p.shotTarget = tgt;
      const T = canDunk ? 0.5 : 0.46;
      p.vx = (tgt.x - p.x) / T;
      p.vy = (tgt.y - p.y) / T;
      p.faceTarget = { x: H.x, y: H.y };
      p.facing = Math.atan2(H.y - p.y, H.x - p.x);
      p.released = false;
      p.stats.fga++;
      return true;
    }
    p.setAction('jumpshot');
    p.charging = true;
    p.released = false;
    p.charge = 0;
    p.facing = Math.atan2(H.y - p.y, H.x - p.x);
    p.ai.releaseAt = SHOT.PERFECT;
    return true;
  }

  /** Point just in front of the rim on the shooter's side. */
  private attackPoint(p: Player): { x: number; y: number } {
    const H = p.hoop;
    const along = Math.max(0.6, (p.x - H.x) * H.dir) * H.dir;
    const dy = p.y - H.y;
    const l = Math.hypot(along, dy) || 1;
    return { x: H.x + (along / l) * 1.7, y: H.y + (dy / l) * 1.7 };
  }

  releaseJumper(p: Player) {
    if (!p.charging || this.ball.owner !== p) return;
    p.charging = false;
    p.released = true;
    const { q, grade } = releaseQuality(p.charge);
    const evals = jumpShotChance(p, this.opponents(p), q, Math.hypot(p.vx, p.vy));
    p.stats.fga++;
    if (evals.three) p.stats.tpa++;
    const make = Math.random() < evals.p;
    let result: ShotResult;
    if (make) result = q >= 0.95 && evals.contest < 0.5 ? 'swish' : chance(0.55) ? 'swish' : 'rimIn';
    else if (q < 0.15 && evals.dist > 12 && chance(0.6)) result = 'airball';
    else result = chance(0.25) && evals.dist > 6 ? 'boardOut' : 'rimOut';
    this.ev.emit('release', { p, grade, q, three: evals.three, chance: evals.p });
    this.launchShot(p, result, evals.three ? 3 : 2, q);
  }

  private launchShot(p: Player, result: ShotResult, points: 2 | 3, quality: number) {
    const b = this.ball;
    const H = p.hoop;
    b.state = 'shot';
    b.owner = null;
    b.lastTouch = p.side;
    b.x = p.x + Math.cos(p.facing) * 0.5;
    b.y = p.y + Math.sin(p.facing) * 0.5;
    b.z = p.z + p.def.height * 1.12 * CHAR_VIS;
    b.reboundable = true;
    b.touchedRim = false;
    b.throughHoop = false;
    p.touchLock = 0.3;
    const dist = hoopDist(b.x, b.y, H);
    const apex = 2.6 + dist * 0.12;
    let tx = H.x; let ty = H.y; let tz = H.z + 0.05;
    const ang = Math.atan2(b.y - H.y, b.x - H.x);
    switch (result) {
      case 'rimIn': {
        const a = ang + rand(-0.5, 0.5);
        tx = H.x + Math.cos(a) * COURT.RIM_R * 0.9; ty = H.y + Math.sin(a) * COURT.RIM_R * 0.9; tz = H.z + 0.42;
        break;
      }
      case 'rimOut':
      case 'layupOut': {
        const a = ang + rand(-1.3, 1.3) + (chance(0.4) ? Math.PI : 0);
        const r = COURT.RIM_R + 0.18;
        tx = H.x + Math.cos(a) * r; ty = H.y + Math.sin(a) * r; tz = H.z + 0.3;
        break;
      }
      case 'boardOut': {
        const bx = H.dir === 1 ? COURT.BOARD.inset : COURT.L - COURT.BOARD.inset;
        tx = bx + H.dir * (PHYS.BALL_R + 0.02); ty = H.y + rand(-1.4, 1.4); tz = H.z + rand(1.2, 2.4);
        break;
      }
      case 'airball': {
        const short = rand(2.5, 4.5);
        tx = H.x + Math.cos(ang) * short; ty = H.y + Math.sin(ang) * short + rand(-1.5, 1.5); tz = 8.6;
        break;
      }
      default:
        break;
    }
    const T = result === 'layupIn' || result === 'layupOut'
      ? Ball.flightTime(b.z, tz, 1.2)
      : Ball.flightTime(b.z, tz, apex);
    b.aimAt(tx, ty, tz, T);
    b.shot = {
      shooter: p, hoop: H, result, points, t: 0, T, stage: 0,
      releasedBeforeBuzzer: this.gameClock > 0 || this.overtime,
      blockChecked: new Set(), quality,
    };
  }

  passBall(from: Player, to: Player) {
    const b = this.ball;
    if (b.owner !== from || b.state !== 'held') return;
    const dist = from.distTo(to);
    let T = Ball.flightTime(4, 4, 0.5 + dist * 0.016);
    T /= 0.9 + from.r.passing / 500;
    const lx = to.x + to.vx * T * 0.8;
    const ly = to.y + to.vy * T * 0.8;
    b.state = 'pass';
    b.owner = null;
    b.lastTouch = from.side;
    b.x = from.x + Math.cos(from.facing) * 0.8;
    b.y = from.y + Math.sin(from.facing) * 0.8;
    b.z = 4.2;
    b.aimAt(lx, ly, 4.0, T);
    b.pass = { from, to, t: 0, T, checked: new Set() };
    from.setAction('pass');
    from.facing = Math.atan2(ly - from.y, lx - from.x);
    from.touchLock = 0.35;
    to.lastPasser = from;
    this.ev.emit('pass', { from, to });
  }

  /**
   * Crossover: switch hands with a hard lateral burst. A defender caught
   * reaching or overplaying can lose their footing ("ankles").
   */
  crossover(p: Player, mx = 0, my = 0): boolean {
    const b = this.ball;
    if (b.owner !== p || b.state !== 'held' || p.locked || p.airborne || p.crossCd > 0 || p.action === 'crossover') return false;
    p.setAction('crossover');
    p.crossCd = MOVES.CROSSOVER_COOLDOWN;
    p.dribbleSide = (p.dribbleSide === 1 ? -1 : 1);
    const fx = Math.cos(p.facing); const fy = Math.sin(p.facing);
    // Burst toward the input direction if given, else toward the new ball side.
    let dx = -fy * p.dribbleSide * 0.85 + fx * 0.5;
    let dy = fx * p.dribbleSide * 0.85 + fy * 0.5;
    if (Math.hypot(mx, my) > 0.3) { dx = mx; dy = my; }
    const dl = Math.hypot(dx, dy) || 1;
    const burst = 10 + p.r.handling / 12 + p.r.speed / 25;
    p.vx = (dx / dl) * burst;
    p.vy = (dy / dl) * burst;
    this.ev.emit('crossover', { p });

    for (const d of this.opponents(p)) {
      if (d.airborne || d.action === 'ankles' || d.distTo(p) > 5.5) continue;
      // Is the defender in front of the ball handler?
      const ox = d.x - p.x; const oy = d.y - p.y;
      const inFront = (ox * fx + oy * fy) / (Math.hypot(ox, oy) || 1) > -0.1;
      if (!inFront) continue;
      let c = 0.06 + (p.r.handling - d.r.defense) / 260;
      if (d.action === 'reach') c += 0.4; // caught gambling
      if (d.speed > 7) c += 0.1; // moving the wrong way
      if (!d.isUser && this.cfg.userSide !== null && d.side !== this.cfg.userSide) c *= this.tune.anklesMult;
      if (d.isUser) c *= 0.75;
      if (Math.random() < clamp(c, 0.02, 0.7)) {
        d.setAction('ankles');
        d.charging = false;
        this.ev.emit('ankles', { p: d, by: p });
        this.ev.emit('shake', { amount: 0.005, ms: 180 });
      } else if (!d.isUser) {
        // Even when they stay up, the defender's read is delayed.
        d.ai.tx = d.x; d.ai.ty = d.y;
      }
    }
    return true;
  }

  attemptSteal(d: Player) {
    if (d.stealCd > 0 || d.locked || d.airborne) return;
    d.setAction('reach');
    d.stealCd = 0.85;
    const h = this.handler;
    const b = this.ball;
    if (!h || h.side === d.side) return;
    const reach = Math.hypot(b.x - d.x, b.y - d.y);
    if (reach > 3.1 || d.distTo(h) > 4.2) return; // whiff
    let p = 0.26 + (d.r.steal - h.r.handling) / 170 + (3.1 - reach) * 0.06;
    if (h.action === 'jumpshot' || h.action === 'layup') p *= 0.4;
    if (h.action === 'crossover') p *= 0.35;
    if (!d.isUser && this.cfg.userSide !== null && d.side !== this.cfg.userSide) p *= 0.85;
    p = clamp(p, 0.05, 0.7);
    if (Math.random() < p) {
      h.touchLock = 0.6;
      h.charging = false;
      if (h.locked) h.setAction('none');
      if (chance(0.55)) {
        d.stats.stl++;
        h.stats.tov++;
        this.ev.emit('steal', { p: d, from: h, intercept: false });
        this.giveBall(d);
        return;
      }
      b.state = 'loose';
      b.owner = null;
      b.lastTouch = d.side;
      const ax = d.x - h.x; const ay = d.y - h.y; const al = Math.hypot(ax, ay) || 1;
      b.x = (b.x + d.x) / 2; b.y = (b.y + d.y) / 2; b.z = Math.min(b.z, 2.5);
      b.vx = (ax / al) * rand(3, 6) + rand(-2, 2);
      b.vy = (ay / al) * rand(3, 6) + rand(-2, 2);
      b.vz = rand(1, 3);
      b.reboundable = false;
      this.pendingSteal = { d, h };
    } else if (chance(0.5)) {
      d.setAction('stumble');
    }
  }

  contestJump(p: Player) {
    if (p.airborne || p.locked) return;
    p.setAction('contest');
    p.startJump(1);
    this.ev.emit('jump', { p });
  }

  private updateActions(dt: number) {
    for (const p of this.players) {
      if (p.action === 'jumpshot') {
        if (p.charging) {
          const rate = 1 / (SHOT.METER_TIME * (1.08 - p.r.shooting / 900));
          p.charge += dt * rate;
          if (p.actionT > 0.07 && !p.airborne && p.z === 0 && p.vz === 0) {
            p.vz = 12.5 + p.def.height * 0.3;
            this.ev.emit('jump', { p });
          }
          if (p.charge >= SHOT.AUTO_RELEASE) this.releaseJumper(p);
        } else if (p.released && p.z <= 0 && p.actionT > 0.2) {
          p.setAction('none');
          p.released = false;
        }
      } else if (p.action === 'layup' || p.action === 'dunk') {
        const isDunk = p.action === 'dunk';
        if (p.actionT > 0.1 && !p.airborne && !p.released && p.vz === 0) {
          p.vz = isDunk ? 17.5 + p.r.dunk / 25 : 14;
          this.ev.emit('jump', { p });
        }
        const releaseT = isDunk ? 0.5 : 0.42;
        if (!p.released && p.actionT >= releaseT) {
          p.released = true;
          p.vx *= 0.25; p.vy *= 0.25;
          if (this.ball.owner === p) this.finishAtRim(p, isDunk);
        }
        if (p.released && p.z <= 0 && p.actionT > releaseT + 0.1) {
          p.setAction('none');
          p.released = false;
          p.vx = 0; p.vy = 0;
        }
      }
    }
  }

  private finishAtRim(p: Player, dunk: boolean) {
    const defs = this.opponents(p);
    const ev = layupChance(p, defs, dunk);
    const H = p.hoop;
    for (const d of defs) {
      if (!d.airborne) continue;
      if (Math.hypot(d.x - p.x, d.y - p.y) < 2.8 && Math.random() < (dunk ? 0.04 : 0.1) + d.r.block / 600) {
        this.ev.emit('release', { p, grade: null, q: 0.5, three: false, chance: ev.p });
        this.ball.state = 'shot';
        this.ball.owner = null;
        this.ball.lastTouch = p.side;
        this.ball.reboundable = true;
        this.doBlock(d, p);
        return;
      }
    }
    const make = Math.random() < ev.p;
    this.ev.emit('release', { p, grade: null, q: 0.8, three: false, chance: ev.p });
    const b = this.ball;
    if (dunk && make) {
      b.state = 'loose';
      b.owner = null;
      b.lastTouch = p.side;
      b.x = H.x; b.y = H.y; b.z = H.z - 0.2;
      b.vx = 0; b.vy = 0; b.vz = -18;
      b.reboundable = false;
      b.throughHoop = true;
      p.vz = Math.max(p.vz, 1.5);
      this.ev.emit('dunk', { p });
      this.ev.emit('shake', { amount: 0.012, ms: 260 });
      this.ev.emit('net', { strength: 1.6, hoop: H });
      this.ev.emit('rim', { strength: 1.4, hoop: H });
      this.scoreBasket(p.side, 2, p, 'dunk');
      return;
    }
    if (dunk && !make) {
      b.state = 'loose';
      b.owner = null;
      b.lastTouch = p.side;
      b.x = H.x + H.dir * 0.3; b.y = H.y; b.z = H.z + 0.6;
      b.vx = H.dir * rand(5, 10); b.vy = rand(-6, 6); b.vz = rand(8, 12);
      b.reboundable = true;
      b.touchedRim = true;
      this.ev.emit('rim', { strength: 1.2, hoop: H });
      this.ev.emit('miss', { p });
      return;
    }
    this.launchShot(p, make ? 'layupIn' : 'layupOut', 2, 0.8);
  }

  private doBlock(d: Player, shooter: Player) {
    const b = this.ball;
    const H = shooter.hoop;
    b.state = 'loose';
    b.owner = null;
    const ax = b.x - H.x; const ay = b.y - H.y; const al = Math.hypot(ax, ay) || 1;
    b.vx = (ax / al) * rand(6, 11) + rand(-3, 3);
    b.vy = (ay / al) * rand(6, 11) + rand(-3, 3);
    b.vz = rand(-5, 4);
    b.lastTouch = d.side;
    b.shot = null;
    b.reboundable = true;
    d.stats.blk++;
    this.ev.emit('block', { p: d, shooter });
    this.ev.emit('shake', { amount: 0.009, ms: 220 });
  }

  // ------------------------------------------------------------------ ball

  private updateBall(dt: number) {
    const b = this.ball;
    switch (b.state) {
      case 'held': this.updateHeldBall(dt); break;
      case 'shot': this.updateShot(dt); break;
      case 'pass': this.updatePass(dt); break;
      case 'loose': this.updateLoose(dt); break;
      case 'dead': break;
    }
  }

  private updateHeldBall(dt: number) {
    const b = this.ball;
    const p = b.owner;
    if (!p) { b.state = 'loose'; return; }
    const fx = Math.cos(p.facing); const fy = Math.sin(p.facing);
    const rx = -fy; const ry = fx;
    const shooting = p.action === 'jumpshot' || p.action === 'layup' || p.action === 'dunk';
    if (shooting) {
      const lift = p.action === 'jumpshot' ? 6.6 + Math.min(1, p.charge) * 0.7 : p.action === 'dunk' ? 7.6 : 7.0;
      b.x = p.x + fx * 0.55;
      b.y = p.y + fy * 0.55;
      b.z = p.z + lift * (p.def.height / 6.6) * CHAR_VIS;
      b.vx = p.vx; b.vy = p.vy; b.vz = 0;
      return;
    }
    if (this.phase !== 'live' || p.action === 'pass') {
      b.x = p.x + fx * 0.8; b.y = p.y + fy * 0.8; b.z = 4.1;
      return;
    }
    const speed = p.speed;
    if (p.action === 'crossover') {
      // Low, quick bounce across the body to the new hand.
      const t = Math.min(1, p.actionT / MOVES.CROSSOVER_TIME);
      const side = p.dribbleSide * (-1 + 2 * t) * 0.95;
      b.x = p.x + fx * 0.85 + rx * side;
      b.y = p.y + fy * 0.85 + ry * side;
      const prevZ = b.z;
      b.z = PHYS.BALL_R + Math.abs(Math.cos(t * Math.PI)) * 1.3;
      if (prevZ > PHYS.BALL_R + 0.3 && b.z <= PHYS.BALL_R + 0.3) this.ev.emit('dribble', { x: b.x, y: b.y });
      b.dribblePhase = Math.PI; // resume the regular dribble from the floor
      return;
    }
    const prev = b.dribblePhase;
    b.dribblePhase += dt * (3.6 + speed * 0.16) * Math.PI;
    const side = 0.95 * p.dribbleSide;
    const fwd = 0.55 + Math.min(1, speed / 14) * 0.7;
    b.x = p.x + fx * fwd + rx * side + p.vx * 0.03;
    b.y = p.y + fy * fwd + ry * side + p.vy * 0.03;
    b.z = PHYS.BALL_R + Math.abs(Math.cos(b.dribblePhase)) * 2.7;
    b.vx = p.vx; b.vy = p.vy;
    b.spin += dt * 4;
    if (Math.floor(prev / Math.PI - 0.5) !== Math.floor(b.dribblePhase / Math.PI - 0.5)) {
      this.ev.emit('dribble', { x: b.x, y: b.y });
    }
  }

  private updateShot(dt: number) {
    const b = this.ball;
    const s = b.shot;
    if (!s) { b.state = 'loose'; return; }
    s.t += dt;
    b.integrate(dt);
    const H = s.hoop;

    if (s.stage === 0 && s.t < 0.38) {
      for (const d of this.opponents(s.shooter)) {
        if (!d.airborne || s.blockChecked.has(d.id)) continue;
        const handZ = d.z + d.def.height * 1.3;
        const dd = Math.hypot(d.x - b.x, d.y - b.y, (handZ - b.z) * 0.8);
        if (dd < 1.35) {
          s.blockChecked.add(d.id);
          const sh = s.shooter;
          const front = (d.x - sh.x) * (H.x - sh.x) + (d.y - sh.y) * (H.y - sh.y) > 0;
          if (front && Math.random() < 0.08 + d.r.block / 500) { this.doBlock(d, s.shooter); return; }
        }
      }
    }

    if (s.t < s.T) return;

    switch (s.result) {
      case 'swish':
      case 'layupIn':
        this.makeThrough(s.shooter, s.points, s.result, H);
        return;
      case 'rimIn':
        if (s.stage === 0) {
          s.stage = 1;
          s.t = 0;
          s.T = 0.42;
          this.ev.emit('rim', { strength: 0.6, hoop: H });
          b.touchedRim = true;
          b.aimAt(H.x, H.y, H.z - 0.05, s.T);
        } else this.makeThrough(s.shooter, s.points, 'rimIn', H);
        return;
      default:
        b.state = 'loose';
        if (s.result === 'rimOut' || s.result === 'layupOut') {
          // Carom off the iron: away from the rim center, biased back toward the shooter.
          const ox = b.x - H.x; const oy = b.y - H.y; const ol = Math.hypot(ox, oy) || 1;
          const sx = s.shooter.x - H.x; const sy = s.shooter.y - H.y; const sl = Math.hypot(sx, sy) || 1;
          let dx = (ox / ol) * 0.6 + (sx / sl) * 0.4; let dy = (oy / ol) * 0.6 + (sy / sl) * 0.4;
          const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
          // never carom back toward the baseline behind the board
          if (dx * H.dir < -0.2) dx = -0.2 * H.dir;
          const spd = rand(3.5, 8) + hoopDist(s.shooter.x, s.shooter.y, H) * 0.12;
          b.vx = dx * spd; b.vy = dy * spd; b.vz = rand(5, 11);
          b.z = Math.max(b.z, H.z + PHYS.BALL_R + 0.1);
          this.ev.emit('rim', { strength: 0.9, hoop: H });
        }
        b.touchedRim = s.result !== 'airball';
        if (s.result === 'airball') this.ev.emit('banner', { text: 'AIRBALL', tone: 'warn' });
        this.ev.emit('miss', { p: s.shooter });
        if (s.result === 'boardOut') { this.ev.emit('board', { strength: 1 }); b.touchedRim = true; }
        if (this.buzzerPending) this.resolveBuzzer();
        return;
    }
  }

  private makeThrough(shooter: Player, pts: 2 | 3, kind: ShotResult, H: Hoop) {
    const b = this.ball;
    b.state = 'loose';
    b.x = H.x + (b.x - H.x) * 0.3;
    b.y = H.y + (b.y - H.y) * 0.3;
    b.vx *= 0.15; b.vy *= 0.15; b.vz = Math.min(b.vz, -7);
    b.throughHoop = true;
    b.reboundable = false;
    this.ev.emit('net', { strength: kind === 'swish' ? 1.2 : 0.9, hoop: H });
    if (kind === 'rimIn') this.ev.emit('rim', { strength: 0.35, hoop: H });
    this.scoreBasket(shooter.side, pts, shooter, kind);
  }

  private updatePass(dt: number) {
    const b = this.ball;
    const ps = b.pass;
    if (!ps) { b.state = 'loose'; return; }
    ps.t += dt;
    b.integrate(dt);

    for (const d of this.opponents(ps.from)) {
      if (ps.checked.has(d.id) || (d.locked && d.action !== 'contest')) continue;
      const dd = Math.hypot(d.x - b.x, d.y - b.y);
      if (dd < 1.7 && b.z < 7 + d.z) {
        ps.checked.add(d.id);
        let p = 0.16 + d.r.steal / 400 + (d.airborne ? 0.12 : 0);
        if (this.cfg.userSide !== null && d.side !== this.cfg.userSide) p *= this.cfg.difficulty === 'rookie' ? 0.6 : this.cfg.difficulty === 'pro' ? 0.85 : 1;
        if (Math.random() < p) {
          d.stats.stl++;
          ps.from.stats.tov++;
          this.ev.emit('steal', { p: d, from: ps.from, intercept: true });
          this.giveBall(d);
          return;
        }
        if (chance(0.35)) {
          b.state = 'loose';
          b.pass = null;
          b.vx = b.vx * 0.3 + rand(-6, 6);
          b.vy = b.vy * 0.3 + rand(-6, 6);
          b.vz = rand(2, 6);
          b.lastTouch = d.side;
          return;
        }
      }
    }

    const r = ps.to;
    if (ps.t > ps.T * 0.35 && r.touchLock <= 0) {
      const dd = Math.hypot(r.x - b.x, r.y - b.y);
      if (dd < 2.1 && b.z < 7.5 + r.z) {
        this.giveBall(r);
        r.catchTime = this.time;
        this.ev.emit('catch', { p: r });
        return;
      }
    }
    if (ps.t > ps.T + 0.3) {
      b.state = 'loose';
      b.pass = null;
    }
  }

  private updateLoose(dt: number) {
    const b = this.ball;
    const prevZ = b.z;
    const contact = b.physics(dt);
    if (contact === 'floor') {
      this.ev.emit('bounce', { strength: clamp(Math.abs(b.vz) / 12, 0.15, 1), x: b.x, y: b.y });
    } else if (contact === 'rim') {
      b.touchedRim = true;
      this.ev.emit('rim', { strength: 0.8, hoop: b.x < MID_X ? COURT.HOOPS[0] : COURT.HOOPS[1] });
    } else if (contact === 'board') {
      b.touchedRim = true;
      this.ev.emit('board', { strength: 0.8 });
    }

    // A loose ball falling through a hoop after a rim bounce counts (roll-in / put-back).
    if (!b.throughHoop && this.phase === 'live' && b.vz < 0) {
      for (const H of COURT.HOOPS) {
        if (prevZ >= H.z && b.z < H.z && Math.hypot(b.x - H.x, b.y - H.y) < COURT.RIM_R - 0.12) {
          b.throughHoop = true;
          const scoringSide: Side = attackHoop(0) === H ? 0 : 1;
          const shooter = b.shot?.shooter ?? null;
          this.ev.emit('net', { strength: 0.8, hoop: H });
          if (shooter && shooter.side === scoringSide && shooter.side === b.lastTouch) this.scoreBasket(scoringSide, b.shot?.points ?? 2, shooter, 'rimIn');
          else this.scoreBasket(scoringSide, 2, null, 'putback');
          return;
        }
      }
    }
    if (b.throughHoop && b.z < 5) b.throughHoop = b.z > 0.5;

    if (this.phase !== 'live') return;

    if (b.z < 4 && !inBounds(b.x, b.y, 0.8)) {
      const side = (1 - b.lastTouch) as Side;
      this.ev.emit('whistle', null);
      this.ev.emit('banner', { text: 'OUT OF BOUNDS', tone: 'neutral' });
      const frontcourt = depthFrom(attackHoop(side), b.x) < MID_X;
      this.deadBall(side, frontcourt ? 'frontcourt' : 'backcourt');
      return;
    }

    let best: Player | null = null;
    let bestScore = -Infinity;
    for (const p of this.players) {
      if (p.touchLock > 0 || p.action === 'stumble' || p.action === 'ankles') continue;
      const dd = Math.hypot(p.x - b.x, p.y - b.y);
      const reachZ = p.def.height * 1.2 + p.z;
      if (dd < 1.7 && b.z < reachZ) {
        const score = -dd + (p.r.rebound / 100) * (b.reboundable ? 1.2 : 0.3) + Math.random() * 0.8;
        if (score > bestScore) { bestScore = score; best = p; }
      }
    }
    if (best) {
      const ps = this.pendingSteal;
      this.pendingSteal = null;
      if (ps && best.side === ps.d.side) {
        ps.d.stats.stl++;
        ps.h.stats.tov++;
        this.ev.emit('steal', { p: ps.d, from: ps.h, intercept: false });
      }
      this.giveBall(best);
    }
  }

  /** Hand the ball to a player during live play, applying possession rules. */
  giveBall(p: Player) {
    const b = this.ball;
    const wasReboundable = b.reboundable;
    const touchedRim = b.touchedRim;
    const changed = p.side !== this.offense;
    this.giveBallRaw(p);
    if (wasReboundable) {
      p.stats.reb++;
      this.ev.emit('rebound', { p, offensive: !changed });
    }
    if (changed) {
      this.offense = p.side;
      this.shotClock = RULES.SHOT_CLOCK;
      this.reassignDefense(false);
      this.ev.emit('possession', { side: p.side });
    } else if (touchedRim) {
      this.shotClock = RULES.SHOT_CLOCK;
    }
    if (this.cfg.userSide !== null) {
      if (p.side === this.cfg.userSide) this.setUser(p);
      else if (changed && this.user) {
        const guard = this.team(this.cfg.userSide).find((d) => this.assign.get(d.id) === p);
        if (guard) this.setUser(guard);
      }
    }
  }

  private giveBallRaw(p: Player) {
    const b = this.ball;
    b.state = 'held';
    b.owner = p;
    b.lastTouch = p.side;
    b.shot = null;
    b.pass = null;
    b.reboundable = false;
    b.touchedRim = false;
    b.throughHoop = false;
    b.vx = 0; b.vy = 0; b.vz = 0;
    b.x = p.x + Math.cos(p.facing) * 0.8; b.y = p.y + Math.sin(p.facing) * 0.8; b.z = Math.min(b.z, 4.1);
    p.ai.holdT = 0;
    p.ai.decideT = 0.25;
    p.ai.plan = 'probe';
  }

  /**
   * Man-to-man matchups. On a change of possession defenders take whoever is
   * closest; at a dead-ball restart they match by roster slot (guard on guard).
   */
  reassignDefense(byRoster: boolean) {
    const off = this.team(this.offense);
    const def = this.team(this.defense);
    this.assign.clear();
    if (byRoster) {
      def.forEach((d, i) => this.assign.set(d.id, off[i] ?? off[0]));
      return;
    }
    const free = new Set(off);
    const pairs: { d: Player; o: Player; dist: number }[] = [];
    for (const d of def) for (const o of off) pairs.push({ d, o, dist: d.distTo(o) });
    pairs.sort((a, b) => a.dist - b.dist);
    const done = new Set<Player>();
    for (const pr of pairs) {
      if (done.has(pr.d) || !free.has(pr.o)) continue;
      this.assign.set(pr.d.id, pr.o);
      done.add(pr.d);
      free.delete(pr.o);
    }
  }

  // ------------------------------------------------------------------ scoring / rules

  private scoreBasket(side: Side, pts: number, shooter: Player | null, kind: ShotResult | 'putback') {
    if (this.phase !== 'live') return;
    this.score[side] += pts;
    let assist: Player | null = null;
    if (shooter) {
      shooter.stats.pts += pts;
      shooter.stats.fgm++;
      if (pts === 3) shooter.stats.tpm++;
      if (shooter.lastPasser && shooter.lastPasser.side === shooter.side && this.time - shooter.catchTime < 5) {
        assist = shooter.lastPasser;
        assist.stats.ast++;
      }
      shooter.lastPasser = null;
    }
    this.ev.emit('score', { side, pts, p: shooter, kind, assist });
    if (pts === 3) this.ev.emit('shake', { amount: 0.006, ms: 200 });
    if (this.overtime) this.ended = true;
    if (this.buzzerPending) { this.buzzerPending = false; this.endRegulation(); return; }
    this.deadBall((1 - side) as Side, 'backcourt');
  }

  private turnover(side: Side, reason: string) {
    const h = this.handler;
    if (h && h.side === side) h.stats.tov++;
    this.ev.emit('whistle', null);
    this.ev.emit('turnover', { side, reason });
    this.ev.emit('banner', { text: reason, sub: 'TURNOVER', tone: 'warn' });
    this.deadBall((1 - side) as Side, 'backcourt');
  }

  private deadBall(nextOffense: Side, restart: Restart) {
    if (this.phase === 'dead' || this.phase === 'over') return;
    this.phase = 'dead';
    this.phaseT = 0;
    this.nextOffense = nextOffense;
    this.nextRestart = restart;
    const b = this.ball;
    if (b.state === 'held') { b.state = 'loose'; b.owner = null; b.vz = 2; }
    if (b.state === 'pass' || b.state === 'shot') b.state = 'loose';
    for (const p of this.players) { p.charging = false; if (p.action === 'jumpshot' && !p.airborne) p.setAction('none'); }
    this.prepareFormation(nextOffense, restart);
  }

  /** During a dead ball everyone jogs toward their spots for the restart. */
  private prepareFormation(side: Side, restart: Restart) {
    this.formation.clear();
    const H = attackHoop(side);
    const own = defendHoop(side);
    this.team(side).forEach((p, i) => {
      const s = restart === 'backcourt' ? rel(own, BACKCOURT_OFF[(i + 1) % 5].u, BACKCOURT_OFF[(i + 1) % 5].v) : rel(H, FRONT_OFF[(i + 1) % 5].u, FRONT_OFF[(i + 1) % 5].v);
      this.formation.set(p.id, { x: s.x, y: s.y, face: null });
    });
    this.team((1 - side) as Side).forEach((p, i) => {
      const s = rel(H, BACKCOURT_DEF[i % 5].u, BACKCOURT_DEF[i % 5].v);
      this.formation.set(p.id, { x: s.x, y: s.y, face: null });
    });
  }

  private onBuzzer() {
    this.ev.emit('buzzer', null);
    if (this.ball.state === 'shot' && this.ball.shot?.releasedBeforeBuzzer) {
      this.buzzerPending = true;
      return;
    }
    this.endRegulation();
  }

  private resolveBuzzer() {
    this.buzzerPending = false;
    this.endRegulation();
  }

  private endRegulation() {
    if (this.score[0] === this.score[1]) {
      this.overtime = true;
      this.ev.emit('banner', { text: 'OVERTIME', sub: 'Next bucket wins', tone: 'neutral' });
      this.phase = 'dead';
      this.phaseT = -0.8;
      this.nextOffense = chance(0.5) ? 0 : 1;
      this.nextRestart = 'backcourt';
      this.prepareFormation(this.nextOffense, 'backcourt');
      return;
    }
    this.ended = true;
    this.phase = 'dead';
    this.phaseT = 0;
    this.prepareFormation(this.offense, 'frontcourt');
  }

  private finish() {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.phaseT = 0;
    this.formation.clear();
    const winner: Side = this.score[0] > this.score[1] ? 0 : 1;
    for (const p of this.players) if (p.side === winner) p.setAction('celebrate');
    this.ev.emit('buzzer', null);
    this.ev.emit('gameover', null);
  }

  // ------------------------------------------------------------------ physics helpers

  private separatePlayers() {
    const ps = this.players;
    const R2 = Player.RADIUS * 2;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]; const b = ps[j];
        if (Math.abs(a.z - b.z) > 3) continue;
        if (a.action === 'ankles' || b.action === 'ankles') continue; // step over a fallen defender
        const dx = b.x - a.x; const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= R2 || d === 0) continue;
        const nx = dx / d; const ny = dy / d;
        const overlap = R2 - d;
        const wa = a.side === this.defense ? 0.35 : 0.65;
        const wb = b.side === this.defense ? 0.35 : 0.65;
        const tw = wa + wb;
        a.x -= nx * overlap * (wa / tw); a.y -= ny * overlap * (wa / tw);
        b.x += nx * overlap * (wb / tw); b.y += ny * overlap * (wb / tw);
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) {
          a.vx += nx * rv * (wa / tw); a.vy += ny * rv * (wa / tw);
          b.vx -= nx * rv * (wb / tw); b.vy -= ny * rv * (wb / tw);
        }
      }
    }
  }

  isThree(p: Player): boolean { return isThree(p.x, p.y, p.hoop); }
}
