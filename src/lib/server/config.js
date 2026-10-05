// @ts-check
import { z } from 'zod';

const runtimeConfigSchema = z.object({
  DATABASE_PATH: z.string().trim().min(1).default('/data/shopping-list.sqlite'),
  CANONICAL_ORIGIN: z.string().trim().url(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

/**
 * @typedef {object} AppConfig
 * @property {string} databasePath
 * @property {string} canonicalOrigin
 * @property {number} port
 * @property {'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'} logLevel
 */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {AppConfig}
 */
export function readConfig(env = process.env) {
  const parsed = runtimeConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) =>
          `${issue.path.join('.') || 'configuration'}: ${issue.message}`,
      )
      .join('; ');
    throw new Error(`Invalid runtime configuration: ${details}`);
  }

  const canonicalUrl = new URL(parsed.data.CANONICAL_ORIGIN);
  if (
    !['http:', 'https:'].includes(canonicalUrl.protocol) ||
    canonicalUrl.username !== '' ||
    canonicalUrl.password !== '' ||
    canonicalUrl.pathname !== '/' ||
    canonicalUrl.search !== '' ||
    canonicalUrl.hash !== ''
  ) {
    throw new Error(
      'Invalid runtime configuration: CANONICAL_ORIGIN must be an HTTP(S) origin without a path or credentials',
    );
  }

  return {
    databasePath: parsed.data.DATABASE_PATH,
    canonicalOrigin: canonicalUrl.origin,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
  };
}

/** @returns {AppConfig} */
export function getConfig() {
  return readConfig(process.env);
}
