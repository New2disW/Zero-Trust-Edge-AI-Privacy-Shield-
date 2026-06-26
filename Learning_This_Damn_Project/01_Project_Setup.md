# Phase 1: Project Setup — The Foundation

> **Goal:** You have the idea. Now set up the project from scratch. Understand every dependency, every config file, and WHY each decision was made. After this phase, you should be able to explain what happens when you type `npm run dev`.

---

## Step 1: "I Have an Idea. What Do I Create First?"

You want to build a browser app. You need:
- A **build tool** to bundle your code (Vite)
- A **UI library** to build the interface (React)
- A **language** that catches bugs early (TypeScript)

The very first command you'd run:

```bash
npx create-vite@latest zero-trust-document-ai --template react-ts
cd zero-trust-document-ai
npm install
```

This gives you a bare React + TypeScript + Vite skeleton. Now you need to add the actual dependencies for your project.

---

## Step 2: Understanding `package.json`

This is the **shopping list** of your project. Every library you need is listed here.

```json
{
  "name": "zero-trust-document-ai",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "sync:wasm": "node ./scripts/copy-ort-wasm.mjs",
    "postinstall": "npm run sync:wasm",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.2.4",
    "pdfjs-dist": "^4.8.69",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-dropzone": "^14.3.5",
    "uuid": "^11.0.5"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.2",
    "vite": "^5.4.11"
  }
}
```

### Every Dependency Explained

#### Production Dependencies (what your app needs to RUN)

| Package | What It Does | Why We Chose It | Alternatives We Could Have Used |
|---------|-------------|----------------|-------------------------------|
| `@huggingface/transformers` | Runs AI models (NER, Embeddings) directly in the browser using WebGPU or WASM | It's the ONLY mature library that lets you run Hugging Face models in the browser. No server needed. | `tensorflow.js` — but doesn't support Hugging Face model formats; `ONNX Runtime` alone — but Transformers.js wraps it with a nicer API |
| `pdfjs-dist` | Mozilla's PDF parsing engine. Extracts text from PDF files | It's the gold standard for browser-based PDF reading. Used by Firefox itself. Fully client-side. | `pdf-parse` — but it's Node.js only, needs a server; `mammoth` — only handles Word docs, not PDFs |
| `react` | UI component library | Industry standard for building interactive UIs | `Vue`, `Svelte` — equally valid, React was chosen for familiarity |
| `react-dom` | React's bridge to the actual browser DOM | Required companion to `react` | N/A — always paired with `react` |
| `react-dropzone` | Handles drag-and-drop file uploads | Small, focused library that handles all edge cases (file type validation, multiple files, etc.) | Write our own with the HTML5 Drag & Drop API — but that has many browser quirks |
| `uuid` | Generates unique IDs like `"a1b2c3d4-e5f6-..."` | We need unique IDs to track which worker response belongs to which request | `crypto.randomUUID()` — built into browsers, but `uuid` is more portable; `nanoid` — another option |

#### Dev Dependencies (needed only during development)

| Package | What It Does |
|---------|-------------|
| `typescript` | The TypeScript compiler. Converts `.ts`/`.tsx` files to JavaScript |
| `vite` | The build tool. Serves your app locally during dev, bundles it for production |
| `@vitejs/plugin-react` | Tells Vite how to handle React's JSX syntax |
| `tailwindcss` | CSS utility framework. Write `className="text-white bg-black"` instead of custom CSS |
| `postcss` | CSS processing pipeline. Tailwind needs this to generate its utility classes |
| `autoprefixer` | Adds browser-specific CSS prefixes (e.g., `-webkit-`) automatically |
| `@types/react`, `@types/react-dom`, `@types/node` | TypeScript type definitions for React and Node.js APIs |

### The Scripts Explained

```json
"scripts": {
  "dev": "vite",                              // Start the dev server (http://localhost:5173)
  "build": "tsc -b && vite build",            // Type-check, then build for production
  "preview": "vite preview",                   // Preview the production build locally
  "sync:wasm": "node ./scripts/copy-ort-wasm.mjs",  // Copy ONNX WASM files (see below)
  "postinstall": "npm run sync:wasm",          // Auto-runs after npm install
  "typecheck": "tsc --noEmit"                  // Just check types, don't generate files
}
```

**Why `sync:wasm`?**
The `@huggingface/transformers` library internally uses ONNX Runtime, which needs `.wasm` files. This script copies those WASM binaries to the `public/` folder so the browser can load them. However, in the current codebase, the workers import WASM files directly using Vite's `?url` import feature, making this script somewhat vestigial.

