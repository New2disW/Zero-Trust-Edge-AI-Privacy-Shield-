# Phase 5: Off-Main-Thread AI with Web Workers

> **Goal:** We need to run two AI models in the browser: one for generating embeddings (MiniLM-L6), one for detecting names/entities (BERT NER). These models take 200-800ms per inference — if they ran on the main thread, the UI would freeze. We solve this with Web Workers. By the end, you'll understand Web Workers, the Singleton pattern for model loading, and the async message protocol.

---

## What is a Web Worker?

JavaScript in the browser runs on a **single thread** called the "main thread." This thread handles:
- Rendering the UI
- Processing user clicks/typing
- Running your JavaScript code

If your code takes 500ms to run, the UI **freezes** for 500ms. No scrolling, no typing, nothing.

```
WITHOUT Web Workers:
┌──────────────────────────────────────────────────────────┐
│  MAIN THREAD                                             │
│                                                          │
│  [Render UI] [Handle Click] [AI Inference 500ms...] [UI] │
│                              ^^^^^^^^^^^^^^^^^^^^^^^^     │
│                              UI IS FROZEN HERE! ❌        │
└──────────────────────────────────────────────────────────┘

WITH Web Workers:
┌──────────────────────────────────────────────────────────┐
│  MAIN THREAD                                             │
│  [Render UI] [Handle Click] [Render UI] [Handle Click]   │
│                                          ✅ UI stays      │
│                                          responsive!      │
├──────────────────────────────────────────────────────────┤
│  WORKER THREAD                                           │
│  [AI Inference 500ms.......] [Done! Post result back]    │
└──────────────────────────────────────────────────────────┘
```

A Web Worker is a **separate JavaScript thread**. It runs in parallel, has its own memory, and communicates with the main thread via `postMessage()`.

### Key Rules of Web Workers:
1. **No DOM access** — Workers can't touch HTML elements
2. **Communication via messages** — Workers and main thread exchange data via `postMessage()`
3. **Data is copied** — When you send data to a worker, it's copied (unless using Transferable objects)
4. **Separate global scope** — Workers use `self` instead of `window`

---

## Our Two Workers

| Worker | AI Model | Purpose | Output |
|--------|----------|---------|--------|
| `embedding-worker.ts` | `Xenova/all-MiniLM-L6-v2` | Convert text → 384-dim vectors | `Float32Array[]` |
| `ner-worker.ts` | `Xenova/bert-base-NER` | Detect person names, organizations, locations | `RedactionResult[]` |

Both workers follow the **exact same architecture**. Once you understand one, you understand both.

---

## The Message Protocol: How Main Thread and Workers Talk

Workers communicate through messages. We need a structured protocol:

```
MAIN THREAD                              WORKER THREAD
    │                                        │
    │  ───── {type: 'init'} ──────────────▶  │  Load AI model
    │                                        │
    │  ◀── {type: 'status', stage: 'init'} ─ │  "Starting..."
    │  ◀── {type: 'status', stage: 'progress'}│  "Loading file X..."
    │  ◀── {type: 'status', stage: 'ready'} ─│  "Model loaded!"
    │  ◀── {type: 'complete'} ────────────── │  "Done!"
    │                                        │
    │  ─ {type: 'embed', texts: [...]} ───▶  │  Generate embeddings
    │                                        │
    │  ◀── {type: 'status', stage: 'ready'} ─│  "Processing..."
    │  ◀── {type: 'complete', embeddings} ── │  Result!
    │                                        │
```

### The Type Definitions (`types.ts`)

This file defines the "language" that workers and the main thread speak:

```typescript
// What lifecycle stage is the worker in?
export type WorkerLifecycleStage =
  | 'init'       // Model is being downloaded
  | 'progress'   // Download progress update
  | 'ready'      // Model is loaded and ready
  | 'complete'   // Task finished
  | 'error';     // Something went wrong

// Status message: worker → main thread
export interface WorkerStatusMessage {
  type: 'status';
  requestId?: string;     // Which request is this about?
  stage: 'init' | 'progress' | 'ready';
  message: string;         // Human-readable status
  progress?: number;       // 0.0 to 1.0 (download progress)
  model: string;           // e.g., "Xenova/all-MiniLM-L6-v2"
  device: 'webgpu' | 'wasm';  // Which hardware accelerator
}

// Error message: worker → main thread
export interface WorkerErrorMessage {
  type: 'error';
  requestId?: string;
  message: string;
}
```

