import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const require = createRequire(realpathSync('node_modules/wrangler/package.json'));
await mkdir('.sites-runtime/rossko-tests', { recursive: true });
await require('esbuild').build({ entryPoints: ['lib/rossko-search-controller.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: '.sites-runtime/rossko-tests/search-controller.mjs' });
const { createRosskoSearchController } = await import(pathToFileURL(process.cwd() + '/.sites-runtime/rossko-tests/search-controller.mjs'));
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
let time = 0, id = 0;
const timers = new Map();
const clock = {
  now: () => time,
  setTimer(callback, delay) { const n = ++id; timers.set(n, { at: time + delay, callback }); return n; },
  clearTimer(n) { timers.delete(n); },
  async advance(ms) {
    const target = time + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    time = target; await flush();
  },
};
const calls = [], states = [];
const engine = createRosskoSearchController({ ...clock, changed: state => states.push(state), request: (input, signal) => new Promise((resolve, reject) => calls.push({ input, signal, resolve, reject, at: time })) });
const input = query => ({ supplierId: 'rossko', query });
const result = (query, analogue = false) => ({ query, checkedAt: '2026-10-10T20:00:00Z', supplierName: 'ROSSKO', offers: [{ offerId: 'offer-' + query, code: query, brand: 'KYB', name: 'Стойка', priceCents: 244985, stock: 4, multiplicity: 1, leadDays: 3, type: 0, analogue }] });

engine.queue(input('3')); await clock.advance(1000); assert.equal(calls.length, 0);
engine.queue(input('33')); await clock.advance(400); assert.equal(calls.length, 0);
engine.queue(input('333')); await clock.advance(400); assert.equal(calls.length, 0);
engine.queue(input('333114')); await clock.advance(749); assert.equal(calls.length, 0);
await clock.advance(1); assert.equal(calls.length, 1); assert.deepEqual(calls[0].input, input('333114'));

engine.queue(input('333115')); assert.equal(calls[0].signal.aborted, true);
calls[0].resolve(result('333114')); await flush(); assert.equal(states.at(-1).phase, 'waiting'); assert.equal(states.at(-1).query, '333115'); assert.equal(states.at(-1).result, null);
engine.queue(input('333115'), true, true); await clock.advance(3199); assert.equal(calls.length, 1);
await clock.advance(1); assert.equal(calls.length, 2); assert.ok(calls[1].at - calls[0].at >= 3000);
calls[1].resolve(result('333115', true)); await flush(); assert.equal(states.at(-1).phase, 'success'); assert.equal(states.at(-1).result.offers[0].analogue, true);
engine.queue(input(' 333115 ')); await clock.advance(1000); assert.equal(calls.length, 2); assert.equal(states.at(-1).phase, 'success');

// A suggestion/Enter starts a search immediately when there is a free slot,
// while a repeated Enter cannot issue a duplicate in-flight request.
await clock.advance(30000); engine.queue(input('333116'), true, true); await clock.advance(0); assert.equal(calls.length, 3);
engine.queue(input('333116'), true, true); await clock.advance(0); assert.equal(calls.length, 3);
calls[2].reject(new Error('ROSSKO требует адрес доставки')); await flush(); assert.equal(states.at(-1).phase, 'error'); assert.ok(states.at(-1).error.includes('адрес'));
engine.queue(input('333116')); await clock.advance(10000); assert.equal(calls.length, 3, 'An upstream error must not create an automatic retry loop');

engine.queue(input('333117'), true, true); await clock.advance(0); assert.equal(calls.length, 4);
engine.queue(input('')); assert.equal(calls[3].signal.aborted, true); assert.equal(states.at(-1).phase, 'idle');
calls[3].resolve(result('333117')); await flush(); assert.equal(states.at(-1).phase, 'idle');

engine.recordRequest(); engine.queue(input('333118'), true, true); await clock.advance(3199); assert.equal(calls.length, 4);
await clock.advance(1); assert.equal(calls.length, 5);
const before = states.length; engine.dispose(); assert.equal(calls[4].signal.aborted, true); assert.equal(timers.size, 0);
calls[4].resolve(result('333118')); await flush(); assert.equal(states.length, before);
engine.queue(input('333119')); await clock.advance(10000); assert.equal(calls.length, 5);
console.log('ROSSKO autosearch: partial input, debounce, suggestion/Enter, rate guard, analogues, cache, stale results, honest error, clear and unmount passed.');
