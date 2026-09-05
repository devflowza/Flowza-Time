import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

export type Logger = PinoLogger;

/** Keys whose values are always redacted from logs. Never log secrets, tokens or biometric data. */
export const REDACTED_PATHS = [
  'password', '*.password', 'token', '*.token', 'accessToken', '*.accessToken', 'refreshToken', '*.refreshToken',
  'apiKey', '*.apiKey', 'api_key', '*.api_key', 'secret', '*.secret', 'clientSecret', '*.clientSecret',
  'authorization', '*.authorization', 'headers.authorization', 'credentials', '*.credentials',
  'template', '*.template', 'biometric', '*.biometric', 'pin', '*.pin', 'nationalId', '*.nationalId',
];

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  pretty?: boolean;
  base?: Record<string, unknown>;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    name: opts.name,
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.name, ...(opts.base ?? {}) },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  return pino(options);
}

/** Structured event helper: log.info(event('device_attendance_sync_completed', { deviceId, records })) */
export function event(name: string, fields: Record<string, unknown> = {}) {
  return { event: name, ...fields };
}
