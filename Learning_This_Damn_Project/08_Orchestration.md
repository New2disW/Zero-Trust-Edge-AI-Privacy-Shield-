# Phase 8: The Orchestrator — `useDocumentAI.ts`

> **Goal:** This is the BRAIN of the project — 1181 lines that wire every module together. It's a React custom hook that manages the entire state machine: from PDF upload to AI response. By the end, you'll understand how every piece connects and the state management patterns used.

---

## Why One Giant Hook?

You might think: "1181 lines in one file? Isn't that bad practice?"

For this project, it makes sense:
1. **All state is interconnected** — document state, worker state, conversation state, and privacy state all depend on each other
2. **The pipeline is sequential** — PDF → Chunks → Embeddings → Search → Sanitize → LLM → Rehydrate
3. **Splitting into many hooks** would create complex prop-drilling or context chains

Think of `useDocumentAI` as a **state machine controller** — it manages transitions between states and coordinates async operations.

---

## The State Machine

```
┌────────────────┐
│    IDLE         │  No PDF loaded. Show the dropzone.
│                │
│  User drops    │
│  a PDF file    │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│  INGESTING      │  Processing the PDF:
│                │  1. Extract text (PDFExtractor)
│                │  2. Split into chunks (Chunker)
│                │  3. Generate embeddings (embedding-worker)
│                │  4. Store in VectorStore
│                │
│  Progress bar  │
│  shows steps   │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│    READY        │  Document indexed. Chat interface visible.
│                │
│  User types    │
│  a question    │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│   QUERYING      │  Processing the question:
│                │  1. Sanitize user input
│                │  2. Embed query
│                │  3. Vector search (Top-K)
│                │  4. Sanitize Top-K chunks
│                │  5. Build prompt
│                │  6. Stream LLM response
│                │  7. Rehydrate
│                │
│  Streaming     │
│  response      │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│    READY        │  Response displayed. User can ask another question.
│                │
└────────────────┘
```

---

## The Hook's Return Type (What the UI Gets)

```typescript
export interface UseDocumentAIReturn {
  // Current state
  stage: 'idle' | 'ingesting' | 'ready' | 'querying';

  // Worker status
  embeddingWorkerStatus: WorkerStatusInfo;
  nerWorkerStatus: WorkerStatusInfo;

  // Document info
  fileName: string | null;
  chunkCount: number;

  // Chat
  messages: ConversationMessage[];
  isStreaming: boolean;

  // Ingestion progress
  pipelineSteps: PipelineStep[];
  ingestionProgress: number;

  // Settings
  privacyShieldEnabled: boolean;
  topK: number;
  semanticThreshold: number;
  groqApiKey: string;

  // Actions
  ingestDocument: (file: File) => Promise<void>;
  submitQuery: (query: string) => Promise<void>;
  resetDocument: () => void;
  togglePrivacyShield: () => void;
  setTopK: (value: number) => void;
  setSemanticThreshold: (value: number) => void;
  setGroqApiKey: (key: string) => void;
}
```

---

## The Internal State (What the Hook Manages)

```typescript
function useDocumentAI(): UseDocumentAIReturn {
  // ─── STAGE & PIPELINE ────────────────────────────────────
  const [stage, setStage] = useState<'idle' | 'ingesting' | 'ready' | 'querying'>('idle');
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>([]);
  const [ingestionProgress, setIngestionProgress] = useState(0);

  // ─── DOCUMENT ────────────────────────────────────────────
  const [fileName, setFileName] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState(0);

  // ─── CONVERSATION ────────────────────────────────────────
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  // ─── SETTINGS ────────────────────────────────────────────
  const [privacyShieldEnabled, setPrivacyShieldEnabled] = useState(true);
  const [topK, setTopK] = useState(5);
  const [semanticThreshold, setSemanticThreshold] = useState(0.35);
  const [groqApiKey, setGroqApiKey] = useState('');

  // ─── WORKER STATUS ───────────────────────────────────────
  const [embeddingWorkerStatus, setEmbeddingWorkerStatus] = useState<WorkerStatusInfo>({
    stage: 'pending', model: '', device: ''
  });
  const [nerWorkerStatus, setNerWorkerStatus] = useState<WorkerStatusInfo>({
    stage: 'pending', model: '', device: ''
  });

  // ─── REFS (mutable values that don't trigger re-renders) ──
  const embeddingWorkerRef = useRef<Worker | null>(null);
  const nerWorkerRef = useRef<Worker | null>(null);
  const vectorStoreRef = useRef(new VectorStore());
  const chunkerRef = useRef(new Chunker({ chunkSize: 1000, chunkOverlap: 200 }));
  const tokenRegistryRef = useRef(createTokenRegistry());
  const pendingEmbeddingRequestsRef = useRef(new Map());
  const pendingNERRequestsRef = useRef(new Map());
```

