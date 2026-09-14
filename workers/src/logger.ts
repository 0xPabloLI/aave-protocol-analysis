/**
 * Minimal structured (JSON) logger for the Worker + Durable Object.
 *
 * One JSON object per line on console.log — wrangler dev / `wrangler tail`
 * render them as queryable structured entries (level, component, msg, fields).
 * No dependencies: runs in the workerd runtime and in Node (tests).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel = LEVELS.info;

export interface WorkerLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(component: string): WorkerLogger {
  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < minLevel) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...(fields ?? {}),
    };
    console.log(JSON.stringify(entry));
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
