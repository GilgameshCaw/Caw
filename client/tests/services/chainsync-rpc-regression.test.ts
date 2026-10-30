// Mocha regression tests; included by the existing tests/**/*.test.ts command.
// Real source functions run in a VM with fake time and no service imports.
import { it as test } from 'mocha';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { FetchRequest, JsonRpcProvider, Network } from 'ethers';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

class Clock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { fn: () => void; due: number; interval: number }>();
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms, 0);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clear = (id: number) => this.timers.delete(id);
  add(fn: () => void, ms: number, interval: number) {
    const id = this.nextId++;
    this.timers.set(id, { fn, due: this.now + ms, interval });
    return id;
  }
  async flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  }
  async advance(ms: number) {
    const target = this.now + ms;
    await this.flush();
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else this.timers.delete(id);
      timer.fn();
      await this.flush();
    }
    this.now = target;
    await this.flush();
  }
}

function loadSelected(relativePath: string, names: string[], expose: string[], clock: Clock,
  globals: Record<string, unknown> = {}, optionalNames: string[] = []): any {
  const filename = path.resolve(testDirectory, '../..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const selected: string[] = [];
  for (const node of ast.statements) {
    const declared = ts.isFunctionDeclaration(node) ? [node.name?.text]
      : ts.isVariableStatement(node)
        ? node.declarationList.declarations.map(d => d.name.getText(ast)) : [];
    if (declared.some(name => typeof name === 'string' && [...names, ...optionalNames].includes(name))) {
      for (const name of declared) if (typeof name === 'string' && names.includes(name)) found.add(name);
      selected.push(node.getText(ast));
    }
  }
  assert.deepEqual([...found].sort(), [...names].sort(), 'source extraction must find every dependency');
  const input = selected.join('\n').replace(/\bexport\s+/g, '')
    + `\n globalThis.subject = { ${expose.join(',')} };`;
  const js = ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({
    Date: class extends Date {
      constructor(value?: number | string) { super(value ?? clock.now); }
      static now() { return clock.now; }
    },
    AbortController, activeTaskRuns: new Map(),
    setTimeout: clock.setTimeout, setInterval: clock.setInterval,
    clearTimeout: clock.clear, clearInterval: clock.clear,
    console: { log() {}, warn() {}, error() {} },
    ...globals,
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(js, context, { timeout: 1000 });
  return context.subject;
}

function scheduler(clock: Clock) {
  return loadSelected('src/services/ChainSyncService/index.ts',
    ['startTask', 'stopTask'], ['startTask', 'stopTask'], clock);
}

function rpc(clock: Clock) {
  return loadSelected('src/utils/rpcProvider.ts', [
    'MIN_CALL_GAP_MS', 'nextSlotAt', 'throttle', 'rateLimitedUntil',
    'backoffMs', 'consecutiveSuccesses', 'consecutiveMaxBackoffs',
    'MAX_BACKOFF_MS', 'SUCCESSES_BEFORE_BACKOFF_RESET',
    'MAX_BACKOFFS_BEFORE_CIRCUIT_OPEN', 'CIRCUIT_OPEN_MS',
    'recordRateLimit', 'clearRateLimit', 'isRateLimited', 'waitForRateLimit',
    'isRateLimitError', 'BLOCK_NUMBER_TTL_MS', 'blockNumberCache',
    'getProviderUrl', 'wrapDestroy', 'wrapSend',
  ], ['wrapSend', 'recordRateLimit', 'isRateLimited'], clock);
}

test('control: completed sync runs again and stopped timer stays stopped', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let calls = 0;
  let beats = 0;
  const task = { name: 'L2Events', interval: 60000, sync: async () => { calls++; } };
  subject.startTask(task, () => beats++);
  await clock.advance(60000);
  assert.equal(calls, 2);
  assert.equal(beats, 2);
  subject.stopTask(task);
  await clock.advance(120000);
  assert.equal(calls, 2);
});

test('regression: slow L2 sync must not overlap the next scheduled sync', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const task = { name: 'L2Events', interval: 60000, sync: async () => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await new Promise<void>(resolve => clock.setTimeout(resolve, 90000));
    active--;
  } };
  subject.startTask(task, () => {});
  await clock.advance(61000);
  subject.stopTask(task);
  assert.equal(maximum, 1, `concurrent syncs=${maximum}; starts=${calls}`);
});

