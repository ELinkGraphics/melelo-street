import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // Otherwise watch app source only — never .skill/.git/dist/supabase, whose
      // files can lock on Windows and crash the watcher (EBUSY).
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: ['**/.skill/**', '**/.claude/**', '**/.git/**', '**/dist/**', '**/supabase/**'],
      },
    },
  };
});
