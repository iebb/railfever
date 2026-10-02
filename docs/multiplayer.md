# Real multiplayer for Railfever

Developer proposal, audited on `v2.4-urban-rail`, 2026-10-03. This proposal and `scripts/determinism.ts` change no game code. Numbers labelled estimates are planning assumptions; the probe results below are measured locally.

## Recommendation and scope

Build a **WebRTC host-and-peers room with a hybrid simulation protocol**: every participant runs the full, fixed-step simulation; the host assigns the order and execution tick of validated commands; state hashes check agreement; the host supplies authoritative compressed snapshots for joining and recovery. Here “hybrid” means command replay in normal play plus authoritative recovery, not continuously mixing peer simulation with arbitrary vehicle corrections. Start with two-player co-op. Ship competitive companies after the command and company-context refactor.

This fits the existing headless `Game`, seeded world generation, company ownership, track access, shared lines and save format. Commands stay small even when maps and fleets grow. It also lets a player host directly from GitHub Pages or the single-file build. **The current simulation is not ready for cross-browser lockstep:** identical steps matched in this probe, but frame-sized steps did not; previews mutate state; save loading does not continue an interrupted AI project exactly. Fix those before enabling multiplayer, rather than treating frequent resync as normal operation.

The first product target is 2–4 humans, up to eight active companies including optional AIs, maps up to 768 units and roughly 1,000 owned vehicles as a performance test target, not a verified capacity. Expand these limits after measurement. A room lives while a host browser is connected and able to run it. There is no persistent world running after everybody closes the game, no public ranked competition, and no centrally protected secret state in this design.

### Modes and membership

| Mode / event | Behaviour |
| --- | --- |
| Co-op | Multiple player identities control one company, sharing its cash, assets and lines. Company administrator assigns builder, operator, finance and observer permissions. Simultaneous spending is resolved in host command order. |
| Competitive | Each player controls a distinct human company; additional companies may be AIs. Infrastructure, vehicles, finances, shares and access agreements belong to company IDs, not browser identities. Optional co-op partners can later join a competitive player's company. |
| Drop-in | Join the lobby as an observer, verify the build/protocol, receive a snapshot and command tail, then claim an available company or join a company with permission. Claiming control is a replicated membership operation. |
| Drop-out | Assets and services keep operating. Reserve that person's company and permissions for reconnect; do not instantly sell it or silently make it an AI. The lobby may explicitly choose AI takeover after a grace period, recorded at a tick boundary. In co-op, other members continue. |
| Save/resume | Export a game snapshot plus multiplayer metadata. Any authorised player can retain a copy; a chosen player hosts the resumed room, identities reclaim company seats using locally retained credentials or host approval. New connection invitations and a new room epoch are generated. |
| Host leaves | Graceful handover pauses at an agreed checkpoint and establishes connections to a successor. For the first release, an abrupt host loss pauses the session and offers “host the last shared save”; automatic crash election is a later feature. Never allow two successors to continue the same room epoch. |

Add `PlayerIdentity`, `RoomMember` and `CompanyController` separately from `Company.ai`. `Game.create` currently makes one human company; `addAICompany` is the only additional-company creation API (`src/game/game.ts:169`, `src/game/game.ts:209`). Add a human-company API and controller assignment without starting and disposing an AI as a workaround. Preserve IDs when seats are unoccupied or companies are acquired.

Competitive takeovers need a room rule: default to requiring the affected human company's consent for merger/control changes. A defeated player can spectate or join the acquiring company by invitation. Existing AI acquisitions and subsidiary operations alone are not a human membership policy.

## Architecture options

| Dimension | (a) Deterministic lockstep | (b) Host-authoritative snapshots + deltas | (c) Recommended hybrid |
| --- | --- | --- | --- |
| Simulation | Every peer advances the same simulation from the same ordered commands. | Only host decides physics, passengers, growth and AI; clients maintain display replicas. | All peers simulate; host sequences commands and provides authoritative checkpoints/recovery. |
| Bandwidth | Commands and tick seals, mostly independent of map/fleet size; map/save transfer on join. | Initial full map, then entity/terrain/network changes. Moving-vehicle traffic grows with fleet size. Full saves every frame are impractical. | Command-scale steady traffic; occasional full snapshots. Large maps affect join/resync cost and local CPU, not every normal packet. |
| Latency / speeds | Input buffering; slowest peer can stall strict lockstep. All peers must have each tick's sealed command batch. At 8×, CPU demand and ticks of input delay rise eightfold. | Host can keep running despite a slow client. Display interpolation hides network jitter; construction still waits for an authoritative result. At 8×, a 100 ms display buffer represents 0.8 simulation seconds. | Same input delay as command replay; bounded lag can be caught up or resynced. Lagging participants need not permanently block the room, but may not edit stale state. |
| Cheating | Honest peers can reject impossible commands/desyncs. All peers see the whole world; modified clients can inspect it, lie about hashes or withhold traffic. | Host rejects client cheats, but the hosting player can cheat. A trusted dedicated server would be needed for ranked play. | All honest peers validate commands and compare state. The host's sequencing and snapshot authority still require trust; hash agreement is diagnosis, not proof of fair play. |
| Complexity | Small transport layer; substantial determinism, command extraction and exact snapshot work. | Less cross-engine determinism work, but needs a new replication model, deltas/tombstones, revisions, interpolation and separation of renderer reads from running `Game`. | Lockstep's determinism work plus snapshot/recovery and log handling. Avoids maintaining continuous deltas for every simulation subsystem. |
| Fit here | Strong headless fit; unsafe with current frame timing/previews/load behaviour. | Good fallback if engine determinism proves too costly. Existing saves bootstrap it, but `deserialize` runs repairs/AI cleanup and is not a faithful display replica loader today. | Best long-term fit if the determinism gates pass; reuses command APIs and the world/save model, with explicitly required engine changes. |

**Decision gate:** prototype command replay and snapshot continuation across Chromium, Firefox and Safari before committing to option (c). If exact continuation and cross-engine math cannot be made reliable within the core phase, choose (b), run AI only on the host, and build an explicit replica loader/delta protocol. Budget another 4–6 weeks for that fallback; do not continually overwrite a running divergent simulation with partial patches. It is a product tradeoff, not a configuration flag that solves determinism.

### Bandwidth and map/fleet scale

Terrain alone is `5 * (size + 1)^2` bytes: float32 heights plus byte locks (`src/game/world.ts:47`). Before save base64 encoding, trees, buildings, network profiles, stations, demand or vehicles:

| Map preset (`src/ui/title.ts:27`) | Heights + locks, raw |
| --- | ---: |
| 512 | 1.25 MiB |
| 768 | 2.82 MiB |
| 1024 | 5.01 MiB |
| 1536 | 11.26 MiB |

The probe's **384-unit** populated fixture produced **2,110,266 JSON bytes / 874,269 gzip bytes**. This is one seed and one early game, not a prediction of XL saves. Do not regenerate a joiner's world from just its seed: generation also uses engine-dependent geometry math and subsequent construction/growth changed the world. Transfer the authoritative map/save. Measure mature 768/1536 worlds and loading peaks; JSON/base64 plus both old and new worlds can temporarily multiply memory usage.

