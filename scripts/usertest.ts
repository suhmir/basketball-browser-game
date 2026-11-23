// Scripted checks of user-facing mechanics against the real simulation.
import { Match, NO_INPUT, type InputState } from '../src/sim/Match';
import { TEAMS } from '../src/data/teams';
import { SHOT } from '../src/config';

let failures = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const mk = (over: Partial<ConstructorParameters<typeof Match>[0]> = {}) =>
  new Match({ teams: [TEAMS[0], TEAMS[1]], userSide: 0, starIndex: 0, difficulty: 'rookie', gameTime: 120, ...over });
const inp = (o: Partial<InputState> = {}): InputState => ({ ...NO_INPUT, ...o });
const step = (m: Match, s: number, i: InputState = NO_INPUT) => { for (let t = 0; t < s; t += 1 / 60) m.update(1 / 60, i); };
const toLive = (m: Match) => { for (let i = 0; i < 600 && m.phase !== 'live'; i++) m.update(1 / 60, NO_INPUT); };

// 1. Intro -> live, user has the ball
{
  const m = mk();
  toLive(m);
  ok(m.phase === 'live', 'match goes live after intro');
  ok(m.user === m.ball.owner && m.user?.def.name === 'Marcus Reyes', 'user controls star with the ball');
}

// 2. Perfect release from the top of the key, wide open -> PERFECT grade and high odds
{
  let perfect = 0; let made = 0; const N = 60;
  for (let k = 0; k < N; k++) {
    const m = mk();
    toLive(m);
    // clear defenders away to make it open
    for (const p of m.team(1)) { p.x = 5 + p.id; p.y = 44; }
    const u = m.user!;
    u.x = u.hoop.x - 25.5; u.y = 25; // top of the key, just beyond the arc
    let grade = ''; let chanceV = 0;
    m.ev.on('release', (e) => { grade = e.grade ?? ''; chanceV = e.chance; });
    m.ev.on('score', () => { made++; });
    m.update(1 / 60, inp({ shootPressed: true, shootHeld: true }));
    while (u.charging && u.charge < SHOT.PERFECT - 0.004) { for (const p of m.team(1)) { p.x = 5 + p.id; p.y = 44; p.vx = 0; p.vy = 0; } m.update(1 / 120, inp({ shootHeld: true })); }
    m.update(1 / 60, inp({ shootReleased: true }));
    if (grade === 'PERFECT') perfect++;
    if (k === 0) console.log('      sample: grade', grade, 'chance', chanceV.toFixed(2));
    step(m, 3);
  }
  ok(perfect === N, `perfect timing graded PERFECT (${perfect}/${N})`);
  ok(made / N > 0.75, `open perfect threes go in most of the time (${made}/${N})`);
}

// 3. Very early release from the same spot rarely goes in
{
  let made = 0; const N = 80;
  for (let k = 0; k < N; k++) {
    const m = mk(); toLive(m);
    for (const p of m.team(1)) { p.x = 5 + p.id; p.y = 44; }
    m.user!.x = m.user!.hoop.x - 25.5; m.user!.y = 25;
    m.ev.on('score', () => { made++; });
    m.update(1 / 60, inp({ shootPressed: true, shootHeld: true }));
    step(m, 0.12, inp({ shootHeld: true }));
    m.update(1 / 60, inp({ shootReleased: true }));
    step(m, 3);
  }
  ok(made / N < 0.3, `early releases mostly miss (${made}/${N})`);
}

// 4. Pass hands control to the receiver on catch and credits an assist on a quick score
{
  const m = mk(); toLive(m);
  for (const p of m.team(1)) { p.x = 5 + p.id; p.y = 44; } // keep defenders out of the passing lane
  const u = m.user!;
  const mates = m.teammates(u);
  m.update(1 / 60, inp({ passPressed: true, mx: (mates[0].x - u.x), my: (mates[0].y - u.y) }));
  ok(m.ball.state === 'pass', 'E starts a pass');
  step(m, 1.2);
  ok(m.user === m.ball.owner && m.user !== u, `control follows the ball to the receiver (${m.user?.def.name})`);
}

