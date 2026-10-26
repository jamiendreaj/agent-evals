/**
 * Printing a run so a person can act on it.
 *
 * The rule throughout: a passing case gets one line, a failing case gets the
 * reason. A report that prints everything equally makes you hunt for the four
 * lines that matter among the thirty-eight that don't.
 */

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m` }
  : { dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, bold: (s) => s };

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const rule = (n = 68) => '─'.repeat(n);

export function printRun(report) {
  const width = Math.max(...report.results.map((r) => r.id.length), 10);

  for (const r of report.results) {
    const tag = r.pass ? C.green(' PASS ') : C.red(' FAIL ');
    console.log(`${tag} ${r.id.padEnd(width)}  ${String(r.latency_ms).padStart(6)}ms`);
    for (const c of r.checks.filter((x) => !x.pass)) {
      console.log(C.red(`        ✗ ${c.name}`) + (c.detail ? C.dim(` — ${c.detail}`) : ''));
    }
  }

  console.log(`\n${rule()}`);
  const head = `${report.passed}/${report.total} passed  ·  ${pct(report.rate)}  ·  ${(report.duration_ms / 1000).toFixed(1)}s`;
  console.log(report.passed === report.total ? C.green(C.bold(head)) : C.bold(head));

  const checks = Object.entries(report.byCheck).filter(([, v]) => v.pass < v.total);
  if (checks.length) {
    console.log('\nweakest checks');
    for (const [name, v] of checks.sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total)) {
      console.log(`  ${name.padEnd(18)} ${String(v.pass).padStart(3)}/${v.total}`);
    }
  }

  const tags = Object.entries(report.byTag);
  if (tags.length) {
    console.log('\nby tag  ' + tags.map(([t, v]) => `${t} ${v.pass}/${v.total}`).join('  ·  '));
  }

  if (report.usage?.output) {
    console.log(C.dim(`\n${report.usage.input} input  ·  ${report.usage.output} output  ·  ${report.usage.cache_read} cached`));
  }

  if (report.calibration) printCalibration(report.calibration);
}

function printCalibration(cal) {
  console.log(`\n${rule()}`);
  console.log(C.bold('judge calibration'));
  console.log(`  agreed with your labels on ${cal.labelled} cases: ${pct(cal.agreement)}`);
  console.log(`  ${cal.falsePass ? C.red(`false passes: ${cal.falsePass}`) : C.green('false passes: 0')}` +
              C.dim(`   false fails: ${cal.falseFail}`));
  if (!cal.trustworthy) {
    console.log(C.yellow('  not yet trustworthy') +
      C.dim(' — needs 10+ labelled cases, zero false passes, 90%+ agreement'));
    if (cal.falsePass) {
      console.log(C.dim('  a judge that passes what you failed is worse than no judge: it'));
      console.log(C.dim('  reports a number that looks like evidence.'));
    }
  }
}

export function printComparison(cmp) {
  console.log(`\n${rule()}`);

  if (cmp.verdict === 'no-baseline') {
    console.log(C.dim('no baseline yet — run with --save to record this one'));
    return;
  }

  const label = {
    regressed: C.red(C.bold('REGRESSED')),
    improved: C.green(C.bold('IMPROVED')),
    unchanged: C.dim('unchanged'),
  }[cmp.verdict];
  console.log(`${label}  ${C.dim(`vs baseline ${cmp.baselineAt?.slice(0, 16).replace('T', ' ') ?? ''}`)}`);

  if (cmp.broke.length) {
    console.log(C.red(`\n${cmp.broke.length} case${cmp.broke.length > 1 ? 's' : ''} that passed before now fail:`));
    for (const b of cmp.broke) console.log(`  ${b.id}` + C.dim(`  (${b.failed.join(', ')})`));
  }

  if (cmp.fixed.length) {
    console.log(C.green(`\n${cmp.fixed.length} newly passing:`));
    for (const f of cmp.fixed) console.log(`  ${f.id}` + C.dim(`  (was failing ${f.wasFailing.join(', ')})`));
  }

  if (cmp.checkDeltas.length) {
    console.log('\ncheck movement');
    for (const d of cmp.checkDeltas) {
      const arrow = d.delta < 0 ? C.red('↓') : C.green('↑');
      console.log(`  ${arrow} ${d.name.padEnd(18)} ${d.before} → ${d.now}`);
    }
  }

  if (cmp.newCases?.length) {
    console.log(C.dim(`\n${cmp.newCases.length} new case${cmp.newCases.length > 1 ? 's' : ''} not in the baseline: ${cmp.newCases.join(', ')}`));
  }

  if (cmp.verdict === 'regressed') {
    console.log(C.dim('\nA higher pass rate with a broken case is still a regression.'));
  }
}
