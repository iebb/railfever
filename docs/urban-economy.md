# Urban rail economics

The passenger calendar remains at 0.1 times the old daily generation rate. Fares are in calibrated game money; the boarding charges are not literal real-world ticket prices. Main-line and high-speed distance fare curves, regional OD rates, walking limits and street-walking catchments are unchanged.

## Local demand and fares

`urbanIntensity` combines town size (zero below 3,000 residents, full at 8,000), residents/jobs within 200 metres, and proximity to the centre. The local transit multiplier depends on this intensity, the mode and the service's journey time including waiting. Dense, frequent metro and light rail unlock many short intra-town trips. Village services receive no density uplift. Intercity OD generation stays unchanged.

Metro, light rail, tram and bus receipts include a boarding charge plus the distance component. Metro/light rail have larger calibrated charges to sustain their much higher station and structure costs. Bus/tram retain 90% of the old distance component. The same context is used for AI forecasts and vehicle receipts. Dense-centre trips add parking time and reduce car speed; walking remains the reference for very short journeys.

## Main-line access

A walking catchment describes walking only. Car access follows connected forecourt roads through ramps and bridges before reaching residential streets. It does not turn a raised road into a ground walking entrance. Regional stations also attract car drop-off and park-and-ride passengers from street-connected parts of their town within 840 metres. This is a separate demand pool, not a larger walking circle. At headways of 100 simulation seconds or less, up to 85% of otherwise uncovered residents are eligible; eligibility tapers to zero at 200 seconds. Eligibility is not a ridership percentage: eligible residents still produce the existing small regional OD rate, with the usual coverage and journey-time elasticity. The compressed game calendar makes simulation headways much longer in calendar days.

Buildings with a walking route to an existing intercity service are excluded from that pool: their passengers already enter through actual bus/tram/rail routes and transfers. Competing main-line stations share each remaining lot once. Sparse services and villages receive only an 8% allowance for unmodelled drop-off. Forecasts and operating demand use the same pool and frequency rule. Car feeders contribute only to regional trips; local trips between a through line's city stops use walking residents. Passenger generation reads the separate eligible population, so a park-and-ride station can work even when nobody walks to it; `catchPop` continues to report walking residents only. Scheduled main-line services therefore gain from frequency and well-connected access, without inflating every rural railway's income.

## AI investment

Urban selection uses actual street-connected population, overlapping catchment shares, regional destinations, capacity, queue abandonment, boarding fares, and `opcosts.ts` vehicle estimates. Main-line arrival transfers and trips between termini count in an interchange proposal. Stations at either owner's main-line terminus form explicit walking complexes. Light rail considers surface, elevated and underground alignments; metro goes underground. Track connections are checked before construction. Capital-limited light rail can open with three or four stops, retaining room to extend later.

Light rail must repay from operating surplus within nine years; metro and through tunnels within fifteen. Urban ranking scales the return by that accepted horizon against a six-year reference, so inexpensive regional services do not indefinitely defer a viable city investment. Conventional main-line civil works have a longer amortisation horizon plus a 3% capital allowance; high-speed rail keeps its existing investment threshold. Both project selection and construction planning yield between expensive forecasts/site checks.

Planning takes a consistent regional-demand snapshot when it spans several simulation days, and caches walking geometry separately from daily population and service updates. Main-line sites must have lasting road access: a new forecourt street ending on a bridge would be removed by network maintenance, so such sites are rejected. Access is rechecked after track/depot construction; lost access gets an affordable repair attempt before another route is started.

## Cooperative through tunnels

Open-access AI companies with facing main-line termini in one city may jointly build a centre station and underground connection. A deterministic pair selection reserves the partner and permits only one through-link project in a town at a time. Cost shares follow the operators' scheduled train capacity, or split equally when usage is unknown. Each owns the tunnel nearest its terminus. Both must have positive incremental returns, individually repay their share within fifteen years, and afford it under their own reserves and credit appetite. Actual overruns are checked again before live services are joined.