> **Why `useRef` instead of `useState` for workers and vector store?**
> - `useState` triggers a re-render when updated. We don't want to re-render the entire app every time we add a chunk to the vector store.
> - `useRef` stores a mutable value that persists across renders without triggering re-renders.
> - Workers, VectorStore, Chunker, and pending request maps are **mutable infrastructure** — the UI doesn't need to react to their internal changes.

---

## The Document Ingestion Pipeline

When a user drops a PDF, `ingestDocument()` runs:

```typescript
const ingestDocument = async (file: File): Promise<void> => {
  setStage('ingesting');

  // Define the pipeline steps for the UI progress indicator
  const steps: PipelineStep[] = [
    { label: 'Extracting text', hint: 'Reading PDF...', state: 'pending' },
    { label: 'Chunking', hint: 'Splitting into pieces...', state: 'pending' },
    { label: 'Generating embeddings', hint: 'Creating vectors...', state: 'pending' },
    { label: 'Indexing', hint: 'Building search index...', state: 'pending' }
  ];

  const updateStep = (index: number, state: 'active' | 'complete') => {
    steps[index].state = state;
    setPipelineSteps([...steps]);  // Spread to trigger re-render
  };

  try {
    // ─── STEP 1: Extract text ──────────────────────────────
    updateStep(0, 'active');
    const extracted = await PDFExtractor.extract(file);
    setFileName(extracted.fileName);
    updateStep(0, 'complete');

    // ─── STEP 2: Chunk the text ────────────────────────────
    updateStep(1, 'active');
    const chunks = chunkerRef.current.split(extracted.fullText);
    setChunkCount(chunks.length);
    updateStep(1, 'complete');

    // ─── STEP 3: Generate embeddings ───────────────────────
    updateStep(2, 'active');
    const texts = chunks.map(c => c.text);

    // Send to the embedding worker and wait for response
    const requestId = uuidv4();
    const embeddingResult = await sendEmbeddingRequest({
      type: 'embed',
      requestId,
      payload: { texts }
    });
    updateStep(2, 'complete');

    // ─── STEP 4: Index in the vector store ─────────────────
    updateStep(3, 'active');
    vectorStoreRef.current.clear();  // Clear any previous document

    const records = chunks.map((chunk, index) => ({
      text: chunk.text,
      embedding: embeddingResult.embeddings[index],
      metadata: {
        chunkIndex: chunk.index,
        length: chunk.length
      }
    }));

    vectorStoreRef.current.addMany(records);
    updateStep(3, 'complete');

    // ─── DONE ──────────────────────────────────────────────
    setStage('ready');

    // Add a system message to the chat
    setMessages([{
      id: uuidv4(),
      role: 'system',
      content: `Indexed "${extracted.fileName}" — ${chunks.length} chunks ready.`,
      createdAt: Date.now()
    }]);

  } catch (error) {
    setStage('idle');
    setMessages(prev => [...prev, {
      id: uuidv4(),
      role: 'system',
      content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      createdAt: Date.now()
    }]);
  }
};
```

---

## The Query Pipeline

When a user submits a question, `submitQuery()` runs:

