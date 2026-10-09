const { Expecter } = require('./expect');
const { render } = require('./template');

// The `rt` object every step type receives: rendering, logging, abortable
// sleep, the target node, and a lazily-opened console. One runtime per run;
// each step gets its own view of it via forStep().

function createRuntime({ ctx, deps, emit, signal, targets, defaultTargetId, user }) {
  const consoles = new Map(); // "lab/node" -> { session, expecter }
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
    });

  // Fresh lookup every call: lab.setMgmtIp changes what later steps see.
  function target(targetId = defaultTargetId) {
    const t = targets[targetId];
    if (!t) throw new Error('this step needs a target input, but the runbook has none');
    const node = deps.labs.getNode(t.lab, t.node);
    if (!node) throw new Error(`${t.node} is no longer deployed in ${t.lab}`);
    return { lab: t.lab, node: t.node, ...node };
  }

  async function openConsole(t) {
    const key = `${t.lab}/${t.node}`;
    if (consoles.has(key)) return consoles.get(key);
    const expecter = new Expecter();
    emit({ type: 'log', line: `opening serial console of ${t.node}` });
    const session = await deps.openConsole(t.vmid, {
      onData: (data) => { expecter.feed(data); emit({ type: 'console', data }); },
      onClose: () => emit({ type: 'log', line: `console of ${t.node} closed`, level: 'warn' }),
      onError: (err) => emit({ type: 'log', line: `console error: ${err.message}`, level: 'warn' }),
    });
    const entry = { session, expecter };
    consoles.set(key, entry);
    return entry;
  }

  // The rt a step sees: shared helpers plus target/console/log bound to
  // that step (its own `target:` override, and its id on every log line).
  function forStep(step) {
    const targetId = step.target || defaultTargetId;
    return {
      deps,
      user,
      signal,
      sleep,
      // `extra` adds step-local variables (e.g. {{chunk}}) without touching the run's context
      render: (v, extra) => render(v, extra ? Object.assign(Object.create(ctx), extra) : ctx),
      target: () => target(targetId),
      console: () => openConsole(target(targetId)),
      log: (line, level) => emit({ type: 'log', line, level, step: step.id }),
    };
  }

  const closeAll = () => {
    for (const { session } of consoles.values()) session.close();
    consoles.clear();
  };

  return { forStep, closeAll };
}

module.exports = { createRuntime };
