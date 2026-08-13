export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFn = (level: LogLevel, message: string) => Promise<unknown>

const ERROR_PATTERNS =
  /authenticat|credentials|expired|not logged in|exit(?:ed)? with code|crash|unhealthy|401|402|billing|subscription/i
const WARN_PATTERNS =
  /rate.limit|429|overloaded|503|stale.session|timeout|timed out/i

/**
 * Create a logger for proxy diagnostics. V2 plugins no longer receive the V1
 * app logging client.
 */
export function createLogger(): LogFn {
  return async (level, message) => {
    const output = `[opencode-with-claude] ${message}`
    if (level === "error") console.error(output)
    else if (level === "warn") console.warn(output)
    else if (level === "debug") console.debug(output)
    else console.info(output)
  }
}

/**
 * Classify a proxy log message into a log level.
 */
export function classifyProxyLog(msg: string): LogLevel {
  if (ERROR_PATTERNS.test(msg)) return "error"
  if (WARN_PATTERNS.test(msg)) return "warn"
  return "debug"
}
