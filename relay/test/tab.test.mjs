// Real CLI homes talk only to the local test relay. The fixture command stands in for
// the separate payments CLI and lets tests deliver signed events in a different order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { setup, owner, connect } from './helpers.mjs';

const run = promisify(execFile);
const source = readFileSync(new URL('../cli/b2b.mjs', import.meta.url), 'utf8');
async function group(t) {
  const env = await setup(t, { autoTick: false, hosted: true, billing: { freeMessages: 2, freePeriod: 'day' }, limits: { groupPostsPer10Min: 100 } });
  const users = [];
  for (const h of ['anna','tom','mia']) users.push(await owner(env,t,h + '@example.com',h,{ status:503 }));
  const [anna,tom,mia] = users;
  await connect(anna,tom,'Anna');
  await connect(anna,mia,'Anna');
  const g = (await anna.cli('group','new','Trip','tom','mia')).match(/number (\d+)/)[1];
  for (const u of [tom,mia]) env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(u.botId)), Number(g), { byOwner: true });
  const inbox = async u => {
    let out = '';
    for (;;) {
      const next = await u.cli('inbox','--json');
      out += next;
      if (!JSON.parse(next.trim().split('\n').at(-1)).more) return out;
    }
  };
  const sync = () => Promise.all(users.map(inbox));
  await sync();
  const fixture = join(anna.home,'fixture.mjs');
  writeFileSync(fixture, source.replace("  case 'tab': try", `  case 'fixture': {
    const [action, ref, json] = pos, cfg = loadCfg(), g = await api('GET',gpath(ref),null,cfg), event = JSON.parse(json);
    if (action === 'post') { console.log(JSON.stringify(await tabPost(cfg,g.id,event))); break; }
    const audience = Object.fromEntries(g.members.map(m => [m.handle,m.joined_at]));
    const e = tabSign(cfg,g.id,{...event,audience});
    if (action === 'unsigned') e.signature = 'A'.repeat(86);
    await groupSend(g.id,{kind:e.type === 'bill' ? 'tab_bill' : 'tab',text:JSON.stringify(e)});
    console.log(JSON.stringify({id:e.id})); break;
  }
  case 'tab': try`));
  const raw = async (u,action,event) => JSON.parse((await run(process.execPath,[fixture,'fixture',action,g,JSON.stringify(event)], { env: { ...process.env,B2B_HOME:u.home } })).stdout);
  const tab = (u,sub,...args) => u.cli('tab',sub,g,...args);
  const state = async u => JSON.parse(await u.cli('tab',g));
  const agree = async () => {
    const states = await Promise.all(users.map(state));
    for (const s of states.slice(1)) assert.deepEqual(s,states[0]);
    return states[0];
  };
  return { env, anna,tom,mia,g,tab,inbox,sync,state,agree,raw };
}