test('control: a rate-limit wait delays the mocked RPC until its deadline', async () => {
  const clock = new Clock();
  const subject = rpc(clock);
  const sent: number[] = [];
  const provider = subject.wrapSend({ send: async () => { sent.push(clock.now); return 'ok'; } });
  subject.recordRateLimit();
  const pending = provider.send('eth_getLogs', []);
  await clock.advance(4999);
  assert.deepEqual(sent, []);
  await clock.advance(1);
  assert.equal(await pending, 'ok');
  assert.deepEqual(sent, [5000]);
});

test('regression: an extended rate-limit deadline must delay already waiting RPCs', async () => {
  const clock = new Clock();
  const subject = rpc(clock);
  const sent: number[] = [];
  const provider = subject.wrapSend({ send: async () => { sent.push(clock.now); return 'ok'; } });
  subject.recordRateLimit(); // deadline 5000
  const pending = provider.send('eth_getLogs', []);
  await clock.advance(1000);
  subject.recordRateLimit(); // extended deadline 11000
  await clock.advance(4000);
  const premature = sent.slice();
  await clock.advance(6000);
  await pending;
  assert.deepEqual(premature, [], `request escaped the extended cooldown at ${premature}ms`);
  assert.deepEqual(sent, [11000]);
});

test('sync guard is released after rejection so the next tick can recover', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let calls = 0;
  let beats = 0;
  const task = { name: 'L2Events', interval: 60000, sync: async () => {
    if (++calls === 1) throw new Error('mock RPC failure');
  } };
  subject.startTask(task, () => beats++);
  await clock.advance(60000);
  subject.stopTask(task);
  assert.equal(calls, 2);
  assert.equal(beats, 1);
});

test('a rate limit set while queued in the throttle is respected before send', async () => {
  const clock = new Clock();
  const subject = rpc(clock);
  const sent: number[] = [];
  const provider = subject.wrapSend({ send: async () => { sent.push(clock.now); return 'ok'; } });
  const first = provider.send('eth_getLogs', []);
  await clock.flush();
  const second = provider.send('eth_getLogs', []);
  await clock.flush();
  subject.recordRateLimit();
  await clock.advance(150);
  assert.deepEqual(sent, [0]);
  await clock.advance(4850);
  await Promise.all([first, second]);
  assert.deepEqual(sent, [0, 5000]);
});


function httpFactory(clock: Clock) {
  return loadSelected('src/utils/rpcProvider.ts', [
    'makeJsonRpcProvider', 'buildAuthenticatedFetchRequest', 'extractEmbeddedAuth', 'basicAuthHeader',
  ], ['makeJsonRpcProvider'], clock, {
    FetchRequest, JsonRpcProvider, Network, URL, Buffer,
    wrapSend: (provider: unknown) => provider,
  }, ['withHttpRequestTimeout']);
}

test('HTTP deadline: the actual ethers request clone has a bounded timeout and is cancelled', async () => {
  const clock = new Clock();
  const subject = httpFactory(clock);
  const provider = subject.makeJsonRpcProvider('https://rpc.invalid', 84532, undefined, 30000);
  try {
    const request = provider._getConnection();
    let signal: { cancelled: boolean } | undefined;
    let release!: (value: unknown) => void;
    request.getUrlFunc = (_request: unknown, cancelSignal: { cancelled: boolean }) => {
      signal = cancelSignal;
      return new Promise(resolve => { release = resolve; });
    };
    const outcome = request.send().then(() => 'response', (err: any) => err.code);
    await clock.advance(30000);
    assert.equal(request.timeout, 30000);
    assert.equal(await outcome, 'TIMEOUT');
    assert.equal(signal?.cancelled, true, 'the real FetchCancelSignal must be cancelled');
    release({ statusCode: 200, statusMessage: 'OK', headers: {}, body: new Uint8Array() });
    await clock.flush();
    assert.equal(await outcome, 'TIMEOUT', 'a late transport response cannot become success');
    assert.equal(clock.timers.size, 0, 'deadline timer must be cleaned up');
  } finally { provider.destroy(); }
});

