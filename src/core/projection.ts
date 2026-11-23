import { VIEW } from '../config';

/**
 * Side-on broadcast camera that pans along the length of the court.
 *
 * A pinhole projection gives true perspective across the court (the far
 * sideline is smaller than the near one); heights are additionally
 * foreshortened by Z_SCALE to mimic a camera tilted down toward the floor.
 * The camera pans in x (`cam.x` is the world x at the screen center) and
 * `cam.ox/oy` add screen-space shake.
 *
 * Key property used by the floor shader: a world line of constant y maps to
 * a single screen row, and x maps linearly along it.
 */

const FAR_K = 24; // px per foot at the far sideline (y = 0)
const NEAR_K = 33; // px per foot at the near sideline (y = 50)
const FAR_Y = 404; // screen y of the far sideline
const NEAR_Y = 1052; // screen y of the near sideline

const D = (50 * FAR_K) / (NEAR_K - FAR_K); // camera distance to the near sideline
export const FOCAL = NEAR_K * D;
export const CAM_Y = D + 50;
export const CAM_H = (NEAR_Y - FAR_Y) / (FOCAL * (1 / D - 1 / (D + 50)));
export const HORIZON = FAR_Y - (FOCAL * CAM_H) / (D + 50);
export const CX = VIEW.W / 2;
export const Z_SCALE = 0.66;

/** Live camera state. */
export const cam = { x: 47, ox: 0, oy: 0 };

export interface Projected { x: number; y: number; k: number }

/** px per foot (horizontal) at depth y. */
export function scaleAt(y: number): number {
  return FOCAL / (CAM_Y - y);
}

export function project(x: number, y: number, z = 0, out: Projected = { x: 0, y: 0, k: 0 }): Projected {
  const d = CAM_Y - y;
  const k = FOCAL / d;
  out.x = CX + (x - cam.x) * k + cam.ox;
  out.y = HORIZON + (FOCAL * CAM_H) / d - z * k * Z_SCALE + cam.oy;
  out.k = k;
  return out;
}

/** Inverse of project() for points on the ground (z = 0). */
export function unproject(sx: number, sy: number): { x: number; y: number } {
  const d = (FOCAL * CAM_H) / Math.max(1, sy - cam.oy - HORIZON);
  const y = CAM_Y - d;
  const x = cam.x + ((sx - cam.ox - CX) * d) / FOCAL;
  return { x, y };
}

/**
 * How far a static object drawn at depth y with the camera at `refX` must be
 * shifted horizontally to appear correct for the current camera.
 */
export function panShift(y: number, refX: number): number {
  return (refX - cam.x) * scaleAt(y) + cam.ox;
}