---

## Step 3: Understanding `vite.config.ts`

This is the **brain of the build system**. Let's read it line by line:

```typescript
// Node.js built-in modules for handling file paths
import { fileURLToPath, URL } from 'node:url';
// The React plugin — teaches Vite how to handle JSX/TSX files
import react from '@vitejs/plugin-react';
// Vite's config helper
import { defineConfig } from 'vite';
```

### The Content Security Policy (CSP) — A Real Security Feature

```typescript
function buildCsp(isDev: boolean): string {
  return [
    // By default, only allow resources from our own domain
    "default-src 'self'",

    // Scripts: allow our own scripts + WebAssembly execution
    // In dev mode, also allow inline scripts (Vite uses them for hot reload)
    isDev
      ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
      : "script-src 'self' 'wasm-unsafe-eval'",

    // Styles: allow inline styles (Tailwind generates them)
    "style-src 'self' 'unsafe-inline'",

    // Images: allow self, data: URIs, and blob: URIs
    "img-src 'self' data: blob:",

    // Fonts
    "font-src 'self' data:",

    // Network requests: this is the MOST IMPORTANT line
    // Only allow connections to:
    //   - ourselves (self)
    //   - WebSocket (for Vite dev server hot reload)
    //   - Hugging Face CDN (to download AI models)
    //   - Groq API (to send sanitized queries)
    "connect-src 'self' ws: wss: https://huggingface.co https://*.huggingface.co https://cdn-lfs.huggingface.co https://hf.co https://*.hf.co https://api.groq.com",

    // Web Workers can be loaded from self or blob: URIs
    "worker-src 'self' blob:",

    // No plugins (Flash, etc.)
    "object-src 'none'",

    // Prevent clickjacking — no one can embed our app in an iframe
    "frame-ancestors 'none'"
  ].join('; ');
}
```

> **Interview Gold:** If asked "What security measures did you implement?", you can point to this CSP. It explicitly whitelists only two external domains (Hugging Face for model downloads, Groq for LLM queries). This is defense-in-depth.

### The Security Headers

```typescript
function buildSharedHeaders(isDev: boolean) {
  return {
    'Content-Security-Policy': buildCsp(isDev),

    // These two headers together enable SharedArrayBuffer,
    // which is required for multi-threaded WASM execution
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',

    // Don't leak the full URL when navigating to external sites
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Prevent browsers from guessing the MIME type
    'X-Content-Type-Options': 'nosniff'
  };
}
```

> **Why `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy`?**
> Web Workers with `SharedArrayBuffer` (needed for multi-threaded WASM) require these headers. Without them, the browser refuses to give you shared memory. This is a post-Spectre security requirement.

### The Main Config

```typescript
export default defineConfig(({ command }) => {
  const isDev = command === 'serve'; // true during `npm run dev`

  return {
    plugins: [react()],

    resolve: {
      alias: {
        // This lets you write `import { Chunker } from '@/lib/Chunker'`
        // instead of `import { Chunker } from '../../lib/Chunker'`
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },

    // Tell Vite that .wasm and .onnx files are assets (not code)
    assetsInclude: ['**/*.wasm', '**/*.onnx'],

    optimizeDeps: {
      // Don't pre-bundle Transformers.js — it has dynamic imports
      // that Vite's optimizer can't handle correctly
      exclude: ['@huggingface/transformers']
    },

    // Attach security headers to the dev server
    server: {
      headers: buildSharedHeaders(isDev)
    },

    // Attach security headers to the preview server too
    preview: {
      headers: buildSharedHeaders(false)
    },

    // Web Workers must use ES module format
    worker: {
      format: 'es'
    },

    // Build for modern browsers only (enables top-level await, etc.)
    build: {
      target: 'esnext',
      sourcemap: true
    }
  };
});
```

### Key Decisions & Why

| Decision | Why | Alternative |
|----------|-----|------------|
| `exclude: ['@huggingface/transformers']` | Transformers.js uses dynamic `import()` internally to load models on demand. Vite's optimizer tries to pre-bundle everything, which breaks these dynamic imports | Could let Vite bundle it, but then model loading would crash at runtime |
| `worker: { format: 'es' }` | Our workers use ES `import` syntax. Without this, Vite would compile them as classic scripts, breaking `import` statements | Could use classic workers, but then we can't use `import` |
| `target: 'esnext'` | We use modern features (top-level await, optional chaining, etc.) | Could target older browsers, but we need WebGPU/WASM support anyway |
| CSP headers | Even though the app is client-side, CSP prevents XSS attacks and limits where data can be sent | Could skip them, but that weakens the "zero trust" claim |

