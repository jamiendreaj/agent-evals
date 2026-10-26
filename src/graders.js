/**
 * Code graders: deterministic, free, and the ones that must never regress.
 *
 * A grader takes the case and the agent's result and returns checks. It never
 * throws — a grader that crashes on a weird output would take the whole run
 * with it, and the weird output is exactly what you wanted to see.
 *
 * Every grader is a plain function, so a project with a rule nobody anticipated
 * writes its own and passes it in the same list as these.
 */

/** One check. `pass` is the only field the runner reads; `detail` is for humans. */
const check = (name, pass, detail = '') => ({ name, pass: Boolean(pass), detail: String(detail) });

/** Pull the gradeable text out of whatever shape the agent returned. */
export function textOf(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.output === 'string') return result.output;
  if (typeof result.text === 'string') return result.text;
  if (typeof result.draft === 'string') return result.draft;
  return '';
}

/* ── the built-ins ──────────────────────────────────────────────────────── */

/** Every string in `expect.contains` appears in the output, case-insensitively. */
export const contains = (c, r) =>
  (c.expect?.contains ?? []).map((needle) =>
    check(`contains:${needle}`, textOf(r).toLowerCase().includes(String(needle).toLowerCase()), 'absent'));

/** No string in `expect.absent` appears. The negative case is usually the important one. */
export const absent = (c, r) =>
  (c.expect?.absent ?? []).map((needle) =>
    check(`absent:${needle}`, !textOf(r).toLowerCase().includes(String(needle).toLowerCase()), 'present'));

/** `expect.matches` / `expect.notMatches` as regex source strings. */
export const matches = (c, r) => {
  const text = textOf(r);
  const out = [];
  for (const src of c.expect?.matches ?? []) {
    out.push(check(`matches:${src}`, new RegExp(src).test(text), 'no match'));
  }
  for (const src of c.expect?.notMatches ?? []) {
    const hit = text.match(new RegExp(src));
    out.push(check(`notMatches:${src}`, !hit, hit ? `matched "${hit[0]}"` : ''));
  }
  return out;
};

/** Named tools the agent was supposed to call, read off `result.tool_calls`. */
export const toolsCalled = (c, r) => {
  const called = (r?.tool_calls ?? []).map((t) => t.name);
  const out = (c.expect?.tools ?? []).map((t) =>
    check(`tool:${t}`, called.includes(t), `called [${called.join(', ') || 'none'}]`));
  for (const t of c.expect?.toolsNotCalled ?? []) {
    out.push(check(`noTool:${t}`, !called.includes(t), 'was called'));
  }
  return out;
};

/** The output parses as JSON and has the required top-level keys. */
export const jsonShape = (c, r) => {
  const want = c.expect?.jsonKeys;
  if (!want) return [];
  let parsed;
  try { parsed = JSON.parse(textOf(r)); } catch { return [check('json', false, 'did not parse')]; }
  if (parsed === null || typeof parsed !== 'object') return [check('json', false, 'not an object')];
  return want.map((k) => check(`json:${k}`, k in parsed, 'missing'));
};

/**
 * The agent finished cleanly.
 *
 * Only graded when the result carries a stop reason — an agent that reports
 * one is held to it; a plain string output is not failed for lacking metadata
 * it was never going to have.
 */
export const finished = (c, r) =>
  r?.stop_reason == null ? [] : [check('finished', r.stop_reason === 'end_turn', `stop_reason=${r.stop_reason}`)];

/** The output is not empty. Catches the clean finish that returns nothing. */
export const notEmpty = (c, r) => [check('notEmpty', textOf(r).trim().length > 0, 'empty output')];

/** Latency ceiling in milliseconds, per case or per suite. */
export const underLatency = (limitMs) => (c, r) => {
  const limit = c.expect?.maxLatencyMs ?? limitMs;
  if (!limit || r?.latency_ms == null) return [];
  return [check('latency', r.latency_ms <= limit, `${r.latency_ms}ms > ${limit}ms`)];
};

/** The default set. Cheap, deterministic, and enough for most suites. */
export const DEFAULT_GRADERS = [finished, notEmpty, contains, absent, matches, toolsCalled, jsonShape];

/**
 * Wrap a grader so a throw becomes a failed check instead of a dead run.
 * A bad regex in one case should cost that case, not the other forty-one.
 */
export function safely(grader) {
  return (c, r) => {
    try {
      const out = grader(c, r);
      return Array.isArray(out) ? out : [out];
    } catch (err) {
      return [check(grader.name || 'grader', false, `grader threw: ${err?.message ?? err}`)];
    }
  };
}

export { check };
