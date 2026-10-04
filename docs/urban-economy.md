# Urban rail economics

Rail is one transport mode. Main-line, metro and light-rail track and stations are construction styles of it. The style sets:

- track speed, curves, grades and cost
- electrification and clearance
- station defaults: underground with street entrances and screen doors, elevated decks, halts and spacing

Every rail vehicle runs on every track type, though electric traction needs the wire. Any rail line may stop at any rail station, and one line may mix the styles. Lines, numbering, codes, colours, catchments, fares, local demand and forecasts treat every rail line alike. The Urban tools are presets for the urban construction styles.

The passenger calendar remains at a 0.1 scale. Covered residents now make 20% more trips: the local base rate is 0.0102 per game day before that scale, and the long-distance monthly rate is 0.0144, preserving their balance. Fares are in calibrated game money: the boarding charges and the rail minimum are not literal real-world ticket prices. The main-line and high-speed distance fare curves are unchanged.

## Walking reach

Passengers walk along streets from forecourts, entrances and stops. Every walking limit is 70% of the release-2.6 value. All rail stations share one limit, whatever their track type:

| Mode | Limit | Along streets |
| --- | ---: | ---: |
| Rail, every station whatever its track type | 23.52 units | 294 m |
| Tram | 21.56 units | 269.5 m (270 m in labels) |
| Bus | 15.68 units | 196 m |

The street distance includes the 1.25 street-grid allowance. Building bonuses extend all three limits as before. Labels and help text take the limits from `walkLimit`.

A building with a station within `FULL_COVER_WALK` (14.7 units, 147 m along streets) is fully covered. Further out, coverage falls with the walking weight `1 / (1 + d / 5.6)`, the same weight that shares buildings between stations. The weight's distance scale also falls by 30%, from 8 to 5.6 units, so both full coverage and the entire taper keep their shape at 70% of the old distances: about 0.8 coverage at a bus stop's limit and 0.6 at a rail station's.

A building's coverage comes from its best walk (`coverOf`): the nearest eligible station sets it. The stations that reach it share that coverage in proportion to their weights (share = weight / sum of weights × coverage). A second stop as far away splits the building's coverage; it adds none. Before this rule, two far stops covered a building wholly where one covered 85% of it. The live, sliced and reference share-outs and the AI's forecasts use the same rule. `catchPop` is a station's share of residents. The hover counts show everyone within the walking limit.

Added entrances are access points of their station: side halls, footbridges and underpasses with stairs on both sides of the tracks, platform-end gates, pavilions and stair towers. Each walks the same rail reach with the station building's bonus, and the share-out counts its residents with the same taper. The AI values a candidate entrance by the residents it newly brings within reach, counted with that taper and split with the other served stations that reach them; residents an access street demolishes count at the station's current share.

A ground station's forecourt also reaches its own access street where that street starts below or above the levelled station ground. The street is laid before the station levels its site, and the station's steps bridge the difference, as its road-access check already assumed. Before, such a station could show road access but have no walking catchment.

At 70% of the distance, an unobstructed street grid's search area is 49% of the previous area. Recomputes stay incremental, and the comparison with a full reference recompute remains exact. The measured calibration below includes both a five-year 768-map run and cold recomputes on the identical release-2.6 saved world.

## Local demand and fares

`urbanIntensity` combines three things:

- town size, from zero below 3,000 residents to full at 8,000
- residents and jobs within 200 metres
- proximity to the centre

Within a town, local trips are multiplied by `1 + k × intensity × quality`. The quality depends on the service's journey time, including waiting. The mode that carries the journey sets `k` (`DemandModel.journeyMode`: rail when a rail line with trains carries any of its legs, else tram when a tram line does, else bus):

- 8 for rail of any track type, so a cross-city main line's city stops count too (6 in release 2.6)
- 4 for trams (3 in release 2.6)
- 2 for buses (1.5 in release 2.6)

