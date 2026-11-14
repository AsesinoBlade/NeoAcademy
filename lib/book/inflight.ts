/**
 * One run per book step at a time.
 *
 * Book steps (write a section, review it, verify the build) take minutes to
 * hours on a local model. If the browser's request drops part-way (sleep,
 * network blip, tab reload) the client retries — but the server is still
 * working on the first request. Starting a second identical run doubles the
 * load on the single local model (and on a Mac, can push it into swap), so
 * both crawl; then the two runs overwrite each other's results.
 *
 * Instead, a repeated request for a step that is already running JOINS that
 * run and gets the same response when it finishes.
 */
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('BookInflight');

type Store = Map<string, Promise<Response>>;
const g = globalThis as unknown as { __neoBookInflight?: Store };
const store: Store = (g.__neoBookInflight ??= new Map());

export function inflightCount(): number {
  return store.size;
}

/**
 * Run `handler` once per key. Every caller (the original and any retries
 * that arrive while it runs) gets its own clone of the single response.
 */
export async function runOncePerKey(
  key: string | null,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (!key) return handler();
  let running = store.get(key);
  if (running) {
    log.warn(`${key} is already running — this request joins it instead of starting a second run`);
  } else {
    const started = Date.now();
    running = handler().finally(() => {
      store.delete(key);
      const minutes = (Date.now() - started) / 60000;
      if (minutes > 30) log.warn(`${key} took ${minutes.toFixed(0)} min`);
    });
    store.set(key, running);
  }
  return (await running).clone();
}

/** Read the JSON body without consuming the request the handler will read. */
export async function peekJson<T>(req: NextRequest): Promise<T | null> {
  return (await req.clone().json().catch(() => null)) as T | null;
}
