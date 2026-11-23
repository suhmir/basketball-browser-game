import { COURT, SHOT, type Hoop } from '../config';
import { chance, clamp, distToSegment, gauss, rand } from '../core/math';
import { attackHoop, hoopDist, isThree, rel } from '../sim/court';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import { expectedShotValue } from '../sim/shooting';

/** Hoop-relative spacing slots (u = feet from baseline, v = lateral offset). */
const SPOTS = [
  { u: 4, v: -21.5, tag: 'corner' },
  { u: 4, v: 21.5, tag: 'corner' },
  { u: 18, v: -19, tag: 'wing' },
  { u: 18, v: 19, tag: 'wing' },
  { u: 30, v: 0, tag: 'top' },
  { u: 27, v: -11, tag: 'slot' },
  { u: 27, v: 11, tag: 'slot' },
  { u: 15, v: -7, tag: 'elbow' },
  { u: 15, v: 7, tag: 'elbow' },
  { u: 4, v: -7, tag: 'dunker' },
  { u: 4, v: 7, tag: 'dunker' },
  { u: 9, v: 0, tag: 'post' },
] as const;

/** Feet from the attacking hoop beyond which a player is still bringing the ball up. */
const TRANSITION_DIST = 33;

export function runAI(m: Match, p: Player, dt: number) {
  p.sprint = false;
  const b = m.ball;
  if (p.action === 'ankles') { p.mx = 0; p.my = 0; return; }
  if (b.state === 'loose' || b.state === 'shot') {
    reboundAI(m, p);
    return;
  }
  if (p.side === m.offense) {
    if (b.owner === p && b.state === 'held') handlerAI(m, p, dt);
    else offBallAI(m, p, dt);
  } else {
    defenseAI(m, p, dt);
  }
}

// --------------------------------------------------------------- movement helpers

function steer(p: Player, tx: number, ty: number, opts: { sprintBeyond?: number; slowRadius?: number; speed?: number } = {}) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  const slow = opts.slowRadius ?? 2.2;
  if (d < 0.3) { p.mx = 0; p.my = 0; return d; }
  const s = Math.min(1, d / slow) * (opts.speed ?? 1);
  p.mx = (dx / d) * s;
  p.my = (dy / d) * s;
  p.sprint = d > (opts.sprintBeyond ?? 9) && p.stamina > 0.25;
  return d;
}

function clampTarget(ai: { tx: number; ty: number }) {
  ai.tx = clamp(ai.tx, 1.5, COURT.L - 1.5);
  ai.ty = clamp(ai.ty, 1.5, COURT.W - 1.5);
}

function spotWorld(H: Hoop, i: number) {
  return rel(H, SPOTS[i].u, SPOTS[i].v);
}

/** Defenders who are between the player and the hoop (i.e. back in position). */
function defendersBack(m: Match, p: Player): number {
  const d0 = p.distToHoop();
  return m.opponents(p).filter((o) => hoopDist(o.x, o.y, p.hoop) < d0 - 2).length;
}

// --------------------------------------------------------------- offense: ball handler