test('three homes agree on receipt shares, FX, edits, objections and confirmed payments', async t => {
  const { env,anna,tom,mia,g,tab,inbox,sync,state,agree,raw } = await group(t);
  const receipt = join(anna.home,'receipt.json');
  writeFileSync(receipt,JSON.stringify({ items: [{ n:1,name:'Wine',qty:1,price:1000 },{ n:2,name:'Beer',qty:3,price:300 }], extras:{tip:101},total:2001 }));
  const first = JSON.parse(await tab(anna,'add','--items',receipt,'--what','Dinner','--currency','EUR')).id;
  assert.match(await inbox(tom),/What did you have/);
  await inbox(mia);
  await tab(tom,'pick',first,'--items','1,2x2');
  await tab(anna,'pick',first,'--items','1');
  await tab(mia,'pick',first,'--even');
  await sync();
  let s = await agree();
  // Wine splits between Anna and Tom; one unclaimed beer splits three ways. Tip is proportional.
  assert.deepEqual(s.bills[0].shares,{'@anna':633,'@tom':1263,'@mia':105});
  assert.equal(s.bills[0].status,'closed');
  await raw(tom,'signed',{type:'pick',bill:first,absent:true});
  await raw(tom,'signed',{type:'fix',bill:first,place:'Wrong'});
  const unsigned = await raw(tom,'unsigned',{type:'drop',bill:first});
  const actual = JSON.parse(await tab(anna,'history')).find(e => e.id === first);
  const { id,author,at,group:groupId,signature,nonce,audience,...bill } = actual;
  await raw(tom,'signed',bill); // payer differs from the signing author
  await sync();
  assert.deepEqual(await agree(),s);
  assert.ok(!JSON.parse(await tab(anna,'history')).some(e => e.id === unsigned.id), 'an unsigned event never enters local history');
  const other = JSON.parse(await tab(tom,'add','--amount','100','--what','Taxi','--currency','CZK','--rate','0.04')).id;
  await tab(tom,'close',other);
  await sync();
  const foreign = await agree();
  assert.equal(foreign.bills[1].currency,'CZK');
  assert.deepEqual(foreign.balances,{'@anna':1235,'@tom':-997,'@mia':-238});
  await tab(mia,'object',other,'Wrong fare');
  await sync();
  assert.deepEqual((await agree()).balances,s.balances);
  await tab(tom,'fix',other,'--what','Taxi home');
  await sync();
  assert.equal((await agree()).bills[1].status,'closed');
  await tab(tom,'drop',other);
  await sync();
  const p = await raw(tom,'post',{type:'paid',to:'@anna',amount:1200,currency:'EUR'});
  await raw(tom,'signed',{type:'got',paid:p.id});
  await sync();
  assert.deepEqual((await agree()).balances,s.balances);
  await raw(anna,'post',{type:'got',paid:p.id});
  await sync();
  assert.deepEqual((await agree()).balances,{'@anna':168,'@tom':-63,'@mia':-105});
  assert.deepEqual((await state(anna)).plan.map(x => x.amount),[105,63]);
  await tab(mia,'currency','CZK','--rate','25');
  await sync();
  const converted = await agree();
  assert.equal(converted.currency,'CZK');
  assert.equal(Object.values(converted.balances).reduce((a,b) => a+b),0);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'tab' AND next_ring_at IS NOT NULL").get().n,0);
  await assert.rejects(tab(mia,'fix',first,'--what','Other'),/does not fit/);
  await assert.rejects(run(process.execPath,[join(import.meta.dirname,'../cli/b2b.mjs'),'tab','drop',g,first], {env:{...process.env,B2B_HOME:anna.home,B2B_UNATTENDED:'1'}}),/owner needs to say yes/);
});

test('bill fan-out counts once and silent events still work at the limit; history repairs an expired copy', async t => {
  const {env,anna,tom,mia,tab,inbox,sync,agree,state,g} = await group(t);
  const id = JSON.parse(await tab(anna,'add','--amount','9.01','--what','Lunch')).id;
  assert.match(await anna.cli('whoami'),/1\/2 messages sent today/);
  await anna.cli('group','send',g,'Thanks');
  await tab(anna,'close',id);
  assert.match(await anna.cli('whoami'),/2\/2 messages sent today/);
  await assert.rejects(tab(anna,'add','--amount','9','--what','Lunch'),/402/);
  await inbox(tom);
  // Mia sleeps past retention. Remove expired Tab bodies through the relay's own retention worker.
  env.advance(8 * 86400000);
  await env.relay.tick();
  env.relay.retention();
  await inbox(mia);
  assert.equal((await state(mia)).bills.length,0);
  await tab(mia,'resync','--from','tom');
  await inbox(tom);
  await sync();
  assert.deepEqual((await agree()).balances,{'@anna':600,'@tom':-300,'@mia':-300});
  assert.deepEqual(JSON.parse(await tab(mia,'history')), JSON.parse(await tab(anna,'history')));
  // Replay does not reveal old receipts to a new membership.
  const newMember = await owner(env,t,'kim@example.com','kim');
  await connect(anna,newMember,'Anna');
  await anna.cli('group','add',g,'kim');
  env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(newMember.botId)),Number(g),{ byOwner:true });
  await tab(newMember,'resync','--from','tom');
  await inbox(tom); await inbox(newMember);
  assert.deepEqual(JSON.parse(await tab(newMember,'history')),[]);
});
