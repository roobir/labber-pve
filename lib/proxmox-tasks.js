const { pve } = require('./proxmox-request');

// Proxmox reports a task's own exitstatus as the literal string "OK" for a
// clean success, but as "WARNINGS: N" (not "OK") when the task's own log
// included one or more WARN-level lines -- e.g. `qm start`'s "no efidisk
// configured! Using temporary efivars disk." on a UEFI VM with no efidisk0
// (confirmed live: this exact case aborted a real lab deploy partway
// through, since the node after the warning one never got its startVm()
// call). That's still a real success -- Proxmox's own Task Viewer shows
// the identical "N warning(s)" for a task it doesn't consider failed --
// so only exitstatus values that are neither "OK" nor this shape are an
// actual failure.
function taskFailed(exitstatus) {
  return exitstatus !== 'OK' && !/^WARNINGS:/.test(exitstatus);
}

// --- Task polling -------------------------------------------------------------
// Clone/start/stop/delete are async on PVE -- the call itself returns a UPID
// string immediately, and the real work happens in the background. Anything
// that needs to know the outcome (not just "the request was accepted") has
// to poll /tasks/{upid}/status until it stops running.
//
// 10-minute default (was 2 minutes) -- a full clone of a large disk, or a
// slow VM start, genuinely observed taking several minutes on constrained
// hardware in this environment; the old 2-minute ceiling would throw
// "did not complete" on a task that was still legitimately running fine.
async function waitForTask(upid, { timeoutMs = 600000, intervalMs = 1000 } = {}) {
  const started = Date.now();
  for (;;) {
    const status = await pve('GET', `/nodes/{node}/tasks/${encodeURIComponent(upid)}/status`);
    if (status.status === 'stopped') {
      if (taskFailed(status.exitstatus)) {
        throw new Error(`Task ${upid} failed: ${status.exitstatus}`);
      }
      return status;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Task ${upid} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Several calls used by template-builder.js (disk import-from, upload,
// template conversion) are only *sometimes* async on PVE depending on
// version/storage type -- they return a real UPID task string when they are,
// or already-resolved data (often null) when they're not. Wait only when
// there's actually a task to wait on.
async function maybeWaitForTask(result, opts) {
  if (typeof result === 'string' && result.startsWith('UPID:')) {
    return waitForTask(result, opts);
  }
  return result;
}

// Same as waitForTask(), but also polls the task's own worker log
// (/tasks/{upid}/log -- the same text the Proxmox GUI's Task Viewer shows,
// e.g. "starting file import from...", "command: cp ...", "TASK OK") and
// streams new lines to onLogLine as they appear, instead of only finding out
// pass/fail once the whole thing is done. Re-fetches the full log each tick
// and emits by array-length offset rather than using the log endpoint's own
// `start` param -- simpler and avoids any doubt about that param's exact
// off-by-one semantics for a homelab-scale amount of task log text.
async function waitForTaskWithLog(upid, onLogLine, { timeoutMs = 1200000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  let emitted = 0;

  for (;;) {
    if (onLogLine) {
      try {
        const log = await pve('GET', `/nodes/{node}/tasks/${encodeURIComponent(upid)}/log`);
        for (let i = emitted; i < log.length; i++) onLogLine(log[i].t);
        emitted = log.length;
      } catch (e) {
        // Log may not be available for the first tick or two -- fine, the
        // status check below still governs completion either way.
      }
    }

    const status = await pve('GET', `/nodes/{node}/tasks/${encodeURIComponent(upid)}/status`);
    if (status.status === 'stopped') {
      if (taskFailed(status.exitstatus)) {
        throw new Error(`Task ${upid} failed: ${status.exitstatus}`);
      }
      return status;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Task ${upid} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function maybeWaitForTaskWithLog(result, onLogLine, opts) {
  if (typeof result === 'string' && result.startsWith('UPID:')) {
    return waitForTaskWithLog(result, onLogLine, opts);
  }
  return result;
}

module.exports = { waitForTask, maybeWaitForTask, waitForTaskWithLog, maybeWaitForTaskWithLog };
