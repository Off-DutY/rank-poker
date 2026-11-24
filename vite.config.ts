import { defineConfig } from 'vitest/config';

// base './' lets the build run from any static path, such as GitHub Pages.
export default defineConfig({
  base: './',
  test: { environment: 'node' },
});
