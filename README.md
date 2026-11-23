# Hardwood Heat

A 5-on-5 full-court arcade basketball game set in a night-time boardwalk park, running in the browser. Built with Phaser 3, TypeScript and Vite. All teams, players and branding are fictional, and every sound is synthesized at runtime, so the game has no asset files.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks, then writes a static build to `dist/` (open with `npm run preview`) |
| `npm run typecheck` | TypeScript only |
| `npm test` | Mechanics checks plus a 10-game AI-vs-AI simulation (headless, no browser) |

## Controls

| | Offense | Defense |
| --- | --- | --- |
| `WASD` / arrows | Move and dribble | Move |
| `Shift` | Sprint (uses stamina) | Sprint |
| `Space` | Hold, then release when the meter under your feet hits the green zone. Near the rim it's a layup; sprint in for a dunk | Jump to contest or block |
| `F` | Crossover: switch hands with a burst. Catch a defender reaching and they hit the floor | |
| `E` | Pass toward your movement direction or the mouse | |
| `R` | | Swipe for a steal |
| `Q` | Switch to the player nearest the ball | Same |
| `Esc` / `P`, `M` | Pause, mute | |

## Rules

- Full court, 5 on 5. Your team attacks the right-hand basket. After a score, the other team inbounds and brings it up the floor.
- Baskets inside the arc are worth 2 and baskets beyond it are worth 3. The clock is 2, 3 or 5 minutes, and a game tied at the buzzer goes to sudden death (next basket wins).
- The shot clock is 20 seconds and resets when the ball hits the rim.
- Whether a shot goes in depends on the shooter's rating, distance, how close and well-placed the defender is, how fast the shooter is moving, stamina, and release timing. A perfect release on an open look almost always drops.

## How it's built

```
src/
  config.ts            tuning: court geometry, physics, shot meter, difficulty levels
  core/projection.ts   side-on camera that pans along the court (world feet -> screen)
  sim/                 game simulation with no rendering (runs in node)
    Match.ts           rules, clocks, possession, shooting, passing, steals, blocks, stats
    Player.ts, Ball.ts movement, jumps, stamina, ball physics (floor, rim, backboard)
    shooting.ts        make-probability model
  ai/brain.ts          offense (drive / shoot / pass decisions, spacing, cuts), man defense, help, rebounding
  render/floor.ts      main court + park ground, projected per pixel by a GPU shader
  render/Park.ts       skyline, string lights, palms, spectators, hoops and nets, background pickup games
  render/              character rig and effects
  scenes/GameScene.ts  wires the sim to rendering, input and audio
  audio/               Web Audio synthesized sound effects and crowd ambience
  ui/                  HTML/CSS menus, team select, HUD, pause and results screens
scripts/               headless tests (usertest = mechanics, simtest = full games)
```

Notes on the design:

- **The simulation is independent of rendering.** `Match` only knows about world coordinates. Because of that, the headless tests run real games in node, and the same `Match` drives the attract-mode demo behind the main menu.
- **The ground is projected by a shader.** The court and the park around it are painted flat in world space once; a fragment shader inverts the camera for every pixel, so perspective stays exact while the camera pans. Shader textures must be power-of-two sized (Phaser binds them with REPEAT wrapping, which WebGL treats as black for other sizes).
- **Static scenery is drawn once and slid.** Anything at a fixed depth (palms, light strings, background hoops) only needs a horizontal shift as the camera pans, so it is not redrawn each frame.
- **Players are drawn as a 3D-posed rig.** Joints are posed in each player's local frame (run cycle, defensive stance, dribble, jumper, layup, dunk, contest, reach), projected to the screen, depth-sorted, and drawn with an outline. Animation therefore works from any facing direction, and the background pickup players reuse the same rig.
- **The simulation runs on real elapsed time in fixed 1/60 s slices.** A low frame rate drops frames instead of slowing the game down.

## Extending

Teams and ratings are in `src/data/teams.ts`. Difficulty levels are in `DIFFICULTY` in `src/config.ts`. The sim already records per-player box-score stats. `Match` takes a plain config object, so a season or franchise layer can create matches and read back `match.players[i].stats` without touching gameplay code.