test('HTTP deadline: fast requests clear their timer and other providers retain the default', async () => {
  const clock = new Clock();
  const subject = httpFactory(clock);
  const bounded = subject.makeJsonRpcProvider('https://rpc.invalid', 84532, undefined, 30000);
  const unchanged = subject.makeJsonRpcProvider('https://rpc.invalid', 84532);
  try {
    const request = bounded._getConnection();
    request.getUrlFunc = async () => ({ statusCode: 200, statusMessage: 'OK', headers: {}, body: new Uint8Array() });
    assert.equal((await request.send()).statusCode, 200);
    assert.equal(request.timeout, 30000);
    assert.equal(unchanged._getConnection().timeout, 300000);
    assert.equal(clock.timers.size, 0);
  } finally { bounded.destroy(); unchanged.destroy(); }
});

test('restart guard: a replacement with the same task name cannot overlap a stopped pass', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let release!: () => void;
  let calls = 0;
  const old = { name: 'L2Events', interval: 60000, sync: async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
  } };
  subject.startTask(old, () => {});
  await clock.flush();
  const stopped = subject.stopTask(old);
  const replacement = { name: 'L2Events', interval: 60000, sync: async () => { calls++; } };
  subject.startTask(replacement, () => {});
  await clock.flush();
  const beforeRelease = calls;
  release();
  await stopped;
  await clock.advance(60000);
  await subject.stopTask(replacement);
  assert.equal(beforeRelease, 1, 'a task name stays locked until the old pass really exits');
  assert.equal(calls, 2, 'the replacement can run once the old pass has exited');
});

test('restart guard: independent task names can progress while one name is held', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let release!: () => void;
  let clients = 0;
  const held = { name: 'L2Events', interval: 60000, sync: () => new Promise<void>(r => { release = r; }) };
  const other = { name: 'Clients', interval: 60000, sync: async () => { clients++; } };
  subject.startTask(held, () => {});
  subject.startTask(other, () => {});
  await clock.advance(60000);
  assert.equal(clients, 2);
  release();
  await subject.stopTask(held);
  await subject.stopTask(other);
});