For option (b), an illustrative compact **32-byte vehicle pose at 10 updates per wall second** is 32 kB/s for 100 vehicles, 320 kB/s for 1,000, and 3.2 MB/s for 10,000, **per recipient**, before transport overhead, cargo, accounts, routes or other state. The host's upload multiplies by its connected guests. Include ambient traffic: it participates in road occupancy (`src/game/vehicles.ts:293`), and the manager allows up to 320 (`src/game/vehicles.ts:323`). Terrain patches, edge profiles and growing towns add bursts. Deltas should send graph changes immediately and interpolate poses at a fixed wall-clock send rate; sending at every simulation tick would multiply traffic at 8×.

For (a)/(c), estimate 150–600 bytes for a normal JSON command, often 1–10 human commands/s in a room: around 0.15–6 kB/s plus seals, hashes and chat, per guest. Long edge chains, signalling batches and terraforming are larger. AI runs identically on every peer and does not broadcast each decision in this variant. Batch tick seals at a wall-clock rate such as 20 Hz, including the complete execution horizon, rather than sending 160 empty packets/s at 8×. These are packet-budget estimates, not measured WebRTC traffic.

### Tick protocol and responsiveness

Expose a headless `stepTick()` which always advances **0.05 simulation seconds**. The existing constant is a maximum substep, not this invariant. Maintain an integer tick counter: 40 ticks/day with `DAY_SECONDS = 2` (`src/game/constants.ts:5`). Day changes, monthly work, AI work allowances and catchment invalidation are based on those ticks, never floating calendar threshold accumulation or renderer frames.

Speed 1×/2×/4×/8× changes how quickly the host releases ticks: 20/40/80/160 ticks per wall second. It never changes the physics step. A renderer interpolates between committed poses. Put simulation in a bundled worker when feasible; keep `RTCPeerConnection` in its supported window context and bridge messages to the worker. The offline build can inline worker source into a Blob. Worker use does not guarantee execution in a suspended/background browser: detect missed heartbeats, lower speed or pause; do not skip simulation ticks to keep up with rendering.

Start with a 150–250 ms command lead time, adjusted from RTT/jitter. At 200 ms that is 4 ticks at 1×, 32 at 8×; equivalent to 0.1 and 0.8 game days respectively. This delay is tolerable for tycoon construction with immediate local ghosts and a “pending” result. A busy station or edge can change before execution, so rejected stale/busy plans remain visible for retry. This is not a twitch driving game. Keep expensive planning off the rendering path and bound command cost.

Guests submit intents; the host emits an ordered batch and an explicit `advanceThroughTick`, including empty ticks. Execute commands before that tick's simulation work in `hostSeq` order. A peer never advances beyond a sealed horizon or predicts irreversible construction. Acks report the processed sequence/tick. Bound the tail log; a slow guest catches up without rendering, temporarily loses edit permission, and receives a snapshot if too far behind. A disconnected peer's company keeps operating under the recorded room policy. Strict lockstep could instead wait for everyone, but that makes a sleeping laptop stop every player.

Pause/resume and membership use an ordered control revision as well as a tick: commands that resume a paused game must be processed even though simulation ticks have stopped. Record speed changes at a defined tick boundary and clear the scheduler's wall-time accumulator when resuming. Wall time may drive networking deadlines and UI; it must not select simulation outcomes.

## Transport with no game server

Use a **star topology**: one `RTCPeerConnection` from each guest to the browser host. This is peer-to-peer transport even though the hosting browser is the simulation coordinator. Four players need three connections, not six; eight need seven, not 28. The host forwards accepted commands/chat. Full mesh adds signalling, duplicate traffic and election complexity without removing simulation trust requirements.

