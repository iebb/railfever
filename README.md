# Railfever

A transport tycoon game in the spirit of Transport Fever and OpenTTD, built with WebGL (three.js) and TypeScript. It runs fully offline in the browser: no server and no network access.

You connect procedurally generated towns with railways and bus lines. Passengers choose destinations across your network, transfer between lines, and pay by distance and speed. Good service makes towns grow.

## Running

```bash
npm install
npm run dev        # development server at http://localhost:5173
npm run build      # production build
```

`npm run build` writes `dist/railfever.html`. This is one self-contained file with all code and styles inlined. Open it directly from disk; it works offline. Saves are stored in the browser's local storage, and you can also export and import them as files.

URL parameters for quick starts: `?seed=123&size=192&year=1980&nointro`.

## Features

**World**
- Procedural terrain with hills, mountains, lakes and coasts, plus forests and snowy peaks.
- Towns with street grids. They grow over time from cottages to apartments, offices, towers and churches, and grow faster when served.
- Ambient town traffic. At night, building windows light up, street lamps come on and vehicles show headlights.
- Rendering: sky, sun shadows, ambient occlusion, drifting cloud shadows, animated water with shore foam, and an optional day/night cycle.

**Rail**
- Drag to build track. The A* planner grades terrain automatically and adds **bridges** over water or valleys and **tunnels** through hills. Diagonal runs are smoothed into straight diagonal track.
- Junctions, crossings, level crossings with roads, and buffer stops.
- Multi-platform stations with platforms, canopies and a station hall. Depots.
- **Path signals**, two-way or one-way. Trains reserve their path block by block, pick free platforms, and reverse at terminus stations.
- A train consist builder with locomotives and coaches that change by era: steam, diesel, intercity and high speed.

**Road**
- Road building with the same planner, including road bridges and tunnels.
- Drive-through bus stops, bus depots, and buses with lane following, queueing and level-crossing safety.

**Passengers and economy**
- Stations have catchment areas, ratings and waiting passengers grouped by destination.
- Lines are ordered stop lists. Open a line to see its route drawn on the map. Routing across the whole network includes **transfers**: a bus stop next to a train station joins it.
- Vehicles can be cloned, or upgraded when newer models arrive. A vehicle that can't reach its stop is reported in the news.
- Fares depend on distance and speed. The economy covers running costs, maintenance, a loan with interest, and a finance report with charts.

**Interface**
- Toolbar with hotkeys, live build previews with costs, and a minimap.
- Windows for stations, towns, vehicles, lines, finances and news.
- Save and load (local slots, autosave, file export/import). Settings for shadows, ambient occlusion, day/night cycle and resolution.

## Controls

| Action | Input |
| --- | --- |
| Pan | Right-drag, WASD or arrow keys |
| Rotate / tilt | Middle-drag, Shift/Alt + drag, Q/E, R/F |
| Zoom | Mouse wheel (zooms toward the cursor) |
| Tools | 1 inspect, 2 rail, 3 station, 4 signal, 5 train depot, 6 road, 7 bus stop, 8 bus depot, 9 demolish, 0 terraform |
| Windows | L lines, V vehicles, T towns, F1 help |
| Other | Space pause, R rotate station/depot, G grid, M minimap, Esc cancel/close |

## Quick start

1. Place a **train station** (3) near each of two towns.
2. Drag **rail** (2) from a platform end of one station to a platform end of the other.
3. Place a **train depot** (5) next to a track end, or drag track out from the depot.
4. Open **Lines** (L), create a rail line, click both stations on the map, then click **Add train**.

Several trains on one track need signals. On single track, use passing loops with **one-way** signals on the loop tracks.

## Project layout

```
src/game/    simulation: world, terrain gen, towns, construction planner, stations,
             lines & routing, trains (reservation/signalling), road vehicles, economy, saves
src/render/  three.js renderer: terrain & water shaders, chunked static geometry,
             procedural buildings/vehicles/trees, overlays, labels, camera
src/ui/      HUD, tools, windows, minimap
scripts/     build inliner and headless simulation tests (smoke, fuzz, signals, tunnels)
```

The headless tests run in Node:

```bash
npx esbuild scripts/fuzz.ts --bundle --platform=node --format=esm --outfile=/tmp/fuzz.mjs && node /tmp/fuzz.mjs 1
```