**For the Embedding Worker:**

```typescript
// Request: main thread → worker
export interface EmbeddingWorkerInitRequest {
  type: 'init';
  requestId: string;  // Unique ID to track this request
}

export interface EmbeddingWorkerEmbedRequest {
  type: 'embed';
  requestId: string;
  payload: {
    texts: string[];   // Texts to convert to vectors
  };
}

export type EmbeddingWorkerRequest =
  | EmbeddingWorkerInitRequest
  | EmbeddingWorkerEmbedRequest;

// Response: worker → main thread
export interface EmbeddingWorkerCompleteMessage {
  type: 'complete';
  requestId: string;
  embeddings: Float32Array[];  // The resulting vectors
  dimension: number;           // e.g., 384
  count: number;               // How many texts were embedded
}

// All possible messages from the embedding worker
export type EmbeddingWorkerResponse =
  | WorkerStatusMessage
  | WorkerErrorMessage
  | EmbeddingWorkerCompleteMessage;
```

**For the NER Worker:**

```typescript
// The result of redacting one text
export interface RedactionResult {
  originalText: string;    // "Rahul Sharma works at Google"
  redactedText: string;    // "[PERSON_A] works at [ORG_A]"
  dictionary: Record<string, RedactionDictionaryEntry>;  // {[PERSON_A]: {label: "PERSON", original: "Rahul Sharma"}}
  spans: RedactionSpan[];  // Where each entity was found
}

export interface NERWorkerRedactRequest {
  type: 'redact';
  requestId: string;
  payload: {
    texts: string[];  // Texts to scan for entities
  };
}

export interface NERWorkerCompleteMessage {
  type: 'complete';
  requestId: string;
  results: RedactionResult[];
}
```

> **Why `requestId`?** Because messages are asynchronous. The main thread might send 3 requests before getting any response. The `requestId` lets us match each response to its original request. This is essentially a hand-rolled **RPC (Remote Procedure Call)** protocol.

---

## Building `embedding-worker.ts` — Step by Step

### Step 1: Configure the AI Runtime

```typescript
/// <reference lib="webworker" />
// ↑ This tells TypeScript we're in a Web Worker context (self, not window)

import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
  type ProgressInfo
} from '@huggingface/transformers';

// Import WASM binary URLs using Vite's ?url suffix
// These are the ONNX Runtime files that actually execute the AI model
import ortWasmSimdThreadedJsepMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasmSimdThreadedJsepWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import ortWasmSimdThreadedMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import ortWasmSimdThreadedWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';

// Model name on Hugging Face Hub
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

// Detect if the browser supports WebGPU (faster) or fall back to WASM
const WORKER_DEVICE: 'webgpu' | 'wasm' =
  typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
```

**What's happening here:**

```
Transformers.js (high-level API)
    ↓ uses
ONNX Runtime (execution engine)
    ↓ needs
WASM or WebGPU (hardware acceleration)
    ↓ needs
.wasm binary files (the compiled engine)

We import these .wasm files as URLs so Vite includes them in the build.
```

### Step 2: Configure ONNX Runtime Paths

```typescript
// Tell ONNX Runtime where to find its WASM files
const configureONNXEnvironment = env.backends.onnx as { wasm?: { wasmPaths?: any } };

env.allowLocalModels = false;  // Don't look for models on disk (we're in a browser)
env.useBrowserCache = true;    // Cache downloaded models in IndexedDB

configureONNXEnvironment.wasm = configureONNXEnvironment.wasm ?? {};
configureONNXEnvironment.wasm.wasmPaths =
  WORKER_DEVICE === 'webgpu'
    ? { mjs: ortWasmSimdThreadedJsepMjsUrl, wasm: ortWasmSimdThreadedJsepWasmUrl }
    : { mjs: ortWasmSimdThreadedMjsUrl, wasm: ortWasmSimdThreadedWasmUrl };
```

> **Why different WASM files for WebGPU vs WASM?**
> WebGPU uses JSEP (JavaScript Execution Provider) — a bridge between ONNX Runtime and the GPU. WASM uses a pure CPU-based execution path. They need different compiled binaries.

### Step 3: The Singleton Pattern for Model Loading

