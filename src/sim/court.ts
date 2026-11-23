import { COURT, type Hoop } from '../config';

/** Court geometry helpers shared by the simulation, AI and rendering. */

export const MID_X = COURT.L / 2;

/** Hoop that `side` attacks for the whole game (side 0 attacks right, side 1 attacks left). */
export function attackHoop(side: 0 | 1): Hoop {
  return side === 0 ? COURT.HOOPS[1] : COURT.HOOPS[0];
}

/** Hoop that `side` defends. */
export function defendHoop(side: 0 | 1): Hoop {
  return attackHoop((1 - side) as 0 | 1);
}

export function hoopDist(x: number, y: number, h: Hoop): number {
  return Math.hypot(x - h.x, y - h.y);
}

/** Distance from h's baseline, measured into the court. */
export function depthFrom(h: Hoop, x: number): number {
  return h.dir === 1 ? x : COURT.L - x;
}

/**
 * Hoop-relative coordinates to world: u = feet from that hoop's baseline,
 * v = lateral offset from the middle of the court.
 */
export function rel(h: Hoop, u: number, v: number): { x: number; y: number } {
  return { x: h.dir === 1 ? u : COURT.L - u, y: COURT.W / 2 + v };
}

export function isThree(x: number, y: number, h: Hoop): boolean {
  if (depthFrom(h, x) < COURT.CORNER_LEN) return y < COURT.CORNER_IN || y > COURT.W - COURT.CORNER_IN;
  return hoopDist(x, y, h) > COURT.THREE_R;
}

export function nearestHoop(x: number): Hoop {
  return x < MID_X ? COURT.HOOPS[0] : COURT.HOOPS[1];
}

export function inBounds(x: number, y: number, margin = 0): boolean {
  return x >= -margin && x <= COURT.L + margin && y >= -margin && y <= COURT.W + margin;
}