function handlerAI(m: Match, p: Player, dt: number) {
  const ai = p.ai;
  ai.holdT += dt;
  const H = p.hoop;

  if (p.action === 'jumpshot') {
    if (p.charging && p.charge >= ai.releaseAt) m.releaseJumper(p);
    return;
  }
  if (p.locked) return;

  const defs = m.opponents(p);
  const mates = m.teammates(p);
  const tune = m.tune;
  const dHoop = p.distToHoop();
  const myDef = defs.reduce((a, c) => (c.distTo(p) < a.distTo(p) ? c : a));
  const defDist = myDef.distTo(p);

  ai.decideT -= dt;
  if (ai.decideT <= 0) {
    ai.decideT = rand(0.18, 0.34);

    if (dHoop > TRANSITION_DIST) {
      // Bring it up. Push the pace when the defense isn't back.
      const back = defendersBack(m, p);
      const ahead = mates.filter((t) => t.distToHoop() < dHoop - 4);
      if (back <= 1 && dHoop < 60) {
        ai.plan = 'break';
      } else {
        ai.plan = 'advance';
        const tgt = rel(H, 28, clamp(p.y - 25, -12, 12));
        ai.tx = tgt.x; ai.ty = tgt.y;
      }
      // Hit an open man streaking ahead
      for (const t of ahead) {
        const open = m.nearestOpponentDist(t);
        if (open > 7 && laneOpen(p, t, defs) > 3 && t.distToHoop() < 22 && chance(0.5 + tune.aiIq * 0.3)) {
          m.passBall(p, t);
          return;
        }
      }
    } else {
      // Slight preference for attacking over settling for threes
      const myEv = expectedShotValue(p, p.x, p.y, defs) * (isThree(p.x, p.y, H) ? 0.9 : 1);
      const urgency = clamp((5 - m.shotClock) / 5, 0, 1);
      const patience = clamp(ai.holdT / 4, 0, 1);
      const bar = 1.12 - urgency * 0.55 - patience * 0.2;

      if (dHoop < SHOT.LAYUP_RANGE - 0.4) { m.beginShot(p); return; }

      let bestMate: Player | null = null;
      let bestMateEv = -1;
      for (const t of mates) {
        if (laneOpen(p, t, defs) < 2.2) continue;
        let ev = expectedShotValue(t, t.x, t.y, defs) * (isThree(t.x, t.y, H) ? 0.9 : 1);
        if (t.distToHoop() < 8 && t.speed > 6) ev += 0.35; // cutter
        if (ev > bestMateEv) { bestMateEv = ev; bestMate = t; }
      }

      if (m.shotClock < 1.4) {
        if (m.beginShot(p) && p.charging) ai.releaseAt = pickRelease(m, p);
        return;
      }
      if (myEv > bar && defDist > 3.6 && chance(0.85)) {
        if (m.beginShot(p) && p.charging) ai.releaseAt = pickRelease(m, p);
        return;
      }
      if (bestMate && ai.holdT > 0.5 && bestMateEv > myEv + (0.18 - tune.aiIq * 0.1) && chance(0.45 + tune.aiIq * 0.4)) {
        m.passBall(p, bestMate);
        return;
      }
      if (bestMate && ai.holdT > 3.2 && chance(0.5)) {
        m.passBall(p, bestMate);
        return;
      }

      // Shake a tight defender with a crossover
      if (defDist < 4.5 && p.crossCd <= 0 && chance(0.18 * (p.r.handling / 85))) {
        const side = Math.random() < 0.5 ? 1 : -1;
        const toward = Math.atan2(H.y - p.y, H.x - p.x) + side * 0.9;
        if (m.crossover(p, Math.cos(toward), Math.sin(toward))) { ai.plan = 'drive'; ai.decideT = 0.4; }
      }

      const between = distToSegment(myDef.x, myDef.y, p.x, p.y, H.x, H.y);
      const defBehind = hoopDist(myDef.x, myDef.y, H) > dHoop + 0.5 || myDef.action === 'ankles';
      const blowBy = chance(0.12 + (p.r.speed + p.r.handling - myDef.r.defense * 2) / 300);
      const laneClear = m.opponents(p).filter((o) => distToSegment(o.x, o.y, p.x, p.y, H.x, H.y) < 3).length <= 1;
      if ((between > 2.4 || defBehind || blowBy || (laneClear && chance(0.4))) && dHoop > 4 && chance(0.8)) {
        ai.plan = 'drive';
      } else if (chance(0.35) || ai.plan !== 'probe' || Math.hypot(ai.tx - p.x, ai.ty - p.y) < 1) {
        ai.plan = 'probe';
        const base = Math.atan2(p.y - H.y, p.x - H.x) + gauss(0, 0.5);
        const r = clamp(dHoop + rand(-5, 3), 12, 26);
        ai.tx = H.x + Math.cos(base) * r;
        ai.ty = H.y + Math.sin(base) * r;
        // stay on the court side of the hoop
        if ((ai.tx - H.x) * H.dir < 1) ai.tx = H.x + H.dir * 1;
        clampTarget(ai);
      }
    }
  }

  if (ai.plan === 'drive' && dHoop > 7 && dHoop < 17 && p.speed < 5 && defDist < 3 && chance(0.06)) {
    // Stalled in traffic: pull up
    if (m.beginShot(p) && p.charging) ai.releaseAt = pickRelease(m, p);
    return;
  }
  if (ai.plan === 'break' || ai.plan === 'drive') {
    const tgt = { x: H.x + H.dir * 2.2, y: H.y + (p.y - H.y) * 0.12 };
    steer(p, tgt.x, tgt.y, { sprintBeyond: 4 });
    p.sprint = p.stamina > 0.2;
    if (dHoop < SHOT.LAYUP_RANGE - 0.3) m.beginShot(p);
    else if (p.r.dunk >= 70 && dHoop < SHOT.DUNK_RANGE && p.speed > 9 && chance(0.4)) m.beginShot(p);
  } else {
    steer(p, ai.tx, ai.ty, { sprintBeyond: 12, speed: ai.plan === 'advance' ? 0.95 : 0.75 });
  }
}

