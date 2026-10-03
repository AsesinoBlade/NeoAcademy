const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

interface CapturedServerLogEntry {
  timestampMs: number;
  level: LogLevel;
  line: string;
}

const MAX_CAPTURED_SERVER_LOGS = 500;

function getServerLogBuffer(): CapturedServerLogEntry[] {
  const globalStore = globalThis as typeof globalThis & {
    __neoRecentServerLogs?: CapturedServerLogEntry[];
  };

  if (!globalStore.__neoRecentServerLogs) {
    globalStore.__neoRecentServerLogs = [];
  }

  return globalStore.__neoRecentServerLogs;
}

function captureServerLog(
  level: LogLevel,
  line: string,
): void {
  if (
    typeof window !== 'undefined' ||
    (level !== 'warn' && level !== 'error')
  ) {
    return;
  }

  const buffer = getServerLogBuffer();

  buffer.push({
    timestampMs: Date.now(),
    level,
    line,
  });

  if (buffer.length > MAX_CAPTURED_SERVER_LOGS) {
    buffer.splice(
      0,
      buffer.length - MAX_CAPTURED_SERVER_LOGS,
    );
  }
}

export function getRecentServerErrorLogs(options?: {
  withinMs?: number;
  limit?: number;
}): string[] {
  const withinMs = options?.withinMs ?? 10 * 60 * 1000;
  const limit = options?.limit ?? 120;
  const cutoff = Date.now() - withinMs;

  return getServerLogBuffer()
    .filter((entry) => entry.timestampMs >= cutoff)
    .slice(-limit)
    .map((entry) => entry.line);
}

function getMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return env in LOG_LEVELS ? (env as LogLevel) : 'info';
}

function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT === 'json';
}

function formatLine(level: LogLevel, tag: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const upperLevel = level.toUpperCase();
  const msg = args
    .map((a) =>
      a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a),
    )
    .join(' ');

  if (isJsonFormat()) {
    return JSON.stringify({ timestamp, level: upperLevel, tag, message: msg });
  }
  return `[${timestamp}] [${upperLevel}] [${tag}] ${msg}`;
}

export function createLogger(tag: string) {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[getMinLevel()]) return;

    const line = formatLine(level, tag, args);

    captureServerLog(level, line);

    // Console output
    const fn =
      level === 'debug'
        ? console.debug
        : level === 'warn'
          ? console.warn
          : level === 'error'
            ? console.error
            : console.log;
    fn(line);
  };

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}
