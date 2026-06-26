# How to Explain the Codebase from Start to Finish

If an interviewer asks, **"Walk me through the codebase from start to finish,"** or **"Explain how this project works under the hood,"** you need a structured, connected story. 

Below is the step-by-step script for explaining the architecture. For each phase, we list exactly which files are involved and how you should explain the code inside them.

---

## Phase 1: The Big Picture & Architecture (Start Here)
*Start by setting the stage so the interviewer understands the constraints and goals.*

**What's Happening:** Establishing that this is a 100% client-side application. No backend server is used for processing.

**Files Involved:**
- `package.json`: Explain that you are using React 18, Vite for bundling, `@huggingface/transformers` for local AI models, and `pdfjs-dist` for document parsing.
- `vite.config.ts`: Explain that you had to configure strict CORS headers (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`) to allow `SharedArrayBuffer` to work. Explain that this is a hard requirement for ONNX Runtime to use multi-threading in Web Workers.

**The Narrative:** 
- "The entire application is a React single-page app built with Vite."
- "The core constraint I gave myself was **Zero-Trust**: no raw document data should ever leave the user's browser."
- "To achieve this, the architecture is split into two main pipelines: the **Ingestion Pipeline** (processing the PDF) and the **Query Pipeline** (answering questions securely). I use Web Workers to handle heavy AI tasks off the main UI thread."

---

## Phase 2: The Ingestion Pipeline — Reading the PDF
*Transition to what happens when the user drops a file.*

**What's Happening:** Converting a binary PDF file into a single massive string of text.

**Files Involved:**
- `src/lib/PDFExtractor.ts`: 
  - **What to explain:** The `extract()` method. 
  - **How to explain:** Mention that you disable `isEvalSupported` for security. Explain that pdf.js returns text items with X/Y coordinates on the page. Explain that you loop through every page, group text items by their `transform[5]` (the Y coordinate), sort them by X coordinate, and join them to reconstruct natural reading lines.

**The Narrative:**
- "When the user uploads a PDF, it never hits a server. Instead, I pass it to my `PDFExtractor.ts` class."
- "Because PDFs don't have a concept of 'lines' or 'paragraphs', I wrote an algorithm that groups characters sharing the same Y-axis coordinate to reconstruct sentences."

---

## Phase 3: The Ingestion Pipeline — Chunking
*Transition from one massive text block to manageable pieces.*

**What's Happening:** Splitting the extracted text into overlapping chunks.

**Files Involved:**
- `src/lib/Chunker.ts`: 
  - **What to explain:** The `splitRecursively()` and `mergeSplits()` methods.
  - **How to explain:** Explain that `splitRecursively` uses a separator hierarchy (`\n\n`, then `\n`, then `. `). Explain that `mergeSplits` rebuilds chunks up to the max size while keeping a trailing tail of words for the `chunkOverlap`.

**The Narrative:**
- "You can't feed a 100-page PDF into an AI model—it hits the token limit. So, I pass the full text into my `Chunker.ts`."
- "I implemented a **recursive text splitter** that respects natural language boundaries, falling back from paragraphs to lines to sentences."
- "Crucially, I implemented a sliding-window overlap (e.g., 200 characters) so that if a key sentence falls on a boundary, the context isn't lost between two chunks."

---

## Phase 4: The Ingestion Pipeline — Vectorization & Indexing
*Transition from text chunks to mathematical representations.*

**What's Happening:** Turning chunks into numbers (vectors) and saving them.

**Files Involved:**
- `src/workers/embedding-worker.ts`:
  - **What to explain:** The `EmbeddingPipelineSingleton` and the `postMessage` architecture.
  - **How to explain:** Explain that the Singleton ensures the 80MB MiniLM model only downloads once. Explain that you use Transferable Objects (`Float32Array.buffer`) in `postMessage` to send data back to the main thread with zero-copy memory overhead.
- `src/lib/VectorStore.ts`:
  - **What to explain:** The `add()` method and `Float32Array` usage.
  - **How to explain:** Explain that you use a `Map` keyed by UUID for O(1) storage. Emphasize that during insertion, you pre-calculate and cache the vector's magnitude to drastically speed up search later.

**The Narrative:**
- "Next, I need to make these chunks searchable. I pass them to a dedicated **Web Worker** running a MiniLM-L6 model via ONNX Runtime."
- "The worker returns a 384-dimensional `Float32Array` vector for each chunk. I do this in a worker thread so the React UI doesn't freeze."
- "Finally, I store these chunks and their vectors in my custom `VectorStore.ts`."

---

## Phase 5: The Query Pipeline — Semantic Search
*The ingestion is done. Now, transition to what happens when the user types a question.*

**What's Happening:** Finding the chunks that answer the user's question.

**Files Involved:**
- `src/lib/VectorStore.ts`:
  - **What to explain:** The `search()` method and the `cosineSimilarity()` math.
  - **How to explain:** Walk through the math: dot product divided by the product of magnitudes. Mention that because magnitudes are cached during insertion, the search is extremely fast (O(N*D) where N is chunks and D is 384 dimensions) and takes less than 1ms.

**The Narrative:**
- "When the user asks 'What is Rahul's salary?', the embedding worker converts the query into a vector."
- "My Vector Store runs a brute-force **Cosine Similarity** search comparing the query vector against all document vectors, sorting by score to return the Top-K most relevant chunks."

---

## Phase 6: The Query Pipeline — The Privacy Engine (The Climax)
*This is the most important part of the interview. Spend the most time here.*

**What's Happening:** Masking sensitive data *before* it touches the cloud.

**Files Involved:**
- `src/hooks/useDocumentAI.ts`:
  - **What to explain:** The `REGEX_PII_RULES` array, the `getOrCreateSessionToken()` function (the ledger), and the right-to-left string replacement loop inside `sanitizeDocumentChunks()`.
  - **How to explain:** Explain the ledger: a shared `Map` linking `LABEL::normalized_text` (e.g. `PERSON::rahul sharma`) to a token like `[PERSON_1]`. Explain that replacing from Right-to-Left prevents string index corruption.
- `src/workers/ner-worker.ts`:
  - **What to explain:** The `aggregateEntitySpans()` and `collapseOverlaps()` functions.
  - **How to explain:** Explain that the BERT NER model predicts at the token level ("Rah", "##ul"). You have to merge consecutive 'B' and 'I' tags into a single span, and use `collapseOverlaps` to resolve conflicts if the model predicts overlapping entities.

**The Narrative:**
- "Now I have the Top-K chunks containing the answer, but they are full of raw PII. Before sending them to the LLM, I run them through my **Triple-Layer Privacy Engine**."
- "Layer 1: Deterministic Regex scanning for 20+ patterns like Aadhaar and Emails."
- "Layer 2: A BERT NER model in a second Web Worker catching unstructured data like Names and Organizations."
- "Layer 3: The Global Ledger. If 'Rahul' becomes `[PERSON_1]` in chunk A, 'Rahul' must also become `[PERSON_1]` in chunk B."
- "Crucially, this is **Just-In-Time (JIT) Sanitization**. I sanitize *after* vector search, not before, preserving embedding quality."

---

## Phase 7: The Query Pipeline — LLM Integration & Rehydration
*The grand finale. Getting the answer and making it readable.*

**What's Happening:** Chatting with the LLM and swapping tokens back to real names.

**Files Involved:**
- `src/services/llmService.ts`:
  - **What to explain:** The `streamCompletion()` function.
  - **How to explain:** Explain that you use the native `fetch` API, call `response.body.getReader()`, decode the byte stream with `TextDecoder`, and parse the Server-Sent Events line by line, executing an `onDelta` callback for every new word.
- `src/utils/rehydration.ts`:
  - **What to explain:** The `rehydrate()` function and the prefix collision edge-case.
  - **How to explain:** Explain that you iterate over the dictionary keys to run `text.replaceAll()`. Emphasize that you MUST sort the keys longest-first (`[PERSON_10]` before `[PERSON_1]`) so you don't accidentally corrupt longer tokens.

**The Narrative:**
- "I construct a system prompt containing the **sanitized** chunks and send it to the Groq API."
- "I use **Server-Sent Events (SSE)** to stream the response back word-by-word."
- "The LLM replies using the tokens, like: `'[PERSON_1]'s salary is ₹25L'`."
- "As the stream comes in, my `rehydrate()` function looks up `[PERSON_1]` in the Global Ledger and swaps it back to 'Rahul', completely on the client side."

---

## Phase 8: Orchestration & UI — Tying it all together
*Wrap up by explaining how the code is organized.*

**What's Happening:** The state machine that controls the UI and connects all the files above.

**Files Involved:**
- `src/hooks/useDocumentAI.ts`:
  - **What to explain:** The separation of `useState` and `useRef`. The `ingestDocument` and `submitQuery` functions.
  - **How to explain:** Explain that this hook is the "brain." It uses `useState` for things the UI needs to render (chat messages, progress) and `useRef` for mutable infrastructure (VectorStore, Workers, Ledger) to avoid unnecessary React re-renders. Explain the Promise-based wrapper around worker `postMessage` calls.
- `src/App.tsx` & `src/components/ChatMessage.tsx`:
  - **What to explain:** Conditional rendering based on the `stage` state, and the `PayloadDrawer`.
  - **How to explain:** Explain that the Payload Drawer allows the user to inspect the exact `assistantMessage.results` (the sanitized payload) to verify zero-trust compliance.

**The Narrative:**
- "All of this complexity is orchestrated by a massive custom hook called `useDocumentAI.ts`."
- "It acts as a state machine managing 'idle', 'ingesting', 'ready', and 'querying' states, orchestrating the promises between the workers, vector store, and LLM service."
- "The UI simply reads this state. To prove zero-trust to the user, I built a Privacy Inspector drawer in the UI where they can verify the exact sanitized chunks before and after the LLM call."