// Execute the real L2 loop, cursor/session handlers and runServices watchdog.
// The only provider and Prisma objects are in-memory mocks; no app imports.
function lifecycle(clock: Clock, boundedHttp = false, pauseWrite = false) {
  let cursor = 100;
  const writes: number[] = [];
  const sessions = new Map<string, any>();
  const starts: number[] = [];
  const stops: number[] = [];
  const beats: number[] = [];
  let hold = !pauseWrite;
  let releaseWrite!: () => void;
  let injectedSpend = false;
  let disconnectCalls = 0;
  const args = (key: string) => ({ owner: 'owner', sessionKey: key, expiry: 1000,
    scopeBitmap: 255, spendLimit: '100', perActionTipRate: '0' });
  const events: Record<string, any[]> = {
    created: [
      { blockNumber: 110, index: 0, args: args('b') },
      { blockNumber: 115, index: 0, args: args('a') },
    ],
    revoked: [{ blockNumber: 200, index: 0, args: args('b') }],
    authed: [],
  };
  const prisma = {
    chainData: {
      findUnique: async () => ({ value: { block: cursor } }),
      upsert: async ({ update }: any) => {
        cursor = update.value.block;
        writes.push(cursor);
        // A separate API write after indexing; a replay must not zero it.
        if (cursor === 400 && !injectedSpend) {
          sessions.get('owner:a').spent = '7';
          injectedSpend = true;
        }
      },
    },
    sessionKey: {
      upsert: async ({ where, update, create }: any) => {
        const id = where.ownerAddress_sessionAddress;
        const key = `${id.ownerAddress}:${id.sessionAddress}`;
        if (pauseWrite && key === 'owner:b') {
          await new Promise<void>(resolve => { releaseWrite = resolve; });
        }
        sessions.set(key, sessions.has(key) ? { ...sessions.get(key), ...update }
          : { revokedAt: null, spent: '0', ...create });
      },
      updateMany: async ({ where, data }: any) => {
        const key = `${where.ownerAddress}:${where.sessionAddress}`;
        const row = sessions.get(key);
        if (row && row.revokedAt === null) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    user: { findFirst: async () => null },
    networkAuth: { upsert: async () => {} },
    network: { count: async () => 0 },
    $disconnect: async () => { disconnectCalls++; },
  };
  const http = boundedHttp ? httpFactory(clock).makeJsonRpcProvider('https://rpc.invalid', 84532, undefined, 30000) : null;
  const provider = { getBlockNumber: async () => clock.now < 120000 ? 100 : clock.now < 160000 ? 125 : 400 };
  class MockContract {
    filters = { SessionCreated: () => 'created', SessionRevoked: () => 'revoked', Authenticated: () => 'authed' };
    async queryFilter(kind: string, from: number, to: number) {
      if (hold) {
        hold = false;
        if (http) {
          const request = http._getConnection();
          request.getUrlFunc = async () => new Promise(resolve => clock.setTimeout(() => {
            resolve({ statusCode: 200, statusMessage: 'OK', headers: {}, body: new Uint8Array() });
          }, 280000));
          await request.send();
        } else {
          // Deliberately ignores cooperative cancellation to test draining.
          await new Promise<void>(resolve => clock.setTimeout(resolve, 280000));
        }
      }
      return events[kind].filter(e => e.blockNumber >= from && e.blockNumber <= to);
    }
  }
  const subject = loadSelected('src/services/ChainSyncService/index.ts', [
    'startTask', 'stopTask', 'registerTask', 'chainSyncService', 'getLastSyncedL2Block', 'setLastSyncedL2Block',
    'handleSessionCreated', 'handleSessionRevoked', 'handleAuthenticated', 'syncL2Events',
  ], ['chainSyncService', 'activeTaskRuns'], clock, {
    prisma, l2Provider: provider, Contract: MockContract,
    CAW_NAMES_L2_ADDRESS: 'ledger', CAW_NAME_L2_EVENT_ABI: [],
    L2_SYNC_BLOCK_KEY: 'cursor', L2_EVENT_BOOTSTRAP_LOOKBACK: 10000, L2_EVENT_CHUNK_SIZE: 2000,
    maybeRebuildProviders: () => {}, syncTasks: new Map(),
    initializeProviders: async () => {}, loadPricesFromDb: async () => {}, syncAllNetworks: async () => {},
    getL1HttpRpcUrl: () => '', getL2HttpRpcUrl: () => '', getEthMainnetHttpRpcUrl: () => '',
    redactRpcUrl: () => '<mock>', cawPriceCache: null, ethPriceCache: null,
  }, ['CHAIN_SYNC_STOP_DRAIN_MS']);
  const watchdog = loadSelected('src/runServices.ts', ['runInstance'], ['runInstance'], clock, {
    DEFAULT_HEARTBEAT_TIMEOUT_MS: 300000, DEGRADED_ESCALATE_FACTOR: 10,
    HEARTBEAT_CHECK_INTERVAL_MS: 30000, RESTART_ALERT_THRESHOLD: 3, RESTART_ALERT_WINDOW_MS: 600000,
    delay: (ms: number) => new Promise<void>(resolve => clock.setTimeout(resolve, ms)),
  });
  const instance = watchdog.runInstance({ instance: 'mock-chain-sync', config: {}, service: {
    start(_config: unknown, ctx: any) {
      starts.push(clock.now);
      const actual = subject.chainSyncService.start({ l1RpcUrl: '', l2RpcUrl: 'mock' }, {
        ...ctx,
        heartbeat(name: string) {
          if (name === 'ChainSync:L2Events') beats.push(clock.now);
          ctx.heartbeat(name);
        },
      });
      return { ...actual, stop: async () => {
        stops.push(clock.now);
        await actual.stop();
      } };
    },
  } });
  return { sessions, writes, starts, stops, beats, cursor: () => cursor, releaseWrite: () => releaseWrite(),
    activeRuns: () => subject.activeTaskRuns.size, disconnectCalls: () => disconnectCalls,
    stop: async () => { await instance.stop(); http?.destroy(); } };
}

test('watchdog regression: held 280s, restart requested at 330s, late response cannot roll back state', async () => {
  const clock = new Clock();
  const state = lifecycle(clock);
  await clock.advance(470000);
  await state.stop();
  assert.deepEqual(state.stops.slice(0, 1), [330000], 'run the real 240s watchdog boundary');
  assert.ok(state.writes.every((block, i, all) => i === 0 || block >= all[i - 1]),
    `cursor regressed: ${state.writes}`);
  assert.equal(state.cursor(), 400);
  assert.ok(state.sessions.get('owner:b')?.revokedAt, 'a stale SessionCreated must not undo revocation');
  assert.equal(state.sessions.get('owner:a')?.spent, '7', 'a late pass must not reset spent');
  assert.deepEqual(state.starts, [0, 395000], 'restart after the 60s drain cap and 5s restart delay');
  assert.ok(!state.beats.includes(400000), 'stopped passes must not report successful progress');
});

test('watchdog latency: bounded HTTP fetch recovers sessions before watchdog expiry and ignores late transport', async () => {
  const clock = new Clock();
  const state = lifecycle(clock, true);
  await clock.advance(180000);
  const indexedAt180s = state.cursor();
  await clock.advance(230000);
  await state.stop();
  assert.equal(indexedAt180s, 400, 'sessions must recover on the next tick after the 30s fetch deadline');
  assert.deepEqual(state.starts, [0], 'one hung HTTP request must not require a watchdog restart');
  assert.equal(state.cursor(), 400);
  assert.ok(state.sessions.get('owner:b')?.revokedAt);
  assert.equal(state.sessions.get('owner:a')?.spent, '7');
  assert.ok(state.writes.every((block, i, all) => i === 0 || block >= all[i - 1]));
});


test('stop boundary: an in-flight database chunk is drained and checkpointed before replacement', async () => {
  const clock = new Clock();
  const state = lifecycle(clock, false, true);
  await clock.advance(120000);
  let stopped = false;
  const stopping = state.stop().then(() => { stopped = true; });
  await clock.flush();
  assert.equal(stopped, false, 'stop must wait for the in-flight write');
  state.releaseWrite();
  await stopping;
  assert.equal(state.cursor(), 125, 'a started chunk must commit its cursor before shutdown');
  assert.ok(state.sessions.has('owner:a'), 'finish the chunk rather than leave a partial replay');
  assert.equal(state.activeRuns(), 0);
  assert.equal(state.disconnectCalls(), 0, 'normal service shutdown must also preserve shared Prisma');
});

test('stop boundary: stopping before the deferred initial call prevents sync from starting', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let calls = 0;
  const task = { name: 'L2Events', interval: 60000, sync: async () => { calls++; } };
  subject.startTask(task, () => {});
  await subject.stopTask(task);
  await clock.advance(120000);
  assert.equal(calls, 0);
});

test('HTTP deadline: real JsonRpcProvider._send uses the bounded clone without network access', async () => {
  const clock = new Clock();
  const subject = httpFactory(clock);
  const provider = subject.makeJsonRpcProvider('https://rpc.invalid', 84532, undefined, 30000);
  const connection = provider._getConnection.bind(provider);
  let observedTimeout = 0;
  provider._getConnection = () => {
    const request = connection();
    request.getUrlFunc = async (req: FetchRequest) => {
      observedTimeout = req.timeout;
      return { statusCode: 200, statusMessage: 'OK', headers: {},
        body: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] })) };
    };
    return request;
  };
  try {
    const result = await provider._send({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [] });
    assert.equal(result[0].id, 1);
    assert.equal(observedTimeout, 30000);
    assert.equal(clock.timers.size, 0);
  } finally { provider.destroy(); }
});

