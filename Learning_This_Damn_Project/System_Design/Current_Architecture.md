# System Design — Current Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  BROWSER (everything runs here)                                         │
│                                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  Main Thread │  │  Worker #1   │  │  Worker #2   │                  │
│  │              │  │  Embeddings  │  │  NER / PII   │                  │
│  │  React UI    │  │  MiniLM-L6   │  │  BERT NER    │                  │
│  │  + Pipeline  │  │              │  │              │                  │
│  │  Orchestrator│  │  ONNX/WASM   │  │  ONNX/WASM   │                  │
│  │              │  │  or WebGPU   │  │  or WebGPU   │                  │
│  └───────┬──────┘  └──────┬───────┘  └──────┬───────┘                  │
│          │                │                 │                          │
│          │  postMessage   │  postMessage    │                          │
│          ├────────────────┤─────────────────┤                          │
│          │                                                             │
│  ┌───────┴──────────────────────────────────────────┐                  │
│  │  In-Memory Data Layer                             │                  │
│  │  ├── VectorStore (Map<id, chunk+vector>)          │                  │
│  │  ├── TokenRegistry (Map<fingerprint, token>)      │                  │
│  │  └── React State (messages, settings, stage)      │                  │
│  └──────────────────────────────────────┬────────────┘                  │
│                                         │                              │
│                            Only masked data leaves                     │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ HTTPS (SSE stream)
                             │ Only sanitized text
                             ▼
                  ┌──────────────────────┐
                  │  Groq Cloud API      │
                  │  (Llama 3.1 8B)      │
                  │                      │
                  │  Receives:           │
                  │  [PERSON_1]'s salary │
                  │  is ₹25,00,000       │
                  └──────────────────────┘
```

## Data Flow Summary

| Stage | Input | Output | Location | Latency |
|-------|-------|--------|----------|---------|
| PDF Extract | File blob | fullText string | Main thread | ~200ms |
| Chunking | fullText | TextChunk[] (~50-200) | Main thread | ~5ms |
| Embedding | texts[] | Float32Array[] (384-dim) | Worker #1 | ~2-4s |
| Indexing | chunks + vectors | VectorStore | Main thread | ~1ms |
| Query Embed | query string | Float32Array (384-dim) | Worker #1 | ~50ms |
| Vector Search | query vector | Top-K results | Main thread | ~1ms |
| Sanitization | Top-K chunks | Redacted chunks | Main thread + Worker #2 | ~200ms |
| LLM Streaming | Sanitized prompt | Token stream | Cloud | ~500ms-3s |
| Rehydration | Tokenized response | Human-readable answer | Main thread | ~1ms |

## Security Architecture

```
┌──────────────────── CSP BOUNDARY ────────────────────┐
│                                                       │
│  Allowed outbound connections:                        │
│  ├── huggingface.co (model downloads, cached)         │
│  └── api.groq.com (LLM queries, sanitized data only) │
│                                                       │
│  Blocked:                                            │
│  ├── All other domains                               │
│  ├── Inline scripts (production)                     │
│  ├── eval()                                          │
│  └── iframe embedding                                │
│                                                       │
│  Headers:                                            │
│  ├── COOP: same-origin (SharedArrayBuffer)           │
│  ├── COEP: credentialless (cross-origin isolation)    │
│  ├── X-Content-Type-Options: nosniff                 │
│  └── Referrer-Policy: strict-origin                  │
└───────────────────────────────────────────────────────┘
```

## Threading Model

```
Main Thread                     Worker #1 (Embedding)     Worker #2 (NER)
─────────────────────────────   ───────────────────────   ─────────────────
React renders                   MiniLM-L6 model           BERT NER model
User input handling             Tensor ops (ONNX)         Tensor ops (ONNX)
VectorStore operations          Float32Array output       Token classification
State management                                          Span merging
Sanitization coordination                                 RTL replacement
SSE stream reading
Rehydration
```

No shared memory between threads. All communication via `postMessage` with Transferable objects for large arrays.
