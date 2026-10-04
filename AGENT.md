# Railfever agent instructions

These instructions consolidate the existing Claude project memories and the Railfever handoff. No project CLAUDE.md was present when this file was created.

## Product and architecture

Railfever is a Transport Fever / OpenTTD style transport game built with TypeScript, three.js and Vite. Priorities are rail, road and passenger transport, with realistic construction, operations and economics. One world unit is 10 metres.

- Preserve the standalone offline build: `npm run build` produces `dist/railfever.html` with scripts, styles and assets inlined. Do not add CDN or runtime network dependencies.
- Simulation uses fixed steps and must continue exactly after saving and loading. Persist every decision-affecting planner phase, cooldown, observation and departure clock. Treat caches as disposable derived data.
- UI getters and opening windows must not alter simulation state.
- Track is one physical rail type; overhead wires are an attribute. Metro, light rail and main line are station styles. Preserve styles and platform metadata per station part when merging interchanges.
- In-city metro and light-rail stations have half walking reach. Underground subways avoid surface demolition; growing lines can extend and gain intermediate stops.
- Station construction on existing rail must support other companies' tracks while preserving ownership and access rights. Curved stations must use the actual track and platform geometry in construction, clearance, rendering, routing and saves.

## AI and UI

- Guide AI behaviour through costs, revenues, forecasts, financing and opportunity search. Do not force lines, set city-line quotas or add style-dependent trip bonuses.
- Prefer extendable rail trunks and branches serving town centres, including elevated or underground sections when their additional revenue pays for them. Compare extensions and reuse of existing corridors before opening a separate point-to-point line.
- Forecasts must use the same fares and transfer rules as actual operations. Passenger legs apply a 0.9 factor for each prior vehicle change and for a change at that leg’s end; later changes do not retroactively discount earlier legs. Mail applies 0.9 per change to the whole journey. Preserve the capped distance-fare history used for the rail minimum.
- Prefer capacity works when their recovered surplus pays for construction and upkeep. Shared services must consider all operators' traffic and delays.
- Assign suitable platforms when creating routes and coordinate services sharing a station to reduce interference. Assignments must remain valid after line and station edits without bypassing reservations or train clearance.
- Keep UI copy terse: labels, useful numbers and short functional tooltips. Preserve feature meaning when resolving conflicts with trimmed strings.

## Working together

- Work on an isolated feature branch/worktree. Keep the main checkout and unfinished work from other runs intact. Never delete repository files or overwrite another active run's edits.
- The coordinator reviews changes, commits completed work and pushes it. Delegated implementation and validation agents use read-only git commands and do not commit, merge, push or release.
- Parallel work is welcome on separate worktrees with clear ownership; limit concurrent workers to three. Stagger heavy test batteries to keep timing measurements meaningful.
- Inspect active worktrees and coordination notes before integrations. Hold the relevant shared-resource lock before changing integration, preview, main or shared validation checkouts.
- Keep temporary briefs, logs, machine-specific paths and local handoffs out of the public repository.

## Verification and release

- Run `npm run typecheck`, `npm run build` and checks appropriate to the change. Headless scripts are bundled with esbuild and executed with Node from a scratch directory; many require a matching `<name>.mjs` filename.
- Before release, run the full headless battery, including smoke seeds 7/11/23, save and replay, rail/network/access, urban/growth, economic and mail checks, plus new feature checks. Do not weaken behavioural assertions to hide failures.
- Rerun a timing-only AI failure once. If machine load invalidates timing measurements, report that explicitly; functional and replay failures remain blockers.
- As soon as a commit builds, push it to `preview` before the feature gate. GitHub Pages serves it at https://iebb.github.io/railfever/preview/.
- When build and the full gate pass, the coordinator may merge into main and deploy without another confirmation. Verify the Pages deployment.
- For a versioned release, update `src/game/version.ts`, `package.json` and the lockfile version, publish the matching tag and GitHub release with the offline HTML, then synchronize the development branch.
- Browser checks must keep game audio muted before interaction and close test tabs afterwards. Check startup and rendering errors for rendering changes.