Before rail unification, `k` was 18 for metro track and 15 for light rail (by the boarding station's platforms), main-line trains had no uplift, and the first unified version used 12 for rail. The platforms a station has no longer matter: an unused rail platform beside a bus stop once gave bus-only trips the rail uplift (5.85 times the demand). The 8% car drop-off allowance follows the carrying mode too. Village services receive no density uplift.

Rail has one fare model, whatever the track or station style. A journey's rail legs pay their distance fares, together at least `RAIL_FARE.minimum` (550; 500 in release 2.6) before the speed factor (`railLegFare`). The smaller city catchments fill their useful queues before extra demand alone restores a comfortable subway payback; the 10% minimum increase improves that margin without raising long-distance fares or the queue limits. The first rail leg pays up to the minimum; a later one only what takes the journey's distance fares beyond it, so the operator of the first rail leg collects the minimum. The journey's rail fares so far travel with its waiting and cargo groups and are saved with them. The minimum binds on rail trips under about 345 m. Previously the fare depended on the boarding platform's track (metro 1,700 plus the distance component, light rail 900 plus it, main line the plain distance fare); the first unified version charged 1,000 on every leg, so four transfers earned 4.25 times the direct ride.

The speed factor, which compares a leg's time with walking or driving, is capped at 1.8 on trips up to 100 units (1 km), rising to 2.6 from 300 units: a few minutes saved on a walk in town are worth less than the time ratio says, while long trips keep the premium of fast and high-speed services.

Tram and bus receipts are a boarding charge (80 and 12) plus 90% of the old distance component. AI forecasts, project and improvement estimates, vehicle receipts and the line fares panel use the same context. Dense-centre trips add parking time and reduce car speed. Walking remains the reference for very short journeys.

Changes of vehicle cost income (release 2.7): each one takes 10% off the fare of the leg ending in it and of every later leg (`TRANSFER_FARE_FACTOR`, 0.9). Legs are still paid one at a time, each to its operator: a leg after k changes pays 0.9^k, one 0.9 more when its passengers change at its end. A journey with one change earns exactly 10% less than the same legs without a change, whatever their lengths; with two changes 10–19% less (16% for three equal legs). This replaces the 20% bonus direct journeys earned; every fare is 1.2 times its old base (`FARE_LEVEL`), so a direct journey pays what it did. Waiting and cargo groups never mix passengers with different changes so far, just as they never mix rail fare histories: `fareGroupKey` adds the change class (0, 1, 2, 3 or more; the last pays its mean, within 0.2% of the exact fares for three and four changes). Older saves counted the passengers who had changed rather than their changes; read as one change each, a mixed group pays its mean (0.9^0.5 for half, within 0.2% of the exact split), and keeps it when its queue is trimmed: every group stays under the key its own fields give, as a loaded game keys it. Passengers whose next leg is the vehicle they are on (a line extended past their drop-off) stay aboard: no fare until they leave it, and no change of vehicle. AI forecasts price a journey with a change at 0.9 on every leg, and the cross-company link task values today's journeys across two networks the same way.

A station's rating scales its passenger generation, and passengers who give up waiting lower it by up to 0.6 (`RATING_LOST`; 0.25 before). The share who gave up this and last month also reduces the station's generation directly, as OpenTTD's ratings do: where vehicles leave people behind, fewer set out.

## Car access to rail

A walking catchment describes walking only. Car access follows connected forecourt roads through ramps and bridges before reaching residential streets. It does not turn a raised road into a ground walking entrance.

Rail stations with cross-town service also attract car drop-off and park-and-ride passengers. This applies to any track type, not only main-line stations as before. The passengers come from street-connected parts of the station's town within 840 metres. They form a separate demand pool, not a larger walking circle.

How many residents are eligible depends on the headway:

- 100 simulation seconds or less: up to 75% of otherwise uncovered residents (50% in release 2.6)
- longer headways: eligibility tapers off
- 300 seconds or more: none (200 seconds in release 2.6)

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

Both are considered only in towns of at least 4,000 residents (`AIController.urbanPop`; 2,500 before release 2.6). A few stops can cover a smaller town, where buses or trams serve better. Subway style needs at least 5,000 residents (`centrePop`).

Station spacing derives from the one rail walking reach: 0.72 of it (about 212 m) for subway style, 0.6 (about 176 m) for light-rail style. Platforms, curves and turnouts set minimum spacings of 300 m and 250 m respectively. Light rail needs 180 m clear between 70 m platforms for the pair of terminal crossover diagonals and their clearances; using the shorter reach alone left the tracks two-way and the trains blocked. The result is an ordinary rail line: main-line trains may run through onto it, and its trains onto the main line.

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
- a park-and-ride main line with no walking residents, its stations at the ends of country roads beyond walking reach
- two 3,000-person towns joined by one train between central stations, which must be at least 15% full and break even after upkeep by year three
- a two-company through tunnel
- third-company and terminus-owner interchange lines

Its `--maps=7,23 --years=8 --size=768` mode measures naturally selected city railways. It records town population when trains start operating, and captures operating profit exactly two years later. A qualifying service must be profitable both at that observation and at the end of the run.

`economy.ts`, `economy-ops.ts` and `ridership.ts` keep separate controls for existing rail and bus economics. The fixed income and operating-result controls must stay within ±15% of the baseline in `economy.ts`; that baseline is a repeatability check, re-captured with its history in the file. Independent bands check balance: the intercity line runs 10–80% full and repays its full capital within 60 years, the busy bus runs 15–80% full and repays its full capital in 1.5–8 years, and the village railway does not pay its way. An exploit check splits one journey over four legs: it may earn no more than the distance fares alone make it, with the same changes of vehicle (1.47 times the direct ride against 1.41 by the distance fares, within the 5% allowance).

`walkcatch.ts` checks that a second stop as far away adds no coverage. `growth.ts` caps the passengers who give up waiting at 30% over a run and 35% in its last year. `fares.ts` checks fare-history and change-class cohorts through waiting, boarding, transfers, absorption, line redirects and saves, and the journey-level transfer reduction.

The company capacity stress test injects its artificial crowd at the monthly decision, after normal queue abandonment. It freezes business decisions during its separate double-track physics observation.

The HSR speed fixture uses towns 4 to 5.2 km apart (3.4 to 4.5 km before). Station sites can stand at the facing edges of the towns, and a 3 km run tops out at 160 km/h under real acceleration and braking. The underground-centre fixture tries each partner town on a fresh copy of the map. Towards one of them, the route cannot climb out of the centre tunnel, both before and after this change.

Urban scenarios advance committed simulation ticks. The company save comparison likewise advances exactly sixty simulation days in both games. Fixed wall-frame counts can release different numbers of ticks under the frame-time budget.

`growth.ts` checks town growth by service class. `GROWTH_FULL_REACH` rises from 0.3 to 0.4, and the credit in months without a call (`GROWTH_MIN_CALLS`) falls from 15% to 8%. The radius-only growth run had poorly served towns growing 1.84 times: rare calls could still give them nearly full growth credit. Coverage and actual frequency now matter more, while the unserved and best-service intervals (100 and 6 days), transport and rating factors, and all class targets stay unchanged.

## Measured calibration

Release 2.6 (`d95e283`) → 70% walking limits, using the same seed-7 economy controls, final full year of four, no AI. Income and operating result include infrastructure upkeep and are thousands of game money a year. The intercity and bus capital is unchanged; the radius-sensitive village site search produces a slightly cheaper alignment.

| Control | Income, old → new | Operating result, old → new | Boardings/year, old → new | Load, old → new | Full-capital payback, old → new |
| --- | ---: | ---: | ---: | ---: | ---: |
| Intercity rail | 502.7 → 490.7 | +167.5 → +155.4 | 233 → 248 | 15.6% → 18.3% | 51.0 → 55.0 years |
| Busy bus, two articulated buses | 196.4 → 175.8 | +122.5 → +101.8 | 422 → 373 | 28.8% → 25.9% | 5.6 → 6.7 years |
| Short bus | 23.1 → 18.2 | −10.7 → −15.6 | 154 → 122 | 17.0% → 13.4% | never → never |
| Village rail | 305.2 → 242.1 | −68.4 → −133.2 | 83 → 54 | 7.2% → 4.2% | never → never |

The new economy baseline was captured only after the independent load, full-capital payback, village-loss and split-journey bands passed, and after checking urban economics. Its comment records the old and new constants and results; all bands remain unchanged. Narrower walking reach intentionally reduces the short bus and village line's traffic. The separate feeders and 20% higher generation per covered resident sustain the useful intercity service.

Urban fixtures remain 8,000-person towns with five stations across a real street grid:

| Service | Release 2.6 | 70% walking limits |
| --- | ---: | ---: |
| Light-rail style | 14.24M invested, +4.10M/year, 3.5-year payback | 14.14M invested, +3.10M/year, 4.6-year payback |
| Subway style | 28.64M invested, +3.46M/year, 8.3-year payback | 28.38M invested, +2.12M/year, 13.4-year payback |
| Two 3,000-person towns, central stations, year 3 | 20.5% load, +468k/year | 27.0% load, +690k/year |

Reducing walking reach alone failed the independent intercity economics and left subway payback at 14.9 years. Its shorter light-rail spacing also left no room for the terminal crossover pair, blocking all four trains. The physical spacing floor, modest demand and feeder calibration, and 10% rail minimum increase address those measured problems. Increasing urban demand beyond 8/4/2 mostly filled the queue caps without improving subway payback, so the final calibration keeps that uplift and preserves the queue limits.

The four-transfer exploit remains 1.48 times the direct journey, as with the distance fares alone. A bus complex's unused rail platform still gives exactly the plain bus demand. AI estimates still agree with passenger receipts. The overlapping-stop fixture now uses a house about 183 m from each bus stop, beyond full coverage but inside the shorter walking limit: two equally distant stops share the same coverage as one.

The 20-year 768-map runs, seeds 7 and 23, keep every raw class mean inside its target without relying on the sample tolerance. Classes follow the service each town actually received, so class membership can change.

| Growth class | Release 2.6 | 70% walking limits | Target |
| --- | ---: | ---: | ---: |
| Well served | 2.066× (20 towns) | 1.955× (19 towns) | 1.6–2.5× |
| Poorly served | 1.603× (5 towns) | 1.458× (6 towns) | 1.3–1.6× |
| Unserved | 1.285× (1 town) | 1.202× (1 town) | 1.1–1.3× |

| Seed | Abandonment over 20 years, old → new | Abandonment in final year, old → new |
| --- | ---: | ---: |
| 7 | 16.0% → 24.0% | 16.7% → 29.2% |
| 23 | 14.9% → 12.8% | 21.8% → 20.3% |

Both run totals remain below 30%, and both final years below 35%. Seed 7 has more abandonment after recalibration, within the unchanged ceilings; the feedback on station ratings and passenger generation remains in place.

The separate seed-11 tiny-village smoke control connects Glendale (260 residents) and Greenham (175), runs for exactly two years and must carry passengers:

| Measurement | Release 2.6 | 70% walking limits |
| --- | ---: | ---: |
| Station walking residents | 281.8 / 171.0 | 187.4 / 153.6 |
| Passengers delivered in two years | 146 | 136 |

### Release 2.7: transfer rule, riders who give up, one game per memo

Release 2.7 combines the 70% walking limits with the transfer rule above (every fare 1.2 times its old base, each change of vehicle 10% off the leg ending in it and every later leg), the AI's cross-company links, two AI changes and a determinism fix:

- A bus or tram line at its fleet limit, earning over twice its costs, whose riders gave up waiting by two vehicle-loads or more last month (its share of each stop's queue), may run one vehicle more; its stops still bound the fleet, and trams the street. The capacity rule also counts those riders as waiting: on small stops a busy line never shows a long queue, they give up instead. In the seed-7 growth run both companies' trams at Wilwood Market Cross earned 8.5 times their costs, capped at five each, while 1,238 passengers a year gave up at that stop alone.
- The AI's route-evaluation memo was one map for every game in the process, keyed by distances rounded to 4 units: its values were the first query's of each bucket, so an earlier game in the same tab (or the queries before a save) changed a game's later choices. It is per game and exact now. `growth.ts` runs seed 23 after seed 7 in one process, so earlier seed-23 numbers depended on seed 7's run.

The economy controls are unchanged (direct journeys pay what they did): intercity 490.7k income, 55.0-year full-capital payback; busy bus 175.8k, 6.7 years; village rail −133.2k. The urban fixtures, the two-town line (27.0% load, +690k in year three) and the seed-11 tiny village (136 passengers in two years) are unchanged too. The split-journey exploit check reads 1.47 times the direct ride against 1.41 by the distance fares alone.

Growth, 20 years on 768 maps (seeds 7 and 23 are the test's; 5 and 11 a second sample). "Merged" is 2.7 before the capacity rule and the memo fix; "Calibrated" adds them; "Release 2.7" adds the validation fixes (riders staying aboard, change classes kept when queues are trimmed, links that demolish nothing and pay the partner):

| Growth class, seeds 7 / 23 | 70% walking limits | Merged | Calibrated | Release 2.7 | Target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Well served | 1.96× (19 towns) | 1.96× (18) | 1.96× (19) | 1.94× (19) | 1.6–2.5× |
| Poorly served | 1.43× (6) | 1.49× (7) | 1.58× (6) | 1.60× (6) | 1.3–1.6× |
| Unserved | 1.14× (1) | 1.21× (1) | 1.23× (1) | 1.55× (1) | 1.1–1.3× |

| Growth class, seeds 5 / 11 | 70% walking limits | Merged | Calibrated | Release 2.7 |
| --- | ---: | ---: | ---: | ---: |
| Well served | 1.64× (16) | 1.64× (15) | 1.67× (16) | 1.60× (16) |
| Poorly served | 1.51× (7) | 1.46× (7) | 1.51× (8) | 1.58× (5) |
| Unserved | 1.24× (3) | 1.20× (4) | 1.14× (2) | 1.20× (5) |

| Passengers who gave up, run / final year | 70% walking limits | Merged | Calibrated | Release 2.7 |
| --- | ---: | ---: | ---: | ---: |
| Seed 7 | 24% / 29% | 27% / 36% | 23% / 30% | 23% / 32% |
| Seed 23 | 13% / 24% | 14% / 18% | 12% / 17% | 13% / 17% |
| Seed 5 | 19% / 24% | 20% / 25% | 19% / 24% | 20% / 23% |
| Seed 11 | 13% / 17% | 10% / 11% | 10% / 11% | 10% / 11% |

In the merged build seed 7's final year passed the 35% ceiling: a third company was bought three years earlier than before, and the profitable trams above stayed capped. Letting the fleet follow riders who give up by a single vehicle-load a month brought seed 7 to 19% / 29% but raised the poorly served class to 1.73× (two small towns gained service late in the run: Oakmoor 268 → 766 residents, Hayhaven 242 → 437); two vehicle-loads, as adopted, kept every class and ceiling inside its target on both samples. With the validation fixes the one unserved town of seeds 7 and 23, Hayhaven, is a boundary case: unserved until a coach line reached it late in 1966 (242 → 301 residents, 1.24×), then served by three coach lines of two companies (301 → 374) in 23 of the 240 months, one month short of the 10% that makes a town poorly served; its 1.55× is the class mean. Over the four seeds the classes grow 1.78× (well served, 35 towns), 1.59× (poorly served, 11) and 1.25× (unserved, 6), each inside its target.

Catchment timing uses Node 20.18.2, seed 23, a 768 map and three AI companies. The five-year runs use `--timing-only --cpu`, excluding allocations from the independent reference comparison.

| Measurement | Release 2.6 | 70% walking limits |
| --- | ---: | ---: |
| Live recompute mean | 11.60 ms | 4.72 ms |
| Live recompute p99 | 39.16 ms | 15.46 ms |
| Live recompute maximum | 220.77 ms | 21.64 ms |
| Live recompute mean CPU | 15.36 ms | 7.94 ms |
| Identical-world cold recompute mean | 6.45 ms | 2.85 ms |
| Identical-world cold recompute median | 5.44 ms | 2.48 ms |
| Five-year passengers delivered | 11,722 | 13,307 |

The live runs end with 43 → 48 stations and 6,602 → 6,456 buildings. To isolate walking geometry from those changed networks, the cold comparison loads the same release-2.6 saved world (41 stations, 6,602 buildings), forces a complete recompute, discards five warm-up samples and measures twenty more. Mean cold time falls about 56%; live mean falls about 59%. Wall maxima include host scheduling and garbage collection. The unchanged-call maximum also stays tiny: 0.0053 → 0.0044 ms.

All 44 requested gate cases pass, with their independent bands unchanged. This includes smoke 7/11/23, twenty exact 120-day network-job replays, through-service saves, full/reference catchment comparisons, migration of eighteen legacy saves from `review/t23`, and both mature-network and staggered-depot 400-day exact replays for seeds 7 and 23. The final gate's AI timing outlier passed on an unchanged isolated retry (27.2 ms maximum against the existing 30 ms limit).

Radius-specific checks in `stations`, `bigstations` and `urban` now assert the reduced limits and retained building bonus. `walkcatch` checks clipped streets, a house removed from the old catchment, the proportionally scaled taper, the new map-legend distances, and equal-distance overlapping stops beyond full coverage. `entrances` checks that added landings retain nearby surviving houses and exclude the far ends. Smoke adds the explicit tiny-village control; replay widens its route-search fallback because seed 23's shorter-radius site ranking no longer connects its nearby pair. Every exactness check remains in place.