test('HTTP429: queued sends respect both the 5s cooldown and its extension to 15s', async () => {
  const clock = new Clock();
  const subject = rpc(clock);
  const sent: number[] = [];
  const provider = subject.wrapSend({ send: async () => {
    sent.push(clock.now);
    if (sent.length <= 2) throw new Error('HTTP status 429');
    return 'ok';
  } });
  const pending = Array.from({ length: 10 }, () => provider.send('eth_getLogs', []).catch(() => '429'));
  await clock.advance(4999);
  assert.deepEqual(sent, [0]);
  await clock.advance(1);
  assert.deepEqual(sent, [0, 5000]);
  await clock.advance(9999);
  assert.deepEqual(sent, [0, 5000]);
  await clock.advance(2000);
  await Promise.all(pending);
  assert.equal(sent.length, 10);
  assert.ok(sent.slice(2).every(t => t >= 15000));
  assert.ok(sent.every((t, i) => i === 0 || t - sent[i - 1] >= 150));
});

test('HTTP429 transport: real ethers surfaces 429 and the next send waits for the shared cooldown', async () => {
  const clock = new Clock();
  const limiter = rpc(clock);
  const provider = httpFactory(clock).makeJsonRpcProvider('https://rpc.invalid', 84532, undefined, 30000);
  const connection = provider._getConnection.bind(provider);
  let transportCalls = 0;
  provider._getConnection = () => {
    const request = connection();
    request.getUrlFunc = async (req: FetchRequest) => {
      if (++transportCalls === 1) {
        return { statusCode: 429, statusMessage: 'Too Many Requests', headers: {}, body: new Uint8Array() };
      }
      const payload = JSON.parse(new TextDecoder().decode(req.body ?? new Uint8Array()));
      const result = (Array.isArray(payload) ? payload : [payload]).map((item: any) => {
        assert.equal(item.method, 'eth_getLogs');
        return { jsonrpc: '2.0', id: item.id, result: [] };
      });
      return { statusCode: 200, statusMessage: 'OK', headers: {},
        body: new TextEncoder().encode(JSON.stringify(result)) };
    };
    return request;
  };
  try {
    const wrapped = limiter.wrapSend(provider);
    await assert.rejects(wrapped.send('eth_getLogs', []));
    assert.equal(transportCalls, 1, 'do not let ethers immediately resend below wrapSend');
    assert.equal(limiter.isRateLimited(), true);
    const next = wrapped.send('eth_getLogs', []);
    await clock.advance(4999);
    assert.equal(transportCalls, 1);
    await clock.advance(1);
    assert.deepEqual(await next, []);
    assert.equal(transportCalls, 2);
  } finally { provider.destroy(); }
});


