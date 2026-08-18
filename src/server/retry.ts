export class RetryableError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { attempts = 3, baseDelayMs = 500, sleep = defaultSleep } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RetryableError)) throw error;
      if (attempt === attempts) break;
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      await sleep(error.retryAfterMs ?? backoff);
    }
  }
  throw lastError;
}