```typescript
const submitQuery = async (query: string): Promise<void> => {
  if (!query.trim() || stage !== 'ready') return;

  setStage('querying');
  setIsStreaming(true);

  // ─── Add user message to chat ──────────────────────────
  const userMessage: ConversationMessage = {
    id: uuidv4(),
    role: 'user',
    content: query,
    createdAt: Date.now()
  };
  setMessages(prev => [...prev, userMessage]);

  try {
    // ─── STEP 1: Sanitize the user's input ───────────────
    let sanitizedQuery = query;
    let inputDictionary: Record<string, { label: string; original: string }> = {};

    if (privacyShieldEnabled) {
      const result = await sanitizeText(query, tokenRegistryRef.current);
      sanitizedQuery = result.sanitizedText;
      inputDictionary = result.dictionary;
    }

    // ─── STEP 2: Embed the query ─────────────────────────
    const queryEmbeddingResult = await sendEmbeddingRequest({
      type: 'embed',
      requestId: uuidv4(),
      payload: { texts: [sanitizedQuery] }
    });
    const queryVector = queryEmbeddingResult.embeddings[0];

    // ─── STEP 3: Vector search ───────────────────────────
    const searchResults = vectorStoreRef.current.search(queryVector, topK);

    // ─── STEP 4: Semantic routing ────────────────────────
    const topScore = searchResults.length > 0 ? searchResults[0].score : 0;
    const { route, reason } = determineRoute(topScore, semanticThreshold, query);

    let redactedResults: RedactedSearchResult[] = [];
    let assistantContent = '';
    let systemPrompt = '';

    if (route === 'document') {
      // ─── STEP 5: Sanitize Top-K chunks ──────────────
      if (privacyShieldEnabled) {
        redactedResults = await sanitizeDocumentChunks(
          searchResults, tokenRegistryRef.current
        );
      } else {
        // No sanitization — use raw chunks
        redactedResults = searchResults.map(r => ({
          ...r,
          redactedText: r.text,
          dictionary: {}
        }));
      }

      // ─── STEP 6: Build the prompt with chunks ───────
      const chunksContext = redactedResults
        .map((r, i) => `Chunk ${i} (${(r.score * 100).toFixed(1)}% match):\n${r.redactedText}`)
        .join('\n\n');

      systemPrompt = SYSTEM_PROMPT_DOCUMENT.replace('{chunks}', chunksContext);
    } else {
      systemPrompt = SYSTEM_PROMPT_GENERAL;
    }

    // ─── STEP 7: Stream from LLM ──────────────────────
    // Create a placeholder assistant message
    const assistantMessage: ConversationMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      route,
      routeMessage: reason,
      privacyShieldEnabled,
      semanticScore: topScore,
      semanticThreshold,
      sanitizedInput: sanitizedQuery !== query ? sanitizedQuery : undefined,
      sanitizedInputDictionary: Object.keys(inputDictionary).length ? inputDictionary : undefined,
      results: redactedResults.length ? redactedResults : undefined
    };

    setMessages(prev => [...prev, assistantMessage]);

    // Build the merged dictionary (input + all chunks)
    const mergedDictionary = { ...inputDictionary };
    for (const result of redactedResults) {
      Object.assign(mergedDictionary, result.dictionary);
    }

    // Stream the LLM response
    const completion = await streamCompletion({
      apiKey: groqApiKey,
      systemPrompt,
      userMessage: sanitizedQuery,
      onDelta: (delta) => {
        assistantContent += delta;

        // Rehydrate and update the message in real-time
        const rehydrated = rehydrate(assistantContent, mergedDictionary);

        setMessages(prev =>
          prev.map(msg =>
            msg.id === assistantMessage.id
              ? { ...msg, content: rehydrated }
              : msg
          )
        );
      }
    });

    // ─── STEP 8: Final rehydration ────────────────────
    const finalContent = rehydrate(completion.content, mergedDictionary);
    setMessages(prev =>
      prev.map(msg =>
        msg.id === assistantMessage.id
          ? { ...msg, content: finalContent }
          : msg
      )
    );

  } catch (error) {
    setMessages(prev => [...prev, {
      id: uuidv4(),
      role: 'system',
      content: `Error: ${error instanceof Error ? error.message : 'Query failed'}`,
      createdAt: Date.now()
    }]);
  } finally {
    setStage('ready');
    setIsStreaming(false);
  }
};
```

---

## The Worker Management Pattern

### Worker Initialization

```typescript
useEffect(() => {
  // Create workers using Vite's special URL syntax
  const embeddingWorker = new Worker(
    new URL('../workers/embedding-worker.ts', import.meta.url),
    { type: 'module' }
  );
  const nerWorker = new Worker(
    new URL('../workers/ner-worker.ts', import.meta.url),
    { type: 'module' }
  );

  embeddingWorkerRef.current = embeddingWorker;
  nerWorkerRef.current = nerWorker;

  // Set up message handlers
  embeddingWorker.onmessage = handleEmbeddingMessage;
  nerWorker.onmessage = handleNERMessage;

  // Initialize both models in parallel
  const initId1 = uuidv4();
  const initId2 = uuidv4();
  embeddingWorker.postMessage({ type: 'init', requestId: initId1 });
  nerWorker.postMessage({ type: 'init', requestId: initId2 });

  // Cleanup on unmount
  return () => {
    embeddingWorker.terminate();
    nerWorker.terminate();
    // Reject any pending promises
    for (const [, pending] of pendingEmbeddingRequestsRef.current) {
      pending.reject(new Error('Worker terminated'));
    }
    pendingEmbeddingRequestsRef.current.clear();
    for (const [, pending] of pendingNERRequestsRef.current) {
      pending.reject(new Error('Worker terminated'));
    }
    pendingNERRequestsRef.current.clear();
  };
}, []);  // Empty deps = runs once on mount
```

### The Promise-Based Worker Communication

