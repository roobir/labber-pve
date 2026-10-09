const infra = require('./lab-deploy');
const bootstrap = require('./lab-bootstrap');
const { parseTopology, readState } = require('./lab-files');

// deploy = build the infrastructure (lab-deploy.js), then bootstrap the nodes
// with their runbooks (lab-bootstrap.js). They fail differently, so they are
// handled differently:
//   - building fails  -> nothing valuable exists yet (no licenses used, no
//                        config), so by default roll back to a clean slate
//                        (onDeployFailure: keep leaves it up for debugging)
//   - bootstrap fails -> the lab is built and booted and its state is the
//                        evidence, so by default KEEP it, report which
//                        runbook failed on which node, and allow a retry
//                        (onBootstrapFailure: destroy for throwaway labs)

async function rollback(name, onProgress) {
  onProgress('deploy failed -- rolling back what was created (set `onDeployFailure: keep` in the lab file to keep it for debugging)');
  try {
    await infra.destroy(name, onProgress);
  } catch (err) {
    onProgress(`rollback incomplete: ${err.message} -- destroy the lab manually to finish cleaning up`);
  }
}

async function deploy(name, onProgress = () => {}, { user = 'deploy' } = {}) {
  if (readState(name)) throw new Error(`"${name}" already has a deployed state -- destroy it first`);
  const topo = parseTopology(name);
  bootstrap.preflight(topo); // typo in a runbook name? find out now, not after the build

  let state;
  try {
    state = await infra.deploy(name, onProgress);
  } catch (err) {
    if (topo.onDeployFailure !== 'keep') await rollback(name, onProgress);
    throw err;
  }

  const result = await bootstrap.run(name, { user, onProgress });
  if (result.ok) return state;

  const message = `bootstrap failed: ${result.failures.join('; ')}`;
  onProgress(`ERROR: ${message}`);
  if (topo.onBootstrapFailure === 'destroy') {
    onProgress('onBootstrapFailure is destroy -- tearing the lab down');
    await infra.destroy(name, onProgress);
  } else {
    onProgress('the lab is left running; fix the problem, then use "bootstrap" to resume where it stopped');
  }
  throw new Error(message);
}

// Resume / run bootstrap on an already-deployed lab.
async function runBootstrap(name, onProgress = () => {}, { user = 'bootstrap' } = {}) {
  if (!readState(name)) throw new Error(`"${name}" is not deployed`);
  const result = await bootstrap.run(name, { user, onProgress });
  if (!result.ok) throw new Error(`bootstrap failed: ${result.failures.join('; ')}`);
  onProgress('bootstrap complete');
}

module.exports = { deploy, runBootstrap };
