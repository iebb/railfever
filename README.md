# Railfever

A transport tycoon game in the spirit of Transport Fever and OpenTTD, built with WebGL (three.js) and TypeScript. It runs fully offline in the browser: no server and no network access.

**Play it in your browser: https://iebb.github.io/railfever/** (or download `railfever.html` from there and open it from disk).

You connect procedurally generated towns with railways, trams and bus lines on a continuous, realistic-scale world (1 unit = 10 m). Tracks and roads are free-form curves, not tiles. Passengers choose destinations across your network, transfer between lines, and pay by distance and journey time. Good service makes towns grow. Rival AI companies build their own networks.

## Running

```bash
npm install
npm run dev        # development server at http://localhost:5173
npm run build      # production build
```

`npm run build` writes `dist/railfever.html`. This is one self-contained file with all code, styles and fonts inlined. Open it directly from disk; it works offline. Saves are stored in the browser's IndexedDB, and you can also export and import them as files.

URL parameters for quick starts: `?seed=123&size=512&towns=12&terrain=hilly&water=medium&year=1980&ai=2&nointro`.

## Features

**World**

- Continuous terrain at real scale (maps of 5.1–15.4 km) with hills, mountains, lakes and coasts, forests and snowy peaks.
- Fewer, larger towns with terrain-aligned street layouts, plazas, parks and suburban fringes. Buildings densify from cottages to towers, and good service speeds growth. Streets can cross railways using level crossings or grade separation.
- Country roads connect all towns from the start (a spanning tree plus shortcuts), routed over the terrain with viaducts, river bridges and the occasional tunnel.
- Town traffic with junction priority, queueing and level-crossing safety.
- Rendering: procedural grass, soil and rock textures, detailed trees, anti-aliasing, cascaded sun shadows, ambient occlusion, cloud shadows, sky, animated water with shore foam and moonlit nights. Distance LOD and dynamic resolution limit rendering costs.

**Rail**

- Free-form track building: click to start, click to build, and keep clicking to chain smooth curves. The planner fits Bezier curves to radius and gradient limits, grades cuttings and embankments, and adds **bridges** (girder, truss or arch), covered **tunnels** with portals sized for parallel tracks, and retaining walls.
- **Parallel tracks**: build 1–4 tracks at once, or upgrade single track later. Hold Shift over a track to copy it as a parallel track.
- **Height offset** (PgUp/PgDn or `[` `]`) and crossing preference (auto, **overpass**, **underpass**, level) for grade-separated junctions.
- Standard and electric track (160 km/h), metro (100 km/h), light rail (80 km/h) and high-speed track (up to 400 km/h). All except standard are electrified; existing standard and platform tracks can be electrified. Metro and light rail are construction styles of one rail mode: every train runs on every track type (electric traction under the wire), and one rail line may mix main-line, metro and light-rail track and stations.
- Ground, elevated and underground lines and stations, with height/depth controls, street entrances and closely spaced urban stops. Re-level existing track and stations together, with connecting ramps.
- Switches anywhere along a track, diamond crossings, level crossings with animated barriers and buffer stops. **Connect tracks** builds signalled junctions; directional double track gets crossovers immediately outside both station ends.
- Free-placed stations of any length and orientation, with up to **8 platform tracks**, 1–2 optional through tracks, canopies and platform access. Expansion connects new platforms with automatic throat ladders. Stations can also be inserted into existing lines; depots attach to track ends.
- Station building styles: no building, halt shelters, classic, brick, modern, concourse and terminal. Buildings are optional at every level and add 20–30% to the catchment radius; no building and halt shelters add none.
- Station capacity panels show platform occupancy, waiting trains and expansion recommendations. Nearby stations can merge into one station or form a walking-transfer complex.
- **Path and block signals**, manual or automatic. Trains reserve their path, pick free platforms, and reverse at terminus stations.
- Physics: power, adhesion, mass and gradient decide acceleration; curves set speed limits; aerodynamic drag, realistic braking and braking-distance reservations govern high-speed running.
- Train models cover steam and diesel locomotives, coaches, metro and commuter EMUs, articulated light rail and high-speed sets by era. Multiple units are bought as whole sets and require compatible, electrified track.
- **Through services** between operators on compatible networks, including metro and electric suburban rail. Shared lines let partners contribute vehicles and pay infrastructure usage fees; each operator must own a station on the line.

**Road**

- Curved streets and country roads with automatic junctions, bridges and tunnels. Ground surfaces, junctions, sidewalks and markings drape over the terrain.
- Shared bus and tram stops, connected depots and lane-following buses. Stops can be co-located or merged to share upkeep.
- Tram tracks in town streets, tram depots and era-based articulated trams.

**AI competitors**

- Up to seven AI companies (choose them in the new-game dialog or add them later). They build intercity railways, bus and tram networks and country roads, and manage money, loans and fleets.
- Urban networks include underground metros, elevated/light-rail lines and cross-city links, with through services where compatible.
- Network building includes station growth, pairing single tracks, signalled junctions, interchange and infill stations, consolidation of nearby termini, and decommissioning unprofitable routes. Construction can include building demolition and terraforming.
- Congestion response adds signals, passing loops, double track or platforms. Companies join shared lines instead of duplicating routes.
- Companies with open track access link their networks: new lines share a neighbour's station, and where two companies' railways run side by side a connecting curve (with passing loops on single track) carries direct trains across both when the riders pay for it, the owner earning access fees and invited to run trains too; otherwise a walking transfer links their stations. AI companies never alter the player's track.
- AI construction can be switched off in the Companies window or the settings; their vehicles keep running.

