/**
 * A multi-subscriber event hub. Producers push events; consumers `attach()` to
 * get an async iterator that first REPLAYS everything buffered so far, then
 * streams new events live until the hub is closed.
 *
 * This is what lets a run/turn keep executing in the background regardless of
 * who's connected: the work pushes into the hub, and a browser can disconnect
 * (refresh) and re-`attach()` later to replay the whole thing.
 */
export interface Hub<T> {
  /** Append an event and wake all waiting consumers. */
  push(ev: T): void;
  /** Mark the stream finished; consumers drain the buffer then end. */
  close(): void;
  isClosed(): boolean;
  /** All events pushed so far (for one-shot snapshots). */
  readonly buffer: readonly T[];
  /** Iterate: replay buffered events, then live ones until closed. */
  attach(): AsyncGenerator<T>;
}

export function createHub<T>(): Hub<T> {
  const buffer: T[] = [];
  const waiters = new Set<() => void>();
  let closed = false;

  const wakeAll = () => {
    for (const w of waiters) w();
    waiters.clear();
  };

  return {
    buffer,
    push(ev: T) {
      if (closed) return;
      buffer.push(ev);
      wakeAll();
    },
    close() {
      if (closed) return;
      closed = true;
      wakeAll();
    },
    isClosed: () => closed,
    async *attach(): AsyncGenerator<T> {
      let i = 0;
      while (true) {
        if (i < buffer.length) {
          yield buffer[i++];
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => waiters.add(resolve));
      }
    },
  };
}
