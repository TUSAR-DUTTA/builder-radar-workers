export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface ActiveProviderCell {
  cellId: string;
  workerId: string;
  jobId: string;
  controller: AbortController;
  operationPromise: Promise<unknown> | null;
  settled: boolean;
}

export interface ShutdownDependencies {
  failCell: (
    cellId: string,
    workerId: string,
    error: Error,
    failure: {
      category: 'cancelled';
      retryable: false;
      code: 'worker_shutdown_cancelled';
      publicCode: 'publication_withheld';
    },
  ) => Promise<boolean>;
  closeBrowsers: () => Promise<void>;
  refreshJob: (jobId: string) => Promise<unknown>;
  setExitCode: (code: number) => void;
  forceExit: (code: number) => never | void;
  log: (message: string) => void;
  timeoutMs?: number;
}

const SHUTDOWN_FAILURE = Object.freeze({
  category: 'cancelled' as const,
  retryable: false as const,
  code: 'worker_shutdown_cancelled' as const,
  publicCode: 'publication_withheld' as const,
});

export class ShutdownCoordinator {
  private active: ActiveProviderCell | null = null;
  private signalCount = 0;
  private cleanupPromise: Promise<void> | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly dependencies: ShutdownDependencies) {
    this.timeoutMs = Math.max(50, dependencies.timeoutMs ?? 20_000);
  }

  get isShuttingDown(): boolean {
    return this.signalCount > 0;
  }

  get canClaim(): boolean {
    return !this.isShuttingDown;
  }

  beginCell(input: Omit<ActiveProviderCell, 'operationPromise' | 'settled'>): void {
    if (this.isShuttingDown) throw new Error('worker_shutdown_in_progress');
    if (this.active) throw new Error('worker_active_cell_already_registered');
    this.active = { ...input, operationPromise: null, settled: false };
  }

  trackOperation(cellId: string, operationPromise: Promise<unknown>): void {
    if (!this.active || this.active.cellId !== cellId) throw new Error('worker_active_cell_mismatch');
    this.active.operationPromise = operationPromise;
  }

  markCellSettled(cellId: string): void {
    if (this.active?.cellId === cellId) this.active.settled = true;
  }

  clearCell(cellId: string): void {
    if (this.active?.cellId === cellId) this.active = null;
  }

  async handleSignal(signal: ShutdownSignal): Promise<void> {
    this.signalCount += 1;
    if (this.signalCount > 1) {
      this.dependencies.log(`[runner] received second ${signal}; forcing exit`);
      this.dependencies.forceExit(1);
      return;
    }

    this.dependencies.log(`[runner] received ${signal}; stopping claims and cleaning active lifecycle state`);
    const activeAtSignal = this.active;
    activeAtSignal?.controller.abort(new Error('worker_shutdown_aborted'));

    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      this.dependencies.log(`[runner] graceful shutdown exceeded ${this.timeoutMs}ms; forcing exit`);
      this.dependencies.forceExit(1);
    }, this.timeoutMs);
    timeout.unref?.();

    this.cleanupPromise = (async () => {
      if (activeAtSignal?.operationPromise) {
        await activeAtSignal.operationPromise.catch(() => {});
      }
      if (activeAtSignal && !activeAtSignal.settled) {
        const failed = await this.dependencies.failCell(
          activeAtSignal.cellId,
          activeAtSignal.workerId,
          new Error('worker_shutdown_cancelled'),
          SHUTDOWN_FAILURE,
        );
        if (failed) activeAtSignal.settled = true;
      }
      await this.dependencies.closeBrowsers().catch(() => {});
      if (activeAtSignal?.jobId) {
        await this.dependencies.refreshJob(activeAtSignal.jobId).catch(() => {});
      }
      this.dependencies.setExitCode(1);
    })().finally(() => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
    });

    await this.cleanupPromise;
  }

  async waitForCleanup(): Promise<void> {
    await this.cleanupPromise;
  }
}

export function installShutdownSignalHandlers(
  coordinator: ShutdownCoordinator,
  target: Pick<NodeJS.Process, 'on'> = process,
): void {
  target.on('SIGTERM', () => { void coordinator.handleSignal('SIGTERM'); });
  target.on('SIGINT', () => { void coordinator.handleSignal('SIGINT'); });
}
