import { defineConfig } from 'vitest/config';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * React Compiler (stable Babel build): memoises components and hooks automatically, so a /me refetch, a poll or a
 * keystroke re-renders what changed instead of the whole shell. The code already passes the compiler's lint rules
 * (eslint-plugin-react-hooks recommended); a component that breaks a rule is skipped by the compiler, not miscompiled.
 *
 * Modules that use React Hook Form are left alone: `formState` is a proxy that subscribes on read, and a form object
 * handed down as a prop is the same reference after every validation, so a memoised step kept showing no errors
 * (device-new-page.test.tsx caught it). The compiler only recognises the hook itself, not a form passed around.
 */
const compiler = reactCompilerPreset();
const reactCompiler = {
  ...compiler,
  rolldown: { ...compiler.rolldown, filter: { ...compiler.rolldown?.filter, code: { include: /forwardRef|memo|\b(?:[A-Z]|use[A-Z0-9])/, exclude: /['"]react-hook-form['"]/ } } },
};

/** A vendor group: every module that lives in one of these packages (pnpm nests them as `node_modules/<name>/`). */
const vendor = (...packages: string[]) => new RegExp(`[\\\\/]node_modules[\\\\/](${packages.map((p) => p.replace('/', '[\\\\/]')).join('|')})[\\\\/]`);

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompiler] }), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { port: 5173 },
  build: {
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Long-lived vendor chunks, matched by package path rather than by import specifier, so `react-dom` and
        // `react-dom/client` (and any other sub-path) always land in the same chunk as their package.
        codeSplitting: {
          groups: [
            { name: 'react', test: vendor('react', 'react-dom', 'scheduler', 'react-router', 'cookie-es', '@remix-run/route-pattern'), priority: 30 },
            { name: 'query', test: vendor('@tanstack/react-query', '@tanstack/query-core', '@tanstack/react-table', '@tanstack/table-core'), priority: 20 },
            { name: 'supabase', test: vendor('@supabase'), priority: 20 },
            { name: 'charts', test: vendor('recharts', 'victory-vendor', 'd3-[a-z-]+', 'internmap', 'decimal.js-light', 'es-toolkit', 'eventemitter3', '@reduxjs/toolkit', 'redux', 'react-redux', 'redux-thunk', 'reselect', 'immer'), priority: 10 },
            { name: 'i18n', test: vendor('i18next', 'react-i18next', 'i18next-browser-languagedetector', 'html-parse-stringify', 'void-elements'), priority: 20 },
            { name: 'luxon', test: vendor('luxon'), priority: 20 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    testTimeout: 20_000,
    // component tests import the app shell, which validates these at module load; the values are inert (no network in jsdom)
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: 'test-anon-key', VITE_API_URL: 'http://localhost:4000' },
  },
});
