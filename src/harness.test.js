/**
 * Tests for the harness itself.
 *
 * A tool that tells you whether your agent works is worthless if nobody has
 * checked whether the tool works. All of this runs offline: the "agent" under
 * test is a function that returns whatever the case tells it to, and the judge
 * is a scripted client. No API key, nothing that fails for a reason unrelated
 * to the code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineSuite, runSuite } from './run.js';
import { DEFAULT_GRADERS, contains, absent, matches, toolsCalled, jsonShape, notEmpty, finished, underLatency, safely, textOf } from './graders.js';
import { makeJudge, calibrate } from './judge.js';
import { saveBaseline, loadBaseline, compare } from './baseline.js';

/** An agent that simply echoes whatever the case wants it to say. */
const echo = (input) => ({ output: String(input), stop_reason: 'end_turn' });

const suiteOf = (cases, extra = {}) =>
  defineSuite({ name: 'test-suite', cases, run: echo, concurrency: 2, ...extra });

/* ── graders ────────────────────────────────────────────────────────────── */

test('textOf reads every shape an agent might return', () => {
  assert.equal(textOf('bare string'), 'bare string');
  assert.equal(textOf({ output: 'a' }), 'a');
  assert.equal(textOf({ text: 'b' }), 'b');
  assert.equal(textOf({ draft: 'c' }), 'c');
  assert.equal(textOf(null), '');
  assert.equal(textOf({ nothing: 1 }), '', 'an unknown shape grades as empty, not undefined');
});

test('contains and absent are case-insensitive', () => {
  const c = { expect: { contains: ['Parking'], absent: ['REFUND'] } };
  const r = { output: 'parking is available; no refunds discussed' };
  assert.equal(contains(c, r)[0].pass, true);
  assert.equal(absent(c, r)[0].pass, false, 'absent should catch "refund" inside "refunds"');
});

test('matches and notMatches take regex sources', () => {
  const c = { expect: { matches: ['\\d+ ?€|€ ?\\d+'], notMatches: ['\\bfree\\b'] } };
  assert.equal(matches(c, { output: 'the rate is 240€' })[0].pass, true);
  assert.equal(matches(c, { output: 'it is free' })[1].pass, false);
});

test('toolsCalled checks both directions', () => {
  const c = { expect: { tools: ['get_rate'], toolsNotCalled: ['send_payment'] } };
  const r = { tool_calls: [{ name: 'get_rate' }, { name: 'send_payment' }] };
  const out = toolsCalled(c, r);
  assert.equal(out[0].pass, true);
  assert.equal(out[1].pass, false, 'a forbidden tool that was called must fail');
});

test('jsonShape fails loudly on unparseable output', () => {
  const c = { expect: { jsonKeys: ['intent'] } };
  assert.equal(jsonShape(c, { output: 'not json' })[0].detail, 'did not parse');
  assert.equal(jsonShape(c, { output: '{"intent":"book"}' })[0].pass, true);
  assert.equal(jsonShape(c, { output: '{"other":1}' })[0].pass, false);
});

test('finished only grades agents that report a stop reason', () => {
  assert.deepEqual(finished({}, { output: 'x' }), [], 'no metadata means nothing to hold it to');
  assert.equal(finished({}, { output: 'x', stop_reason: 'max_tokens' })[0].pass, false);
});

test('notEmpty catches the clean finish that returns nothing', () => {
  assert.equal(notEmpty({}, { output: '   ', stop_reason: 'end_turn' })[0].pass, false);
});

test('underLatency prefers the per-case limit', () => {
  const g = underLatency(1000);
  assert.equal(g({ expect: { maxLatencyMs: 50 } }, { latency_ms: 100 })[0].pass, false);
  assert.equal(g({}, { latency_ms: 100 })[0].pass, true);
});

test('a grader that throws fails one check, not the run', () => {
  const bad = () => { throw new Error('boom'); };
  const out = safely(bad)({}, {});
  assert.equal(out[0].pass, false);
  assert.match(out[0].detail, /grader threw: boom/);
});

