import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Did the change help?
 *
 * A pass rate on its own cannot answer that. 38/42 against 40/42 looks like a
 * regression and is usually noise; it can also hide a real one, where two
 * cases started passing and two others broke. So the comparison is per case,
 * not per percentage: which cases newly fail, which newly pass, and which
 * check moved.
 *
 * Baselines are committed on purpose. The question "is this better than what
 * we shipped" is only answerable if what we shipped is in the repository.
 */

const DIR = 'baselines';

const pathFor = (suite, dir = DIR) => join(dir, `${suite.replace(/[^\w.-]/g, '_')}.json`);

export function saveBaseline(report, { dir = DIR } = {}) {
  mkdirSync(dir, { recursive: true });
  const slim = {
    suite: report.suite,
    at: report.at,
    passed: report.passed,
    total: report.total,
    byCheck: report.byCheck,
    byTag: report.byTag,
    // Only what a comparison needs. Full outputs live in the run log, which is
    // gitignored — a baseline that carries every generated reply is unreadable
    // in a diff and bloats the repo for no gain.
    cases: Object.fromEntries(report.results.map((r) => [r.id, {
      pass: r.pass,
      failed: r.checks.filter((c) => !c.pass).map((c) => c.name),
    }])),
  };
  const p = pathFor(report.suite, dir);
  writeFileSync(p, JSON.stringify(slim, null, 2) + '\n');
  return p;
}

export function loadBaseline(suiteName, { dir = DIR } = {}) {
  const p = pathFor(suiteName, dir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Compare a run against its baseline.
 *
 * `verdict` is deliberately blunt, because the reason you ran this was to
 * decide whether to keep the change:
 *   regressed  — at least one case that passed now fails. Nothing else matters.
 *   improved   — nothing broke and something newly passes.
 *   unchanged  — same cases pass and fail.
 *   mixed      — cannot happen; a broken case makes it a regression.
 *
 * A case that was already failing and still fails is not news. A case that
 * broke is, even if the headline rate went up.
 */
export function compare(report, baseline) {
  if (!baseline) return { verdict: 'no-baseline', broke: [], fixed: [], checkDeltas: [] };

  const broke = [];
  const fixed = [];
  for (const r of report.results) {
    const was = baseline.cases?.[r.id];
    if (!was) continue;
    if (was.pass && !r.pass) broke.push({ id: r.id, failed: r.checks.filter((c) => !c.pass).map((c) => c.name) });
    if (!was.pass && r.pass) fixed.push({ id: r.id, wasFailing: was.failed });
  }

  const checkDeltas = [];
  for (const [name, now] of Object.entries(report.byCheck)) {
    const before = baseline.byCheck?.[name];
    if (!before) continue;
    const d = (now.pass / now.total) - (before.pass / before.total);
    if (Math.abs(d) > 0.0001) {
      checkDeltas.push({ name, before: `${before.pass}/${before.total}`, now: `${now.pass}/${now.total}`, delta: d });
    }
  }
  checkDeltas.sort((a, b) => a.delta - b.delta);

  const newCases = report.results.filter((r) => !baseline.cases?.[r.id]).map((r) => r.id);

  const verdict = broke.length ? 'regressed' : fixed.length ? 'improved' : 'unchanged';
  return { verdict, broke, fixed, checkDeltas, newCases, baselineAt: baseline.at };
}