```typescript
// Send a request and get a Promise back
function sendEmbeddingRequest(request: EmbeddingWorkerRequest): Promise<EmbeddingWorkerCompleteMessage> {
  return new Promise((resolve, reject) => {
    const worker = embeddingWorkerRef.current;
    if (!worker) return reject(new Error('Worker not initialized'));

    pendingEmbeddingRequestsRef.current.set(request.requestId, { resolve, reject });
    worker.postMessage(request);
  });
}

// Handle incoming messages from the worker
function handleEmbeddingMessage(event: MessageEvent<EmbeddingWorkerResponse>) {
  const message = event.data;

  if (message.type === 'status') {
    // Update UI status (model loading progress, etc.)
    setEmbeddingWorkerStatus({
      stage: message.stage,
      model: message.model,
      device: message.device,
      message: message.message,
      progress: message.progress
    });
    return;
  }

  if (message.type === 'complete' && message.requestId) {
    const pending = pendingEmbeddingRequestsRef.current.get(message.requestId);
    if (pending) {
      pendingEmbeddingRequestsRef.current.delete(message.requestId);
      pending.resolve(message);
    }
    return;
  }

  if (message.type === 'error' && message.requestId) {
    const pending = pendingEmbeddingRequestsRef.current.get(message.requestId);
    if (pending) {
      pendingEmbeddingRequestsRef.current.delete(message.requestId);
      pending.reject(new Error(message.message));
    }
  }
}
```

---

## Key Architectural Patterns

### Pattern 1: State + Refs Separation

```
useState (triggers UI re-render):          useRef (no re-render):
├── stage                                  ├── embeddingWorkerRef
├── messages                               ├── nerWorkerRef
├── fileName                               ├── vectorStoreRef
├── chunkCount                             ├── chunkerRef
├── isStreaming                             ├── tokenRegistryRef
├── pipelineSteps                          ├── pendingEmbeddingRequestsRef
└── settings (topK, threshold, etc.)       └── pendingNERRequestsRef
```

**Rule:** If the UI needs to display it → `useState`. If it's internal infrastructure → `useRef`.

### Pattern 2: Immutable State Updates

```typescript
// ❌ BAD: Mutating state directly
messages.push(newMessage);
setMessages(messages);

// ✅ GOOD: Creating a new array (immutability)
setMessages(prev => [...prev, newMessage]);

// ✅ GOOD: Updating a specific message
setMessages(prev =>
  prev.map(msg =>
    msg.id === targetId
      ? { ...msg, content: newContent }  // New object for the changed message
      : msg                               // Same reference for unchanged messages
  )
);
```

React compares old and new state by reference. If you mutate an existing array, React doesn't notice the change and won't re-render.

### Pattern 3: Resource Lifecycle Management

```typescript
useEffect(() => {
  // SETUP: Create resources
  const worker = new Worker(...);
  workerRef.current = worker;

  // CLEANUP: Destroy resources when component unmounts
  return () => {
    worker.terminate();
    // Reject pending promises to prevent memory leaks
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error('Terminated'));
    }
    pendingRequests.clear();
  };
}, []);
```

This ensures no memory leaks and no orphaned workers.

---

## Dead Code in This File

Two functions are defined but never used:

1. **`combineResults()`** (line ~1131) — Was likely an earlier approach to merging search results with sanitization results. Replaced by inline logic in `submitQuery`.

2. **`resetConversationMemory()`** (line ~898) — Intended for a "clear conversation" button that was never wired up in the UI.

---

## Interview Questions

### Basic
- **Q:** "Walk me through what happens when a user drops a PDF."
- **A:** "Four steps: (1) PDFExtractor reads the binary and extracts text page by page, (2) Chunker splits the text into ~1000-char overlapping pieces, (3) the embedding worker converts each chunk to a 384-dim vector, (4) all chunks and vectors are stored in the VectorStore. The entire process runs in the browser."

### Intermediate
- **Q:** "Why use `useRef` for the VectorStore instead of `useState`?"
- **A:** "The VectorStore is mutable infrastructure — adding items, searching — these operations don't need to trigger a React re-render. Using `useState` would cause unnecessary re-renders every time a chunk is added. `useRef` persists the reference across renders without triggering updates."

### Advanced
- **Q:** "How do you handle the case where the user asks a question before both workers are ready?"
- **A:** "The `sendEmbeddingRequest` function checks if the worker ref is non-null. If the worker hasn't been created yet, the Promise rejects immediately. The `submitQuery` function catches this error and displays it to the user. In practice, the workers initialize within a few seconds of mounting."

### Design
- **Q:** "If you were to refactor this into smaller pieces, how would you do it?"
- **A:** "I'd extract: (1) a `useWorkers()` hook for worker lifecycle and the Promise-based communication protocol, (2) a `usePIISanitization()` hook for the regex + NER sanitization logic, (3) a `useRAGPipeline()` hook for vector search + prompt building, and (4) keep the top-level `useDocumentAI()` as a thin orchestration layer. I'd use React Context for shared state like the token registry."

---

**Next Phase → [09_UI_Layer.md](./09_UI_Layer.md)** — We'll build the UI: chat interface, inspector drawer, and component architecture.
