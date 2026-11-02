import type { Station } from './stations';
import type { VehicleModel } from './vehicle-types';
import type { ShareBid, PhysicalWitness } from './ai-share-options';

/** A shared-service job keeps its next native work unit and the depot works it has paid for. */
export interface ShareTask {
  version: 1;
  owner: number; a: number; b: number; joinLine: number;
  stage: 'init' | 'access' | 'fund' | 'groundSites' | 'groundNext' | 'groundCommit' | 'groundAfter'
    | 'bidProof' | 'bidFund' | 'bidBuild' | 'bidOpening' | 'sideStart' | 'sideSites' | 'sideNext' | 'sideCommit' | 'depot' | 'purchase' | 'done';
  stA?: Station; stB?: Station; ownerName: string; key: string;
  requested: boolean; accessResult: string;
  works: number; cars: VehicleModel[]; firstEdge: number; depot: number;
  route: number[]; station: number; candidates: { id: number; s: number; d?: number }[]; at: number;
  reachesA: boolean;
  bid?: ShareBid; proofAt?: number; proofFor?: 'fund' | 'purchase'; proof?: PhysicalWitness; bidEdges?: number[]; opening?: number;
}

export function newShareTask(owner: number, a: number, b: number, joinLine: number, bid?: ShareBid): ShareTask {
  return { version: 1, owner, a, b, joinLine, stage: 'init', ownerName: '', key: '', requested: false,
    accessResult: '', works: 0, cars: [], firstEdge: -1, depot: -1, route: [], station: 0,
    candidates: [], at: 0, reachesA: false, ...(bid ? { bid } : {}) };
}