---

## Step 4: Understanding `tailwind.config.ts`

Tailwind is a CSS framework. Instead of writing `.my-button { color: white; background: blue; }`, you write `className="text-white bg-blue-500"` directly in your JSX.

```typescript
import type { Config } from 'tailwindcss';

export default {
  // Tell Tailwind which files to scan for class names
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  theme: {
    extend: {
      // Custom colors used throughout the UI
      colors: {
        ink: {
          950: '#040816',   // Very dark blue-black (background)
          900: '#09111f',
          800: '#111d31'
        },
        signal: {
          cyan: '#7dd3fc',   // Accent color for highlights
          mint: '#34d399',   // Success / active indicators
          amber: '#fbbf24',  // Warning indicators
          rose: '#fb7185'    // Error indicators
        }
      },

      // Custom shadows for the glassmorphism panels
      boxShadow: {
        panel: '0 24px 80px rgba(2, 6, 23, 0.48)',
        glow: '0 0 0 1px rgba(125, 211, 252, 0.18), 0 28px 120px rgba(14, 165, 233, 0.12)'
      },

      // Custom animations
      keyframes: {
        drift: { /* Slow floating animation */ },
        pulseSoft: { /* Gentle pulsing for status indicators */ },
        sheen: { /* Shimmering effect on progress bars */ }
      },
      animation: {
        drift: 'drift 10s ease-in-out infinite',
        'pulse-soft': 'pulseSoft 1.8s ease-in-out infinite',
        sheen: 'sheen 2.8s linear infinite'
      }
    }
  },
  plugins: []
} satisfies Config;
```

---

## Step 5: Understanding `index.html` + `main.tsx`

### `index.html` — The Entry Point

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zero-Trust Document AI</title>
  </head>
  <body>
    <!-- React will render the entire app inside this div -->
    <div id="root"></div>

    <!-- Vite loads our TypeScript entry point as an ES module -->
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### `main.tsx` — The React Entry Point

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';      // Our main application component
import './styles.css';         // Global styles (Tailwind + custom)

// Find the <div id="root"> in index.html and render our app inside it
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**What is `React.StrictMode`?**
It's a development-only wrapper that:
- Warns you about unsafe lifecycle methods
- Detects unexpected side effects by rendering components twice (only in dev)
- Helps you find bugs early

---

## Step 6: Understanding `styles.css`

```css
/* Import Tailwind's three layers */
@tailwind base;        /* CSS reset + base styles */
@tailwind components;  /* Component-level classes */
@tailwind utilities;   /* Utility classes like text-white, bg-black */

@layer base {
  :root {
    color-scheme: dark;   /* Tell the browser this is a dark-theme app */
  }

  html {
    min-height: 100%;
    /* Multi-layered gradient background — creates depth */
    background:
      radial-gradient(circle at top left, rgba(8, 145, 178, 0.16), transparent 30%),
      radial-gradient(circle at top right, rgba(52, 211, 153, 0.12), transparent 24%),
      linear-gradient(180deg, #040816 0%, #050b17 100%);
  }

  body {
    /* Tailwind's @apply lets you use Tailwind classes inside CSS */
    @apply min-h-screen bg-transparent text-slate-100 antialiased;
    margin: 0;
    font-family: "Soehne", "Avenir Next", "IBM Plex Sans", "Segoe UI", sans-serif;
  }
}

@layer components {
  /* Reusable glassmorphism panel */
  .panel-surface {
    @apply rounded-[28px] border border-white/10 bg-white/[0.04]
           shadow-panel backdrop-blur-2xl;
  }

  /* Subtle version of the panel */
  .panel-surface-muted {
    @apply rounded-[24px] border border-white/10 bg-white/[0.03]
           backdrop-blur-xl;
  }

  /* Status pill badges */
  .signal-pill {
    @apply inline-flex items-center gap-2 rounded-full border border-white/10
           bg-white/[0.05] px-3 py-1 text-[0.68rem] font-medium uppercase
           tracking-[0.24em] text-slate-300;
  }

  /* Subtle grid pattern overlay */
  .grid-noise {
    background-image:
      linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
    background-size: 32px 32px;
    mask-image: radial-gradient(circle at center, black 32%, transparent 88%);
  }
}
```

