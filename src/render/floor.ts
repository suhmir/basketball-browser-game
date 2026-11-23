import Phaser from 'phaser';
import { COURT, VIEW } from '../config';
import { hex, lighten, mixColor } from '../core/math';
import { cam, CAM_H, CAM_Y, CX, FOCAL, HORIZON } from '../core/projection';
import type { TeamDef } from '../data/teams';

/**
 * The ground is painted flat in world space (two textures: a detailed main
 * court and a lower-resolution park around it) and projected per pixel by a
 * fragment shader that inverts the camera. That keeps perspective exact while
 * the camera pans, at almost no cost.
 */

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const COURT_RECT: Rect = { x0: -10, y0: -8, x1: 104, y1: 58 };
export const BG_RECT: Rect = { x0: -95, y0: -35, x1: 190, y1: 70 };
/**
 * Texture sizes must be powers of two: Phaser binds shader channels with
 * REPEAT wrapping, and WebGL samples non-power-of-two REPEAT textures as black.
 */
const COURT_TEX = { w: 4096, h: 2048 };
const BG_TEX = { w: 2048, h: 1024 };

/** Pickup courts behind the main court: half courts with the hoop at the back. */
export interface BgCourt { cx: number; y0: number; y1: number; w: number; surface: number; paint: number }
export const BG_COURTS: BgCourt[] = [
  { cx: -36, y0: -31, y1: -11, w: 42, surface: 0x2d5f55, paint: 0x3a4f8a },
  { cx: 14, y0: -31, y1: -11, w: 42, surface: 0x3a5d4a, paint: 0x8a3a4a },
  { cx: 64, y0: -31, y1: -11, w: 42, surface: 0x2d5f55, paint: 0x3a6f8a },
  { cx: 114, y0: -31, y1: -11, w: 42, surface: 0x3a5d4a, paint: 0x7a5a2a },
];
export const BG_HOOP_DEPTH = 4.25; // rim center distance from the back baseline

const WALKWAY = 0x4b3f4c;
const WALK_LINE = 0x3e3340;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasFor(r: Rect, size: { w: number; h: number }): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size.w;
  c.height = size.h;
  const ctx = c.getContext('2d')!;
  const sx = size.w / (r.x1 - r.x0);
  const sy = size.h / (r.y1 - r.y0);
  ctx.setTransform(sx, 0, 0, sy, -r.x0 * sx, -r.y0 * sy);
  return [c, ctx];
}