```typescript
class EmbeddingPipelineSingleton {
  // The cached model pipeline — null means not loaded yet
  private static instance: Promise<FeatureExtractionPipeline> | null = null;

  static getInstance(
    progress_callback?: (progress: ProgressInfo) => void
  ): Promise<FeatureExtractionPipeline> {
    // First call: start loading the model
    // Subsequent calls: return the same Promise (already loading or loaded)
    if (!this.instance) {
      this.instance = pipeline('feature-extraction', MODEL_NAME, {
        progress_callback,
        device: WORKER_DEVICE
      });
    }
    return this.instance;
  }
}
```

**Why Singleton?**

```
WITHOUT Singleton:
  Request 1: Load model (200MB download)... done
  Request 2: Load model (200MB download AGAIN!)... done  ← WASTE!
  Request 3: Load model (200MB download AGAIN!)... done  ← WASTE!

WITH Singleton:
  Request 1: Load model (200MB download)... done
  Request 2: Reuse cached model... instant ✅
  Request 3: Reuse cached model... instant ✅
```

> **Subtle detail:** We store a `Promise`, not the resolved value. This means even if two requests arrive simultaneously before the model finishes loading, they both get the SAME Promise. No duplicate downloads.

### Step 4: The Message Handler

```typescript
const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<EmbeddingWorkerRequest>) => {
  const { data } = event;

  try {
    switch (data.type) {
      case 'init': {
        await initializeModel(data.requestId);
        break;
      }
      case 'embed': {
        await embedTexts(data.requestId, data.payload.texts);
        break;
      }
      default: {
        postError('Unsupported embedding worker message type.', data);
      }
    }
  } catch (error) {
    postError(
      error instanceof Error ? error.message : 'Embedding worker failed.',
      data
    );
  }
};
```

### Step 5: The Actual Embedding Logic

```typescript
async function embedTexts(requestId: string, texts: string[]): Promise<void> {
  if (texts.length === 0) {
    // Return empty result for empty input
    workerScope.postMessage({
      type: 'complete', requestId, embeddings: [], dimension: 0, count: 0
    });
    return;
  }

  // Get the model (loads on first call, cached thereafter)
  const extractor = await EmbeddingPipelineSingleton.getInstance();

  // Run inference: texts → tensor of embeddings
  const tensor = await extractor(texts, {
    pooling: 'mean',      // Average all token embeddings into one vector per text
    normalize: true        // Normalize vectors to unit length (makes cosine = dot product)
  });

  // The tensor is a flat array — split it into individual embeddings
  const count = texts.length;
  const dimension = tensor.dims.at(-1) ?? 0;  // e.g., 384
  const embeddings = Array.from({ length: count }, (_, index) => {
    const start = index * dimension;
    const end = start + dimension;
    return new Float32Array(tensor.data.slice(start, end));
  });

  // Send results back to main thread
  // Using Transferable objects to MOVE (not copy) the ArrayBuffers
  workerScope.postMessage(
    { type: 'complete', requestId, embeddings, dimension, count },
    embeddings.map((e) => e.buffer)  // ← Transfer ownership, avoid copy
  );
}
```

> **Transferable Objects:** Normally, `postMessage` copies data. For large `Float32Array`s, this copy is expensive. By passing `embedding.buffer` as a Transferable, we **transfer ownership** — the main thread gets the buffer instantly, and the worker can no longer access it. Zero-copy transfer.

---

## The NER Worker (`ner-worker.ts`)

The NER (Named Entity Recognition) worker follows the exact same pattern but:
1. Uses `Xenova/bert-base-NER` model instead of MiniLM
2. Runs `token-classification` instead of `feature-extraction`
3. Post-processes the output to **merge token-level predictions into entity spans**

### The Core Difference: Token → Entity Span Merging

BERT NER doesn't output "Rahul Sharma is a person." It outputs token-level labels:

```
Token:  "Rah"   "##ul"  "Sha"   "##rma"  "works"  "at"   "Goo"  "##gle"
Label:  B-PER   I-PER   I-PER   I-PER    O        O      B-ORG  I-ORG
Score:  0.98    0.97    0.96    0.95     0.99     0.99   0.94   0.92

B = Beginning of entity
I = Inside (continuation) of entity
O = Outside (not an entity)
```

We need to merge these into spans:

```
"Rahul Sharma"  → PERSON (spans characters 0-12)
"Google"        → ORG    (spans characters 22-28)
```

### The `aggregateEntitySpans` Function