test('stop boundary: held writes retain their guard and Prisma across watchdog generations', async () => {
  const clock = new Clock();
  const state = lifecycle(clock, false, true);
  await clock.advance(900000);
  assert.deepEqual(state.starts, [0, 395000, 670000]);
  assert.equal(state.cursor(), 100);
  assert.deepEqual(state.writes, [], 'replacement generations must not write while the old pass is held');
  assert.equal(state.activeRuns(), 1, 'the old pass must retain the shared task-name guard');
  assert.equal(state.disconnectCalls(), 0, 'service stops must never disconnect shared Prisma');
  state.releaseWrite();
  await clock.advance(120000);
  assert.equal(state.cursor(), 400);
  assert.equal(state.activeRuns(), 0, 'release the guard only after the old pass and replacement settle');
  assert.ok(state.writes.every((block, i, all) => i === 0 || block >= all[i - 1]));
  assert.ok(state.sessions.get('owner:b')?.revokedAt);
  assert.equal(state.sessions.get('owner:a')?.spent, '7');
  await state.stop();
  assert.equal(state.disconnectCalls(), 0);
});

function cursorScanner(clock: Clock, layer: 'L1' | 'L2', read: () => Promise<unknown>) {
  const writes: number[] = [];
  const ranges: [number, number][] = [];
  let providerReads = 0;
  const stored = layer === 'L2' ? 10000 : 100000;
  const provider = { getBlockNumber: async () => { providerReads++; return stored + 10; } };
  class EmptyContract {
    filters = new Proxy({}, { get: (_target, key) => () => String(key) });
    async queryFilter(_kind: string, from: number, to: number) {
      ranges.push([from, to]);
      return [];
    }
  }
  const getter = layer === 'L2' ? 'getLastSyncedL2Block' : 'getLastSyncedL1FeeBlock';
  const setter = layer === 'L2' ? 'setLastSyncedL2Block' : 'setLastSyncedL1FeeBlock';
  const sync = layer === 'L2' ? 'syncL2Events' : 'syncL1FeeEvents';
  const subject = loadSelected('src/services/ChainSyncService/index.ts',
    [getter, setter, sync], [getter, sync], clock, {
      prisma: { chainData: {
        findUnique: read,
        upsert: async ({ update }: any) => { writes.push(update.value.block); },
      } },
      l1Provider: provider, l2Provider: provider, Contract: EmptyContract,
      NETWORK_MANAGER_ADDRESS: 'manager', NETWORK_FEE_EVENT_ABI: [],
      CAW_NAMES_L2_ADDRESS: 'ledger', CAW_NAME_L2_EVENT_ABI: [],
      L1_FEE_SYNC_BLOCK_KEY: 'l1-cursor', L1_FEE_EVENT_BOOTSTRAP_LOOKBACK: 50000,
      L1_FEE_EVENT_CHUNK_SIZE: 2000,
      L2_SYNC_BLOCK_KEY: 'l2-cursor', L2_EVENT_BOOTSTRAP_LOOKBACK: 10000,
      L2_EVENT_CHUNK_SIZE: 2000, maybeRebuildProviders: () => {},
    });
  return { stored, writes, ranges, providerReads: () => providerReads,
    read: () => subject[getter](), sync: () => subject[sync]() };
}

