import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/lib/server/config.js';

describe('runtime configuration', () => {
  it('applies safe defaults and canonicalizes the configured origin', () => {
    expect(
      readConfig({ CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net/' }),
    ).toEqual({
      databasePath: '/data/shopping-list.sqlite',
      canonicalOrigin: 'https://shopping-list.example.ts.net',
      port: 3000,
      logLevel: 'info',
    });
  });

  it('rejects an origin that is not an origin-only URL', () => {
    expect(() =>
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net/app',
      }),
    ).toThrow(/must be an HTTP\(S\) origin/);
  });

  it('rejects an invalid port', () => {
    expect(() =>
      readConfig({ CANONICAL_ORIGIN: 'http://localhost:3000', PORT: '70000' }),
    ).toThrow(/PORT/);
  });
});