---

## Step 7: The `scripts/copy-ort-wasm.mjs` Script

This script runs after `npm install`. It copies ONNX Runtime WASM files from `node_modules` to `public/wasm/`:

```javascript
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Find the project root directory
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');

// Source: ONNX Runtime's compiled WASM files inside node_modules
const sourceDirectory = resolve(projectRoot, 'node_modules/onnxruntime-web/dist');

// Target: our public folder (served as static assets by Vite)
const targetDirectory = resolve(projectRoot, 'public/wasm');

// If ONNX Runtime isn't installed, skip silently
if (!existsSync(sourceDirectory)) {
  console.warn('onnxruntime-web dist folder was not found. Skipping WASM sync.');
  process.exit(0);
}

// Clean and recreate target directory
rmSync(targetDirectory, { recursive: true, force: true });
mkdirSync(targetDirectory, { recursive: true });

// Copy only .mjs and .wasm files (not everything)
cpSync(sourceDirectory, targetDirectory, {
  recursive: true,
  filter: (sourcePath) => {
    if (sourcePath === sourceDirectory) return true;
    return /ort(?:[-.].+)?\.(?:mjs|wasm)$/.test(sourcePath);
  }
});
```

> **Note:** In the current codebase, the workers directly import WASM files using Vite's `?url` import syntax (e.g., `import wasmUrl from '../../node_modules/.../ort-wasm-simd-threaded.wasm?url'`). This means the copy script is largely vestigial — Vite handles the WASM bundling automatically.

---

## Development Simulation: How a Real Student Would Build This

### Attempt 1: "Let me just use create-react-app"
**Problem:** Create React App doesn't support Web Workers with ES modules, doesn't handle WASM imports, and doesn't let you set custom headers.

### Attempt 2: "Fine, I'll use Vite"
**Better!** Vite has native Web Worker support with `new Worker(new URL(...), { type: 'module' })` and handles `.wasm` imports via the `?url` suffix.

### Attempt 3: "The AI model won't load..."
**Debugging:** The ONNX Runtime needs `SharedArrayBuffer`, which requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` headers. Without them, the browser blocks shared memory for security reasons (post-Spectre vulnerability mitigation). Added these to `vite.config.ts`.

### Attempt 4: "Transformers.js breaks during Vite's pre-bundling..."
**Fix:** Added `optimizeDeps: { exclude: ['@huggingface/transformers'] }` to prevent Vite from trying to pre-analyze Transformers.js's dynamic imports.

> **Interview Line:** "Initially I tried the default Vite setup, but I ran into two issues: the ONNX Runtime needs specific CORS headers for SharedArrayBuffer, and Transformers.js uses dynamic imports that break Vite's dependency optimizer. I had to configure custom headers and exclude the library from pre-bundling."

---

## Interview Questions for This Phase

### Basic
- Q: "What build tool does this project use?"
- A: "Vite. I chose it over CRA or Webpack because it has native ES module support, handles Web Workers with `type: 'module'`, and can import WASM files directly."

### Intermediate
- Q: "Why do you have security headers in a Vite config?"
- A: "Two reasons. First, `COOP` and `COEP` headers are required for `SharedArrayBuffer`, which ONNX Runtime uses for multi-threaded WASM execution. Second, the CSP header restricts outbound connections to only Hugging Face (for model downloads) and Groq (for LLM queries), enforcing the zero-trust principle at the network level."

### Advanced
- Q: "What happens if you remove the `optimizeDeps.exclude` for Transformers.js?"
- A: "Vite's dependency pre-bundling would try to statically analyze Transformers.js and bundle it. But Transformers.js dynamically imports model-specific code at runtime based on which model you load. The pre-bundler can't resolve those dynamic paths, so it either throws build errors or silently drops the imports, causing runtime crashes when loading models."

### Trap Question
- Q: "Your `copy-ort-wasm.mjs` copies WASM to `public/`. Isn't that redundant since your workers import WASM via Vite's `?url` suffix?"
- A: "Good catch — yes, it is largely redundant in the current implementation. The workers import WASM paths directly using `?url` imports, which lets Vite handle the bundling. The copy script is a leftover from an earlier approach where the WASM files were served as static assets from `public/`. I should clean it up."

---

**Next Phase → [02_Reading_PDFs.md](./02_Reading_PDFs.md)** — We'll build the PDF text extractor from scratch.
