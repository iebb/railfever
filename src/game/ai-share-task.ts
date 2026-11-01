import type { Station } from './stations';
import type { VehicleModel } from './vehicle-types';

/** A shared-service job keeps its next native work unit and the depot works it has paid for. */
export interface ShareTask {
  version: 1;
  owner: number; a: number; b: number; joinLine: number;
  stage: 'init' | 'access' | 'fund' | 'groundSites' | 'groundNext' | 'groundCommit' | 'groundAfter'
    | 'sideStart' | 'sideSites' | 'sideNext' | 'sideCommit' | 'depot' | 'purchase' | 'done';
  stA?: Station; stB?: Station; ownerName: string; key: string;
  requested: boolean; accessResult: string;
  works: number; cars: VehicleModel[]; firstEdge: number; depot: number;
  route: number[]; station: number; candidates: { id: number; s: number; d?: number }[]; at: number;
  reachesA: boolean;
}

export function newShareTask(owner: number, a: number, b: number, joinLine: number): ShareTask {
  return { version: 1, owner, a, b, joinLine, stage: 'init', ownerName: '', key: '', requested: false,
    accessResult: '', works: 0, cars: [], firstEdge: -1, depot: -1, route: [], station: 0,
    candidates: [], at: 0, reachesA: false };
}