```typescript
function aggregateEntitySpans(
  sourceText: string,
  predictions: TokenClassificationOutput
): RedactionSpan[] {
  const spans: RedactionSpan[] = [];
  let currentSpan: RedactionSpan | null = null;

  for (const prediction of predictions) {
    // Skip invalid predictions
    if (typeof prediction.start !== 'number' || prediction.end <= prediction.start) continue;

    const entityText = sourceText.slice(prediction.start, prediction.end).trim();
    if (!entityText) continue;

    const { prefix, label } = parseEntityLabel(prediction.entity);
    // prefix = 'B' or 'I', label = 'PERSON', 'ORG', 'LOCATION'
    if (!label) continue;

    const nextSpan = {
      start: prediction.start,
      end: prediction.end,
      label,
      placeholder: '',
      text: entityText,
      score: prediction.score
    };

    // Can we extend the current span?
    const canExtend =
      currentSpan !== null &&
      prefix !== 'B' &&                        // Not a new entity beginning
      currentSpan.label === nextSpan.label &&   // Same entity type
      nextSpan.start <= currentSpan.end + 1;    // Adjacent or overlapping

    if (!canExtend || currentSpan === null) {
      // Start a new span
      if (currentSpan) spans.push(currentSpan);
      currentSpan = nextSpan;
    } else {
      // Extend the current span
      currentSpan.end = Math.max(currentSpan.end, nextSpan.end);
      currentSpan.text = sourceText.slice(currentSpan.start, currentSpan.end).trim();
      currentSpan.score = (currentSpan.score + nextSpan.score) / 2;
    }
  }

  if (currentSpan) spans.push(currentSpan);
  return spans.filter((span) => span.text.length > 0);
}
```

### The Overlap Resolution (`collapseOverlaps`)

Models sometimes produce overlapping spans. We resolve them:

```typescript
function collapseOverlaps(spans: RedactionSpan[]): RedactionSpan[] {
  const sortedSpans = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end
  );
  const collapsed: RedactionSpan[] = [];

  for (const span of sortedSpans) {
    const previous = collapsed.at(-1);

    // No overlap — just add it
    if (!previous || span.start >= previous.end) {
      collapsed.push(span);
      continue;
    }

    // Same label — merge the spans
    if (previous.label === span.label) {
      previous.end = Math.max(previous.end, span.end);
      previous.score = Math.max(previous.score, span.score);
      continue;
    }

    // Different labels overlapping — keep the better one
    const preferCurrent =
      span.score > previous.score ||
      (span.score === previous.score && span.end - span.start > previous.end - previous.start);

    if (preferCurrent) {
      collapsed[collapsed.length - 1] = span;
    }
  }

  return collapsed;
}
```

> **This is the classic "merge overlapping intervals" problem from DSA!** Frequently asked in coding interviews. Here it has the twist of label-based conflict resolution.

### Right-to-Left Replacement

After finding entity spans, we replace them with placeholders. But we must do this **right-to-left**:

```
Text: "Rahul works at Google in Bangalore"
Spans: [0-5: PERSON], [15-21: ORG], [25-34: LOCATION]

LEFT-TO-RIGHT (BROKEN):
  Replace Rahul (0-5) with [PERSON_A] (10 chars)
  → "[PERSON_A] works at Google in Bangalore"
  Now Google is at position 20, not 15! Our span offsets are WRONG! 💥

RIGHT-TO-LEFT (CORRECT):
  Replace Bangalore (25-34) with [LOCATION_A] first
  → "Rahul works at Google in [LOCATION_A]"
  Replace Google (15-21) with [ORG_A]
  → "Rahul works at [ORG_A] in [LOCATION_A]"
  Replace Rahul (0-5) with [PERSON_A]
  → "[PERSON_A] works at [ORG_A] in [LOCATION_A]"
  ✅ All offsets are correct because we only change text AFTER our cursor!
```

```typescript
// Sort spans from right to left (highest start position first)
const replacements = [...spans].sort((left, right) => right.start - left.start);
let redactedText = sourceText;

for (const span of replacements) {
  // Generate or reuse a placeholder
  const placeholder = getOrCreatePlaceholder(span);

  // Replace the text at the span's position
  redactedText =
    redactedText.slice(0, span.start) +
    placeholder +
    redactedText.slice(span.end);
}
```

---

## How Workers Are Created and Managed

In `useDocumentAI.ts`, the workers are created in a `useEffect`:

```typescript
useEffect(() => {
  // Create workers using Vite's special URL syntax
  const embeddingWorker = new Worker(
    new URL('../workers/embedding-worker.ts', import.meta.url),
    { type: 'module' }  // ES module worker
  );
  const nerWorker = new Worker(
    new URL('../workers/ner-worker.ts', import.meta.url),
    { type: 'module' }
  );

  // Set up message handlers
  embeddingWorker.onmessage = (event) => handleEmbeddingWorkerMessage(event.data);
  nerWorker.onmessage = (event) => handleNERWorkerMessage(event.data);

  // Initialize both models in parallel
  void initializeWorkers();

  // Cleanup: terminate workers when component unmounts
  return () => {
    embeddingWorker.terminate();
    nerWorker.terminate();
    // Reject any pending requests
    for (const pending of pendingRequestsRef.current.values()) {
      pending.reject(new Error('Worker was terminated.'));
    }
  };
}, []);
```

### The Promise-Based Request/Response Pattern

```typescript
// Send a request to a worker and return a Promise
const sendEmbeddingRequest = (
  request: EmbeddingWorkerRequest
): Promise<EmbeddingWorkerCompleteMessage> => {
  const worker = embeddingWorkerRef.current;
  if (!worker) return Promise.reject(new Error('Worker not available.'));

  return new Promise((resolve, reject) => {
    // Store the resolve/reject handlers keyed by requestId
    pendingEmbeddingRequestsRef.current.set(request.requestId, { resolve, reject });
    // Send the message
    worker.postMessage(request);
  });
};

// When a response arrives, find the matching pending request
const handleEmbeddingWorkerMessage = (message: EmbeddingWorkerResponse) => {
  if (message.type === 'complete') {
    const pending = pendingEmbeddingRequestsRef.current.get(message.requestId);
    if (pending) {
      pendingEmbeddingRequestsRef.current.delete(message.requestId);
      pending.resolve(message);  // Resolves the Promise!
    }
  }
};
```

```
Main Thread                               Worker Thread
    │                                         │
    │  sendEmbeddingRequest({                  │
    │    requestId: "abc-123",                 │
    │    type: 'embed',                        │
    │    payload: { texts: ["Hello"] }         │
    │  })                                      │
    │                                          │
    │  → Creates Promise                       │
    │  → Stores {resolve, reject}              │
    │    in Map keyed by "abc-123"             │
    │  → postMessage() ────────────────────▶   │
    │                                          │  Runs AI model
    │                                          │
    │  ◀──────────────────── postMessage() ──  │
    │  → Looks up "abc-123" in Map             │
    │  → Calls resolve(message)                │
    │  → Promise resolves!                     │
    │  → Caller gets the embeddings            │
    │                                          │
```

---

## Interview Questions

### Basic
- **Q:** "Why use Web Workers?"
- **A:** "AI model inference takes 200-800ms per call. If this ran on the main thread, the UI would freeze — no scrolling, no typing. Web Workers run in separate threads, keeping the UI responsive at 60fps."

### Intermediate
- **Q:** "Explain the Singleton pattern in your workers."
- **A:** "Each worker has a Singleton class that caches the AI model pipeline. The first call to `getInstance()` downloads and compiles the model. Subsequent calls return the same cached Promise — no duplicate downloads. I cache the Promise itself (not the resolved value) so that even simultaneous calls don't trigger duplicate loads."

### Advanced
- **Q:** "How do you handle request/response correlation with workers?"
- **A:** "I implemented an async RPC-like protocol. Each request has a UUID `requestId`. The main thread stores `{resolve, reject}` handlers in a Map keyed by this ID. When the worker posts a response, I look up the matching handler and resolve the Promise. This turns the callback-based `postMessage` API into a Promise-based one."

### Trap
- **Q:** "Why not use `SharedArrayBuffer` instead of `postMessage` for data transfer?"
- **A:** "`SharedArrayBuffer` would avoid copying data between threads, but it requires atomic operations and careful synchronization to prevent race conditions. For our use case, the data volumes are modest (a few kilobytes of text, megabytes of vectors). I use Transferable objects for the large `Float32Array` buffers — this gives zero-copy transfer without the complexity of shared memory."

---

**Next Phase → [06_Privacy_Engine.md](./06_Privacy_Engine.md)** — We'll build the PII detection and masking system.