`canJoinLines`/`joinLines`, when available, create the common through route and preserve both operators. Each runs its own trains end to end and owns stations on the route. Existing usage-share agreements settle track and station fees in both directions. A separate metro can coexist with the through tunnel.

## Checks

`scripts/urbanecon.ts` tests dense 8,000-person five-stop light rail and underground metro, a zero-walking main-line feeder service, a two-company through tunnel, and both third-company and terminus-owner interchange metros. Its `--maps=7,23 --years=8 --size=768` mode measures naturally selected urban lines, records town population when trains start operating, and captures operating profit exactly two years later. It requires a qualifying service to be profitable at both that observation and the end of the run. `economy.ts`, `economy-ops.ts` and `ridership.ts` retain separate controls for existing rail and bus economics; the fixed income controls use a ±15% tolerance.

The company capacity stress test injects its artificial crowd at the monthly decision, after normal queue abandonment, and freezes business decisions during its separate double-track physics observation. The HSR speed fixture uses towns at least 3.4 km apart: walking-aware stations can shorten the actual railway substantially, so a shorter corridor cannot reach its unchanged 160 km/h assertion under real acceleration and braking.

Urban scenarios advance committed simulation ticks. The company save comparison likewise advances exactly sixty simulation days in both games; fixed wall-frame counts can release different numbers of ticks under the frame-time budget.

## Measured calibration

The eight-year 768-map sweep used normal AI choices and management. Seed 7 opened one four-stop light railway in Radgate, population 4,113; it earned +0.71M/year at two years. Its largest town finished at 4,340, so it had no qualifying city.

Seed 23 opened three light railways, two in towns already above 5,000. Fairholm's four-stop line opened at population 5,243 and earned **+0.46M/year at two years**, including station and track upkeep; at 6.9 years its revenue is 1.31M and operating surplus +0.39M. The later three-stop Little Thorncliff line opened at population 7,190 and earns +0.92M/year at age 1.2, so it does not yet count toward the two-year maturity target. The earlier four-stop Little Thorncliff line opened at 4,887 and earned +0.68M/year at two years; the population-at-opening rule conservatively excludes it from the city target.

| Purpose-built service | Annual operating profit | Capital payback |
| --- | ---: | ---: |
| 8,000-person town, five-stop light rail | +4.88M | 2.8 years |
| 8,000-person town, five-stop underground metro | +6.47M | 4.4 years |
| Main-line railway with zero walking residents and real car access | +0.50M | — |
| Third-company interchange metro, alongside the shared through tunnel | +4.67M | — |
| Terminus-owner interchange metro | +5.23M | — |

Both tunnel operators' trains reached both outer towns. Usage-share settlements flowed 82.1k one way and 217.9k the other; cash remained 93.0M and 94.8M. The third-company and terminus-owner metros recorded 319 and 326 transferred boardings over the two-year observation. The urban fixtures measure their operating results after exactly two years.

The fixed seed-7 economy fixtures retain their original sites, service and costs. Amounts below are thousands of game money per year. Both income and operating results stay within 15% of the captured walking-catchment baseline.

| Control | Income before → after | Change | Operating result before → after |
| --- | ---: | ---: | ---: |
| Intercity rail | 89.1 → 100.2 | +12.4% | −248.4 → −237.3 |
| Village rail | 207.3 → 228.9 | +10.4% | −157.8 → −136.2 |
| Busy bus | 100.7 → 99.5 | −1.2% | +26.3 → +25.0 |
| Short bus | 8.8 → 9.8 | +11.5% | −25.0 → −24.0 |

The separate three-year 512-map ridership runs change the AI's networks, so their aggregates describe network selection as well as demand. Seed 7 total/rail boardings rise from 588/33 to 990/401, with rail stations increasing from three to eight and rail waiting p90 from 9 to 42. Seed 23 changes from 405/148 to 617/211, with four rail stations becoming two and waiting p90 from 26 to 34. The fixed-service control table above isolates economic balance from those network changes.
