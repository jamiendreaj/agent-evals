#!/usr/bin/env node
/**
 * agent-evals <suite-file> [options]
 *
 *   --case <id>    run one case, or every case whose id starts with this,
 *                  or every case carrying this tag
 *   --save         record this run as the baseline
 *   --no-judge     skip the model judge (free, and offline)
 *   --json         print the report as JSON instead
 *
 * Exit code is 1 on any failure or regression, so CI can gate on it.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runSuite } from '../src/run.js';
import { saveBaseline, loadBaseline, compare } from '../src/baseline.js';
import { printRun, printComparison } from '../src/report.js';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const has = (n) => args.includes(`--${n}`);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--case');

if (!file) {
  console.error('usage: agent-evals <suite-file> [--case id] [--save] [--no-judge] [--json]');
  process.exit(2);
}

const mod = await import(pathToFileURL(resolve(file)).href);
const suite = mod.default ?? mod.suite;
if (!suite?.name) {
  console.error(`${file} must export a suite (default export, or a named export "suite").`);
  process.exit(2);
}

if (has('no-judge')) suite.judge = null;
if (suite.judge && !process.env.ANTHROPIC_API_KEY) {
  console.error('This suite uses a model judge but ANTHROPIC_API_KEY is not set.');
  console.error('Run with --no-judge to use the code graders alone.');
  process.exit(2);
}

const report = await runSuite(suite, { filter: flag('case') });

if (has('json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.total} cases · ${suite.name}${suite.judge ? ` · judge ${suite.judge.model}` : ' · no judge'}\n`);
  printRun(report);
}

const cmp = compare(report, loadBaseline(suite.name));
if (!has('json')) printComparison(cmp);

mkdirSync('runs', { recursive: true });
const log = `runs/${suite.name.replace(/[^\w.-]/g, '_')}-${report.at.replace(/[:.]/g, '-')}.json`;
writeFileSync(log, JSON.stringify(report, null, 2));
if (!has('json')) console.log(`\nfull log: ${log}`);

if (has('save')) {
  const p = saveBaseline(report);
  if (!has('json')) console.log(`baseline written: ${p}`);
}

process.exit(report.passed === report.total && cmp.verdict !== 'regressed' ? 0 : 1);
