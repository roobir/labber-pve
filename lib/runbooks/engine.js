const { typeOf } = require('./steps');
const { getPath, render } = require('./template');
const { resolveInputs } = require('./inputs');
const { createRuntime } = require('./runtime');

// Runs a validated runbook definition against resolved inputs. Knows
// nothing about HTTP routes, websockets or persistence -- it reports
// progress through `emit` and takes everything external (store, labs,
// console) through `deps`, which is what makes it testable with fakes.
//
// Events emitted: { type:'step', id, name, state: running|ok|failed|skipped },
// { type:'log', line, step? }, { type:'console', data }.

// when: { path: inputs.method, equals: online }            run only if equal
// when: { path: inputs.asm_level, equals: skip, not: true } run unless equal
// when: { path: steps.probe.out.ip, exists: false }          run if nothing was captured
// `equals` may be a template: { path: steps.read.out.ip, equals: '{{inputs.original_ip}}' }
// A list of conditions runs the step only when all of them hold.
function holds(cond, ctx) {
  const value = getPath(ctx, cond.path);
  if ('exists' in cond) return (value !== undefined && value !== '') === !!cond.exists;
  const same = String(value) === String(render(cond.equals, ctx));
  return cond.not ? !same : same;
}

function shouldRun(step, ctx) {
  if (!step.when) return true;
  return [].concat(step.when).every((cond) => holds(cond, ctx));
}

function describeStep(step) {
  return step.name || step.id;
}

async function runStep(step, runtime, ctx, emit) {
  const type = typeOf(step);
  emit({ type: 'step', id: step.id, name: describeStep(step), state: 'running' });
  try {
    ctx.steps[step.id] = await type.run(step[type.key], runtime.forStep(step));
    emit({ type: 'step', id: step.id, name: describeStep(step), state: 'ok' });
  } catch (err) {
    emit({ type: 'step', id: step.id, name: describeStep(step), state: 'failed' });
    if (step.continueOnError && err.message !== 'aborted') {
      emit({ type: 'log', line: `step failed but continueOnError is set: ${err.message}`, level: 'warn', step: step.id });
      ctx.steps[step.id] = { out: {} };
      return;
    }
    throw err;
  }
}

async function execute({ def, given, deps, emit, signal, registerSecret, user }) {
  const resolved = resolveInputs(def, given, deps);
  // Anything pulled from the Store, or from a secret input, is masked in
  // logs from then on -- except a license's uuid/mac, which are identifiers
  // worth seeing in a "mismatch" message.
  const onResolve = (path, value) => {
    const [root, id, field] = path.split('.');
    if (field === 'uuid' || field === 'mac') return;
    if (root === 'store' || (root === 'inputs' && resolved.secretInputs.has(id))) registerSecret(value);
  };
  const ctx = { inputs: resolved.values, store: deps.store.resolveAll(), steps: {}, onResolve };
  const defaultTargetId = (def.inputs || []).find((i) => i.type === 'target')?.id;
  const runtime = createRuntime({ ctx, deps, emit, signal, targets: resolved.targets, defaultTargetId, user, registerSecret });

  try {
    for (const step of def.steps) {
      if (signal.aborted) throw new Error('aborted');
      if (!shouldRun(step, ctx)) {
        emit({ type: 'step', id: step.id, name: describeStep(step), state: 'skipped' });
        continue;
      }
      await runStep(step, runtime, ctx, emit);
    }
  } finally {
    runtime.closeAll();
  }
}

module.exports = { execute };