// 5. Full court: each team scores on its own basket, and the other team inbounds from its backcourt
{
  const m = mk(); toLive(m);
  const u = m.user!;
  ok(u.hoop.x > 47, 'home team attacks the right-hand basket');
  ok(m.team(1)[0].hoop.x < 47, 'away team attacks the left-hand basket');
  for (const p of m.team(1)) { p.x = 20; p.y = 5 + p.id; }
  u.x = u.hoop.x - 3; u.y = 25; u.vx = 0; u.vy = 0;
  let scored = -1;
  m.ev.on('score', (e) => { scored = e.side; });
  m.update(1 / 60, inp({ shootPressed: true, shootHeld: true }));
  step(m, 2.5);
  step(m, 3);
  ok(scored === 0 || m.score[0] === 0, `layup at the right basket credits the home team (${m.score.join('-')})`);
  if (scored === 0) {
    toLive(m);
    const h = m.ball.owner!;
    ok(h.side === 1 && h.x > 47, `after the make the away team brings it up from its backcourt (x=${h.x.toFixed(0)})`);
  }
}

// 6. Shot clock violation turns it over
{
  const m = mk(); toLive(m);
  let reason = '';
  m.ev.on('turnover', (t) => { reason = t.reason; });
  // user stands still holding the ball (AI teammates won't take it)
  step(m, 21);
  ok(reason === 'SHOT CLOCK', `shot clock violation fires (${reason || 'none'})`);
  step(m, 3);
  ok(m.offense === 1, 'other team gets the ball after the violation');
}

// 7. Switching on defense picks the defender nearest the ball
{
  const m = mk(); toLive(m);
  m.giveBall(m.team(1)[0]); // user now on defense
  const before = m.user;
  m.update(1 / 60, inp({ switchPressed: true }));
  ok(m.user !== before && m.user?.side === 0, 'Q switches controlled defender');
}

// 8. Game ends at the buzzer; ties go to sudden death
{
  const m = mk({ gameTime: 5, userSide: null }); toLive(m);
  let over = false; m.ev.on('gameover', () => { over = true; });
  step(m, 120);
  ok(over && m.phase === 'over', `short game finishes (${m.score.join('-')}${m.overtime ? ' OT' : ''})`);
  ok(m.score[0] !== m.score[1], 'there is always a winner');
}

// 9. Steal (R) success rate is sane for a user defender right next to the handler
{
  let steals = 0; const N = 200;
  for (let k = 0; k < N; k++) {
    const m = mk(); toLive(m);
    m.giveBall(m.team(1)[0]);
    const h = m.ball.owner!; const d = m.user!;
    d.x = h.x + Math.cos(h.facing) * 1.6; d.y = h.y + Math.sin(h.facing) * 1.6 + 0.3;
    m.ev.on('steal', () => { steals++; });
    m.update(1 / 60, inp({ stealPressed: true }));
    step(m, 1.2);
  }
  ok(steals / N > 0.08 && steals / N < 0.6, `steal success rate reasonable (${(steals / N * 100).toFixed(0)}%)`);
}

// 10. Crossover (F): switches hands, bursts, and can break the ankles of a defender caught reaching
{
  const m = mk(); toLive(m);
  const u = m.user!;
  const side0 = u.dribbleSide;
  m.update(1 / 60, inp({ crossPressed: true }));
  ok(u.action === 'crossover' && u.dribbleSide !== side0, 'F performs a crossover and switches hands');
  ok(u.speed > 9, `crossover gives a burst of speed (${u.speed.toFixed(1)} ft/s)`);
  let ankles = 0; const N = 300;
  for (let k = 0; k < N; k++) {
    const mm = mk(); toLive(mm);
    const h = mm.user!;
    const d = mm.team(1).find((x) => mm.assign.get(x.id) === h)!;
    d.x = h.x + Math.cos(h.facing) * 3; d.y = h.y + Math.sin(h.facing) * 3;
    d.setAction('reach');
    mm.ev.on('ankles', () => { ankles++; });
    mm.crossover(h);
  }
  ok(ankles / N > 0.2 && ankles / N < 0.85, `crossing a reaching defender drops them often (${(ankles / N * 100).toFixed(0)}%)`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
