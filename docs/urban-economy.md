# Urban rail economics

Rail is one transport mode. Main-line, metro and light-rail track and stations are construction styles of it. The style sets:

- track speed, curves, grades and cost
- electrification and clearance
- station defaults: underground with street entrances and screen doors, elevated decks, halts and spacing

Every rail vehicle runs on every track type, though electric traction needs the wire. Any rail line may stop at any rail station, and one line may mix the styles. Lines, numbering, codes, colours, catchments, fares, local demand and forecasts treat every rail line alike. The Urban tools are presets for the urban construction styles.

The passenger calendar remains at 0.1 times the old daily generation rate. Fares are in calibrated game money: the boarding charges and the rail minimum are not literal real-world ticket prices. The main-line and high-speed distance fare curves and the regional OD rates are unchanged.

## Walking reach

Passengers walk along streets from forecourts, entrances and stops. The path-based walking limits are twice the earlier main-line, tram and bus limits. Metro and light-rail stations had shorter limits (12.6 and 10.5 units) and now share the rail limit:

| Mode | Limit | Along streets |
| --- | ---: | ---: |
| Rail, every station whatever its track type | 33.6 units | 420 m |
| Tram | 30.8 units | 385 m |
| Bus | 22.4 units | 280 m |

The street distance includes the 1.25 street-grid allowance. Building bonuses extend all three limits as before. Labels and help text take the limits from `walkLimit`.

Fewer people walk 400 m than 200 m. A building with a station within `FULL_COVER_WALK` (21 units, 210 m along streets) is fully covered. Further out, coverage falls with the walking weight `1 / (1 + d / 8)`, the same weight that shares buildings between stations. It is measured against the weight at 210 m: about 0.8 at a bus stop's limit and 0.6 at a rail station's.

A building's coverage comes from its best walk (`coverOf`): the nearest eligible station sets it. The stations that reach it share that coverage in proportion to their weights (share = weight / sum of weights × coverage). A second stop as far away splits the building's coverage; it adds none. Before this rule, two far stops covered a building wholly where one covered 85% of it. The live, sliced and reference share-outs and the AI's forecasts use the same rule. `catchPop` is a station's share of residents. The hover counts show everyone within the walking limit.

Added entrances are access points of their station: side halls, footbridges and underpasses with stairs on both sides of the tracks, platform-end gates, pavilions and stair towers. Each walks the same rail reach with the station building's bonus, and the share-out counts its residents with the same taper. The AI values a candidate entrance by the residents it newly brings within reach, counted with that taper and split with the other served stations that reach them; residents an access street demolishes count at the station's current share.

A ground station's forecourt also reaches its own access street where that street starts below or above the levelled station ground. The street is laid before the station levels its site, and the station's steps bridge the difference, as its road-access check already assumed. Before, such a station could show road access but have no walking catchment.

The street searches now cover four times the area. Catchment recomputes take longer (`scripts/catchperf.ts`, seed 23, timing runs on the final code):

| Map | Mean before → after | Worst before → after | Mean simulation tick |
| --- | ---: | ---: | ---: |
| 768, 5 years | 1.8 → 5.5–5.9 ms | 9 → 24–26 ms | 0.36 → 0.43–0.45 ms |
| 1024, 3 years | 1.1 → 3.5–3.6 ms | 4 → 12 ms | 0.36 → 0.34–0.36 ms |

Recomputes stay incremental, and the comparison with a full reference recompute remains exact.

## Local demand and fares

`urbanIntensity` combines three things:

- town size, from zero below 3,000 residents to full at 8,000
- residents and jobs within 200 metres
- proximity to the centre

Within a town, local trips are multiplied by `1 + k × intensity × quality`. The quality depends on the service's journey time, including waiting. The mode that carries the journey sets `k` (`DemandModel.journeyMode`: rail when a rail line with trains carries any of its legs, else tram when a tram line does, else bus):

- 6 for rail of any track type, so a cross-city main line's city stops count too
- 3 for trams
- 1.5 for buses