function lightPool(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${color},${a})`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}

function walkway(c: CanvasRenderingContext2D, r: Rect) {
  c.fillStyle = hex(WALKWAY);
  c.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  c.strokeStyle = hex(WALK_LINE);
  c.lineWidth = 0.12;
  for (let x = Math.ceil(r.x0 / 6) * 6; x < r.x1; x += 6) { c.beginPath(); c.moveTo(x, r.y0); c.lineTo(x, r.y1); c.stroke(); }
  for (let y = Math.ceil(r.y0 / 6) * 6; y < r.y1; y += 6) { c.beginPath(); c.moveTo(r.x0, y); c.lineTo(r.x1, y); c.stroke(); }
}

/** Generic half court (hoop at y0, facing +y) for the background pickup courts. */
function drawHalfCourt(c: CanvasRenderingContext2D, bc: BgCourt) {
  const x0 = bc.cx - bc.w / 2;
  c.fillStyle = '#1e2c33';
  c.fillRect(x0 - 2, bc.y0 - 2, bc.w + 4, bc.y1 - bc.y0 + 4);
  c.fillStyle = hex(bc.surface);
  c.fillRect(x0, bc.y0, bc.w, bc.y1 - bc.y0);
  const keyD = 12;
  c.fillStyle = hex(bc.paint);
  c.fillRect(bc.cx - 6, bc.y0, 12, keyD);
  c.strokeStyle = 'rgba(240,240,230,0.85)';
  c.lineWidth = 0.22;
  c.strokeRect(x0, bc.y0, bc.w, bc.y1 - bc.y0);
  c.strokeRect(bc.cx - 6, bc.y0, 12, keyD);
  c.beginPath(); c.arc(bc.cx, bc.y0 + keyD, 4.5, 0, Math.PI); c.stroke();
  // Scaled-down arc that fits the shallow pickup courts
  const hy = bc.y0 + BG_HOOP_DEPTH;
  const r = 14.5; const side = 13.5;
  const dy = Math.sqrt(r * r - side * side);
  c.beginPath();
  c.moveTo(bc.cx - side, bc.y0); c.lineTo(bc.cx - side, hy + dy);
  c.arc(bc.cx, hy, r, Math.PI - Math.asin(dy / r), Math.asin(dy / r), true);
  c.lineTo(bc.cx + side, bc.y0);
  c.stroke();
  lightPool(c, bc.cx, bc.y0 + 9, 16, '255,236,200', 0.1);
}

export function buildBgCanvas(): HTMLCanvasElement {
  const [cv, c] = canvasFor(BG_RECT, BG_TEX);
  const rnd = seeded(99);
  walkway(c, BG_RECT);
  // Grass beds and palm planters around the edges
  c.fillStyle = '#1f3326';
  c.fillRect(BG_RECT.x0, BG_RECT.y0, BG_RECT.x1 - BG_RECT.x0, 3.5);
  for (const bc of BG_COURTS) drawHalfCourt(c, bc);
  // Planter strip between the pickup courts and the main walkway
  c.fillStyle = '#26382c';
  c.fillRect(BG_RECT.x0, -10.5, BG_RECT.x1 - BG_RECT.x0, 1.4);
  // Random scuffs on the boardwalk
  for (let i = 0; i < 400; i++) {
    c.fillStyle = `rgba(0,0,0,${0.04 + rnd() * 0.06})`;
    c.beginPath();
    c.ellipse(BG_RECT.x0 + rnd() * (BG_RECT.x1 - BG_RECT.x0), BG_RECT.y0 + rnd() * (BG_RECT.y1 - BG_RECT.y0), 0.4 + rnd() * 1.5, 0.3 + rnd(), 0, 0, Math.PI * 2);
    c.fill();
  }
  // Warm pools under the string lights
  for (let x = -90; x < 190; x += 14) lightPool(c, x, -6.5, 9, '255,200,140', 0.1);
  return cv;
}

export function buildCourtCanvas(home: TeamDef): HTMLCanvasElement {
  const [cv, c] = canvasFor(COURT_RECT, COURT_TEX);
  const rnd = seeded(1337);
  const L = COURT.L; const W = COURT.W;
  walkway(c, COURT_RECT);

  // Apron and playing surface
  c.fillStyle = '#152a33';
  c.fillRect(-4, -3, L + 8, W + 6);
  const surface = 0x225449;
  c.fillStyle = hex(surface);
  c.fillRect(0, 0, L, W);
  // Rubber sport-tile texture: faint grid and speckle
  c.strokeStyle = 'rgba(0,0,0,0.07)';
  c.lineWidth = 0.04;
  for (let x = 0; x <= L; x += 1) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, W); c.stroke(); }
  for (let y = 0; y <= W; y += 1) { c.beginPath(); c.moveTo(0, y); c.lineTo(L, y); c.stroke(); }
  for (let i = 0; i < 9000; i++) {
    c.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)';
    c.fillRect(rnd() * L, rnd() * W, 0.12, 0.12);
  }

  // Two-tone: lighter inside each arc, painted keys in the home colours
  for (const H of COURT.HOOPS) {
    c.save();
    c.beginPath(); arcPath(c, H.x, H.dir); c.closePath();
    c.fillStyle = hex(lighten(surface, 0.12));
    c.fill();
    c.restore();
    const kx = H.dir === 1 ? 0 : L - COURT.KEY_LEN;
    c.fillStyle = hex(home.paint);
    c.fillRect(kx, W / 2 - COURT.KEY_W / 2, COURT.KEY_LEN, COURT.KEY_W);
  }
  // Center circle logo
  c.beginPath(); c.arc(L / 2, W / 2, COURT.CENTER_R, 0, Math.PI * 2);
  c.fillStyle = hex(home.primary); c.fill();
  c.beginPath(); c.arc(L / 2, W / 2, COURT.CENTER_R - 1.1, 0, Math.PI * 2);
  c.fillStyle = hex(lighten(home.primary, -0.3)); c.fill();
  floorText(c, home.abbr, L / 2, W / 2, 4.2, 'rgba(255,255,255,0.9)');

  // Lines
  c.strokeStyle = '#f2efe6';
  c.lineWidth = 0.2;
  c.strokeRect(0, 0, L, W);
  c.beginPath(); c.moveTo(L / 2, 0); c.lineTo(L / 2, W); c.stroke();
  c.beginPath(); c.arc(L / 2, W / 2, COURT.CENTER_R, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.arc(L / 2, W / 2, 2, 0, Math.PI * 2); c.stroke();
  for (const H of COURT.HOOPS) {
    c.beginPath(); arcPath(c, H.x, H.dir); c.stroke();
    const kx = H.dir === 1 ? 0 : L - COURT.KEY_LEN;
    c.strokeRect(kx, W / 2 - COURT.KEY_W / 2, COURT.KEY_LEN, COURT.KEY_W);
    const ftx = H.dir === 1 ? COURT.KEY_LEN : L - COURT.KEY_LEN;
    c.beginPath();
    if (H.dir === 1) c.arc(ftx, W / 2, COURT.FT_R, -Math.PI / 2, Math.PI / 2);
    else c.arc(ftx, W / 2, COURT.FT_R, Math.PI / 2, Math.PI * 1.5);
    c.stroke();
    c.setLineDash([0.9, 0.75]);
    c.beginPath();
    if (H.dir === 1) c.arc(ftx, W / 2, COURT.FT_R, Math.PI / 2, Math.PI * 1.5);
    else c.arc(ftx, W / 2, COURT.FT_R, -Math.PI / 2, Math.PI / 2);
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    if (H.dir === 1) c.arc(H.x, H.y, COURT.RESTRICTED_R, -Math.PI / 2, Math.PI / 2);
    else c.arc(H.x, H.y, COURT.RESTRICTED_R, Math.PI / 2, Math.PI * 1.5);
    c.stroke();
    for (const d of [7, 8, 11, 14]) {
      const hx = H.dir === 1 ? d : L - d;
      c.beginPath();
      c.moveTo(hx, W / 2 - COURT.KEY_W / 2 - 0.6); c.lineTo(hx, W / 2 - COURT.KEY_W / 2);
      c.moveTo(hx, W / 2 + COURT.KEY_W / 2); c.lineTo(hx, W / 2 + COURT.KEY_W / 2 + 0.6);
      c.stroke();
    }
  }

  // Wordmark painted on the far apron
  floorText(c, `${home.city.toUpperCase()} ${home.name.toUpperCase()}`, L / 2, -1.5, 2.1, 'rgba(255,255,255,0.55)');
  floorText(c, 'BOARDWALK PARK', 18, -1.5, 1.6, 'rgba(255,200,120,0.5)');
  floorText(c, 'BOARDWALK PARK', L - 18, -1.5, 1.6, 'rgba(255,200,120,0.5)');

  // Floodlights: four warm pools, darker toward the ends
  c.globalCompositeOperation = 'lighter';
  for (const [x, y, r, a] of [[22, 20, 30, 0.07], [72, 20, 30, 0.07], [47, 28, 26, 0.04]] as const) {
    lightPool(c, x, y, r, '255,240,210', a);
  }
  c.globalCompositeOperation = 'source-over';
  return cv;
}

function arcPath(c: CanvasRenderingContext2D, hx: number, dir: number) {
  const W = COURT.W;
  const cl = COURT.CORNER_LEN;
  const bx = dir === 1 ? 0 : COURT.L;
  const lx = bx + dir * cl;
  const a = Math.asin((W / 2 - COURT.CORNER_IN) / COURT.THREE_R);
  c.moveTo(bx, COURT.CORNER_IN);
  c.lineTo(lx, COURT.CORNER_IN);
  if (dir === 1) c.arc(hx, W / 2, COURT.THREE_R, -a, a);
  else c.arc(hx, W / 2, COURT.THREE_R, Math.PI + a, Math.PI - a, true);
  c.lineTo(bx, W - COURT.CORNER_IN);
}

function floorText(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string) {
  c.save();
  c.translate(x, y);
  c.scale(1, 1.35); // counter the perspective squash a little so it stays readable
  c.font = `italic 700 ${size}px Teko, Impact, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.fillText(text, 0, 0);
  c.restore();
}