function laneOpen(from: Player, to: Player, defs: Player[]): number {
  let best = 99;
  for (const d of defs) best = Math.min(best, distToSegment(d.x, d.y, from.x, from.y, to.x, to.y));
  return best;
}

function pickRelease(m: Match, p: Player): number {
  const sd = m.tune.aiReleaseError * (1.25 - p.r.shooting / 200);
  return clamp(SHOT.PERFECT + gauss(0, sd), 0.35, SHOT.AUTO_RELEASE - 0.02);
}

// --------------------------------------------------------------- offense: off ball

function offBallAI(m: Match, p: Player, dt: number) {
  const ai = p.ai;
  const b = m.ball;
  const H = p.hoop;
  const handler = m.handler;

  if (b.state === 'pass' && b.pass?.to === p) {
    const T = Math.max(0, b.pass.T - b.pass.t);
    steer(p, b.x + b.vx * T, b.y + b.vy * T, { sprintBeyond: 3, slowRadius: 1 });
    p.faceTarget = { x: b.x, y: b.y };
    return;
  }

  ai.spotT -= dt;
  ai.cutT -= dt;

  // Transition: run the floor, filling a lane ahead of the ball.
  if (handler && handler.distToHoop() > TRANSITION_DIST && p.distToHoop() > 14) {
    if (ai.spotIdx < 0 || ai.spotT <= 0) { ai.spotIdx = chooseSpot(m, p); ai.spotT = rand(2, 3.5); }
    const s = spotWorld(H, ai.spotIdx);
    steer(p, s.x, s.y, { sprintBeyond: 6 });
    return;
  }

  if (ai.cutT > 0) {
    const tx = H.x + H.dir * 3.5;
    const ty = H.y + (p.y < H.y ? -2 : 2);
    steer(p, tx, ty, { sprintBeyond: 2 });
    if (p.distTo({ x: tx, y: ty }) < 1.5) ai.cutT = Math.min(ai.cutT, 0.6);
    return;
  }

  if (ai.spotT <= 0 || ai.spotIdx < 0) {
    ai.spotT = rand(1.6, 3.4);
    ai.spotIdx = chooseSpot(m, p);
    const myDefEntry = [...m.assign.entries()].find(([, man]) => man === p);
    const defender = myDefEntry ? m.players.find((x) => x.id === myDefEntry[0]) : null;
    const defGap = defender ? defender.distTo(p) : 99;
    if (handler && p.distToHoop() > 10 && (defGap > 6 || chance(0.12 * m.tune.aiIq)) && chance(0.35)) {
      ai.cutT = rand(1.1, 1.6);
      return;
    }
  }
  const s = spotWorld(H, ai.spotIdx);
  steer(p, s.x, s.y, { sprintBeyond: 10, speed: 0.8 });
  p.faceTarget = handler ? { x: handler.x, y: handler.y } : null;
}

