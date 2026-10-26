import Anthropic from '@anthropic-ai/sdk';
import { textOf, check } from './graders.js';

/**
 * A model grading another model's output — and the means to check whether it
 * is any good at it.
 *
 * An LLM judge nobody has measured is a vibe with a percentage sign on it. It
 * will happily tell you 84% of your outputs are fine, and you have no way to
 * know whether that number means anything. So this file ships two things: the
 * judge, and `calibrate()`, which runs the judge against cases you labelled by
 * hand and reports how often it agreed with you.
 *
 * Use a cheap model here. The judge answers yes-or-no questions against a
 * rubric you wrote; it is not doing the hard part.
 */

export const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';

function systemFor(criteria) {
  const lines = criteria.map((c) => `${c.id}: ${c.question}`).join('\n');
  const shape = criteria.map((c) => `"${c.id}":<true|false>`).join(',');
  return `You grade one output produced by an automated agent. You are strict, and you answer only with JSON.

Judge only the criteria below. Do not invent additional standards, and do not reward an output for being pleasant if it fails a criterion.

CRITERIA
${lines}

Return exactly this JSON and nothing else:
{${shape},"note":"<at most 20 words, naming the clearest failure, or empty if all passed>"}`;
}

function userFor(c, r, context) {
  const parts = [];
  if (context) parts.push(`CONTEXT THE AGENT WAS GIVEN:\n${typeof context === 'string' ? context : JSON.stringify(context, null, 1)}`);
  parts.push(`INPUT:\n${typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 1)}`);
  if (r?.tool_calls?.length) {
    parts.push(`TOOL RESULTS THE AGENT SAW:\n${JSON.stringify(r.tool_calls.map((t) => ({ [t.name]: t.output })), null, 1)}`);
  }
  if (c.expect?.note) parts.push(`WHAT THIS CASE IS TESTING:\n${c.expect.note}`);
  parts.push(`THE OUTPUT TO GRADE:\n${textOf(r)}`);
  return parts.join('\n\n');
}

/**
 * Build a judge grader from a rubric.
 *
 * `criteria` is a list of `{ id, question }`. Keep each question answerable
 * with yes or no by someone who has only read the rubric — a criterion that
 * needs taste produces a judge that drifts between runs.
 */
export function makeJudge({
  criteria,
  model = DEFAULT_JUDGE_MODEL,
  client,
  context = null,
  maxTokens = 400,
} = {}) {
  if (!criteria?.length) throw new Error('makeJudge needs at least one criterion.');
  const anthropic = client ?? new Anthropic();
  const system = systemFor(criteria);

  const judge = async (c, r) => {
    let res;
    try {
      res = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        // The rubric is identical for every case in the suite; the output is not.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userFor(c, r, context) }],
      });
    } catch (err) {
      return [check('judge', false, `judge call failed: ${err?.message ?? err}`)];
    }

    if (res.stop_reason === 'max_tokens') {
      return [check('judge', false, 'judge hit max_tokens — raise maxTokens')];
    }

    const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [check('judge', false, 'judge returned no JSON')];

    let v;
    try { v = JSON.parse(m[0]); } catch { return [check('judge', false, 'unparseable judge output')]; }

    return criteria.map((cr) =>
      check(cr.id, v[cr.id] === true, v[cr.id] === undefined ? 'judge omitted this criterion' : (v.note ?? '')));
  };

  judge.criteria = criteria;
  judge.model = model;
  judge.judgeUsage = { input: 0, output: 0 };
  return judge;
}

/**
 * Grade the grader.
 *
 * Hand-label a handful of cases with `labels: { pass: true|false }`, run this,
 * and you learn whether the judge agrees with you — and, more usefully, which
 * way it is wrong. A judge that passes everything you failed is worse than no
 * judge, because it reports a number that looks like evidence.
 *
 * Returns agreement plus the two error types, because they are not equally
 * bad: a false pass ships a broken output, a false fail only wastes your time.
 */
export function calibrate(results) {
  const labelled = results.filter((r) => typeof r.label === 'boolean' && typeof r.judgePass === 'boolean');
  if (!labelled.length) return null;

  let agree = 0, falsePass = 0, falseFail = 0;
  for (const r of labelled) {
    if (r.judgePass === r.label) agree += 1;
    else if (r.judgePass && !r.label) falsePass += 1;
    else falseFail += 1;
  }

  return {
    labelled: labelled.length,
    agreement: agree / labelled.length,
    falsePass,
    falseFail,
    /** The judge is only worth trusting when it rarely passes what you failed. */
    trustworthy: labelled.length >= 10 && falsePass === 0 && agree / labelled.length >= 0.9,
  };
}
