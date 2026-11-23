/**
 * Central tuning values. World units are feet; time is seconds.
 * World axes: x runs along the length of the court (0..94, baseline to
 * baseline), y runs across it (0 = far sideline, 50 = near sideline, closest
 * to the camera), z is height above the ground.
 */

export const VIEW = { W: 1920, H: 1080 } as const;

/** Characters are drawn slightly larger than life so they read well from the camera. */
export const CHAR_VIS = 1.04;

export interface Hoop { readonly x: number; readonly y: number; readonly z: number; readonly dir: 1 | -1 }

export const COURT = {
  L: 94,
  W: 50,
  /** dir points from the baseline into the court. */
  HOOPS: [
    { x: 5.25, y: 25, z: 10, dir: 1 },
    { x: 88.75, y: 25, z: 10, dir: -1 },
  ] as readonly Hoop[],
  /** Arcade-sized rim (real: 0.75) so the hoop reads clearly from the camera. */
  RIM_R: 0.95,
  /** Backboard planes, perpendicular to x, 1.25 ft behind the rim center. */
  BOARD: { inset: 4, y0: 21.4, y1: 28.6, z0: 9.4, z1: 13.6 },
  THREE_R: 23.75,
  /** Corner three: straight lines 3 ft inside the sidelines, 14.2 ft from the baseline. */
  CORNER_IN: 3,
  CORNER_LEN: 14.2,
  KEY_W: 16,
  KEY_LEN: 19,
  FT_R: 6,
  RESTRICTED_R: 4,
  CENTER_R: 6,
} as const;

export const PHYS = {
  /** Gravity used for ball flight (slightly arcade-heavy for snappy arcs). */
  G: 40,
  JUMP_G: 44,
  BALL_R: 0.39,
  FLOOR_RESTITUTION: 0.62,
  RIM_RESTITUTION: 0.48,
  BOARD_RESTITUTION: 0.55,
  PLAYER_R: 1.05,
} as const;

export const MOVE = {
  BASE_SPEED: 14,
  SPRINT_MULT: 1.36,
  BALL_MULT: 0.93,
  ACCEL: 62,
  DECEL: 75,
  STAMINA_DRAIN: 0.17,
  STAMINA_REGEN: 0.1,
} as const;

export const SHOT = {
  /** Seconds for the meter to fill from 0 to 1. */
  METER_TIME: 0.62,
  /** Meter value of a perfect release. */
  PERFECT: 0.8,
  PERFECT_WINDOW: 0.055,
  GOOD_WINDOW: 0.14,
  /** Holding past this auto-releases (very late). */
  AUTO_RELEASE: 1.12,
  LAYUP_RANGE: 5.2,
  DUNK_RANGE: 6.2,
} as const;

export const MOVES = {
  CROSSOVER_TIME: 0.32,
  CROSSOVER_COOLDOWN: 0.65,
  ANKLES_TIME: 1.05,
} as const;

export const RULES = {
  SHOT_CLOCK: 20,
  DEFAULT_GAME_TIME: 180,
  CHECK_TIME: 1.7,
  DEAD_TIME: 1.3,
} as const;

export type Difficulty = 'rookie' | 'pro' | 'allstar';

export interface DifficultyTuning {
  label: string;
  /** How quickly AI defenders react to the ball handler (higher is quicker). */
  defReact: number;
  /** On-ball cushion in feet. */
  defGap: number;
  /** AI steal attempts per second when in range. */
  stealRate: number;
  /** Chance an AI defender bothers to contest a shot. */
  contestChance: number;
  /** Std-dev of AI shot-meter release error. */
  aiReleaseError: number;
  /** Multiplier on AI defender top speed. */
  defSpeed: number;
  /** How willing the AI is to pass for a better shot (0..1). */
  aiIq: number;
  /** Multiplier on the chance that a crossover breaks an AI defender's ankles. */
  anklesMult: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyTuning> = {
  rookie: { label: 'Rookie', defReact: 3.2, defGap: 4.2, stealRate: 0.12, contestChance: 0.45, aiReleaseError: 0.17, defSpeed: 0.88, aiIq: 0.35, anklesMult: 1.5 },
  pro: { label: 'Pro', defReact: 6, defGap: 3.2, stealRate: 0.3, contestChance: 0.75, aiReleaseError: 0.11, defSpeed: 0.97, aiIq: 0.7, anklesMult: 1 },
  allstar: { label: 'All-Star', defReact: 9.5, defGap: 2.6, stealRate: 0.5, contestChance: 0.95, aiReleaseError: 0.075, defSpeed: 1.04, aiIq: 1, anklesMult: 0.7 },
};
