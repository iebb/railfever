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

A building's share for each station is that station's weight divided by the larger of two values: the sum of the weights of all its stations, or the weight at 210 m. A building in reach of several stations is shared between them. It is wholly covered once their weights add up to the weight at 210 m. `catchPop` is a station's share of residents. The hover counts show everyone within the walking limit.

Added entrances are access points of their station: side halls, footbridges and underpasses with stairs on both sides of the tracks, platform-end gates, pavilions and stair towers. Each walks the same rail reach with the station building's bonus, and the share-out counts its residents with the same taper. The AI values a candidate entrance by the residents it newly brings within reach, counted with that taper and split with the other served stations that reach them.

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

Within a town, local trips are multiplied by `1 + k × intensity × quality`. The quality depends on the service's journey time, including waiting. The mode sets `k`:

- 12 for rail of any track type, so a cross-city main line's city stops count too
- 3 for trams
- 1.5 for buses

Before, `k` was 18 for metro track and 15 for light rail, and main-line trains had no uplift. Village services receive no density uplift. Intercity OD generation is unchanged.

Rail has one fare model, whatever the track or station style. A boarding pays the distance fare but at least `RAIL_FARE.minimum` (1,000), both before the speed factor. Long trips and the high-speed premium follow distance and time saved, as before. Previously the fare depended on the boarding platform's track:

- metro: 1,700 plus the distance component
- light rail: 900 plus the distance component
- main line: the plain distance fare

Tram and bus receipts are a boarding charge (80 and 12) plus 90% of the old distance component. AI forecasts, vehicle receipts and the line fares panel use the same context. Dense-centre trips add parking time and reduce car speed. Walking remains the reference for very short journeys.

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

The through service joins a city line to a main line that ends within 900 m of the city line's depot end, in the same town. A connector of the city line's own track type runs from the terminus to the depot ramp, at least 50 m clear of the depot. The main line is electrified. A through line then runs the largest electric commuter unit that fits every platform from the main line into the city, entering at the end the connector joins. The service never ran before, for two reasons:

- It looked for a unit whose first listed track type was electrified track, but every unit lists every track type, starting with standard track.
- It looked up the ramp by edge ids that the station throat and double-track works had already replaced.

In a scratch scenario, a subway-style line next to a main-line terminus now opens a through line that carries passengers for a year. A street-level light-rail-style ramp is usually too short to join clear of the depot.

Light-rail-style lines must repay from operating surplus within nine years; subway-style lines and through tunnels within fifteen. Urban ranking scales the return by that horizon against a six-year reference, so cheap regional services do not defer a viable city investment indefinitely. Conventional main-line civil works have a longer amortisation horizon plus a 3% capital allowance. High-speed rail keeps its existing investment threshold. Project selection and construction planning both yield between expensive forecasts and site checks.

Planning takes a consistent regional-demand snapshot when it spans several simulation days. It caches walking geometry separately from daily population and service updates. Main-line sites must have lasting road access. A new forecourt street ending on a bridge would be removed by network maintenance, so such sites are rejected. So is a site without road access, which has no walking catchment; the legacy site search used to accept one by its catchment circles alone. Access is rechecked after track and depot construction. Lost access gets an affordable repair attempt before another route is started.

## Cooperative through tunnels

Open-access AI companies with facing main-line termini in one city may jointly build a centre station and underground connection. A deterministic pair selection reserves the partner and allows only one through-link project per town at a time. Cost shares follow the operators' scheduled train capacity, or split equally when usage is unknown. Each company owns the tunnel nearest its terminus. Both must have positive incremental returns and each must repay its own share within fifteen years. Each must also afford its share within its own reserves and credit appetite. Actual overruns are checked again before live services are joined. The through line's city stops earn local trips like any rail line's.

`canJoinLines`/`joinLines`, when available, create the common through route and keep both operators. Each runs its own trains end to end and owns stations on the route. Existing usage-share agreements settle track and station fees in both directions. A separate subway-style line can coexist with the through tunnel.

## Checks

`scripts/urbanecon.ts` contains these fixtures:

- dense 8,000-person five-stop light-rail-style and subway-style lines
- a park-and-ride main line with no walking residents, its stations at the ends of country roads beyond the doubled reach
- two 3,000-person towns joined by one train between central stations, which must be at least 15% full and break even after upkeep by year three
- a two-company through tunnel
- third-company and terminus-owner interchange lines

Its `--maps=7,23 --years=8 --size=768` mode measures naturally selected city railways. It records town population when trains start operating, and captures operating profit exactly two years later. A qualifying service must be profitable both at that observation and at the end of the run.

`economy.ts`, `economy-ops.ts` and `ridership.ts` keep separate controls for existing rail and bus economics. The fixed income and operating-result controls must stay within ±15% of the baseline in `economy.ts`. That baseline was re-captured for the doubled reach. The previous one held no operating results, so its profit checks compared against NaN.

The company capacity stress test injects its artificial crowd at the monthly decision, after normal queue abandonment. It freezes business decisions during its separate double-track physics observation.

The HSR speed fixture uses towns 4 to 5.2 km apart (3.4 to 4.5 km before). With the doubled reach, stations stand at the facing edges of the towns, and a 3 km run tops out at 160 km/h under real acceleration and braking. The underground-centre fixture tries each partner town on a fresh copy of the map. Towards one of them, the route cannot climb out of the centre tunnel, both before and after this change.

