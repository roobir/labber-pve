const { readState, clearState } = require('../lab-files');
const { removeVm } = require('./node-ops');
const { teardownCreatedBridges } = require('./bridges');

// Any failure is reported on the terminal pane as an ERROR line before it
// propagates (lab-bridge.js's own catch only keeps the message for the status).
async function destroy(name, onProgress = () => {}) {
  const state = readState(name);
  if (!state) throw new Error(`"${name}" has no deployed state to destroy`);

  try {
    for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
      onProgress(`stopping ${nodeName} (vmid ${nodeState.vmid})...`);
      await removeVm(nodeName, nodeState, onProgress, { announceDelete: true, prefix: '' });
    }
    await teardownCreatedBridges(state, onProgress);
    clearState(name);
    onProgress(`lab "${name}" destroyed`);
  } catch (err) {
    onProgress(`ERROR: ${err.message}`);
    throw err;
  }
}

module.exports = { destroy };