Use separate reliable ordered data channels for `commands-control`, `snapshots` with small chunks/backpressure, and `chat`. Optional cursor presence uses another unordered channel with `maxRetransmits: 0`; reliability is configured per channel. Never drop simulation commands. Data-channel support, reliability modes and offer/answer negotiation are standard browser APIs. [W3C WebRTC specification](https://www.w3.org/TR/webrtc/#rtcdatachannel).

### Manual signalling and QR

The browser needs signalling to exchange SDP descriptions and ICE candidates; WebRTC does not supply a lobby/discovery service. [WebRTC peer connection guide](https://webrtc.org/getting-started/peer-connections).

1. Host creates a connection/data channels for **one** joining peer, creates its offer and sets the local description. Wait until ICE gathering is complete. Export a versioned token containing the final `localDescription`, room ID, invitation nonce, build ID and expiry.
2. Joiner pastes/imports/scans it, sets the remote description, creates an answer, sets its local description and also waits for gathering to finish. Export the final answer token.
3. Host pastes/imports/scans the answer into that connection. On opening the channel, exchange protocol/build IDs, identity, seat request and snapshot metadata. Generate another offer for each additional guest.
4. For a network change/ICE restart, exchange a new offer/answer; old copied tokens do not provide an ongoing signalling path.

Copying the offer before candidates are gathered is a common failure. Manual mode uses non-trickle ICE so the exchange is two complete tokens; relay mode can trickle candidates. Keep text import/export as the primary route. Compressed SDP may fit a QR; larger offers need segmented QR frames or a small token file, not a promise that every SDP fits one code. Camera scanning is optional and requires its own permission; pasted text/image/file works without camera access. Invitations can carry non-secret identifiers in a URL fragment; never put SDP or reconnect secrets in query parameters/logs.

### STUN, TURN and the meaning of “no server”

Manual signalling removes the **signalling/game server**, not every networking dependency. With `iceServers: []`, reachable LAN peers may connect using host candidates, subject to browser address/privacy policy. Internet NAT traversal normally uses a STUN service; some NAT/firewall combinations still require a **TURN relay**. TURN relays encrypted packets, and is separate from a signalling worker. ICE alone cannot guarantee direct connectivity. [IETF TURN protocol](https://www.rfc-editor.org/rfc/rfc8656.html).

Provide explicit modes: LAN with no external services; direct internet with configured STUN; and “allow relay” with TURN, including TCP/TLS endpoints for networks blocking UDP. Show connection type and a clear failure explanation if TURN is unavailable. A STUN-only room must be advertised as best effort. The file can play without internet on a LAN, but internet multiplayer still needs connectivity even though the application's assets are offline.

Never embed a long-lived TURN/API secret in the static HTML. Optional credential issuance belongs in the relay worker with expiry, quotas and invitation checks. A service-free/manual mode accepts the user's own temporary TURN credentials. Reconnect/resume creates new credentials and ICE sessions; saves contain no live SDP or TURN passwords.

### Optional tiny signalling relay

Offer an opt-in HTTPS/WSS worker with an ephemeral room object, for example a Cloudflare Worker + SQLite-backed Durable Object using WebSocket hibernation. Responsibilities: random invitation IDs, short-lived room membership, SDP/candidate forwarding, rate/message limits and optional TURN credential issuance. **It never receives simulation snapshots, commands or chat after the peer channels open.** Keep state for minutes during joining/reconnection; close signalling sockets when no longer needed or keep a lightweight reconnect subscription. Do not use process-local worker memory or eventually consistent KV as a reliable live room coordinator.

Budget for light usage: potentially $0 on the free allowances, or approximately $5/month base on Workers Paid plus requests, CPU, Durable Object duration/storage and TURN usage. Durable Objects currently include 100,000 requests/day and 13,000 GB-seconds/day on Free; paid usage has separate allowances. Hibernation avoids idle socket duration charges. These are provider limits/prices checked 2026-10-03, not a fixed operating-cost guarantee. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

As one optional TURN service, Cloudflare currently lists $0.05/GB egress with the first 1,000 GB/month shared between SFU and TURN free. For illustration, 320 kB/s to three guests for an hour is about 3.46 GB of outgoing payload, roughly $0.17 if billable at that rate, before protocol traffic and joins; direct peers incur no TURN egress. Billing depends on the selected service and how connections are relayed. [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/).

Privacy: direct connections disclose network addresses to peers; the signalling operator sees source IPs, room membership and SDP/candidates unless signalling payloads are separately encrypted. STUN/TURN operators see endpoints and traffic metadata. Data channels use DTLS, including when relayed, but encryption does not make an untrusted lobby trustworthy: bind invitations to peer fingerprints/identity and optionally compare a short verification code through the invitation channel. A relay-only ICE policy can hide direct peer addresses at a bandwidth cost. Keep names/SDP out of persistent logs and explain the relay choice in the lobby. [WebRTC IP-address considerations](https://www.w3.org/TR/webrtc/#revealing-ip-addresses), [data-channel encryption](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels#security).

### GitHub Pages and the offline file

GitHub Pages only delivers HTTPS static assets; browser peers establish their own connections and may call the optional relay. No WebSocket endpoint or TURN service can be implemented just by adding a file to Pages. CORS applies to relay HTTP requests; WSS has an Origin header the relay should validate. Keep room access based on a random capability, not Origin alone.

The inline HTML must contain the same networking code, command schema, worker/math assets and compression/QR libraries as the hosted build. It can use manual tokens without fetching scripts. `file:` URLs are generally potentially trustworthy, but browsers may apply stricter policy; feature-detect and test `RTCPeerConnection`, Blob workers, compression and optional clipboard/camera separately. Clipboard denial should leave an ordinary selectable text box; file-origin relay HTTP may send Origin `null`, so support it with scoped invitation credentials rather than an unconditional public proxy. IndexedDB/localStorage behaviour also needs file-browser testing; exported saves are the portable fallback. The specification does not guarantee that every browser exposes every capability to local files. [W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy).

### Framing and compatibility

Include protocol version, exact simulation build/content hash, save-schema version and deterministic-math version in the handshake. Refuse mixed simulation builds; identical seed plus different vehicle constants is not compatibility. Channel packets carry room epoch, message kind, monotonic sequence and bounded length. Authenticate the sender by the connection's registered identity; the message's claimed company/player ID is not authority.

Snapshots are gzip binary, not base64 strings on the wire. Start with 16 KiB chunks, respecting negotiated `pc.sctp.maxMessageSize`, with snapshot ID, tick, sequence, byte count, chunk index and final SHA-256. Use `bufferedAmount`/`bufferedAmountLowThreshold` to throttle, prioritise control, and cap compressed/decompressed size before installing a snapshot. Separate channels still share a congestible connection. Larger messages can block other SCTP traffic, and absent negotiation the SDP default is 64 KiB; do not send the entire save in one `send()`. [Data-channel message-size guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels#understanding_message_size_limits).

## Serializable commands: complete UI mutation inventory

Introduce one `submitCommand()` boundary between UI and simulation. Offline mode uses the same dispatcher immediately; multiplayer queues it. Renderers, windows and tools receive read-only simulation views. Local ghosts, selections, camera/follow, sound, filters, graphics/audio settings and tool defaults stay local. The table includes direct object assignments and actions indirectly performed on “Done”, not just obvious game-method calls.

An envelope can be JSON initially:

```ts
type Intent = {
  protocol: number;
  roomEpoch: string;
  clientSeq: number;            // deduplication within this identity/epoch
  companyId: number;           // checked against connection membership
  baseRevision?: number;
  maxSpend?: number;           // reject if the recomputed price exceeds approval
  action: { type: string; args: unknown }; // replace with a versioned tagged union
};
type OrderedCommand = Intent & {
  playerId: string;            // supplied by the registered connection, not trusted input
  hostSeq: number;
  tick: number;
};
```

All active peers run the same validator and dispatcher at execution time. Recompute plans and prices against committed state, then commit through the game API. Do not accept a remote `Proposal`, `StationPlan`, `DepotPlan`, arbitrary vehicle-model object, injected cost, `town: true`, `force: true`, function, `Map`, typed-array object or uncontrolled AI options. Encode models/styles/enums by IDs; coordinates/angles as finite, bounded quantised values; snaps as stable node IDs or edge ID + distance, with revisions. Derive tangents/heights/ownership from the world. IDs created by accepted commands are deterministic and appear in the result; local request IDs allow the UI to open an object after acceptance.

Every row below gets a schema, actor permission check, entity-existence/revision check, finite/range checks and a deterministically computed result. A rejection is a recorded result with no simulation mutation, including no consumed IDs or RNG. Co-op races use execution-time money/ownership; two members cannot both spend the last cash based on an old preview. In the hybrid, the host cannot waive peer validation: a different result is a desync. Cosmetic acknowledgements/news can be shown locally after commit.

### Construction and infrastructure

| Player action and current code | Proposed command payload / validation |
| --- | --- |
| Build single/multiple rail tracks, road/street, tram road, metro/light rail, elevated/underground/bridge/tunnel chains: `tools.ts:1562`, `tools.ts:1813` → `planEdge` / `commitProposal` | `BuildEdge {a,b,kind,type,tracks,heightOffset,crossing,tram,straight,...}`; send each chain segment or a bounded transaction. Include direction/snap options needed by the planner. Builder permission; check owned/usable endpoints, allowed joins to foreign tracks, clearance, structures, busy edges and money. Current commit trusts the already-computed proposal (`src/game/construction.ts:973`); never expose that trust on the wire. |
| Double track / directional finishing: `tools.ts:1051`, `tools.ts:1068`; congestion action `win-ops.ts:156` | `DoubleTrack {edgeIds,side,finish,rightHand}` and `FinishDoubleTrack {edgeIds,rightHand}` → plan/commit/finish. Ordered edge chain, own plain rail, room to build, legal turnouts/signals and money. |
| Connect tracks: `tools.ts:1228` → `planConnection` / `commitConnection` | `ConnectTracks {edgeA,sA,edgeB,sB,dirA?,dirB?,search?}`; ownership/access, join geometry, traffic and total cost. |
| Rebuild height/level: `tools.ts:1287` → `planRelevel` / `commitRelevel` | `Relevel {edgeIds,level,...}`; own infrastructure and any moved station parts, revisions, busy assets, geometry and money. |
| Electrify track: `tools.ts:1118`; compatibility action `win-ops.ts:267` → `electrify` | `Electrify {edgeIds}`; owner, convertible types, exact selected set and cost. A UI “fix this line” resolves to explicit IDs, not client-computed prices. |
| Add/remove tram tracks on roads: `tools.ts:1743` → `addTramTracks` / `removeTramTracks` | `TramTrack {edgeIds,enabled}`; distinguish road owner from tram-track owner, apply town-road rules, protect other companies' tram tracks, traffic and money. |
| Build/insert/relocate rail station: `tools.ts:1905`, `tools.ts:1337`, `tools.ts:1894` → `commitRail`, `commitStationOnTrack`, `relocateStation` | `BuildStation {x,z,angle,length,tracks,opts}`; `InsertStation {edge,s,opts}`; `RelocateStation {id,...}`. Include track type, style, level/height/depth, through tracks/mode and access/entrance choices. Validate ownership, footprint/earthworks, track capacity, relocation references, trains, access roads and cost. |
| Upgrade/expand/restyle station (platform length/count, through tracks, side, level/style): `win-info.ts:273`, `win-info.ts:394`, `win-ops.ts:196` → `planStationUpgrade` / `commitStationUpgrade` | `UpgradeStation {id,opts}`. Explicit desired values, builder permission, busy-station test, style/year/mode compatibility and recalculated cost. |
| Add bus/tram stops / use shared stop: `tools.ts:1917`, `tools.ts:1930` → `commitBusStop` | `BuildStop {x,z,share}`; road/tram compatibility, catch/join rules, actor access, cost. Tram stop currently calls the bus-stop API after checking for usable tram track. |
| Add/remove entrances: `tools.ts:1986`, `win-info.ts:450` → `addEntrance` / `removeEntrance` | `AddEntrance {stationId,x,z}` / `RemoveEntrance {stationId,partIdOrIndex,revision}`; station owner, level/spacing/road access, protected formation and money. A bare index without revision can remove the wrong entrance after another edit. |
| Link/unlink/merge station complexes: `win-info.ts:352`, `win-info.ts:353`, `win-info.ts:358` → `unlink`, `link`, `mergeStations` | `LinkStations {a,b,linked}` / `MergeStations {a,b}`; existing distance/mode/ownership/line constraints, revisions and any cost. Cross-company access does not confer a right to merge or demolish another company's station. |
| Rename station: direct `s.name = ...` at `win-info.ts:108` | `RenameStation {id,name}`; owner/editor, length limit (currently 40) and validated text. |
| Build/move depot: `tools.ts:1954`, `tools.ts:1945` → `depots.plan/commit`, `relocateDepot` | `BuildDepot {kind,x,z,angle}` / `RelocateDepot {id,x,z,angle}`; actor owns it, matching network, legal exit/footprint, resident vehicles and money. |
| Place/cycle/remove signal, block/path class, direction and pass-from-behind: `tools.ts:1966`, `tools.ts:1975`, `tools.ts:993` → `toggleSignal` / `setSignal` | `SetSignal {edge,s,mode,forward,class,pass}`; encode explicit desired state for a cycle, node/edge revisions, own track, plain-track/busy rules and cost. |
| Signal drag/clear; auto-signal line, chosen edges or whole network: `tools.ts:972`, `tools.ts:977`, `win-signals.ts:38`, `win-signals.ts:68` | `SignalAlong {edge,dir,s0,length,spacing,kind,class,pass}` / `ClearSignalsAlong {...}` / `AutoSignal {lineId? or edgeIds?,rightHand,...}` → `autoSignals`, `clearSignalsAlong`, `autoSignalLine/Network`. Owner-filter the target set, cap work, check cost and recompute rules; previews are not committed signal lists. |
| Demolish one object or rectangle, including station/stop/depot/track/building: `tools.ts:1999` → `bulldoze` | `Bulldoze {rectangle,target?,expectedIds?}`; preserve current partial-success semantics only if the selected ordering/result is identical on all peers. Protect foreign property, resident vehicles, tunnel/formation locks; quote spend/refund before mutation. Explicit targets plus revisions prevent deleting a new asset built inside a stale rectangle. |
| Raise/lower/level terrain while holding brush: `tools.ts:661` → `terraformBrush` | `TerraformStamp {x,z,radius,mode,level}` or bounded ordered stamp list. Each stamp uses the current 0.25 amount (`src/game/build-ops.ts:337`); validate locks, protected infrastructure and money. Log stamps at a controlled input rate; never reconstruct them from a peer's pointer frame rate or local hold duration. |

Paths in these tables without a directory prefix are in `src/ui/`. Planner options should be encoded as explicit schema fields, not an unrestricted spread of `BuildOptions`/`StationOpts` that accidentally exposes internal flags.

### Vehicles, lines, services and sharing

| Player action and current code | Proposed command payload / validation |
| --- | --- |
| Buy locomotive + wagons/EMU consist, bus or tram: `win-info.ts:839` → `vehicles.buyTrain/buyRoad` | `BuyTrain {depotId,modelIds,lineId?,patternId?}` / `BuyRoad {depotId,modelId,lineId?,patternId?}`. Actor owns depot, mode/year/consist compatibility, line-operation rights/reachability and money. Existing purchases infer owner from depot, so independently authenticate the actor. |
| Clone last vehicle: `win-lines.ts:330`; sell vehicle: `win-info.ts:575` | `CloneVehicle {sourceId,depotId,lineId}` / `SellVehicle {id}`. Owner/operator role, explicit source/revision instead of locally choosing “last”, depot and cloned consist validation; refund is recomputed. |
| Upgrade/replace vehicle: `win-info.ts:663` → sell then buy | `ReplaceVehicle {id,depotId,modelIds,lineId?,patternId?}`. Atomic preflight/commit of sale and purchase, including net funding and compatibility. Current UI can sell before finding the purchase rejected; network commands must not leave a half-applied replacement. |
| Assign/unassign line: `win-info.ts:547` → `v.setLine` | `AssignVehicle {id,lineId|null}`. Vehicle owner, matching mode and `lines.operateError`; validate partner rights and reset/reroute consistently. Returning to a depot when unassigned is part of the same result. |
| Create rail/bus/tram line: `win-lines.ts:132` → `lines.create`; delete: `win-lines.ts:306` → `lines.delete` | `CreateLine {kind}` / `DeleteLine {id}`; owner/operator permissions, deterministic IDs/naming, clear vehicles and redirects through the API. |
| Add/reorder/remove stops: direct list edits at `win-lines.ts:160`, `win-lines.ts:251`, `win-lines.ts:253`; map click at `tools.ts:1881` and station-card click at `ui.ts:148` call `addStopToLine` | `EditStops {id,revision,operation}` or `SetStops {id,revision,stationIds}`. Lead-company editor, existing compatible station IDs, foreign access, route/duplicate semantics. Bundle rebuild and `onLineChanged` with the command. Never overwrite a newer list from a stale window. |
| Auto/loop/out-and-back route: `win-lines.ts:261` → `lines.setLoop` | `SetLineLoop {id,mode: auto|loop|back}`; line owner, validate route and replan vehicles. Encode `auto` explicitly rather than relying on JSON's dropped `undefined`. |
| Rename / choose or reset automatic line colour: `win-lines.ts:197`, `win-lines.ts:220` → `gameapi.renameLine/setLineColor` (`gameapi.ts:30`, `gameapi.ts:33`) | `RenameLine {id,name}` / `SetLineColor {id,color|null}`; lead editor, text/colour validation, auto-name/auto-colour flags and invalidations. Shared names/colours are world metadata even if cosmetic. |
| Finish stop editing and automatically fold subset lines into service patterns: `tools.ts:267` → `ui.onLineEdited`; `ui.ts:335` → `canonicalizeLines` | `FinalizeLineEdit {id,revision}` or explicit `CanonicalizeLines {id}`. Lead ownership, cross-owner merge policy and redirect/vehicle updates. Window close/tool change must submit this; UI closure cannot independently mutate the world. |
| Add all-stops/express/short-turn services, edit stopping flags/kind/name, remove service: `win-services.ts:61`, `win-services.ts:91`, `win-services.ts:117`, `win-services.ts:123` | `SetPatterns {lineId,revision,patterns}` / `AddPattern {...}` / `RemovePattern {lineId,patternId}` → `setPatterns/addPattern/removePattern`. Lead editor, valid stable IDs, stop alignment, at least two distinct served stations and valid reassignment on removal. Send the chosen flags, not a UI-dependent “suggest express” result. |
| Assign vehicle's service: `win-services.ts:143`, `win-info.ts:594` → `setVehiclePattern` | `AssignPattern {vehicleId,patternId}`; actor owns vehicle, line contains that pattern and flags are compatible. |
| Shared line policy/invite/join/leave/remove partner: `win-ops.ts:314`, `win-ops.ts:319`, `win-ops.ts:333`, `win-ops.ts:327`, `win-ops.ts:308` | `SetPartnerPolicy`, `InviteOperator`, `JoinLine`, `LeaveLine`, `RemoveOperator`. Lead authorises invitations/removal; actor joins/leaves only its own company. Retain owned-station requirement and track access (`src/game/lines.ts:452`, `src/game/lines.ts:463`); invitations do not imply edit ownership. |
| Decommission (sell own vehicles, leave/delete/transfer shared line): `win-ops.ts:380`–`384` | `DecommissionLine {id,revision}`. Compute the same vehicles and heir from committed state, verify actor rights, then commit the composite action. Partners retain their owned vehicles. |

There is no separate player vehicle rename, manual drive/reverse, timetable slider or depot-send button in these audited windows; reversal/dispatch/depot returns are consequences of the above APIs. Do not invent wire commands for inactive UI features. Any new mutation must enter this boundary.

### Company, finance, access and session actions

| Player action and current code | Proposed command payload / validation |
| --- | --- |
| Borrow/repay: `win-company.ts:46`, `win-company.ts:47` → economy methods | `Borrow` / `Repay {steps:1}`; finance permission, current loan step, limit, cash and interest rules of the actor's economy. |
| Buy/sell 10% shares: `win-company.ts:305` → `shares.invest/divest` | `Invest {target}` / `Divest {target}`; active companies, self/subsidiary/share rules, owned/free float, deterministic execution-time quote and funds. `maxSpend` protects against a stale quote. |
| Merge acquired company / keep subsidiary: `win-company.ts:342`, `win-company.ts:350` | `MergeCompany {target}` / `KeepSubsidiary {target}`; finance/admin role, 100% share requirements, human-control room rule, transfer assets/access/operators and update player seats atomically. |
| Enable/disable AI construction: `win-company.ts:153`; add AI: `win-company.ts:271` → `gameapi.addAI` (`gameapi.ts:56`) | Room-admin `SetAIEnabled {enabled}` / `AddAICompany {config,name,color}`. Respect slot count, bounded normalised config, agreed starting cash and deterministic creation. Vehicles keep running when construction is disabled. |
| Apply AI settings/preset, including activeness/risk/mode focus/access policy/rate: `win-company.ts:268` → `gameapi.applyAIConfig` (`gameapi.ts:50`) and access setters | Room-admin `ConfigureAI {id,config}`. Normalise identically, apply policy/rate invalidation in the same transaction. Current edit form's name/colour are creation fields, not an existing-company rename operation. |
| Ask/withdraw/approve/reject access: `win-access.ts:32`, `win-access.ts:76`, `win-access.ts:113`, `win-access.ts:114` | `RequestAccess {owner}`, `CancelAccessRequest {owner}`, `AnswerAccessRequest {requestId,approved}`. Requesting actor is the user; only owner admin answers. Validate request identity/expiry/active companies and preserve AI/open-policy decisions. |
| Open/ask/auto-approve/auto-reject policy and fee multiplier: `win-access.ts:121`, `win-access.ts:125` | `SetAccessPolicy {policy}` / `SetAccessMultiplier {value}`; owner's admin/finance permission, range 0..3, deterministic network refresh. |
| End agreement, block/unblock another company: `win-access.ts:52`, `win-access.ts:136`, `win-access.ts:138` | `EndAccess {user,owner}`, `BlockCompany {other,blocked}`; one of the agreement parties may end it, only owner blocks users of its own network. Revoke/reroute/meters as existing API does. |
| Pause / 1×–8× speed: `ui.ts:163`, `ui.ts:164`, controls at `hud.ts:179`; title currently sets pause at `title.ts:47` | `VotePause`, `VoteSpeed`; host emits `SetPaused` / `SetSpeed` after the agreed policy. Opening title/settings is local and must not directly pause a network room. Allowed speeds are the explicit set, not arbitrary numbers. |
| New game/load/import while playing: `win-menu.ts:14`, `win-menu.ts:49`, `win-menu.ts:73` | Room-admin `ReplaceWorld {snapshotId}` / `StartGame {options}` behind a lobby/barrier. Guests cannot call `app.setGame` independently while remaining connected. Map options, start year, seed and initial AI settings are agreed once. |
| Save/export/overwrite/delete browser slots: `win-menu.ts:35`, `win-menu.ts:47`, `win-menu.ts:51`, `win-menu.ts:60` | Local storage actions; multiplayer export uses an agreed tick/host snapshot. Renaming/deleting a local save is not a simulation command. Loading it into the room is the replacement operation above. |

`aiAcquisitions` and `vehicles.ambientEnabled` are simulation-affecting game flags (`src/game/game.ts:107`, `src/game/vehicles.ts:34`), though these windows do not currently expose switches. Add validated room-admin settings if exposing them in multiplayer. Graphics, audio, label, resolution, transparency and performance settings in `win-menu.ts:89` are per-client and must not be replicated as game settings.

The dispatch refactor must replace `PLAYER = 0`, `g.player` and `g.economy` assumptions with a local authorised company context (`src/game/game.ts:79`, `src/game/game.ts:239`). Do not remap company 0 differently on different peers. Core trusted APIs are not network validators: e.g. `Game.company(id)` falls back to the town company for an unknown ID (`src/game/game.ts:229`), and several rename/line/access methods have no actor argument. Reject missing/negative company IDs and re-check ownership before invoking them. Track access permits use of another network, not arbitrary alteration of its assets.

## Determinism audit of `src/game`

These are source findings, distinguished from what the one-engine probe actually demonstrated.

### Randomness and wall clocks

| Finding | Consequence / change |
| --- | --- |
| No `Math.random` call found in `src/game`. Integer RNG uses `Math.imul`/bitwise operations at `rng.ts:7`; seed/state exposed at `rng.ts:5`, `rng.ts:17`. | Good foundation. Keep **all simulation randomness seeded**, including new multiplayer features; serialise every stream and consume it only at deterministic points. Network identity nonces use cryptographic randomness outside simulation. |
| Seeded instances: game `game.ts:162`, AI `ai.ts:1092`, town generation `towns.ts:273`, trees `terrain-gen.ts:86`, road vehicles `roadvehicle.ts:259`, ambient manager `vehicles.ts:32`, noise permutation `rng.ts:36`. | Ambient RNG's constant 4242 is deterministic, not unseeded; deriving it from the world seed would give varied worlds but is not required to fix a desync. Save states are already included in `save.ts:152`, `save.ts:183`, `save.ts:123`, `ai.ts:4099`. |
| Initial UI seed uses `Math.random` at `src/ui/title.ts:88`, outside `src/game`. | Host chooses one seed and transmits it; peers never independently choose a new seed. |
| `ai-network.ts:90` wraps `performance.now`/`Date.now`; calls at `ai-network.ts:374`, `ai-network.ts:387`, `ai-network.ts:400`. **Work limit is four units**, `ai-network.ts:113`, loop at `ai-network.ts:386`. | Timing is profiling only in this branch; no wall-clock AI decision budget found. Preserve that property. Exclude timing profiles from hashes/save semantics. |
| AI `ai.ts:1203`–`1205` times/logs slow steps only with profiling enabled; its budget is day-fraction work units (`ai.ts:1199`). `roads.ts:31`, `roads.ts:81` measure generation duration. `save.ts:424`, `save.ts:431` timestamp slot metadata. | No observed gameplay choice depends on those measurements. Keep profile logs/storage timestamps local; never convert elapsed milliseconds into an AI search cutoff. Day-fraction scheduling still needs integer-tick conversion. |

### Step size, ordering and preview side effects

| Finding | Consequence / required change |
| --- | --- |
| `game.ts:773` scales/clamps incoming real `dt`; `game.ts:776` takes `min(MAX_STEP, dt)` with `MAX_STEP = 0.05` at `game.ts:87`. Short updates run shorter ticks and remainders can differ. | Replace this multiplayer simulation path with a fixed step plus integer tick calendar. Accumulate wall time outside the simulation. Never feed per-client rAF `dt` (`src/main.ts:105`) into replicated state. **Demonstrated blocker.** |
| Calendar adds `dt / DAY_SECONDS` and tests `>= 1` at `game.ts:796`–`799`; AI computes floor differences from day fractions at `ai.ts:1200`. | Floating accumulation moves daily/monthly events across boundaries. Define day and AI work budgets from tick integers; speed affects pacing only. |
| Train integration/acceleration/motion at `train.ts:857`, `train.ts:863`, `train.ts:869`; road speed/position at `roadvehicle.ts:603`, `roadvehicle.ts:606`; ambient timer at `vehicles.ts:308`; six replans per tick at `vehicles.ts:294`. | Smaller ticks change integration, timer overshoot and work-per-second. The probe shows a different train position after equal supplied seconds. Fixed steps are needed even if calendar fields were rounded. |
| `game.ts:769` clears deferred catchment once per outer update; `game.ts:771` flushes it there; month end sets `deferCatchment` at `game.ts:945`–`946`, tested at `game.ts:813`. | A month crossing halfway through a long update can defer more ticks than with short updates. Move flush/invalidation to a specific tick phase, including paused command application; independent of browser updates. Not isolated as the cause of the probe's first difference. |
| Vehicles update `Map.values()` sequentially at `vehicles.ts:297`; RNG-driven station generation uses map order at `game.ts:839`; passenger distribution uses line list order at `lines.ts:611`. Routing sort only compares cost at `lines.ts:549`. | JS Map/Set insertion order and stable sorts are defined, not inherently random. They still depend on mutation history. Enforce a stable entity/update/tie order and serialize necessary order; do not populate maps in packet-arrival order. Prefer explicit `(cost,id,dir)` tie keys, then keep that convention across AI/routing. |
| `spatial.ts:32` already preserves insertion order on removal; query returns cell/insertion order at `spatial.ts:42`, `spatial.ts:45`. Nearest node accepts only strictly closer candidates at `network.ts:359`. | Good existing work, but equal-distance winners can change after a different rebuild/restore history. Sort candidate IDs or use explicit tie-breaking for simulation decisions and test index rebuild equivalence. |
| `trackops.ts:437` creates temporary nodes in **planDoubleTrack**, removed at `trackops.ts:445`; `network.ts:138` consumes next IDs and `network.ts:150` advances version. AI's analogous preview deliberately reserves IDs at `ai.ts:667`. | **A hover/dry plan changes future IDs/versions**, even when cancelled. Different peers hover different tools. Make previews pure using a detached planning view/temporary IDs, and allocate durable IDs only during accepted commit. Prevent all UI planning against mutable authoritative state until this is fixed. |

### Floating-point math and caches

ECMAScript permits implementation-approximated results for several `Math` functions. Same-process equality cannot establish equality across V8, SpiderMonkey and JavaScriptCore. [ECMAScript math specification](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.sin).

| Finding | Consequence / required change |
| --- | --- |
| `Math.sin/cos`: depot virtual train segment `train.ts:102`, actual depot placement `build-ops.ts:71`, station construction `stations.ts:742`, town generation axes `towns.ts:434` and growth footprints `towns.ts:1659`; track fitting uses cosine `construction.ts:413` and sine `construction.ts:729`. | These affect committed positions, costs, collisions and future routes, not just three.js rendering. Pin deterministic trig/geometry helpers and input quantisation, or persist exact computed geometry and still make every later simulation use deterministic helpers. Transmitting only the seed does not solve this. |
| Non-integer `Math.pow`: local/long-distance demand `demand.ts:52`, `demand.ts:58`; reference journey time, fare and trip factors `fares.ts:55`, `fares.ts:79`, `fares.ts:104`; AI work budget `ai.ts:1101` and vehicle scoring `ai.ts:3098`. Line colour choice also uses `** 2.4` / `Math.cbrt` (`lines.ts:88`, `lines.ts:92`). No `Math.exp` call found in `src/game`. | Fractional powers affect passenger demand, revenue and AI work/choices, including random-rounding thresholds. Cover these functions with pinned helpers; do not describe nonexistent `exp` as a current blocker. Colour metadata can use host-chosen values or deterministic helpers. |
| Geometry/physics also uses `Math.hypot`, `sqrt`, `atan2`, `acos`: e.g. `geom.ts:78`, `geom.ts:171`, `train.ts:48`, `roadvehicle.ts:46`, `demand.ts:128`, and terrain generation `terrain-gen.ts:23`. | Audit the entire decision path, not just sin/cos. Float32 storage at `terrain-gen.ts:58` reduces precision but does not prove all double intermediates match. Use a versioned deterministic math module (e.g. bundled implementations with specified rounding or pinned WASM math) and golden vectors/cross-engine replays. Fixed point for money/clock is useful; converting all geometry to fixed point is a larger redesign. Merely rounding final hashes hides errors. |
| Town full-side cache changes whether RNG is consumed at `towns.ts:1628`; its game-day/building-count expiry is at `towns.ts:144`. It is saved via `towns.ts:229`, `save.ts:171`. | This is simulation state, not a disposable optimisation. Preserve it through checkpoint/resume and hash it. Clearing it on one peer changes later RNG/world growth. |
| Company asset cache key at `game.ts:588` uses day/network version/entity counts; contents at `game.ts:609` include vehicle resale values. Acquisition/share quotes use it (`game.ts:623`, `shares.ts:54`). UI finance windows call it too (`src/ui/win-company.ts:38`). | A same-day sell/rebuy with unchanged count can reuse an earlier value if the UI warmed the cache; peers may have different windows open. Invalidate on all relevant asset mutations/ownership/value changes or compute authoritative valuation at a defined tick/command point. This is a concrete cache-key risk; not exercised by the baseline probe. |
| AI network demand cache has a 30-day lifetime at `ai-network.ts:573`, affects `townTrips` at `ai-network.ts:590`, and is explicitly saved (`ai-network.ts:357`). Planner save persists deadlines but not generator job/scan position (`ai-network.ts:327`, `ai-network.ts:351`). | Preserve timed cached values as simulation state. Make planning jobs resumable state machines, or restart them at an agreed barrier on **all** participants. Rebuilding derived caches must not move deadlines or change job work relative to other actors. |
| Service timetable cache at `patterns.ts:365`, `patterns.ts:375`; demand station cache at `demand.ts:356`; geometry caches at `network.ts:127`. `Lines.checkStations` stores `stationSig` at `lines.ts:149`. | Distinguish pure derived caches from history-sensitive shortcuts. Add warm/cold/UI-read/restore equivalence checks. In particular, the timetable fast path assumes matching routing version/stop reference/vehicle count means all dependencies match; invalidate through dispatcher commits before any read. Snapshot reconstruction must restore or canonicalise listener/signature state. |

Release requirements: fixed tick/clock, seeded streams everywhere, pure previews/read paths, specified iteration/ties, deterministic math where simulation decisions need it, and exact snapshot continuation including AI progress and simulation-sensitive caches. Cross-browser tests must exercise these properties with command races, UI cache warming and saves, not just run this Node probe twice.

### Probe and findings

`scripts/determinism.ts` creates **four independent `Game.create` worlds in one process**, using the same cloned options. Its fixture follows `scripts/smoke.ts` / `scripts/lib.ts`: equally fund the player; place/connect two rail stations with `planEdge/commitProposal`; build a rail depot; create a rail line and buy/assign a locomotive with coaches; build town bus stops/depot, create a road line and buy two buses. The deterministic site search and fixture transcript must agree. AI remains enabled. Scripted edits at nominal days 60/120/180 rename the lines, repay one loan step and change rail-line colour/rebuild. It does not monkeypatch clocks, RNG, AI or simulation methods.

It hashes the existing save representation plus runtime versions, routing, reservations, crossing closure, deferred catchment flag, speed/pause and AI busy flags. SHA-256 over canonically ordered object keys preserves array/Map/Set order and exact numbers, with explicit non-finite/-0 tags. Visual time/news and timing profiles are excluded. Whole-world hashing is deliberately diagnostic, not the proposed cheap production hash. Captures are immutable strings; it cannot inspect JS generator instruction pointers, private WeakMap caches or every unpersisted temporary. Equal hashes therefore do not prove exact full-memory equality.

Commands used (run from repository root, esbuild 0.25.12, Node v20.18.2):

```sh
mkdir -p "${TMPDIR:-/tmp}/railfever"
node_modules/.bin/esbuild scripts/determinism.ts --bundle --platform=node --format=esm --outfile="${TMPDIR:-/tmp}/railfever/determinism.mjs"
node "${TMPDIR:-/tmp}/railfever/determinism.mjs" --days=360 --every=30
node "${TMPDIR:-/tmp}/railfever/determinism.mjs" --days=30 --every=1
```

Options: seed 7, size 384, 10 towns, hilly, medium water, year 1980, two AIs, speed 1×. Sampling uses integer update indices at equal total supplied seconds, not each copy's possibly different calendar. Command boundaries add comparisons even if outside the requested sample interval.

| Comparison | Observed result |
| --- | --- |
| `update(0.05)` twice | All initial/periodic hashes matched through 360 nominal days / 720 supplied seconds / 14,400 updates each. Final hash `71436928619704b9…`; 692 edges, 13 stations, 7 lines, 13 vehicles, 574 player passengers delivered. AI project counts 4 and 7; one AI still planning at the end. |
| `update(0.05)` vs `update(0.1)` | Matched through 360 days. Existing 0.05 maximum splits 0.1 into the same two substeps at 1× for this fixture. This comparison alone would miss tick-rate dependence. |
| `update(0.05)` vs `update(1/60)` | First observed divergence at the first 30-day sample in the main run. The daily refinement found it already at nominal day **1**, after exactly two supplied seconds: day **1** vs **0**, day fraction `4.440892098500626e-16` vs `0.9999999999999989`; train `headPos` **0.1887538762074778** vs **0.19526165583888888**. AI network planners existed in one copy but not the other because the daily event had not fired. |

First observed means first **checked** divergence, not the earliest internal tick. The different-step copy stops at its first observation so the diagnostic state is retained; fixed copies keep running. The day-30 main observation also differed in station/demand/finance/RNG/AI state, beyond a cosmetic clock field. Exact source mechanisms identified above explain why chunking is unsafe; the probe does not isolate every later difference to one cause.

Both commands exited 0: identical-step determinism passed, while chunking differences are expected observations. An additional `--days=1 --every=1 --strict-chunking` run reproduced the day-1 difference and exited 1 as intended. Invalid fixtures/options throw visibly with exit 2, identical-step desync uses exit 1. CLI also supports `--seed`, `--size`, `--ais`, `--days`, `--every`. This evidence covers one seed/fixture/JS engine with default AI settings, not other speeds, browser engines, UI hover, packet timing or save/resume. Bundling/running were verified; a separate script typecheck is not part of the repository's `src`-only tsconfig and the installed dependencies lack Node type definitions.

## Desync detection, recovery and multiplayer saves

### Cheap state hashes

Emit section hashes and a root at the same sealed tick, initially every **10 game days** (20 wall seconds at 1×, 2.5 at 8×) and after significant command batches. Hash:

- Tick/calendar; all RNG states; next IDs; room/world revision and last applied command sequence.
- Companies' money/loans/current accounting, shares/subsidiaries; access policies, requests, blocked lists, agreements and monthly usage/fees.
- Vehicle IDs/order, owners, models/consists, line/pattern, route/segments/reservations, progress/speed/load/state, timers, cargo, physics/operation counters and ambient vehicles/spawn RNG/timer.
- Stations' waiting groups/gen accumulator/rating/catchment/links and service statistics; lines' stops/patterns/operators/redirects and accounting; towns' populations, growth deadlines and full-side caches; demand regions/matrices/update cursor.
- AI RNG, decision state, durable work cursor/projects/managed lines/deadlines/timed demand caches. Hashing only AI entity counts misses different unfinished jobs.
- A cached static-state root covering terrain/locks, trees/buildings, graph geometry/profiles/signals, stations and depots. Rehash changed simulation chunks after construction/growth; do not depend on renderer dirty sets that one client's rendering clears.

Use a defined binary encoding (endianness, exact float representation, IDs/ties) and deterministic entity order, with section hashes for diagnostics. A fast 64-bit checksum per section folded into a SHA-256 root is adequate for accidental desync detection, or use a fast pinned hash implementation throughout. Include any meaningful insertion order until simulation explicitly uses sorted order. Counts, balances rounded to dollars, or positions rounded for display are insufficient. Exclude camera, visual cycle, notification history, audio, profiling, ping and wall-clock storage metadata.

Keep a limited command log and matching checkpoint IDs. Compare hashes tagged with **the same tick**, not whichever state a message arrives beside. A mismatch freezes that peer's commands; record first bad/last matching tick and section digests. If only one peer differs, use the host checkpoint. If several peers agree against the host, report a host mismatch and pause the room for recovery/debugging; don't silently let authoritative host recovery conceal a repeatable bug.

### Exact snapshot continuation is required

Reuse `serialize` / `deserialize` (`src/game/save.ts:141`, `src/game/save.ts:193`) as the foundation, with gzip via `CompressionStream` and a bundled fallback when needed (`src/game/save.ts:388`). Add tick/command sequence, build/math versions and multiplayer metadata to an outer envelope. Do not hash compressed bytes as the logical state: compression output can vary while state matches. Transfer checksum verifies bytes; state hashes verify simulation.

**Current save semantics need changes:**

- `AIController.load` explicitly abandons an interrupted project and resets cooldown (`src/game/ai.ts:4117`–`4128`). Network-planner saves retain deadlines but not generator position (`src/game/ai-network.ts:351`). A late joiner loading this save changes gameplay and cannot replay alongside an uninterrupted host.
- `deserialize` runs world repairs (`src/game/save.ts:353`), rebuilds routing (`src/game/save.ts:357`) and restores/cleans AIs (`src/game/save.ts:371`). Introduce strict same-build network restoration separate from legacy migration/repair. Make AI jobs serialisable state machines; restore decision-sensitive caches and cursors. Reconstruct derived reservations/indexes/geometry deterministically, then compare immediately and after advancing.
- Speed and pause are not in `serialize`'s top-level state (`src/game/save.ts:152`); restore them from the room envelope. Unsaved listener/signature/deferred state also needs audit. Serialize only at a defined between-tick barrier with no live preview mutation.

For an early development prototype, all existing peers **and the host** can pause, load the same checkpoint and resume together to align the current AI-cleanup semantics. This deliberately changes interrupted projects and is not the shipping late-join solution. It also needs load-idempotence tests. Loading only the joining or desynced peer is incorrect today.

### Late join and repair sequence

1. Host captures an immutable snapshot at sealed tick T, sequence S. Once strict continuation exists, the room may continue while it is compressed/sent; buffer the complete ordered tail from S+1. Initial prototype may pause during transfer.
2. Joiner verifies length/checksum/build/schema, installs the snapshot, reconstructs derived state and acknowledges state hash at T. It stays an observer with disabled edits while loading.
3. Send the contiguous command batches and empty-tick seals to a later horizon U. Joiner runs fixed ticks without rendering, in bounded batches. Compare state hash at U; only then grant its chosen seat/permissions at a recorded boundary.
4. If transfer/catch-up exceeds the retained log or the joiner cannot catch up at 8×, reduce speed/pause or restart from a newer snapshot. Never apply a live snapshot to half of an old world's objects.
5. Desync recovery uses the same flow. Repeated mismatch for the same build stops simulation with diagnostic log/save export; repeated full-map downloads are not an acceptable compatibility strategy.

Save/resume exports include room mode/settings, stable company/controller assignments, player public IDs/colours/roles, tick, last committed sequence and optionally a bounded replay tail. Store reconnect private credentials locally rather than putting them into a save shared with all peers. A new host accepts existing identity proof or explicitly reassigns seats; a static file alone cannot provide global account authentication. Resume in a paused lobby with fresh ephemeral room/connection IDs. If all players leave, an exported/shared save is the continuity mechanism.

Cache checkpoints locally on the host and at least one agreed backup participant, using their identical state at confirmed ticks to avoid distributing every full snapshot. Export a confirmed multiplayer save before graceful host handover. Abrupt migration later requires term/epoch fencing, agreed membership/checkpoint, new star connections, and a policy for unacknowledged commands; do not bolt leader election onto unconfirmed divergent worlds.

## Multiplayer UI

- **Lobby:** Host/join/resume; co-op/competitive; world and AI options; supported build; player capacity; company seats; manual tokens/file/QR or relay invitation. Connection progress distinguishes signalling, ICE, snapshot download, catch-up and ready. Host starts only when required participants are ready.
- **Company selection:** Choose your own company, an approved co-op seat or observer. Show controlling players and disconnected/reserved seats. Active local company replaces the hard-coded “player 0” UI; global ownership colours remain identical everywhere.
- **Player list:** Identity, company, role, personal colour, host marker, ping, tick lag, direct/relayed state, connected/catching-up/disconnected status. Per-player cursor/build-ghost colours differ from company liveries. Guests' cursors are optional, throttled presence data.
- **Chat:** Room and company channels, bounded plain-text messages, join/leave/status notices, optional map-location links. Escape names/messages, cap size/rate, and store only an optional bounded history. Chat should continue while the game is paused.
- **Pause/speed:** Default any active player may request an immediate pause; resume requires all active controlling players ready, with host removing disconnected members after the grace policy. Choose the minimum requested speed among active players, so 8× requires everyone willing/able. Expose the policy in the lobby; observers don't vote. Host emits the actual recorded setting. Network lag can lower speed or pause automatically, with a visible reason.
- **Permissions:** Company admin grants builder/operator/finance/observer capabilities; room admin controls world replacement, AI/room settings and membership. Existing open/ask/auto-approve/reject access and usage-weighted maintenance remain in the access window. Infrastructure use, shared-line operator rights and company editing rights are separate permissions.
- **Pending/rejected actions:** Show a local preview immediately, then pending order/tick, confirmed cost or explicit rejection (“cash spent by teammate”, “track changed”, “train in station”). Selection/window changes never directly commit state. Reconnect offers reclaim/catch-up; host-loss UI offers the last confirmed save.

## Phased implementation plan

Effort is one developer familiar with this codebase, in working days/weeks, plus real-browser/network testing. Deterministic math and exact AI continuation are the largest uncertainties; these estimates are not a delivery commitment.

| Phase | Rough effort | Concrete outcome / acceptance gate |
| --- | --- | --- |
| 0. Evidence and transport spike | 3–5 days | Extend this probe across seeds and 1×–8×; exercise warm/cold caches, hover previews, save/continue. Two browsers exchange manual offer/answer, a small command and this gzip save; test separate networks, TURN and `file:` without changing hosting. Measure join time, snapshot memory and command latency. |
| 1. Deterministic core and command boundary | 3–5 weeks | Fixed integer ticks/AI budgets, pure previews, valuation/cache invalidation, defined ordering/math. Extract typed validators/dispatcher and company context; begin with build/station/depot/buy/line/terraform, then cover every table row. Implement resumable AI and strict snapshot loader. Cross-engine replay and save/restore/continue hashes agree; invalid/racing commands leave no mutation. Choose (b) if this gate fails. |
| 2. Two-player co-op alpha | 1–2 weeks | Manual-signalled star, identity/company roles, ordered commands/empty seals, chat/player list, pending actions, hashes, pause/speed control. Two independent computers build and operate one company with AIs active, including overspending and busy-track races. Test both static HTTPS and inline file. |
| 3. Join, recovery and save/resume | 1–2 weeks | Chunked gzip/backpressure, strict snapshot + command-tail catch-up, reconnection/seat reservation, multiplayer exports and backup checkpoint. Test dropped connection, forced mismatch, late join at 8× and host loss. No AI project cleanup on just one peer. |
| 4. Competitive companies | 2–3 weeks | Multiple human companies, every window/tool dispatched with correct actor, optional co-op partners, AI slots/config, shares/takeover rule, access and shared-line permissions. Attempt forged company IDs, foreign sale/demolition, invalid invitations and same-tick finance races. |
| 5. Connectivity and scale hardening | 1–2 weeks | Optional signalling worker/ephemeral rooms and TURN credentials; failure/privacy UI; mature 768/1536 maps, large fleets, 4–8 peers, mobile/slow/background browsers. Bound logs/messages/memory and reduce speed gracefully. Graceful host transfer first; automatic crash migration gets its own later estimate. |

Allow approximately **8–15 weeks** for this route to a tested competitive release; a co-op alpha comes earlier but only after its core gates pass. Cross-engine math or AI state-machine redesign may exceed the range. Build an in-memory transport adapter first so record/replay/ordering can be tested without ICE; keep that protocol adapter separate from WebRTC and optional signalling. A future trusted headless host can reuse it without putting the renderer on a server.

**Prototype first:** the already-proven short-step divergence → integer fixed ticks; a cancelled double-track hover → no consumed IDs; and an active-AI snapshot → exact uninterrupted continuation on another engine. Also prototype manual WebRTC save transfer to test static/offline connectivity. Ship command replay only after these simulation and recovery gates pass.
