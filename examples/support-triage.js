/**
 * A worked example: grading a support-triage agent.
 *
 * Run it with no API key and no agent of your own:
 *
 *   npx agent-evals examples/support-triage.js --no-judge
 *
 * The "agent" below is a deliberately mediocre stub, so the suite fails in
 * interesting ways on the first run. That is the point — an eval suite where
 * everything passes on day one is a suite that is not asking anything.
 *
 * Swap `run` for your real agent and the rest of the file stays as it is.
 */

import { defineSuite } from '../src/run.js';
import { DEFAULT_GRADERS, underLatency } from '../src/graders.js';
import { makeJudge } from '../src/judge.js';

/* ── the thing under test ───────────────────────────────────────────────── */

const URGENT = /\b(?:down|outage|cannot log in|can't log in|data loss|breach|charged twice)\b/i;

/**
 * Stand-in for a real agent. Replace this with a call to yours.
 * It takes a ticket and returns a JSON triage decision.
 */
async function triage(ticket) {
  const priority = URGENT.test(ticket) ? 'P1' : 'P3';
  const team = /\b(?:invoice|refund|charged|billing|payment)\b/i.test(ticket) ? 'billing' : 'support';
  return {
    output: JSON.stringify({
      priority,
      team,
      summary: ticket.slice(0, 60),
      // Deliberately wrong: it never asks a human, so the escalation case fails.
      needs_human: false,
    }),
    stop_reason: 'end_turn',
    usage: { input: 120, output: 40, cache_read: 0 },
  };
}

/* ── the cases ──────────────────────────────────────────────────────────── */

const cases = [
  {
    id: 'urgent.outage',
    tags: ['priority'],
    input: 'Our whole team is down, nobody can log in since this morning.',
    expect: { jsonKeys: ['priority', 'team', 'summary'], contains: ['P1'], note: 'A total outage must be P1.' },
    labels: { pass: true },
  },
  {
    id: 'urgent.double-charge',
    tags: ['priority', 'billing'],
    input: 'I was charged twice for October. Please refund one.',
    expect: { contains: ['P1', 'billing'], note: 'Money taken twice is urgent and belongs to billing.' },
    labels: { pass: true },
  },
  {
    id: 'routine.how-to',
    tags: ['priority'],
    input: 'How do I change the timezone on my account?',
    expect: { contains: ['P3'], absent: ['P1'], note: 'A how-to question is not urgent.' },
    labels: { pass: true },
  },
  {
    id: 'routing.invoice',
    tags: ['billing'],
    input: 'Can you send me the invoice for last month?',
    expect: { contains: ['billing'], note: 'Invoices go to billing, not general support.' },
    labels: { pass: true },
  },
  {
    id: 'escalation.legal',
    tags: ['escalation'],
    input: 'Our lawyer will be in touch about the data breach you had.',
    expect: {
      contains: ['P1'],
      matches: ['"needs_human"\\s*:\\s*true'],
      note: 'Anything legal goes to a person. The stub never does this, so it fails.',
    },
    labels: { pass: false },
  },
  {
    id: 'shape.always-json',
    tags: ['shape'],
    input: 'hi',
    expect: { jsonKeys: ['priority', 'team', 'summary', 'needs_human'], maxLatencyMs: 2000 },
    labels: { pass: true },
  },
];

/* ── the rubric ─────────────────────────────────────────────────────────── */

const judge = makeJudge({
  criteria: [
    { id: 'priority_justified', question: 'Does the chosen priority match how much harm the ticket describes? A total outage or money wrongly taken is urgent; a how-to question is not.' },
    { id: 'summary_faithful', question: 'Does the summary describe what the customer actually wrote, without adding detail they did not give?' },
    { id: 'no_promises', question: 'Does the output avoid promising an outcome, a refund, or a timescale?' },
  ],
});

export default defineSuite({
  name: 'support-triage',
  cases,
  run: triage,
  graders: [...DEFAULT_GRADERS, underLatency(3000)],
  judge,
  concurrency: 4,
});