Before, `k` was 18 for metro track and 15 for light rail (by the boarding station's platforms), main-line trains had no uplift, and the first unified version used 12 for rail. The platforms a station has no longer matter: an unused rail platform beside a bus stop once gave bus-only trips the rail uplift (5.85 times the demand). The 8% car drop-off allowance follows the carrying mode too. Village services receive no density uplift. Intercity OD generation is unchanged.

Rail has one fare model, whatever the track or station style. A journey's rail legs pay their distance fares, together at least `RAIL_FARE.minimum` (500) before the speed factor (`railLegFare`). The first rail leg pays up to the minimum; a later one only what takes the journey's distance fares beyond it, so the operator of the first rail leg collects the minimum. The journey's rail fares so far travel with its waiting and cargo groups and are saved with them. The minimum binds on rail trips under about 300 m. Previously the fare depended on the boarding platform's track (metro 1,700 plus the distance component, light rail 900 plus it, main line the plain distance fare); the first unified version charged 1,000 on every leg, so four transfers earned 4.25 times the direct ride.

The speed factor, which compares a leg's time with walking or driving, is capped at 1.8 on trips up to 100 units (1 km), rising to 2.6 from 300 units: a few minutes saved on a walk in town are worth less than the time ratio says, while long trips keep the premium of fast and high-speed services.

Tram and bus receipts are a boarding charge (80 and 12) plus 90% of the old distance component. AI forecasts, project and improvement estimates, vehicle receipts and the line fares panel use the same context. Dense-centre trips add parking time and reduce car speed. Walking remains the reference for very short journeys.

A station's rating scales its passenger generation, and passengers who give up waiting lower it by up to 0.6 (`RATING_LOST`; 0.25 before). The share who gave up this and last month also reduces the station's generation directly, as OpenTTD's ratings do: where vehicles leave people behind, fewer set out.

## Car access to rail

A walking catchment describes walking only. Car access follows connected forecourt roads through ramps and bridges before reaching residential streets. It does not turn a raised road into a ground walking entrance.

Rail stations with cross-town service also attract car drop-off and park-and-ride passengers. This applies to any track type, not only main-line stations as before. The passengers come from street-connected parts of the station's town within 840 metres. They form a separate demand pool, not a larger walking circle.

How many residents are eligible depends on the headway:

- 100 simulation seconds or less: up to 50% of otherwise uncovered residents (85% before the walking reach doubled)
- longer headways: eligibility tapers off
- 200 seconds or more: none

Eligibility is not a ridership percentage. Eligible residents still produce the existing small regional OD rate, with the usual coverage and journey-time elasticity. The compressed game calendar makes simulation headways much longer in calendar days.

Buildings with a walking route to an existing intercity service are excluded from the pool. Their passengers already enter through real bus, tram and rail routes and transfers. Competing rail stations share each remaining lot once. Sparse services and villages get only an 8% allowance for unmodelled drop-off. Forecasts and operating demand use the same pool and frequency rule.

Car feeders contribute only to cross-town trips. Local trips between a line's city stops count only walking residents. A station served only by a city line, with every stop in one town, has no pool. Passenger generation reads the separate eligible population, so a park-and-ride station can work even when nobody walks to it. `catchPop` still reports walking residents only. Frequent, well-connected cross-town services gain riders from this, without inflating every rural railway's income.

## AI investment

Urban selection uses:

- street-connected population and overlapping catchment shares
- regional destinations
- capacity and queue abandonment
- fares
- vehicle estimates from `opcosts.ts`

The AI still chooses a construction style for a city railway:

- **Light-rail style** considers surface, elevated and underground alignments.
- **Subway style** goes underground.

Both are considered only in towns of at least 4,000 residents (`AIController.urbanPop`; 2,500 before). With the doubled reach, a few stops cover a smaller town, where buses or trams serve better. Subway style needs at least 5,000 residents (`centrePop`).

Station spacing derives from the one rail reach: 0.72 of it (about 300 m) for subway style, 0.6 (about 250 m) for light-rail style. Before, the spacing was 1.8 times each style's own, smaller reach: about 280 m and 240 m. Platforms and turnouts set the minimum spacing. The result is an ordinary rail line: main-line trains may run through onto it, and its trains onto the main line.

Main-line arrival transfers and trips between termini count in an interchange proposal. Stations at either owner's main-line terminus form explicit walking complexes. No walking transfer is set up between two stops of the same rail line, whatever their styles. Track connections are checked before construction. A light-rail-style line short of capital can open with three or four stops, leaving room to extend later. A second main-line station in a town counts only the ground that no existing rail station of any style covers.

Forecasts (`DemandModel.forecastLine`) use one rail model whatever the style:

- Every stop is limited by the queue it holds between trains, as in `Stations.trimWaiting`. Main-line projects were not limited before. With the doubled reach, a cross-city link's city stops forecast 57M a year without the limit.
- Cross-town projects add the car feeder pool.
- A city line adds, as transfers, the arrivals at served rail stations of any style beside its stops.

The style sets only the platform length used for the queue.

The through service joins a city line to a main line that ends within 900 m of the city line's depot end, in the same town. A connector of the city line's own track type runs from the terminus to the depot ramp, at least 50 m clear of the depot. The main line is electrified. A through line then runs the largest electric commuter unit that fits every platform from the main line into the city, entering at the end the connector joins.

It is built safely:

- **A follow-up of its own.** The city railway is a finished project before the through service is planned, so a save made from then on keeps it, whatever follows. The through job is saved with the company (`state.through`, a cursor over its candidates) and resumed after loading: a game saved at any tick of it loads exactly and goes on exactly as the original (`scripts/throughsave.ts`).
- **All or nothing.** The candidates (free platform ends of usable termini) are tried one per work unit. The first that plans is built within that unit or not at all: funds, track access and wiring are checked first, the through line's unit is checked over the whole route (`lineCompatibility`) before it is bought, and a failure after the connector removes the connector only.
- **The exact ramp.** The join point is an edge of the city line's own depot ramp and a distance along it, traced from the depot (`rampJoin`), never re-snapped by position: another track crossing above or below that spot is left alone.
- **Provenance.** Work that cuts older track in two never takes the halves for its own. A project's tracked edges skip them (`splitPieces`), so abandoning a project removes only what it laid.

The service never ran before: it looked for a unit whose first listed track type was electrified track (every unit lists every track type, starting with standard track), and it looked up the ramp by edge ids that the station throat and double-track works had already replaced. A street-level light-rail-style ramp is usually too short to join clear of the depot.

Light-rail-style lines must repay from operating surplus within nine years; subway-style lines and through tunnels within fifteen. Urban ranking scales the return by that horizon against a 4.5-year reference (six before the fares for city hops fell), so cheap regional services do not defer a viable city investment indefinitely. Conventional main-line civil works have a longer amortisation horizon plus a 3% capital allowance. High-speed rail keeps its existing investment threshold. Project selection and construction planning both yield between expensive forecasts and site checks.

Planning takes a consistent regional-demand snapshot when it spans several simulation days. It caches walking geometry separately from daily population and service updates. Main-line sites must have lasting road access. A new forecourt street ending on a bridge would be removed by network maintenance, so such sites are rejected. So is a site without road access, which has no walking catchment; the legacy site search used to accept one by its catchment circles alone. Access is rechecked after track and depot construction. Lost access gets an affordable repair attempt before another route is started.

## Cooperative through tunnels

Open-access AI companies with facing main-line termini in one city may jointly build a centre station and underground connection. A deterministic pair selection reserves the partner and allows only one through-link project per town at a time. Cost shares follow the operators' scheduled train capacity, or split equally when usage is unknown. Each company owns the tunnel nearest its terminus. Both must have positive incremental returns and each must repay its own share within fifteen years. Each must also afford its share within its own reserves and credit appetite. Actual overruns are checked again before live services are joined. The through line's city stops earn local trips like any rail line's.

`canJoinLines`/`joinLines`, when available, create the common through route and keep both operators. Each runs its own trains end to end and owns stations on the route. Existing usage-share agreements settle track and station fees in both directions. A separate subway-style line can coexist with the through tunnel.

## Checks

`scripts/urbanecon.ts` contains these fixtures:

- dense 8,000-person five-stop light-rail-style and subway-style lines, each repaying its full capital within a realistic band (light-rail style 3 to 8 years, subway style 4 to 15). The town's street grid crosses the line's corridor every 80 m, as a real grid does; the corridor was a free strip without a crossing street, on which a street-level line cost next to nothing
- a bus complex with an unused rail platform, whose bus-only trips get the bus uplift
- AI estimates priced with the receipts' fare model, for a rail and a bus leg
- a park-and-ride main line with no walking residents, its stations at the ends of country roads beyond the doubled reach
- two 3,000-person towns joined by one train between central stations, which must be at least 15% full and break even after upkeep by year three
- a two-company through tunnel
- third-company and terminus-owner interchange lines

Its `--maps=7,23 --years=8 --size=768` mode measures naturally selected city railways. It records town population when trains start operating, and captures operating profit exactly two years later. A qualifying service must be profitable both at that observation and at the end of the run.

`economy.ts`, `economy-ops.ts` and `ridership.ts` keep separate controls for existing rail and bus economics. The fixed income and operating-result controls must stay within ±15% of the baseline in `economy.ts`; that baseline is a repeatability check, re-captured with its history in the file. Independent bands check balance: the intercity line runs 10–80% full and repays its full capital within 60 years, the busy bus runs 15–80% full and repays its full capital in 1.5–8 years, and the village railway does not pay its way. An exploit check splits one journey over four transfers: it may earn no more than the distance fares alone make it (1.48 times the direct ride).

`walkcatch.ts` checks that a second stop as far away adds no coverage. `growth.ts` caps the passengers who give up waiting at 30% over a run and 35% in its last year.

The company capacity stress test injects its artificial crowd at the monthly decision, after normal queue abandonment. It freezes business decisions during its separate double-track physics observation.

The HSR speed fixture uses towns 4 to 5.2 km apart (3.4 to 4.5 km before). With the doubled reach, stations stand at the facing edges of the towns, and a 3 km run tops out at 160 km/h under real acceleration and braking. The underground-centre fixture tries each partner town on a fresh copy of the map. Towards one of them, the route cannot climb out of the centre tunnel, both before and after this change.

Urban scenarios advance committed simulation ticks. The company save comparison likewise advances exactly sixty simulation days in both games. Fixed wall-frame counts can release different numbers of ticks under the frame-time budget.

`growth.ts` checks town growth by service class. `GROWTH_FULL_REACH` rose from 0.12 to 0.3. With the doubled reach, one station can cover a small town completely. A station called only rarely still counts 15% of its catchment as reached, which used to count as full service.

## Measured calibration

Fixed seed-7 controls, final full year of four, no AI. The sites, service and costs are unchanged. Amounts are thousands of game money a year: v2.5 (b7dfcc3), the first unified version (83ba5bd), and now.

| Control | Income | Operating result | Boardings a year, load |
| --- | ---: | ---: | ---: |
| Intercity rail, stations at the town edges | 95.4 → 495.3 → 502.7 | −242 → +160 → +167 | 46 → 231 → 233, 15.6% |
| Busy bus, two articulated buses | 113.7 → 225.7 → 196.4 | +40 → +151 → +122 | 231 → 473 → 422, 28.8% |
| Short bus | 8.7 → 22.7 → 23.1 | −25 → −11 → −11 | 59 → 150 → 154 |
| Village rail | 226.3 → 302.6 → 305.2 | −139 → −71 → −68 | 70 → 82 → 83 |

The busy bus repays its buses in 4.4 years and its full capital (buses, stops and depot) in 5.6; it lost 13% when two stops stopped adding coverage to buildings far from both. The intercity line repays its train in 9.0 years and its full capital (a hilly line with five bridges and three tunnels) in 51.

Purpose-built services in `urbanecon.ts`, first unified version → now:

| Service | First unified version | Now |
| --- | ---: | ---: |
| Two 3,000-person towns, central stations, year 3 | load 20.5%, +468k a year | unchanged |
| 8,000-person town, five-stop light-rail style | 7.7M at street level on a free strip, +7.20M a year, 1.1-year payback | 14.2M elevated over a real street grid, +4.10M a year, 3.5-year payback |
| 8,000-person town, five-stop subway style | 28.6M, +5.70M a year, 5.0-year payback | 28.6M, +3.46M a year, 8.3-year payback |
| Third-company interchange line | +6.15M a year, 956 transfers | +2.90M a year, 758 transfers |
| Terminus-owner interchange line | +8.74M a year, 853 transfers | +4.20M a year, 1,711 transfers |

City hops earn less now: the rail minimum binds only below 300 m, the premium for speed on short trips is capped, and the rail uplift is 6.

Exploits and estimates, first unified version → now:

- **One journey over four transfers** (48 units in 160 s): 4.25 → 1.48 times the direct ride. The distance fares alone make it 1.48.
- **A bus complex with an unused rail platform:** 5.85 → 1.00 times the demand of the plain bus stop.
- **A house 263 m from two stops:** covered 100% → 84.5%, as by one stop.
- **The AI's estimate for a short rail route:** 1,029 against receipts of 2,386 per passenger → identical.

AI sweep: seeds 7, 11, 23 and 51, 768 maps, five years, three AI companies, first unified version → now:

| Measure | First unified version | Now |
| --- | ---: | ---: |
| AI rail lines with trains | 9 (4 main-line only, 5 on urban track) | 10 (4, 6) |
| Seeds with a line on urban track | 4 of 4 | 4 of 4 |
| Companies with a railway | 9 of 12 | 10 of 12 |
| Companies with a positive operating result in the last year | 12 of 12 (total 12.0M, worst +0.12M) | 11 of 12 (total 9.4M, worst −0.12M) |
| Lowest cash, mean loans | 0.59M, 12.2M | 0.92M, 13.9M |
| Passengers who gave up in the last month | 28%, 35%, 61%, 28% | 15%, 15%, 22%, 20% |
| Bankrupt companies | 0 | 0 |

Over the 20-year growth runs (seeds 7 and 23), the share of passengers who gave up waiting fell from 43% and 42% (48% and 55% in the last year) to 16% and 15% (17% and 22% in the last year); v2.5 had 26% and 17%. Well-served towns grow 2.07 times, poorly served ones 1.60 and unserved ones 1.29, all inside their targets.
