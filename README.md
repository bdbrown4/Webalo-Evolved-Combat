# Webalo: Evolved Combat

### ▶ [Play it in your browser](https://bdbrown4.github.io/Webalo-Evolved-Combat/)

An **original, open-source, browser-based sci-fi FPS** in the spirit of the
early-2000s console shooter: recharging energy shields, a strict two-weapon
carry, cookable grenades, a scoped sidearm, a radar motion tracker, goofy
aliens, and a climactic drive-or-die vehicle escape across a collapsing
ringworld.

Built with **[Three.js](https://threejs.org)** + **[Vite](https://vitejs.dev)**.
Runs entirely client-side in any modern browser (WebGL2). **There are no asset
files anywhere in this repository** — every mesh is generated procedurally in
code, every surface texture is painted to a canvas at runtime, and every sound
is synthesized with the Web Audio API. Clone it and the whole game is here.

> **About the "in the spirit of"**: Webalo is a parody-flavored homage. Game
> *mechanics* (shields, two-weapon limit, grenade types, a vehicle finale) are
> not copyrightable and are faithfully recreated. Everything *expressive* —
> characters, faction and species names, story, dialogue, art, and audio — is
> **original**. The Wobble Coalition is deliberately goofy. This project ships
> no third-party game assets and is not affiliated with or endorsed by any
> other game's rights holders.

## Story

> *When the lost **Vanguard fleet** vanished chasing a distress call from the
> edge of charted space, command wrote them off. The signal kept pulsing.*
>
> *Its source was the **Aureole** — a ringworld older than memory, encircled by
> the **Wobble Coalition**: a swarm of googly-eyed zealots who tend its ancient
> machinery and worship the ring as a friend. They have no idea what it was
> built to cage.*
>
> *One dropship answered the call. Only Sergeant **Vance Orion** walked away
> from the crash — a lone marine, a cracked AI named **IRIS**, and a structure
> the size of a nightmare charging toward something terrible.*
>
> *The Coalition thinks he is trespassing. He intends to prove them right.*

The Aureole was never a refuge. The "distress beacon" was bait, and every
reactor Orion lights to survive only winds the ring closer to firing. Across
eight missions he fights down through maintenance tunnels, data vaults, and a
splitting throne-concourse — heckled the whole way by IRIS — toward the thing
holding it all together: **Supreme Jiggler Pomplemoose**, a billion googly eyes
welded into the dying core, absolutely certain everything is fine.

The opening crawl plays in-game when you start a **New Campaign** (skippable),
and the full arc unfolds through mission briefings and in-mission dialogue.

The cast:

- **Sgt. Vance Orion** ("Vanguard") — the last marine standing, dry as ash.
- **IRIS** — the salvaged ship AI; sardonic, fond of statistics and eulogies.
- **The Wobble Coalition** — Blorks, Gurgs, Wobblers, and hovering Floaters;
  earnest, disorganized, and deeply attached to paperwork (see Quivermaster
  Sprocket and his missing memo three).
- **Supreme Jiggler Pomplemoose** — the finale boss, fused to the reactor it is
  enthusiastically destroying.

## Quick start

```bash
npm install
npm run dev      # opens http://localhost:5173
```

Build a static, deployable bundle (e.g. for GitHub Pages):

```bash
npm run build    # outputs to ./dist
npm run preview  # serve the built bundle locally
```

### Hosting on GitHub Pages

Every push to `main` is built and published automatically by the
[`Deploy to GitHub Pages`](.github/workflows/deploy.yml) workflow — it runs
`npm run build` and serves `./dist` at the
[live URL](https://bdbrown4.github.io/Webalo-Evolved-Combat/). No manual
deploy step is needed; `vite.config.js` sets `base: './'` so the bundle works
from the project-site subpath. (One-time: the workflow enables Pages on its
first run; if your org restricts that, set **Settings → Pages → Source** to
*GitHub Actions* once.)

## Features

- **Classic shooter loop** — recharging shields layered over a smaller health
  pool (shields absorb first and regenerate after a delay; health only comes
  back from pickups), two-weapon carry with swap + reload, melee, and a
  radar-style motion tracker.
- **Five weapons, two firing models** — hitscan ballistics (pistol, auto rifle,
  pellet boomstick) and travelling projectiles (goo caster, homing stinger),
  each with its own reticle, ADS behavior, and recoil. The M7 sidearm carries a
  2× smart-link **scope** with a full-screen optic overlay.
- **Grenades with weight** — *hold* the throw key to **cook** a frag (the fuse
  burns down with quickening beeps; hold too long and it goes off in your hand),
  release to throw. Thrown frags **bounce** off walls and floors so you can bank
  them around cover; **goober** grenades stick to the first surface — or enemy —
  they touch. Your own blasts can hurt you, so the risk is real.
- **First-person presence** — visible arms and gloved hands on every weapon, and
  a dedicated grenade hand that raises, trembles as the fuse burns, and swings
  on release.
- **A drivable finale** — commandeer a Coalition transport and run the gauntlet
  across the breaking Aureole, flattening minions at speed, before the ring
  fires.
- **Wobble Coalition AI** — several archetypes (melee swarmers, charging
  bruisers, hovering ranged drones, shielded officers) plus a three-phase finale
  boss, all with comically physical death tumbles.
- **Procedural, atmospheric worlds** — ACES filmic tone mapping, canvas-painted
  panel/grime textures, per-room light fixtures and fill lighting, exhaust pipes
  and structural trim, starfields and a low sun over a kilometers-wide ringworld
  on the horizon. Room footprints and ceiling heights vary so no two beats feel
  like the same box.
- **Complete front-end** — main menu, mission select with progress, tabbed
  settings (live control rebinding, audio mixer, video/quality with a real bloom
  toggle, difficulty), pause menu, and per-mission result screens.
- **Data-driven campaign** — an 8-mission arc authored as plain data (see
  `missions/schema.js`), with four difficulty tiers and automatic mid-mission
  checkpoints.
- **Daily Challenge** — one seeded run per calendar day, the same for everyone:
  a **Survival of the Day** and a rotating **Mission of the Day**, each with that
  day's **mutators** (Glass Cannon, Horde Night, Moon Boots, Juggernauts…). Your
  best score persists locally and a short share code lets a friend chase the same
  seed — no server, no accounts. Mutators are also a reusable run-modifier system.
- **Two-player co-op** — bring a friend through either **Survival** or the whole
  **Campaign**, over direct peer-to-peer (Trystero relays, or paste-the-code
  manual connect — no account, no server). Host-authoritative: one player runs
  the simulation and streams ~20 Hz world snapshots; the guest predicts its own
  movement and renders the rest. Downed teammates can be revived, and each player
  picks their own between-mission upgrade. The host leads the campaign mission to
  mission; the guest follows.

## Default controls

All controls are **fully rebindable** in `Settings → Controls`.

| Action | Default |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Look | Mouse |
| Fire | Left Mouse |
| Aim / zoom (scope) | Right Mouse |
| Jump | `Space` |
| Crouch | `Left Ctrl` |
| Sprint | `Left Shift` |
| Reload | `R` |
| Melee | `V` |
| Throw grenade (hold to cook) | `G` |
| Swap weapon | `Q` (or mouse wheel) |
| Select weapon 1 / 2 | `1` / `2` |
| Switch grenade type | `B` |
| Interact (consoles, etc.) | `F` |
| Flashlight | `T` |
| Pause / menu | `Esc` |

The vehicle in the finale uses the same movement keys: `W`/`S` to
accelerate and reverse, `A`/`D` to steer.

Settings (controls, mouse sensitivity, audio levels, and video/quality options)
persist in `localStorage`. Campaign progress and checkpoints are saved
automatically.

## Project layout

```
src/
  main.js              boot + top-level wiring
  core/
    Game.js            render loop, scene/renderer, post-processing, state
                       machine, mission flow, combat FX
    Settings.js        persistent settings + keybindings (localStorage)
    Input.js           keyboard/mouse, pointer lock, rebindable action map
    Audio.js           synthesized SFX + adaptive music (WebAudio, no files)
    AssetFactory.js    all procedural meshes, canvas textures, skies, view-models
    Difficulty.js      difficulty tiers (enemy health + incoming damage scaling)
  engine/
    Physics.js         capsule-vs-AABB collision, gravity, ray/normal casts
  entities/
    Player.js          movement, shields/health, weapons, grenades, melee
    Enemy.js           Wobble Coalition AI (idle/alert/chase/attack + boss)
    Weapon.js          weapon definitions + firing logic (hitscan + projectile)
    Projectile.js      goo bolts, homing shards, bouncing/sticky grenades
    Vehicle.js         the drivable finale transport
  world/
    LevelBuilder.js    turns segment-based mission DATA into a dressed level
  missions/
    schema.js          the mission data contract (documented)
    campaign.js        all eight missions as inline data + progress save/load
  ui/
    HUD.js             shields/health/ammo, reticle, scope, cook bar, tracker
    Menus.js           main menu, settings (tabbed), pause, mission cards
  styles.css           HUD + menu styling
```

## How it works

The game is deliberately **dependency-light** (only Three.js) and
**asset-free**. A few notes on how that's achieved:

- **Meshes** are composed from primitives in `AssetFactory.js` — the goofy
  aliens, weapons with first-person arms, props, the vehicle, and FX.
- **Textures** are drawn to an offscreen `<canvas>` at load time
  (`AssetFactory.surfaceTexture`) and tiled per surface, so floors and walls get
  panels, seams, rivets, and grime without shipping image files.
- **Audio** is fully synthesized in `Audio.js`: SFX are short procedural
  oscillator/noise envelopes, and the music bed is a few layered oscillators
  with a slow filter sweep whose intensity adapts per track.
- **Levels** are pure data. A mission is a list of `segments` (rooms) with
  enemies, cover density, pickups, objectives, and dialogue; `LevelBuilder.js`
  turns that into geometry, collision, lighting, and dressing.

## Contributing

PRs welcome — especially new missions (add a mission object to
`missions/campaign.js` matching `missions/schema.js`), enemy archetypes, and
weapons. Please keep **all content original**: no ripped or third-party game
assets, ever.

## License

MIT — see [LICENSE](./LICENSE).
