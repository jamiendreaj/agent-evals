# agent-evals

An evaluation harness for LLM agents. Point it at any agent, give it cases, and
it tells you whether a change made things better or worse.

It answers the question every agent eventually has to answer and most cannot:
**how do you know it works?**

```bash
npx agent-evals examples/support-triage.js --no-judge
```

---

## Why this exists

Three things go wrong when a team starts evaluating an agent, and all three are
quiet failures.

**A pass rate cannot tell you whether a change helped.** 38/42 against 40/42
looks like a regression and is usually noise. Worse, the rate can hold perfectly
still while two cases start passing and two others break. So the comparison here
is per case, not per percentage, and the verdict is blunt: **a case that used to
pass and now fails is a regression, whatever happened to the headline number.**

**An LLM judge nobody has measured is a vibe with a percentage sign on it.** It
will cheerfully report that 84% of your outputs are fine and you have no way to
know whether that means anything. So this ships `calibrate()`: label some cases
by hand, and it tells you how often the judge agreed with you — and which way it
was wrong. A judge that passes what you failed is worse than no judge, because
it produces a number that looks like evidence.

**Everything is coupled to one agent.** Most eval code imports the agent it
grades, so it cannot be reused and nobody writes the second suite. This harness
knows nothing about your agent. You give it `run(input)`.

---

## Quick start

A suite is a file that exports cases, a run function, and how to grade.

```js
import { defineSuite } from 'agent-evals';
import { DEFAULT_GRADERS } from 'agent-evals/graders';

export default defineSuite({
  name: 'support-triage',
  run: (ticket) => myAgent(ticket),      // anything async that returns a string or { output }
  graders: DEFAULT_GRADERS,
  cases: [
    {
      id: 'urgent.outage',
      tags: ['priority'],
      input: 'Our whole team is down, nobody can log in.',
      expect: { contains: ['P1'], jsonKeys: ['priority', 'team'] },
    },
  ],
});
```

```bash
agent-evals suite.js              # run and compare against the baseline
agent-evals suite.js --save       # record this run as the baseline
agent-evals suite.js --case lang  # one case, a prefix, or a tag
agent-evals suite.js --no-judge   # code graders only: free and offline
```

Exit code is 1 on any failure or regression, so CI can gate on it.

---

## The two layers

**Code graders** are deterministic, free, and the ones that must never regress.

| Grader | Checks |
| --- | --- |
| `contains` / `absent` | Strings that must or must not appear |
| `matches` / `notMatches` | Regex, for the shapes a substring cannot express |
| `toolsCalled` | Named tools were called — or were not |
| `jsonShape` | Output parses and carries the required keys |
| `finished` | The agent reached `end_turn`, where it reports one |
| `notEmpty` | Catches the clean finish that returns nothing |
| `underLatency` | A ceiling, per case or per suite |

A grader is a plain function `(case, result) => checks`, so a project with a
rule nobody anticipated writes its own and passes it in the same list. Every
grader is wrapped: one that throws fails its own check rather than killing the
run, because a bad regex in case 3 should not cost you cases 4 through 42.

**The model judge** covers what code cannot: tone, grounding, whether a summary
is faithful. You give it a rubric of yes-or-no questions.

```js
const judge = makeJudge({
  criteria: [
    { id: 'grounded', question: 'Does every factual claim appear in the context given?' },
    { id: 'no_promises', question: 'Does the output avoid promising an outcome or a timescale?' },
  ],
});
```

Keep each question answerable by someone who has only read the rubric. A
criterion that needs taste produces a judge that drifts between runs.

The judge fails loudly rather than quietly: prose instead of JSON, a criterion
it skipped, a truncated response, a 429 — each is a failed check that names
itself, never a silent pass.

---

## Calibration: grading the grader

Label cases you are sure about:

```js
{ id: 'escalation.legal', input: '...', labels: { pass: false } }
```

Then the report tells you whether to believe the judge:

```
judge calibration
  agreed with your labels on 14 cases: 93%
  false passes: 0   false fails: 1
```

The two errors are not equally bad. A **false fail** wastes your time. A **false
pass** ships a broken output and tells you it was fine. So a judge is only
called trustworthy at ten or more labelled cases, **zero** false passes, and 90%
agreement. One false pass disqualifies it however good the headline looks.

---

## Baselines: did the change help?

```bash
agent-evals suite.js --save   # after a run you are happy with
# ... change a prompt ...
agent-evals suite.js          # compared automatically
```

```
REGRESSED  vs baseline 2026-10-26 08:39

1 case that passed before now fails:
  routing.invoice  (contains:billing)

1 newly passing:
  escalation.legal  (was failing matches:"needs_human")

check movement
  ↓ contains           6/6 → 5/6
  ↑ matches            0/1 → 1/1
```

In that run the pass rate did not move at all — 5/6 before, 5/6 after. A
percentage would have called it unchanged. One case had broken.

Baselines are committed on purpose. The question *"is this better than what we
shipped"* is only answerable if what we shipped is in the repository. They
store verdicts, not generated text, so they stay readable in a diff.

---

## Tests

```bash
npm test
```

35 tests, all offline. The agent under test is a function that echoes its input
and the judge is a scripted client, so nothing needs an API key and nothing
fails for a reason unrelated to the code.

A tool that tells you whether your agent works is worthless if nobody has
checked whether the tool works. The suite covers the judge returning prose
instead of JSON, a criterion it silently omitted, a grader that throws, an agent
that throws, results arriving out of order, and the case that matters most: **a
broken case counting as a regression even when the pass rate improves.**

---

## What this is not

Not a prompt optimiser, not a dataset, not a benchmark. It does not tell you
what to change. It tells you whether what you changed worked, which is the part
that is usually guessed at.

MIT.
