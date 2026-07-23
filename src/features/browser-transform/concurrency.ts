import { ExtensionError } from '@/shared/errors';

export interface TransformExecutionGate {
  active: number;
  queued: number;
  waiters: Array<() => void>;
}

export function createTransformExecutionGate(): TransformExecutionGate {
  return { active: 0, queued: 0, waiters: [] };
}

export async function acquireTransformExecutionGate(
  gate: TransformExecutionGate,
  maxConcurrency: number,
  maxQueueDepth: number,
): Promise<() => void> {
  if (gate.active < maxConcurrency) {
    gate.active += 1;
  } else {
    if (gate.queued >= maxQueueDepth) {
      throw new ExtensionError('transform_queue_full', '页面转换队列已满，请降低并发或增加配置并发数');
    }
    gate.queued += 1;
    await new Promise<void>((resolve) => gate.waiters.push(resolve));
    gate.queued -= 1;
    // The releasing operation transfers its active permit directly to this waiter.
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = gate.waiters.shift();
    if (next) {
      next();
      return;
    }
    gate.active = Math.max(0, gate.active - 1);
  };
}
