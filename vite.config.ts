import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  // Vite loads .env files for import.meta.env, but the server-only validated
  // config reads process.env. Populate it for SvelteKit request handlers.
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
    process.env[key] ??= value;
  }

  return {
    plugins: [sveltekit({ adapter: adapter(), preprocess: vitePreprocess() })],
    test: {
      include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
      environment: 'node',
    },
  };
});
