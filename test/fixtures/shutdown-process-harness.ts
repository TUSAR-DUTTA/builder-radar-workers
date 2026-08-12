import { appendFileSync } from 'node:fs';
import { installShutdownSignalHandlers, ShutdownCoordinator } from '../../src/workers/lib/shutdown-coordinator';

const mode = process.argv[2];
const tracePath = process.argv[3];
if (!tracePath || !['graceful', 'forced'].includes(mode)) throw new Error('shutdown harness arguments invalid');

const trace = (event: string): void => appendFileSync(tracePath, `${event}\n`, 'utf8');
const keepAlive = setInterval(() => {}, 1_000);
const controller = new AbortController();
const operation = mode === 'graceful'
  ? new Promise<void>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      trace('operation_aborted');
      reject(controller.signal.reason);
    }, { once: true });
  })
  : new Promise<void>(() => {});
if (mode === 'forced') {
  controller.signal.addEventListener('abort', () => trace('operation_aborted'), { once: true });
}

const coordinator = new ShutdownCoordinator({
  failCell: async (cellId, workerId, _error, failure) => {
    trace(`fail:${cellId}:${workerId}:${failure.category}:${failure.retryable}:${failure.code}`);
    return true;
  },
  closeBrowsers: async () => { trace('browsers_closed'); },
  refreshJob: async (jobId) => { trace(`job_refreshed:${jobId}`); },
  setExitCode: (code) => {
    trace(`exit_code:${code}`);
    process.exitCode = code;
    clearInterval(keepAlive);
  },
  forceExit: (code) => {
    trace(`forced_exit:${code}`);
    process.exit(code);
  },
  log: (message) => trace(`log:${message}`),
  timeoutMs: 150,
});

coordinator.beginCell({ cellId: 'cell-exact', workerId: 'worker-exact', jobId: 'job-exact', controller });
coordinator.trackOperation('cell-exact', operation);
installShutdownSignalHandlers(coordinator);
trace('ready');
setTimeout(() => {
  if (process.platform === 'win32') void coordinator.handleSignal('SIGTERM');
  else process.kill(process.pid, 'SIGTERM');
}, 20);
