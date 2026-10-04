// Byte-for-byte legacy proof against the same script bundled from 0bceced sources.
// Bundle as choiceidentity.mjs. Copy the baseline bundle to before/choiceidentity.mjs, then run:
// node choiceidentity.mjs --oracle=before/choiceidentity.mjs [--days=900]
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Game } from '../src/game/game';
import { serialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { placeAndConnect, depotBehind, Train, fails } from './lib';

export { serialize };
export function fixture(seed: number) {
  const g=Game.create({size:768,seed,towns:20,hilliness:'hilly',water:'medium',startYear:1980,aiCompanies:3});
  g.economy.money=40_000_000;
  const pr=placeAndConnect(g,80,160,0,new Set(),1,()=>{})??placeAndConnect(g,160,240,0,new Set(),1,()=>{});
  assert(pr,'player railway');const dep=depotBehind(g,pr.A,pr.B,0),l=g.lines.create('rail',0);l.stops=[pr.A.id,pr.B.id];
  assert(g.vehicles.buyTrain(dep,['diesel_b','van_ic','coach_ic','coach_ic'].map(id=>MODEL_BY_ID.get(id)!),l.id) instanceof Train);
  assert.equal(fails.length,0);return g;
}
if(import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(!process.argv[1]?.endsWith('choiceidentity.mjs'))throw new Error('bundle this test as choiceidentity.mjs');
  const flag=(name:string)=>process.argv.find(s=>s.startsWith(`--${name}=`))?.slice(name.length+3);
  const oracle=flag('oracle');assert(oracle,'pass --oracle=before/choiceidentity.mjs');
  const base=await import(pathToFileURL(resolve(oracle)).href),days=Number(flag('days')??900),reports=[];
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  for(const seed of [7,23]) {
    const g=fixture(seed),before=base.fixture(seed),snapshots:{day:number;sha256:string}[]=[];
    const compare=()=>{
      const a=JSON.stringify(serialize(g)),b=JSON.stringify(base.serialize(before));
      if(a!==b){let at=0;while(a[at]===b[at])at++;throw new Error(`seed ${seed}, day ${g.day}: save differs at ${at}: ${a.slice(at,at+160)} vs ${b.slice(at,at+160)}`);}
      snapshots.push({day:g.day,sha256:hash(a)});return a;
    };
    compare();const started=performance.now();
    while(g.day<days){g.stepTick();before.stepTick();assert.equal(g.rng.state,before.rng.state,`seed ${seed}, tick ${g.tick}: RNG`);if(g.tick%(g.ticksPerDay*30)===0)compare();}
    const saved=compare(),original=JSON.stringify(base.serialize(before));
    writeFileSync(`choiceidentity-${seed}-current.json`,saved);writeFileSync(`choiceidentity-${seed}-0bceced.json`,original);
    const report={seed,size:768,days,ticks:g.tick,bytes:Buffer.byteLength(saved),sha256:hash(saved),snapshots:snapshots.length,allTickRngEqual:true,mailActive:g.lines.mailActive,mailDelivered:g.vehicles.all().reduce((n,v)=>n+v.mailDelivered,0),seconds:(performance.now()-started)/1000};
    reports.push({...report,checkpoints:snapshots});console.log('IDENTICAL '+JSON.stringify(report));
  }
  writeFileSync('choiceidentity-results.json',JSON.stringify(reports,null,2)+'\n');console.log('ALL CHECKS PASSED');
}