const FRAG = `
precision highp float;
uniform vec2 resolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform float camX;
uniform float ox;
uniform float oy;
uniform float focal;
uniform float camH;
uniform float camY;
uniform float horizon;
uniform float cx;
uniform float cX0; uniform float cY0; uniform float cX1; uniform float cY1;
uniform float bX0; uniform float bY0; uniform float bX1; uniform float bY1;
uniform vec3 fog;

void main() {
  float sx = gl_FragCoord.x - ox;
  float sy = (resolution.y - gl_FragCoord.y) - oy;
  if (sy <= horizon + 2.0) discard;
  float d = focal * camH / (sy - horizon);
  float y = camY - d;
  float x = camX + (sx - cx) * d / focal;
  vec4 col;
  vec2 uc = vec2((x - cX0) / (cX1 - cX0), (y - cY0) / (cY1 - cY0));
  if (uc.x >= 0.0 && uc.x <= 1.0 && uc.y >= 0.0 && uc.y <= 1.0) {
    col = texture2D(iChannel0, uc);
  } else {
    vec2 ub = vec2((x - bX0) / (bX1 - bX0), (y - bY0) / (bY1 - bY0));
    if (ub.x < 0.0 || ub.x > 1.0 || ub.y < 0.0 || ub.y > 1.0) discard;
    col = texture2D(iChannel1, ub);
  }
  // Night haze with distance; fade out at the far edge of the park
  float haze = clamp((-y - 4.0) / 34.0, 0.0, 1.0);
  col.rgb = mix(col.rgb, fog, haze * 0.55);
  float edge = smoothstep(bY0, bY0 + 3.0, y);
  gl_FragColor = vec4(col.rgb * edge + fog * (1.0 - edge), 1.0) * edge;
}
`;