/* ── the suite contract ─────────────────────────────────────────────────── */

test('a suite refuses duplicate case ids', () => {
  assert.throws(() => suiteOf([{ id: 'a', input: '1' }, { id: 'a', input: '2' }]), /Duplicate case id: a/);
});

test('a suite refuses cases without ids', () => {
  assert.throws(() => suiteOf([{ input: '1' }]), /needs an id/);
});

test('a suite refuses to run without a name', () => {
  assert.throws(() => defineSuite({ cases: [{ id: 'a' }], run: echo }), /needs a name/);
});

/* ── the runner ─────────────────────────────────────────────────────────── */

test('an agent that throws fails that case and nothing else', async () => {
  const suite = defineSuite({
    name: 'throwing',
    cases: [{ id: 'ok', input: 'fine' }, { id: 'boom', input: 'x' }, { id: 'ok2', input: 'fine' }],
    run: (input) => { if (input === 'x') throw new Error('agent exploded'); return { output: input, stop_reason: 'end_turn' }; },
  });
  const rep = await runSuite(suite);
  assert.equal(rep.total, 3);
  assert.equal(rep.passed, 2, 'the other two still ran');
  const boom = rep.results.find((r) => r.id === 'boom');
  assert.equal(boom.pass, false);
  assert.match(boom.error, /agent exploded/);
});

test('results come back in case order whatever the finish order', async () => {
  const suite = defineSuite({
    name: 'ordering',
    concurrency: 4,
    cases: [{ id: 'slow', input: 'a' }, { id: 'fast', input: 'b' }, { id: 'mid', input: 'c' }],
    run: async (input) => {
      await new Promise((res) => setTimeout(res, input === 'a' ? 20 : input === 'c' ? 10 : 0));
      return { output: input, stop_reason: 'end_turn' };
    },
  });
  const rep = await runSuite(suite);
  assert.deepEqual(rep.results.map((r) => r.id), ['slow', 'fast', 'mid']);
});

test('--case filters by id, by prefix and by tag', async () => {
  const cases = [
    { id: 'lang.de', input: 'x', tags: ['language'] },
    { id: 'lang.it', input: 'x', tags: ['language'] },
    { id: 'price.quote', input: 'x', tags: ['money'] },
  ];
  const s = suiteOf(cases);
  assert.equal((await runSuite(s, { filter: 'lang.de' })).total, 1);
  assert.equal((await runSuite(s, { filter: 'lang' })).total, 2, 'prefix');
  assert.equal((await runSuite(s, { filter: 'money' })).total, 1, 'tag');
  await assert.rejects(() => runSuite(s, { filter: 'nope' }), /No case matching/);
});

test('per-check rates are grouped by check family', async () => {
  const suite = suiteOf([
    { id: 'a', input: 'parking and breakfast', expect: { contains: ['parking', 'breakfast'] } },
    { id: 'b', input: 'parking only', expect: { contains: ['parking', 'breakfast'] } },
  ]);
  const rep = await runSuite(suite);
  // contains:parking passed twice, contains:breakfast once — grouped as 3/4.
  assert.deepEqual(rep.byCheck.contains, { pass: 3, total: 4 });
});

/* ── the judge ──────────────────────────────────────────────────────────── */

const judgeClient = (payload) => ({
  messages: {
    create: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    }),
  },
});

test('the judge turns rubric criteria into checks', async () => {
  const judge = makeJudge({
    criteria: [{ id: 'grounded', question: 'Is every claim supported?' }, { id: 'tone', question: 'Is it warm and brief?' }],
    client: judgeClient({ grounded: true, tone: false, note: 'reads like a brochure' }),
  });
  const out = await judge({ id: 'x', input: 'q' }, { output: 'a' });
  assert.equal(out.find((c) => c.name === 'grounded').pass, true);
  assert.equal(out.find((c) => c.name === 'tone').pass, false);
  assert.match(out.find((c) => c.name === 'tone').detail, /brochure/);
});

