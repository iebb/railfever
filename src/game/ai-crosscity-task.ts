import type { Town } from './towns';
import type { Station, StationPlan } from './stations';
import type { NNode } from './network';
import type { Line } from './lines';
import type { AIChainCursor } from './ai-chain-job';

export interface CityTerminus { st: Station; line: Line; path: number[]; towns: number[]; side: 1 | -1 }
export interface CrossCityEconomics {
  cost: number; revenue: number; yearly: number; net: number; share: number; viable: boolean; gainA: number; gainB: number;
}
export interface CrossCityTask {
  version: 1; town: Town;
  stage: 'init' | 'survey' | 'inspect' | 'surveyNext' | 'fund' | 'tunnels' | 'chain' | 'throats' | 'settle' | 'done';
  a?: CityTerminus; b?: CityTerminus; na?: NNode; nb?: NNode;
  ea: number[]; eb: number[]; angle: number; platform: number; type: string;
  candidate: number; siteX: number; siteZ: number; proposal?: StationPlan; centrePlan: StationPlan | null; bestPopulation: number;
  partner: number; economics?: CrossCityEconomics; centre?: Station;
  links: { from: number; to: number; owner: number }[]; at: number;
  link?: { firstEdge: number; before: number; chain: AIChainCursor };
  throat: boolean;
}
export function newCrossCityTask(town: Town): CrossCityTask {
  return { version: 1, town, stage: 'init', ea: [], eb: [], angle: 0, platform: 0, type: 'standard',
    candidate: 0, siteX: 0, siteZ: 0, centrePlan: null, bestPopulation: -1, partner: -1, links: [], at: 0, throat: false };
}