function chooseSpot(m: Match, p: Player): number {
  const H = p.hoop;
  const others = m.players.filter((o) => o.side === p.side && o !== p);
  const handler = m.handler;
  let best = 0;
  let bestScore = -Infinity;
  SPOTS.forEach((_, i) => {
    const s = spotWorld(H, i);
    let minMate = 99;
    for (const o of others) {
      const os = o !== handler && o.ai.spotIdx >= 0 ? spotWorld(H, o.ai.spotIdx) : o;
      minMate = Math.min(minMate, Math.hypot(os.x - s.x, os.y - s.y));
    }
    let score = Math.min(minMate, 14);
    score -= Math.hypot(s.x - p.x, s.y - p.y) * 0.08;
    const shooter = (p.r.three - 60) / 20;
    const tag = SPOTS[i].tag;
    if (tag === 'corner' || tag === 'wing' || tag === 'top' || tag === 'slot') score += shooter;
    else score += (p.r.finishing - 70) / 15 - shooter * 0.5;
    if (handler && Math.hypot(handler.x - s.x, handler.y - s.y) < 9) score -= 8;
    score += Math.random() * 2.5;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// --------------------------------------------------------------- defense

function defenseAI(m: Match, p: Player, dt: number) {
  const ai = p.ai;
  const b = m.ball;
  const tune = m.tune;
  const userMatch = m.cfg.userSide !== null;
  const isUserTeam = userMatch && p.side === m.cfg.userSide;
  const react = isUserTeam ? 6 : tune.defReact;
  const gap = isUserTeam ? 3.2 : tune.defGap;
  // The basket this defender protects
  const H = attackHoop(m.offense);

  let man = m.assign.get(p.id);
  if (!man) { m.reassignDefense(false); man = m.assign.get(p.id); }
  if (!man) return;
  const handler = m.handler;

  if (b.state === 'pass' && b.pass) {
    const rem = b.pass.T - b.pass.t;
    const end = { x: b.x + b.vx * rem, y: b.y + b.vy * rem };
    if (distToSegment(p.x, p.y, b.x, b.y, end.x, end.y) < 3) {
      steer(p, end.x * 0.4 + b.x * 0.6, end.y * 0.4 + b.y * 0.6, { sprintBeyond: 0 });
      return;
    }
  }

  let tx: number;
  let ty: number;
  const manHoop = hoopDist(man.x, man.y, H);
  if (man === handler) {
    const dx = H.x - man.x; const dy = H.y - man.y; const dl = Math.hypot(dx, dy) || 1;
    if (manHoop > 36) {
      // Don't pressure full court: wait around the top of the key extended.
      const wait = Math.min(manHoop - gap, 34);
      tx = H.x - (dx / dl) * wait;
      ty = H.y - (dy / dl) * wait;
    } else {
      const g = manHoop < 9 ? Math.min(gap, 2.2) : gap;
      tx = man.x + (dx / dl) * g + man.vx * 0.12;
      ty = man.y + (dy / dl) * g + man.vy * 0.12;
    }
    p.faceTarget = { x: man.x, y: man.y };

    if (man.action === 'jumpshot' || man.action === 'layup' || man.action === 'dunk') {
      tx = man.x + (dx / dl) * 1.6; ty = man.y + (dy / dl) * 1.6;
      if (ai.contestDelay <= 0) ai.contestDelay = rand(0.08, 0.26) * (10 / (react + 4));
      ai.contestDelay -= dt;
      if (ai.contestDelay <= 0.02 && !p.airborne && p.distTo(man) < 6.5 && chance(userMatch && !isUserTeam ? tune.contestChance : 0.8)) {
        m.contestJump(p);
        ai.contestDelay = 9;
      }
    } else {
      ai.contestDelay = 0;
      const stealRate = (userMatch && !isUserTeam ? tune.stealRate : 0.25) * (p.r.steal / 70);
      if (p.distTo(man) < 3.4 && p.stealCd <= 0 && Math.random() < stealRate * dt) m.attemptSteal(p);
    }
  } else {
    // Off-ball: sag toward the hoop and shade toward the ball; never get caught upcourt.
    tx = man.x + (H.x - man.x) * 0.2 + (b.x - man.x) * 0.12;
    ty = man.y + (H.y - man.y) * 0.2 + (b.y - man.y) * 0.12;
    const d = hoopDist(tx, ty, H);
    if (d > 30) {
      tx = H.x + ((tx - H.x) / d) * 30;
      ty = H.y + ((ty - H.y) / d) * 30;
    }
    p.faceTarget = { x: b.x, y: b.y };

    // Help: driver beat his man near the rim
    if (handler && handler.side !== p.side) {
      const hd = hoopDist(handler.x, handler.y, H);
      const onBall = m.players.find((d2) => m.assign.get(d2.id) === handler);
      const beaten = onBall ? hoopDist(onBall.x, onBall.y, H) > hd + 1.2 || onBall.action === 'ankles' : true;
      if (hd < 14 && beaten) {
        const helpers = m.team(p.side).filter((d2) => d2 !== onBall).sort((a, c) => a.distTo(handler) - c.distTo(handler));
        if (helpers[0] === p) {
          tx = handler.x + (H.x - handler.x) * 0.45;
          ty = handler.y + (H.y - handler.y) * 0.45;
          if ((handler.action === 'layup' || handler.action === 'dunk') && !p.airborne && p.distTo(handler) < 5 && chance(0.6)) m.contestJump(p);
        }
      }
    }
  }

  const k = Math.min(1, dt * react);
  ai.tx += (tx - ai.tx) * k;
  ai.ty += (ty - ai.ty) * k;
  const d = steer(p, ai.tx, ai.ty, { sprintBeyond: 5, slowRadius: 1.6 });
  // Sprint back in transition
  if (d > 3 && (man === handler || hoopDist(p.x, p.y, H) > hoopDist(man.x, man.y, H))) p.sprint = p.stamina > 0.15;
}

// --------------------------------------------------------------- rebounds / loose balls

function reboundAI(m: Match, p: Player) {
  const b = m.ball;
  const H = b.shot?.hoop ?? (b.x < COURT.L / 2 ? COURT.HOOPS[0] : COURT.HOOPS[1]);
  let px = b.x; let py = b.y;
  if (b.state === 'shot') {
    const a = Math.atan2(p.y - H.y, p.x - H.x);
    px = H.x + Math.cos(a) * 4.5;
    py = H.y + Math.sin(a) * 4.5;
    if ((px - H.x) * H.dir < 0.5) px = H.x + H.dir * 0.5;
  } else if (b.z > 4) {
    let x = b.x, y = b.y, z = b.z, vz = b.vz;
    for (let i = 0; i < 60 && (z > 5 || vz > 0); i++) { x += b.vx * 0.03; y += b.vy * 0.03; vz -= 40 * 0.03; z += vz * 0.03; }
    px = x; py = y;
  } else {
    px = b.x + b.vx * 0.25; py = b.y + b.vy * 0.25;
  }

  if (p.locked) return;

  const near = hoopDist(b.x, b.y, H) < 30;
  const mates = m.team(p.side).sort((a, c) => a.distTo({ x: px, y: py }) - c.distTo({ x: px, y: py }));
  const rank = mates.indexOf(p);
  // Two closest chase (three on a truly loose ball); the rest get into position.
  if (rank <= 1 || (b.state === 'loose' && (rank <= 2 || !near))) {
    const d = steer(p, px, py, { sprintBeyond: 3, slowRadius: 0.8 });
    p.sprint = d > 2 && p.stamina > 0.1;
    if (b.state === 'loose' && d < 2.2 && b.z > p.def.height * 1.15 && b.z < 11 && b.vz < 4 && !p.airborne && chance(0.25)) {
      m.contestJump(p);
    }
  } else {
    const shootingTeam = p.side === (b.shot?.shooter.side ?? b.lastTouch);
    // Shooting team's extra players get back; the other team leaks out to the wings.
    const own = attackHoop((1 - p.side) as 0 | 1);
    const s = shootingTeam ? rel(own, 30, (rank % 2 ? 1 : -1) * 8) : rel(H, 24, (rank % 2 ? 1 : -1) * 17);
    steer(p, s.x, s.y, { speed: 0.85, sprintBeyond: 14 });
  }
  p.faceTarget = { x: b.x, y: b.y };
}
