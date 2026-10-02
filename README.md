# Railfever

A transport tycoon game in the spirit of Transport Fever and OpenTTD, built with WebGL (three.js) and TypeScript. It runs fully offline in the browser: no server and no network access.

You connect procedurally generated towns with railways and bus lines on a continuous, realistic-scale world (1 unit = 10 m). Tracks and roads are free-form curves, not tiles. Passengers choose destinations across your network, transfer between lines, and pay by distance and speed. Good service makes towns grow. Rival AI companies build their own networks.

## Running

```bash
npm install
npm run dev        # development server at http://localhost:5173
npm run build      # production build
```

`npm run build` writes `dist/railfever.html`. This is one self-contained file with all code, styles and fonts inlined. Open it directly from disk; it works offline. Saves are stored in the browser's local storage, and you can also export and import them as files.

URL parameters for quick starts: `?seed=123&size=512&towns=12&terrain=hilly&water=medium&year=1980&ai=2&nointro`.

## Features

**World**
- Continuous terrain at real scale (maps of 2.5–7.7 km) with hills, mountains, lakes and coasts, forests and snowy peaks.
- Towns laid out on street grids aligned with the terrain: arterials first, then blocks growing outward ring by ring, with continuous frontage around the blocks, a central plaza, parks, street trees and zebra crossings. They densify from cottages to apartments, offices and towers, and grow faster when stations serve them.
- Country roads connect all towns from the start (a spanning tree plus shortcuts), routed over the terrain with viaducts, river bridges and the occasional tunnel.
- Town traffic with junction priority, queueing and level-crossing safety.
- Rendering: sky, fitted sun shadows, ambient occlusion, cloud shadows, animated water with shore foam, moonlit nights, distance LOD for terrain, details, trees and vehicles, and dynamic resolution that holds the frame rate.

**Rail**
- Free-form track building: click to start, click to build, and keep clicking to chain smooth curves. The planner fits Bezier curves within minimum radius and gradient, grades the terrain into cuttings and embankments, and adds **bridges** (girder, truss and arch styles) and **tunnels** automatically.
- **Parallel tracks**: build 1–4 tracks at once; double track widens automatically into station throats. Hold Shift over a track to copy it as a parallel track.
- **Height offset** (PgUp/PgDn or `[` `]`) and crossing preference (auto, **overpass**, **underpass**, level) for grade-separated junctions.
- Standard track (160 km/h) and electrified high-speed track (300 km/h) with catenary.
- Switches anywhere along a track, diamond crossings, level crossings with animated barriers, buffer stops.
- Free-placed multi-platform stations of any length and orientation, with platforms, canopies, footbridges and a station building. Depots attach to track ends.
- **Path signals**, two-way or one-way. Trains reserve their path block by block, pick free platforms, and reverse at terminus stations.
- Physics: power, adhesion, mass and gradient decide acceleration; curves set speed limits; realistic braking.
- Locomotives and coaches change by era: steam, diesel, intercity and high speed.

**Road**
- Curved roads (town streets with sidewalks, or country roads) with automatic junctions, bridges and tunnels.
- Bus stops on any road, bus depots that connect themselves, buses with lane following.

**AI competitors**
- Up to three AI companies (choose them in the new-game dialog or add them later). They plan intercity railways over the terrain with bridges and tunnels, run bus networks in large towns, build country roads, and manage their money, loans and fleets.
- AI construction can be switched off in the Companies window or the settings; their vehicles keep running.

**Passengers and economy**
- Stations have catchment areas, ratings and waiting passengers grouped by destination.
- Lines are ordered stop lists, drawn on the map. Routing across the whole network includes **transfers**.
- Fares depend on distance and speed. The economy covers running costs, maintenance, a loan with interest, and finance and company reports with charts.

**Sound**
- Procedural sound effects (WebAudio, no audio files): soft interface sounds, construction clanks and rollers, demolition, cash chimes, positional trains (steam chuffs, diesel rumble, electric hum, rail-joint clatter, horns and whistles), level-crossing bells, station chimes, and ambience that follows the camera (birds, wind, town hum, surf, crickets at night). Volume sliders per group and a mute button in the top bar.

**Interface**
- A redesigned interface set in Inter and Barlow Condensed, with a getting-started checklist, hover cards in the world and rising income text: a top bar with your company and date, a tool dock with categories, compact tool cards with live cost, grade, radius and speed previews, and windows for stations, towns, vehicles, lines, finances, companies and news.
- Title screen and new-game setup, minimap with layers, settings for shadows, ambient occlusion, resolution, day/night, transparency and the F3 performance overlay.

## Controls

| Action | Input |
| --- | --- |
| Pan | Right-drag, WASD or arrow keys |
| Rotate / tilt | Middle-drag, Shift/Alt + drag, Q/E, R/F |
| Zoom | Mouse wheel (towards the cursor), `+` / `-` |
| Tools | 1 inspect, 2 track, 3 station, 4 signal, 5 train depot, 6 road, 7 bus stop, 8 bus depot, 9 demolish, 0 terraform |
| While building | Click to build and continue, Esc or right-click to end, PgUp/PgDn or `[` `]` height, Shift over a track to copy it in parallel, R to rotate stations and depots |
| Windows | L lines, V vehicles, T towns, C companies, N news, F1 help |
| Other | Space pause, G grid, M minimap, F3 performance overlay, Esc cancel/close |

## Quick start

1. Place a **train station** (3) near each of two towns. It snaps to line up with nearby track ends.
2. Choose the **track** tool (2), pick 1 or 2 parallel tracks, click a platform end of one station and click your way to the other station.
3. Place a **train depot** (5) on a free track end.
4. Open **Lines** (L), create a rail line, click both stations, then add a train.

Several trains on one track need signals. On single track, use passing loops with **one-way** signals.

## Project layout

```
src/game/    simulation: continuous world, terrain gen, towns, network graph (Bezier edges,
             profiles, bridges/tunnels, crossings), construction planner, stations, depots,
             lines & routing, trains, road vehicles, AI companies, economy, saves
src/render/  three.js renderer: terrain LOD & water, batched static world (track, roads,
             bridges, portals, stations, buildings, trees), vehicles, overlays, labels, camera
src/ui/      HUD, tool dock, tools, windows, title screen, minimap, fonts, icons
scripts/     build inliner and headless tests (smoke, save, ai, fuzz, perf, economy, signals, tunnels)
```

The headless tests run in Node:

```bash
npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
```

Other scripts: `save` (exact save/load round trip), `ai [seed] [years] [size] [ais]`, `fuzz [seed] [steps]`, `perf` (512-map stress test), `economy`.