export class Floor {
  readonly shader: Phaser.GameObjects.Shader;

  constructor(scene: Phaser.Scene, home: TeamDef) {
    const courtKey = `floor_court_${home.id}`;
    if (!scene.textures.exists(courtKey)) scene.textures.addCanvas(courtKey, buildCourtCanvas(home));
    if (!scene.textures.exists('floor_bg')) scene.textures.addCanvas('floor_bg', buildBgCanvas());
    const f = (v: number) => ({ type: '1f', value: v });
    const fogCol = mixColor(0x1a1630, 0x2a2245, 0.5);
    const base = new Phaser.Display.BaseShader('floor', FRAG, undefined, {
      camX: f(cam.x), ox: f(0), oy: f(0),
      focal: f(FOCAL), camH: f(CAM_H), camY: f(CAM_Y), horizon: f(HORIZON), cx: f(CX),
      cX0: f(COURT_RECT.x0), cY0: f(COURT_RECT.y0), cX1: f(COURT_RECT.x1), cY1: f(COURT_RECT.y1),
      bX0: f(BG_RECT.x0), bY0: f(BG_RECT.y0), bX1: f(BG_RECT.x1), bY1: f(BG_RECT.y1),
      fog: { type: '3f', value: { x: ((fogCol >> 16) & 255) / 255, y: ((fogCol >> 8) & 255) / 255, z: (fogCol & 255) / 255 } },
    });
    this.shader = scene.add.shader(base, 0, 0, VIEW.W, VIEW.H, [courtKey, 'floor_bg']).setOrigin(0, 0).setDepth(-3000);
  }

  update() {
    this.shader.setUniform('camX.value', cam.x);
    this.shader.setUniform('ox.value', cam.ox);
    this.shader.setUniform('oy.value', cam.oy);
  }
}
