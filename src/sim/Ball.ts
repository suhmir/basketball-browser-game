import { COURT, PHYS, type Hoop } from '../config';
import type { Player, Side } from './Player';

export type BallState = 'held' | 'shot' | 'pass' | 'loose' | 'dead';

export type ShotResult = 'swish' | 'rimIn' | 'rimOut' | 'boardOut' | 'airball' | 'dunk' | 'layupIn' | 'layupOut';

export interface ShotInfo {
  shooter: Player;
  hoop: Hoop;
  result: ShotResult;
  points: 2 | 3;
  t: number;
  T: number;
  stage: 0 | 1; // 0 = initial flight, 1 = scripted second hop (rim-in)
  releasedBeforeBuzzer: boolean;
  blockChecked: Set<number>;
  quality: number;
}

export interface PassInfo {
  from: Player;
  to: Player;
  t: number;
  T: number;
  checked: Set<number>;
}

/** Contact reported by the ball physics so the match can play sounds / effects. */
export type BallContact = 'floor' | 'rim' | 'board' | null;

export class Ball {
  x = 47; y = 25; z = 3;
  vx = 0; vy = 0; vz = 0;
  state: BallState = 'held';
  owner: Player | null = null;
  lastTouch: Side = 0;
  shot: ShotInfo | null = null;
  pass: PassInfo | null = null;
  /** True after a rim/board contact until someone secures the ball. */
  touchedRim = false;
  /** Ball was shot and has not been secured: next pickup is a rebound. */
  reboundable = false;
  spin = 0;
  dribblePhase = 0;
  throughHoop = false;

  /** Ballistic velocity so the ball goes from current position to (tx,ty,tz) in T seconds. */
  aimAt(tx: number, ty: number, tz: number, T: number) {
    this.vx = (tx - this.x) / T;
    this.vy = (ty - this.y) / T;
    this.vz = (tz - this.z) / T + 0.5 * PHYS.G * T;
  }

  /** Flight time for an arc that peaks `apex` feet above the higher endpoint. */
  static flightTime(z0: number, z1: number, apex: number): number {
    const top = Math.max(z0, z1) + apex;
    const up = Math.sqrt((2 * (top - z0)) / PHYS.G);
    const down = Math.sqrt((2 * (top - z1)) / PHYS.G);
    return up + down;
  }

  integrate(dt: number) {
    this.vz -= PHYS.G * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    this.spin += Math.hypot(this.vx, this.vy) * dt * 0.9;
  }

  /** Free physics with floor, rims and backboards. Returns the strongest contact this step. */
  physics(dt: number): BallContact {
    let contact: BallContact = null;
    const steps = 3;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.integrate(h);
      const c = this.collide();
      if (c) contact = c;
    }
    return contact;
  }

  private collide(): BallContact {
    const R = PHYS.BALL_R;
    let contact: BallContact = null;
    // Floor
    if (this.z < R) {
      this.z = R;
      if (this.vz < 0) {
        const impact = -this.vz;
        this.vz = impact > 2 ? impact * PHYS.FLOOR_RESTITUTION : 0;
        this.vx *= 0.86;
        this.vy *= 0.86;
        if (impact > 3) contact = 'floor';
      }
      if (this.vz === 0) { this.vx *= 0.985; this.vy *= 0.985; }
    }

    for (const H of COURT.HOOPS) {
      // Backboard: vertical plane perpendicular to x, facing into the court.
      const B = COURT.BOARD;
      const bx = H.dir === 1 ? B.inset : COURT.L - B.inset;
      if (this.y > B.y0 - R && this.y < B.y1 + R && this.z > B.z0 - R && this.z < B.z1 + R) {
        const front = (this.x - bx) * H.dir; // distance in front of the board
        const approaching = this.vx * H.dir < 0;
        if (front < R && front > -0.6 && approaching) {
          this.x = bx + H.dir * R;
          this.vx = -this.vx * PHYS.BOARD_RESTITUTION;
          contact = 'board';
        }
      }

      // Rim: torus approximated by the closest point on the rim circle.
      const dx = this.x - H.x;
      const dy = this.y - H.y;
      const dh = Math.hypot(dx, dy) || 0.0001;
      if (dh > COURT.RIM_R + 1.5 || Math.abs(this.z - H.z) > 1.5) continue;
      const cx = H.x + (dx / dh) * COURT.RIM_R;
      const cy = H.y + (dy / dh) * COURT.RIM_R;
      const nx = this.x - cx;
      const ny = this.y - cy;
      const nz = this.z - H.z;
      const nd = Math.hypot(nx, ny, nz);
      const tube = 0.05;
      if (nd < R + tube) {
        const ux = nx / nd; const uy = ny / nd; const uz = nz / nd;
        const vn = this.vx * ux + this.vy * uy + this.vz * uz;
        if (vn < 0) {
          this.vx -= (1 + PHYS.RIM_RESTITUTION) * vn * ux;
          this.vy -= (1 + PHYS.RIM_RESTITUTION) * vn * uy;
          this.vz -= (1 + PHYS.RIM_RESTITUTION) * vn * uz;
          this.vx += (Math.random() - 0.5) * 2.2;
          this.vy += (Math.random() - 0.5) * 2.2;
          contact = 'rim';
        }
        const push = R + tube - nd;
        this.x += ux * push; this.y += uy * push; this.z += uz * push;
      }
    }

    // Stanchions behind each baseline stop the ball
    if (this.x < -2.5 && this.vx < 0) { this.vx = -this.vx * 0.4; this.x = -2.5; }
    if (this.x > COURT.L + 2.5 && this.vx > 0) { this.vx = -this.vx * 0.4; this.x = COURT.L + 2.5; }
    return contact;
  }
}