**Passengers and economy**

- **Walking catchments**: passengers reach stations and stops by walking along streets from forecourts and entrances: up to 294 m for every rail station (whatever its track type), 270 m for trams and 196 m for buses, more with a station building. Residents beyond 147 m walk less often and count partly. Reachable streets are drawn in each mode’s colour; overlapping catchments share demand. Stations have ratings and waiting passengers grouped by destination.
- **One route is one line**: routes of the same mode contained in a longer route become service patterns of that line. Lines can share tracks and stations, with **transfers** for local and long-distance journeys.
- Local, Rapid, Express and Limited Express patterns can skip stops or short-turn at their first and last stopping stations. Non-stopping trains use through tracks where available; passengers board only services that stop where they need to alight.
- Fares depend on distance and journey time, including waiting, riding and transfer walks, compared with walking or driving. One rail fare for every track type, with a minimum per journey so short city hops pay too. **Each change of vehicle takes 10%** off the fare of the leg ending in it and of every later leg: a journey with one change earns 10% less than the same journey made directly, with two changes 10-19% less, so direct services earn more.
- Operating costs cover energy, crew, vehicle maintenance and track wear; high-speed services cost more to run. The economy includes loans with interest and finance reports with cost breakdowns and charts.

**Sound**

- Procedural sound effects (WebAudio, no audio files): interface sounds, construction, demolition, cash chimes, positional trains (steam chuffs, diesel rumble, era-specific electric motor hum and whine, high-speed wind roar, rail-joint clatter, horns and whistles), tram traction, level-crossing bells, station chimes, and camera-following ambience (birds, wind, town hum, surf, crickets at night). Volume sliders per group and a mute button in the top bar.

**Interface**

- Interface set in Inter and Barlow Condensed, with a getting-started checklist, hover cards, rising income text, a top bar with company and date, a tool dock, live construction previews, and windows for stations, towns, vehicles, lines, finances, companies and news.
- JR-style line symbols, unique line colours and station numbering such as `AS01`, continued across operators on through services. The lines map switches between Lines and numbered Stations displays, with transport-mode and company filters.
- Title screen and new-game setup, minimap with layers, settings for shadows, ambient occlusion, resolution, day/night, transparency and the F3 performance overlay.

## Controls

| Action | Input |
| --- | --- |
| Pan | Right-drag, WASD or arrow keys |
| Rotate / tilt | Middle-drag, Alt + left-drag, Shift/Alt + right-drag, Q/E, R/F |
| Zoom | Mouse wheel (towards the cursor), Ctrl + wheel / trackpad pinch, `+` / `-` |
| Tools | 1 inspect, 2 track, 3 station, 4 signal, 5 train depot, 6 road, 7 bus stop, 8 bus depot, 9 demolish, 0 terraform |
| Network tools | U urban rail, J connect tracks |
| While building | Click to build and continue or drag one section, Esc or right-click to end, PgUp/PgDn or `[` `]` height (5 m steps), Shift over a track to copy it in parallel, R / Shift+R or Alt + wheel to rotate stations and depots |
| Windows | L lines, V vehicles, T towns, C companies, K track access, N news, F1 help |
| Map views | M lines map, H collapse minimap, B toggle Lines / Stations display (opens Stations when closed), P demand, O catchment |
| Other | Space pause, G grid, F3 performance overlay, Esc cancel/close |
| Touch | Two fingers pan, pinch and rotate; long press ends construction |

Space / Enter activates a keyboard-focused button or control. Global shortcuts are ignored while editing text or using form controls; Esc still cancels or closes.

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
             lines & routing, service patterns, trains, road vehicles, network AI,
             fares & operating costs, IndexedDB saves
src/render/  three.js renderer: terrain textures & LOD, water, batched static world (track, draped roads,
             bridges, portals, stations, buildings, trees), vehicles, overlays, labels, camera
src/ui/      HUD, tool dock, tools, windows, title screen, minimap, fonts, icons
scripts/     build inliner, headless simulation tests and shared test helpers
```

The headless tests run in Node:

```bash
npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
```

Headless scripts in `scripts/` (names below omit `.ts`; use the same build/run command):

- General: `smoke`, `save` (exact save/load round trip), `fuzz [seed] [steps]`, `perf` (512-map stress test), `scale`, `physics`, `trackcost`.
- Rail and stations: `signals`, `autosignal`, `double`, `stations`, `throughtracks`, `bigstations`, `levels`, `urban`, `netrules`.
- AI and shared networks: `ai [seed] [years] [size] [ais]`, `networks`, `ainet`, `aiops`, `companies`, `access`, `shared`, `through`.
- Terrain and towns: `towns`, `townfit`, `terrain-fit`, `tunnel`, `tunnel2`, `cover`.
- Economy and trams: `economy`, `economy-ops`, `tram`.

Shared helpers: `lib.ts`, `stationlib.ts`, `terrainfit.ts`, `townstats.ts`.
