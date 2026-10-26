import { DEFAULT_GRADERS, safely, textOf } from './graders.js';
import { calibrate } from './judge.js';

/**
 * Run a suite of cases against an agent and grade every output.
 *
 * The harness knows nothing about your agent. You give it `run(input)` and it
 * calls that; whatever comes back is passed to the graders. An agent that
 * returns a bare string is graded on its text, one that returns
 * `{ output, tool_calls, usage, stop_reason }` is graded on all of it.
 *
 * Nothing here throws on a case failing — a thrown agent is a failed case with
 * the error recorded, because a suite that dies on case 3 tells you nothing
 * about cases 4 to 42.
 */

export function defineSuite({ name, cases, run, graders = DEFAULT_GRADERS, judge = null, concurrency = 4 }) {
  if (!name) throw new Error('A suite needs a name — baselines are stored under it.');
  if (typeof run !== 'function') throw new Error('A suite needs a run(input) function.');
  if (!Array.isArray(cases) || !cases.length) throw new Error('A suite needs at least one case.');

  const seen = new Set();
  for (const c of cases) {
    if (!c.id) throw new Error('Every case needs an id.');
    if (seen.has(c.id)) throw new Error(`Duplicate case id: ${c.id}`);
    seen.add(c.id);
  }

  return { name, cases, run, graders, judge, concurrency };
}

/** Bounded parallelism. Results come back in input order regardless of finish order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function runCase(suite, c) {
  const started = Date.now();
  let result, error = null;

  try {
    result = await suite.run(c.input, c);
  } catch (err) {
    error = String(err?.message ?? err);
  }

  if (error !== null) {
    return {
      id: c.id, tags: c.tags ?? [], label: c.labels?.pass, error,
      checks: [{ name: 'ran', pass: false, detail: error }],
      pass: false, latency_ms: Date.now() - started, usage: null, output: '',
    };
  }

  const latency = result?.latency_ms ?? Date.now() - started;
  const withLatency = (result && typeof result === 'object') ? { ...result, latency_ms: latency } : result;

  const checks = [];
  for (const g of suite.graders) checks.push(...safely(g)(c, withLatency));

  // The judge runs last and separately, so a model failure is visibly a judge
  // failure rather than something blamed on the agent.
  let judgeChecks = [];
  if (suite.judge) {
    judgeChecks = await safely(suite.judge)(c, withLatency);
    checks.push(...judgeChecks);
  }

  return {
    id: c.id,
    tags: c.tags ?? [],
    label: c.labels?.pass,
    error: null,
    checks,
    pass: checks.every((x) => x.pass),
    judgePass: suite.judge ? judgeChecks.every((x) => x.pass) : undefined,
    latency_ms: latency,
    usage: result?.usage ?? null,
    output: textOf(withLatency),
  };
}

export async function runSuite(suite, { filter = null } = {}) {
  let cases = suite.cases;
  if (filter) cases = cases.filter((c) => c.id === filter || c.id.startsWith(filter) || (c.tags ?? []).includes(filter));
  if (!cases.length) throw new Error(`No case matching "${filter}".`);

  const t0 = Date.now();
  const results = await pool(cases, suite.concurrency, (c) => runCase(suite, c));

  const passed = results.filter((r) => r.pass).length;

  // Per-check pass rates, which is where a regression actually shows itself.
  // "38/42" moves for many reasons; "grounded 31/42, was 40/42" names one.
  const byCheck = {};
  for (const r of results) {
    for (const c of r.checks) {
      const key = c.name.split(':')[0];
      byCheck[key] ??= { pass: 0, total: 0 };
      byCheck[key].total += 1;
      if (c.pass) byCheck[key].pass += 1;
    }
  }

  const byTag = {};
  for (const r of results) {
    for (const t of r.tags) {
      byTag[t] ??= { pass: 0, total: 0 };
      byTag[t].total += 1;
      if (r.pass) byTag[t].pass += 1;
    }
  }

  const usage = results.reduce((a, r) => ({
    input: a.input + (r.usage?.input ?? 0),
    output: a.output + (r.usage?.output ?? 0),
    cache_read: a.cache_read + (r.usage?.cache_read ?? 0),
  }), { input: 0, output: 0, cache_read: 0 });

  return {
    suite: suite.name,
    at: new Date().toISOString(),
    passed,
    total: results.length,
    rate: results.length ? passed / results.length : 0,
    duration_ms: Date.now() - t0,
    usage,
    byCheck,
    byTag,
    calibration: suite.judge ? calibrate(results) : null,
    results,
  };
}
