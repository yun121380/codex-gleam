import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const aliases = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer')
}

/**
 * The production renderer is served from file:// and must never reach the network.
 * The dev server needs inline scripts + a websocket for HMR, so the strict policy
 * is injected only into the built HTML.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function injectContentSecurityPolicy(): Plugin {
  return {
    name: 'gleam-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!-- CSP_PLACEHOLDER -->',
        `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    build: {
      outDir: 'out/main',
      minify: false,
      sourcemap: true,
      lib: { entry: resolve(__dirname, 'src/main/main.ts') }
    }
  },
  preload: {
    resolve: { alias: aliases },
    build: {
      outDir: 'out/preload',
      minify: false,
      sourcemap: true,
      lib: { entry: resolve(__dirname, 'src/preload/preload.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    resolve: { alias: aliases },
    plugins: [react(), tailwindcss(), injectContentSecurityPolicy()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