Urban scenarios advance committed simulation ticks. The company save comparison likewise advances exactly sixty simulation days in both games. Fixed wall-frame counts can release different numbers of ticks under the frame-time budget.

`growth.ts` checks town growth by service class. `GROWTH_FULL_REACH` rose from 0.12 to 0.3. With the doubled reach, one station can cover a small town completely. A station called only rarely still counts 15% of its catchment as reached, which used to count as full service.

## Measured calibration

Fixed seed-7 controls, final full year of four, no AI. The sites, service and costs are unchanged. Amounts are thousands of game money a year.

| Control | Income before → after | Operating result before → after | Boardings a year before → after |
| --- | ---: | ---: | ---: |
| Intercity rail, stations at the town edges | 95.4 → 495.3 | −242 → +160 | 46 → 231 (load 3.4% → 15.5%) |
| Busy bus, two articulated buses | 113.7 → 225.7 | +40 → +151 | 231 → 473 |
| Short bus | 8.7 → 22.7 | −25 → −11 | 59 → 150 |
| Village rail | 226.3 → 302.6 | −139 → −71 | 70 → 82 |

The busy bus now pays back its buses in about 3.6 years (13.6 before), and the intercity line its train in 9.4. The intercity boardings rise more than the guide of three to four times. Its Coldden station stands at the town edge: the old reach covered 119 of 1,947 residents, the new one about 660.

Purpose-built services in `urbanecon.ts`:

| Service | Before | After |
| --- | ---: | ---: |
| Two 3,000-person towns, central stations, year 3 | load 3.2%, −126k a year | load 20.5%, +468k a year |
| 8,000-person town, five-stop light-rail style | 13.7M invested, +4.82M a year, 2.8-year payback | 7.7M (street level), +7.20M a year, 1.1-year payback |
| 8,000-person town, five-stop subway style | 28.4M, +7.07M a year, 4.0-year payback | 28.6M, +5.70M a year, 5.0-year payback |
| Park-and-ride main line, no walking residents | +0.60M a year (1,197 eligible) | −0.20M a year (121 eligible) |
| Third-company interchange line | +4.07M a year, 486 transfers | +6.15M a year, 956 transfers |
| Terminus-owner interchange line | +4.26M a year, 430 transfers | +8.74M a year, 853 transfers |

Notes on the purpose-built services:

- **City lines:** both carry about 1.8 to 1.9 times as many passengers. The subway-style line's revenue still falls, because the 1,000 rail minimum replaces its 1,700 boarding charge plus distance.
- **Light-rail-style line:** it now opens at street level.
- **Park-and-ride line:** its stations moved beyond the doubled reach, and the car pool shrank by design.
- **Through tunnel:** the forecast revenue is 5.79M a year (1.59M before). Fees flowed 83.7k one way and 173.3k the other (83.3k and 187.0k before).
- **Terminus-owner line:** its company now tries a through service from the terminus, which fails on the geometry but takes a simulated day. During that day the normal line management adds a train, which lifts the line's result.

AI sweep: seeds 7, 11, 23 and 51, 768 maps, five years, three AI companies.

| Measure | Before | After |
| --- | ---: | ---: |
| AI rail lines with trains | 9 (4 main-line only, 5 on urban track) | 9 (4, 5) |
| Seeds with a city railway | 4 of 4 | 4 of 4 |
| Companies with a railway | 9 of 12 | 9 of 12 |
| Companies with a positive operating result in the last year | 10 of 12 (total 5.9M, worst −0.62M) | 12 of 12 (total 12.0M, worst +0.12M) |
| Lowest cash, mean loans | 0.47M, 11.7M | 0.59M, 12.2M |
| Bankrupt companies | 0 | 0 |

Naturally selected city railways (`--maps=7,23 --years=8 --size=768`):

- **Seed 7:** one city railway opening both before and after. No line qualifies, because the largest town stays below 5,000 (4,468 before, 4,781 after).
- **Seed 23, before:** three qualifying Fairholm lines earned +1.09M, +0.11M and −0.01M a year at the end, and +1.90M, +0.16M and +0.12M at two years.
- **Seed 23, after:** one qualifying line, RE1 Fairholm – Hartburgh Vale. It is a light-rail-style city line merged with a main line into one route, and earns +1.98M a year at the end and +0.94M at two years.

Three-year 512-map ridership runs change the AI's networks, so their totals describe network choice as well as demand.

| Seed | Boardings a year | Rail boardings | Mean load | Time full |
| --- | ---: | ---: | ---: | ---: |
| 7 | 1,674 → 2,255 | 1,117 → 1,035 | 20.2% → 39.9% | 0.0% → 13.3% |
| 23 | 598 → 1,551 | 177 → 1,127 | 24.7% → 38.8% | 5.1% → 14.9% |
| 51 | 770 → 1,794 | 202 → 879 | 34.1% → 39.5% | 0.5% → 5.7% |

At stations present in both runs, boardings rose by a median of 1.9 times (90th percentile 6.5).

Over the 20-year growth runs, the share of passengers who gave up waiting rose with demand, from 17–26% to 42–43%. Well-served towns grow 1.91 times, as before. Poorly served towns grow 1.57 times, inside their 1.3–1.6 target; before, they grew 1.74 times, above it. Unserved towns grow 1.31 times (1.22 before), inside the test's 0.1 slack around the 1.1–1.3 target.
