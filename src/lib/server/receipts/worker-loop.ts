import { getConfig } from '../config.js';
import { getRawDatabase } from '../db/connection';
import {
  engineForConfig,
  runReceiptWorkerTick,
  sweepOrphanedReceipts,
} from '../services/receipt-worker';
import type { OcrEngine } from './ocr-engine';

/**
 * Process lifecycle for the in-process queue worker: sweep interrupted rows at
 * boot, then drain the queue on a timer. The loop is skipped while a tick is
 * still running, and the claim itself is exclusive, so a stray second loop
 * still cannot double-process a receipt.
 *
 * With `RECEIPT_OCR_URL` unset the feature is off and nothing here starts.
 */

/** Tick interval; the plan budgets 2–5 s at household scale. */
export const RECEIPT_WORKER_TICK_MS = 3000;

export type ReceiptWorkerLoopOptions = {
  /** Tick interval override; tests shorten it instead of waiting out a real tick. */
  tickMs?: number;
};

let timer: NodeJS.Timeout | undefined;
let engine: OcrEngine | undefined;
let busy = false;
let shutdownRegistered = false;

/**
 * Boot the worker. Idempotent, and a no-op while the feature is off.
 *
 * @returns whether the worker is running.
 */
export function startReceiptWorker(
  options: ReceiptWorkerLoopOptions = {},
): boolean {
  if (timer) return true;

  const selected = engineForConfig(getConfig());
  if (!selected) return false;
  engine = selected;

  // The sweep comes first so interrupted rows are re-queued before a tick can
  // pick them up; a failure here must not take the app down with it, and the
  // next boot retries it.
  try {
    const swept = sweepOrphanedReceipts(getRawDatabase());
    if (swept > 0) {
      console.info(
        `Receipt worker swept ${swept} interrupted receipt(s) back onto the queue.`,
      );
    }
  } catch (error) {
    console.error('Receipt worker boot sweep failed:', error);
  }

  if (!shutdownRegistered) {
    process.once('sveltekit:shutdown', stopReceiptWorker);
    shutdownRegistered = true;
  }

  timer = setInterval(() => {
    void tick();
  }, options.tickMs ?? RECEIPT_WORKER_TICK_MS);
  // The worker is a background convenience: it must never hold the process open.
  timer.unref();
  return true;
}

/** Stop ticking (graceful shutdown, or a test tearing its worker down). */
export function stopReceiptWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

async function tick(): Promise<void> {
  if (busy || !engine) return;
  busy = true;
  try {
    await runReceiptWorkerTick({ engine });
  } catch (error) {
    console.error('Receipt worker tick failed:', error);
  } finally {
    busy = false;
  }
}
