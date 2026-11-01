// A conservative index must never suppress the native routed transfer leg or its fare history.
import { strict as assert } from 'node:assert';
import { forecastReachIndex } from '../src/game/forecast-reach';
import { forecastTransferJourney } from '../src/game/demand';
import type { Hop } from '../src/game/lines';
import { WALK_LINE } from '../src/game/stations';

type Tables = Map<number, Map<number, Hop>>;
let checked=0, rejected=0, passengers=0;
const bytes=(tables:Tables)=>JSON.stringify([...tables].map(([id,row])=>[id,[...row]]));
function verify(tables:Tables, targets:number[], line:number) {
  const before=bytes(tables), index=forecastReachIndex(tables,targets,line);
  assert(index);
  for(const from of [...tables.keys(),123456789])for(const to of targets) {
    const original=forecastTransferJourney(tables,from,to,line,l=>l%2===0,(a,b)=>Math.abs(a-b)*3.125,(a,b)=>a===b&&a%3===0);
    const selected=index.hasFrom(from)&&index.has(from,to) ? original : [];
    assert.deepEqual(selected,original,`lost native transfer ${from}->${to} on ${line}`);
    checked++;if(!index.has(from,to))rejected++;if(original.length)passengers++;
  }
  assert.equal(bytes(tables),before,'building/reading index mutated hop tables');
  return index;
}
const chain:Tables=new Map([1,2,3,4,5].map(id=>[id,new Map<number,Hop>()]));
for(const [from,to,line] of [[1,2,8],[2,3,WALK_LINE],[3,4,42],[4,5,9]])chain.get(from)!.set(5,{line,alight:to,cost:10});
const indexed=verify(chain,[1,2,3,4,5,999],42);assert(indexed.has(1,5),'a middle proposed ride after a walking change must survive');
assert(forecastTransferJourney(chain,1,5,42,()=>true,()=>23).length>0);
chain.get(3)!.set(5,{line:10,alight:4,cost:10});
const changed=verify(chain,[1,2,3,4,5],42);assert(!changed.has(1,5),'new quote observes changed chosen line');assert(indexed.has(1,5),'earlier disposable index is an isolated snapshot');
// Missing suffixes, self hops and cycles stay conservative; the literal walker still decides completion.
const cycle:Tables=new Map([[1,new Map([[3,{line:42,alight:2,cost:1}]])],[2,new Map([[3,{line:7,alight:1,cost:1}]])]]);
verify(cycle,[1,2,3],42);
let state=0x917bc2;
const random=(n:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
for(let trial=0;trial<700;trial++) {
  const ids=Array.from({length:1+random(12)},(_,i)=>i%2?-i*13:i*100003),targets=[...ids,777777];
  const tables:Tables=new Map(ids.map(id=>[id,new Map<number,Hop>()]));
  for(const from of ids)for(const to of targets)if(random(5))tables.get(from)!.set(to,{line:[42,7,8,WALK_LINE][random(4)],alight:targets[random(targets.length)],cost:random(300),lines:[42,7]});
  verify(tables,targets,[42,7,WALK_LINE,987][random(4)]);
}
verify(new Map(),[0,1],42);
const large:Tables=new Map(Array.from({length:1025},(_,id)=>[id,new Map<number,Hop>()]));
assert.equal(forecastReachIndex(large,large.keys(),42),undefined,'oversized optional work uses literal fallback');
assert(checked>30000&&rejected>10000&&passengers>0);
console.log(`PASS ${checked} native routed-transfer comparisons, ${rejected} proven non-users, ${passengers} retained routed legs; graph edits/cycles/missing suffixes/negative IDs/cap fallback/purity`);
