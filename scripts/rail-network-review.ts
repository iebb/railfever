// Due rail improvements finish their finite saved review before a new route survey.
import assert from 'node:assert/strict';
import { flatGame, station, endNode, depotFor, loco, build, free, railOpts, nodeSnap } from './stationlib';
import { roadOpts } from './lib';
import { saveNetwork, loadNetwork, runNetworkTask, networkPlanner } from '../src/game/ai-network';
import { serialize, deserialize } from '../src/game/save';
const g = flatGame(256);
g.addAICompany({startMoney:30e6, focus:{rail:1,road:0,tram:0}});
const ai = g.ais[0], me = ai.companyId;
assert(build(g,free(g,20,119),free(g,230,119),roadOpts(),'Station access'));
const a = station(g,48,128,Math.PI/2,12,2,me)!, b = station(g,200,128,Math.PI/2,12,2,me)!;
assert(a && b);
assert(build(g,nodeSnap(g,endNode(g,a,0,true),'rail'),nodeSnap(g,endNode(g,b,0,false),'rail'),railOpts(me),'Review railway'));
const depot = depotFor(g,a,b,me), line = g.lines.create('rail',me); line.stops=[a.id,b.id];
assert.equal(typeof g.vehicles.buyTrain(depot,loco(),line.id),'object');
(ai as any).lines.set(line.id,{kind:'rail',towns:[],depot,maxVehicles:2,opened:0});
g.lines.rebuild();g.tick=200*g.ticksPerDay;g.aiEnabled=false;
assert(g.stations.hasAccess(a) && g.stations.hasAccess(b));
runNetworkTask(ai,'lines',0);
const state=saveNetwork(g), planner=state.companies[0][1];
planner.next=planner.next.map(([task])=>[task,['join','insert','extend'].includes(task)?g.day:10000]);
planner.job={task:'lines',items:[{ids:[]}],cursor:0,done:0};
loadNetwork(g,state);ai.state.cooldown=0;
ai.daily();
assert(!ai.busy,'finishing an unrelated empty task cannot immediately start a new-project survey');
assert.equal(ai.state.phase,'reviewing rail network');
assert.deepEqual(saveNetwork(g).companies[0][1].expansionReview,['join','insert','extend']);
const data=serialize(g), replay=deserialize(data);assert.equal(JSON.stringify(serialize(replay)),JSON.stringify(data));
// A newly due ordinary task is not appended to the captured review.
for(const world of [g,replay]) {
 const data=saveNetwork(world);data.companies[0][1].next=data.companies[0][1].next.map(([t,d])=>[t,t==='stops'?world.day:d]);loadNetwork(world,data);
}
let chose=false;
for(let day=0;day<18;day++) {
 g.tick+=g.ticksPerDay;replay.tick+=replay.ticksPerDay;
 ai.daily();replay.ais[0].daily();
 assert.equal(JSON.stringify(serialize(g)),JSON.stringify(serialize(replay)),'pending network review replays exactly after loading');
 if(ai.busy){assert.equal(networkPlanner(ai)?.task,null);assert.equal(ai.state.phase,'evaluating projects');chose=true;break;}
}
assert(chose,'the finite review releases the chooser instead of growing indefinitely');
console.log('PASS due rail reviews precede new projects, finite snapshot, immediate save and exact daily replay');