for (const layer of ['L1', 'L2'] as const) {
  test(`cursor safety ${layer}: failed read cannot bootstrap or write; recovery resumes the stored position`, async () => {
    const clock = new Clock();
    let fail = true;
    const stored = layer === 'L2' ? 10000 : 100000;
    const state = cursorScanner(clock, layer, async () => {
      if (fail) throw new Error('mock cursor read failure');
      return { value: { block: stored } };
    });
    await assert.rejects(state.sync(), /mock cursor read failure/);
    assert.equal(state.providerReads(), 0, 'fail before any RPC');
    assert.equal(state.ranges.length, 0);
    assert.deepEqual(state.writes, []);
    fail = false;
    await state.sync();
    assert.deepEqual(state.writes, [stored + 10]);
    assert.ok(state.ranges.every(([from]) => from === stored + 1));
  });

  test(`cursor safety ${layer}: malformed persisted positions fail closed`, async () => {
    const clock = new Clock();
    for (const value of [null, {}, { block: '10000' }, { block: -1 },
      { block: 1.5 }, { block: Number.MAX_SAFE_INTEGER + 1 }]) {
      const state = cursorScanner(clock, layer, async () => ({ value }));
      await assert.rejects(state.sync(), /Invalid persisted .* cursor/);
      assert.equal(state.providerReads(), 0);
      assert.deepEqual(state.writes, []);
    }
  });
}

test('cursor controls: only an absent row bootstraps; zero and valid positions remain valid', async () => {
  const clock = new Clock();
  for (const layer of ['L1', 'L2'] as const) {
    const absent = cursorScanner(clock, layer, async () => null);
    assert.equal(await absent.read(), null);
    await absent.sync();
    const lookback = layer === 'L2' ? 10000 : 50000;
    assert.equal(absent.ranges[0][0], absent.stored + 10 - lookback + 1);
    assert.equal(absent.writes.at(-1), absent.stored + 10);
    for (const block of [0, 10000]) {
      const present = cursorScanner(clock, layer, async () => ({ value: { block } }));
      assert.equal(await present.read(), block);
    }
  }
});

test('HTTP deadline boundary: the five-minute circuit wait precedes the HTTP timer', async () => {
  const clock = new Clock();
  const limiter = rpc(clock);
  const provider = httpFactory(clock).makeJsonRpcProvider('https://rpc.invalid', 84532, undefined, 30000);
  const sent: number[] = [];
  for (let i = 0; i < 7; i++) limiter.recordRateLimit();
  const wrapped = limiter.wrapSend({ send: async () => {
    sent.push(clock.now);
    const request = provider._getConnection();
    request.getUrlFunc = async () => ({
      statusCode: 200, statusMessage: 'OK', headers: {}, body: new Uint8Array(),
    });
    return request.send();
  } });
  try {
    const pending = wrapped.send('eth_getLogs', []);
    await clock.advance(30000);
    assert.deepEqual(sent, [], 'the HTTP deadline must not bypass the shared cooldown');
    await clock.advance(270000);
    await pending;
    assert.deepEqual(sent, [300000]);
  } finally { provider.destroy(); }
});