test('a judge that returns prose fails instead of passing silently', async () => {
  const judge = makeJudge({
    criteria: [{ id: 'grounded', question: 'q' }],
    client: judgeClient('I think this one is pretty good actually.'),
  });
  const out = await judge({ id: 'x', input: 'q' }, { output: 'a' });
  assert.equal(out[0].pass, false);
  assert.match(out[0].detail, /no JSON/);
});

test('a criterion the judge omitted fails rather than defaulting to pass', async () => {
  const judge = makeJudge({
    criteria: [{ id: 'grounded', question: 'q' }, { id: 'tone', question: 'q' }],
    client: judgeClient({ grounded: true }),
  });
  const out = await judge({ id: 'x', input: 'q' }, { output: 'a' });
  assert.equal(out.find((c) => c.name === 'tone').pass, false);
  assert.match(out.find((c) => c.name === 'tone').detail, /omitted/);
});

test('a judge truncated by max_tokens says so', async () => {
  const judge = makeJudge({
    criteria: [{ id: 'grounded', question: 'q' }],
    client: { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"grou' }] }) } },
  });
  const out = await judge({ id: 'x', input: 'q' }, { output: 'a' });
  assert.match(out[0].detail, /max_tokens/);
});

test('a judge whose API call fails does not take the run down', async () => {
  const judge = makeJudge({
    criteria: [{ id: 'grounded', question: 'q' }],
    client: { messages: { create: async () => { throw new Error('429 rate limited'); } } },
  });
  const out = await judge({ id: 'x', input: 'q' }, { output: 'a' });
  assert.equal(out[0].pass, false);
  assert.match(out[0].detail, /429/);
});

test('makeJudge refuses an empty rubric', () => {
  assert.throws(() => makeJudge({ criteria: [] }), /at least one criterion/);
});

/* ── calibration ────────────────────────────────────────────────────────── */

test('calibration counts false passes separately from false fails', () => {
  const cal = calibrate([
    { label: true, judgePass: true },
    { label: false, judgePass: false },
    { label: false, judgePass: true },   // false pass — the dangerous one
    { label: true, judgePass: false },   // false fail — only wastes time
  ]);
  assert.equal(cal.labelled, 4);
  assert.equal(cal.agreement, 0.5);
  assert.equal(cal.falsePass, 1);
  assert.equal(cal.falseFail, 1);
});

test('a judge with any false pass is never called trustworthy', () => {
  const rows = Array.from({ length: 20 }, () => ({ label: true, judgePass: true }));
  rows.push({ label: false, judgePass: true });
  const cal = calibrate(rows);
  assert.ok(cal.agreement > 0.9, 'agreement is high');
  assert.equal(cal.trustworthy, false, 'but one false pass disqualifies it');
});

test('calibration needs enough labels to mean anything', () => {
  const cal = calibrate([{ label: true, judgePass: true }, { label: false, judgePass: false }]);
  assert.equal(cal.agreement, 1);
  assert.equal(cal.trustworthy, false, 'two labels is not evidence');
});

test('calibration is null when nothing was labelled', () => {
  assert.equal(calibrate([{ judgePass: true }, { judgePass: false }]), null);
});

/* ── baselines ──────────────────────────────────────────────────────────── */

const report = (cases, byCheck = {}) => ({
  suite: 'cmp', at: '2026-10-26T10:00:00.000Z',
  passed: cases.filter((c) => c.pass).length, total: cases.length, byCheck, byTag: {},
  results: cases.map((c) => ({ id: c.id, pass: c.pass, checks: (c.failed ?? []).map((n) => ({ name: n, pass: false })) })),
});

test('a broken case is a regression even when the rate improves', () => {
  const base = report([{ id: 'a', pass: true }, { id: 'b', pass: false }, { id: 'c', pass: false }]);
  const now = report([{ id: 'a', pass: false, failed: ['tone'] }, { id: 'b', pass: true }, { id: 'c', pass: true }]);
  const cmp = compare(now, { cases: Object.fromEntries(base.results.map((r) => [r.id, { pass: r.pass, failed: [] }])) });
  assert.equal(cmp.verdict, 'regressed', '2/3 beats 1/3, but case a broke');
  assert.deepEqual(cmp.broke.map((b) => b.id), ['a']);
  assert.deepEqual(cmp.fixed.map((f) => f.id), ['b', 'c']);
});

test('nothing broken and something fixed is an improvement', () => {
  const cmp = compare(
    report([{ id: 'a', pass: true }, { id: 'b', pass: true }]),
    { cases: { a: { pass: true, failed: [] }, b: { pass: false, failed: ['tone'] } } },
  );
  assert.equal(cmp.verdict, 'improved');
});

test('the same cases passing is unchanged, not an improvement', () => {
  const cmp = compare(report([{ id: 'a', pass: true }]), { cases: { a: { pass: true, failed: [] } } });
  assert.equal(cmp.verdict, 'unchanged');
});

test('a case absent from the baseline is reported, never counted as fixed', () => {
  const cmp = compare(report([{ id: 'a', pass: true }, { id: 'new', pass: true }]), { cases: { a: { pass: true, failed: [] } } });
  assert.deepEqual(cmp.newCases, ['new']);
  assert.equal(cmp.fixed.length, 0);
});

test('check movement is sorted worst-first', () => {
  const cmp = compare(
    report([{ id: 'a', pass: true }], { tone: { pass: 5, total: 10 }, grounded: { pass: 9, total: 10 } }),
    { cases: { a: { pass: true, failed: [] } }, byCheck: { tone: { pass: 9, total: 10 }, grounded: { pass: 8, total: 10 } } },
  );
  assert.equal(cmp.checkDeltas[0].name, 'tone', 'the drop is listed before the gain');
  assert.ok(cmp.checkDeltas[0].delta < 0);
});

test('no baseline is its own verdict, not a pass', () => {
  assert.equal(compare(report([{ id: 'a', pass: true }]), null).verdict, 'no-baseline');
});

test('a baseline round-trips through disk without the generated outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-evals-'));
  try {
    const rep = await runSuite(suiteOf([{ id: 'a', input: 'hello', expect: { contains: ['hello'] } }]));
    const p = saveBaseline(rep, { dir });
    const loaded = loadBaseline('test-suite', { dir });
    assert.equal(loaded.cases.a.pass, true);
    assert.equal(JSON.stringify(loaded).includes('hello'), false,
      'baselines carry verdicts, not generated text — they have to be readable in a diff');
    assert.ok(p.endsWith('test-suite.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing baseline file loads as null rather than throwing', () => {
  assert.equal(loadBaseline('never-run', { dir: '/nonexistent-dir-for-tests' }), null);
});

/* ── end to end ─────────────────────────────────────────────────────────── */

test('a full run grades, compares and reports in one pass', async () => {
  const suite = defineSuite({
    name: 'e2e',
    cases: [
      { id: 'good', input: 'Parking is 18 euro a night.', tags: ['facts'], expect: { contains: ['parking'], notMatches: ['\\bfree\\b'] } },
      { id: 'bad', input: 'Parking is free.', tags: ['facts'], expect: { contains: ['parking'], notMatches: ['\\bfree\\b'] } },
    ],
    run: echo,
    graders: DEFAULT_GRADERS,
  });

  const rep = await runSuite(suite);
  assert.equal(rep.passed, 1);
  assert.equal(rep.total, 2);
  assert.equal(rep.rate, 0.5);
  assert.deepEqual(rep.byTag.facts, { pass: 1, total: 2 });
  assert.equal(rep.calibration, null, 'no judge means no calibration');

  const failing = rep.results.find((r) => r.id === 'bad');
  assert.ok(failing.checks.some((c) => !c.pass && c.name.startsWith('notMatches')));
});
