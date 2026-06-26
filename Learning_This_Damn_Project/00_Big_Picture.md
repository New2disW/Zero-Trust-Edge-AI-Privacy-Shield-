# Phase 0: The Big Picture

> **Goal of this phase:** Before writing a single line of code, understand WHAT we're building, WHY it needs to exist, and HOW data flows through the entire system. By the end of this file, you should be able to draw the architecture on a whiteboard.

---

## The Problem We're Solving

Imagine you work at a company. You have a confidential PDF — maybe it contains employee salaries, customer Aadhaar numbers, medical records, or legal contracts.

You want to ask an AI questions about that PDF. Something like:
- "What is the salary of Rahul Sharma?"
- "Summarize the terms of this NDA."

The obvious solution: upload the PDF to ChatGPT or some cloud AI.

**But here's the problem:**

```
┌─────────────────────────────────────────────────────────────┐
│  YOUR BROWSER                                               │
│                                                             │
│  PDF contains:                                              │
│  • Rahul Sharma's Aadhaar: 4567 8912 1003                  │
│  • PAN: ABCDE1234F                                         │
│  • Salary: ₹25,00,000                                      │
│  • Email: rahul.sharma@company.com                          │
│                                                             │
│           ┌────────────────────┐                            │
│           │  UPLOAD ENTIRE PDF │ ──────────────────┐        │
│           └────────────────────┘                   │        │
└────────────────────────────────────────────────────┼────────┘
                                                     │
                                                     ▼
                                          ┌─────────────────┐
                                          │  CLOUD AI SERVER │
                                          │                 │
                                          │  Now the cloud  │
                                          │  has ALL your   │
                                          │  sensitive data  │
                                          │                 │
                                          │  ❌ Data leak!   │
                                          └─────────────────┘
```

The cloud AI server now has:
- Every name, every ID number, every salary
- It could be logged, stored, or leaked
- You have ZERO control over what happens to it

This is the **data leakage problem** in AI applications.

---

## Our Solution: The Zero-Trust Approach

"Zero Trust" means: **trust nobody. Not even the cloud AI.**

Instead of sending raw data to the cloud, we:

1. **Extract** the PDF text entirely inside the browser (no upload)
2. **Find** the relevant paragraphs using vector search (locally)
3. **Mask** all sensitive information BEFORE sending anything to the cloud
4. **Send** only the masked version to the AI
5. **Get** the AI's answer (which uses masked names like `[PERSON_1]`)
6. **Un-mask** the answer locally, putting the real names back

```
┌─────────────────────────────────────────────────────────────────┐
│  YOUR BROWSER (everything happens here locally)                 │
│                                                                 │
│  Step 1: Extract text from PDF                                  │
│  Step 2: Chop text into paragraphs (chunks)                    │
│  Step 3: Convert chunks to number-vectors (embeddings)          │
│  Step 4: User asks "What is Rahul's salary?"                   │
│  Step 5: Find the most relevant chunks (vector search)          │
│  Step 6: MASK all PII in those chunks:                         │
│          "Rahul Sharma" → [PERSON_1]                           │
│          "4567 8912 1003" → [AADHAAR_1]                        │
│          "ABCDE1234F" → [PAN_1]                                │
│                                                                 │
│  Step 7: Send MASKED chunks to cloud AI ──────────────┐        │
│                                                        │        │
│  Step 9: Receive AI answer:                            │        │
│  "[PERSON_1]'s salary is ₹25,00,000"                  │        │
│                                                        │        │
│  Step 10: UN-MASK locally:                             │        │
│  "Rahul Sharma's salary is ₹25,00,000"                │        │
│                                                        │        │
│  ✅ The cloud NEVER saw "Rahul Sharma"                  │        │
│  ✅ The cloud NEVER saw the Aadhaar number              │        │
└────────────────────────────────────────────────────────┼────────┘
                                                         │
                                                         ▼
                                              ┌──────────────────┐
                                              │  CLOUD AI (Groq) │
                                              │                  │
                                              │  Only sees:      │
                                              │  "[PERSON_1]'s   │
                                              │   salary is..."  │
                                              │                  │
                                              │  ✅ No real names │
                                              │  ✅ No real IDs   │
                                              └──────────────────┘
```

**This is the core idea. Everything else is just engineering to make this work well.**

---

## The Complete Data Flow (End to End)

Let's trace exactly what happens when a user drops a PDF and asks a question.

### Part A: Document Ingestion (happens once per PDF)

```
┌──────────┐     ┌───────────┐     ┌──────────────┐     ┌──────────────┐
│          │     │           │     │              │     │              │
│  PDF     │────▶│  pdf.js   │────▶│   Chunker    │────▶│  Embedding   │
│  File    │     │ Extractor │     │              │     │  Worker      │
│          │     │           │     │  Split into  │     │              │
│          │     │ Page by   │     │  ~1000 char  │     │  Convert to  │
│          │     │ page text │     │  overlapping │     │  384-dim     │
│          │     │ extraction│     │  pieces      │     │  vectors     │
│          │     │           │     │              │     │              │
└──────────┘     └───────────┘     └──────────────┘     └──────┬───────┘
                                                               │
                                                               ▼
                                                     ┌──────────────────┐
                                                     │   Vector Store   │
                                                     │                  │
                                                     │  In-memory map   │
                                                     │  of chunks +     │
                                                     │  their vectors   │
                                                     │                  │
                                                     │  Ready for       │
                                                     │  search!         │
                                                     └──────────────────┘
```

**In plain English:**
1. User drops a PDF file
2. `PDFExtractor` uses the `pdf.js` library to read every page and extract the text
3. `Chunker` splits the full text into ~1000-character paragraphs with 200-character overlap between adjacent chunks (so no information is lost at chunk boundaries)
4. `embedding-worker` (running in a separate thread via Web Worker) converts each chunk into a 384-dimensional number array (called an "embedding" or "vector") using the MiniLM-L6 AI model
5. All chunks + their vectors are stored in `VectorStore` (a simple in-memory HashMap)

### Part B: Query Pipeline (happens every time user asks a question)

```
┌────────────────┐
│ User types:    │
│ "What is       │
│ Rahul's        │
│ salary?"       │
└───────┬────────┘
        │
        ▼
┌───────────────────┐     ┌────────────────────┐
│ INPUT SANITIZATION│     │                    │
│                   │     │  EMBED THE QUERY   │
│ Regex scan:       │     │                    │
│ "Rahul" might be  │     │  Convert question  │
│ PII → mask it     │     │  to a 384-dim      │
│                   │     │  vector too         │
│ NER model scan:   │     │                    │
│ Detect names,     │     │                    │
│ orgs, locations   │     │                    │
└───────┬───────────┘     └────────┬───────────┘
        │                          │
        ▼                          ▼
┌───────────────────┐     ┌────────────────────┐
│ Sanitized query   │     │  VECTOR SEARCH     │
│ sent to LLM       │     │                    │
│                   │     │  Compare query     │
│                   │     │  vector against    │
│                   │     │  all chunk vectors │
│                   │     │                    │
│                   │     │  Return Top-5 most │
│                   │     │  similar chunks    │
│                   │     │                    │
│                   │     └────────┬───────────┘
│                   │              │
│                   │              ▼
│                   │     ┌────────────────────┐
│                   │     │  CHUNK SANITIZATION│
│                   │     │  (JIT = Just In    │
│                   │     │   Time)            │
│                   │     │                    │
│                   │     │  Layer 1: Regex    │
│                   │     │  Aadhaar, PAN,     │
│                   │     │  Email, Phone...   │
│                   │     │                    │
│                   │     │  Layer 2: NER AI   │
│                   │     │  Person names,     │
│                   │     │  Organizations,    │
│                   │     │  Locations         │
│                   │     │                    │
│                   │     │  Global Ledger:    │
│                   │     │  "Rahul" in chunk1 │
│                   │     │  = "Rahul" in      │
│                   │     │  chunk 5 → both    │
│                   │     │  become [PERSON_1] │
│                   │     └────────┬───────────┘
│                   │              │
└───────┬───────────┘              │
        │                          │
        ▼                          ▼
┌─────────────────────────────────────────────┐
│            GROQ API (Cloud LLM)             │
│                                             │
│  System prompt:                             │
│  "Here are document chunks. Answer the      │
│   user's question using only these chunks.  │
│   Chunks contain placeholders like          │
│   [PERSON_1]. Use them as-is."             │
│                                             │
│  Chunks: [PERSON_1] earns ₹25,00,000...    │
│  User: What is [PERSON_1]'s salary?        │
│                                             │
│  AI Response (streamed via SSE):            │
│  "[PERSON_1]'s salary is ₹25,00,000"       │
│                                             │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │  REHYDRATION   │
              │                │
              │  [PERSON_1] →  │
              │  "Rahul Sharma"│
              │                │
              │  Final answer: │
              │  "Rahul        │
              │  Sharma's      │
              │  salary is     │
              │  ₹25,00,000"  │
              │                │
              │  ✅ Displayed   │
              │  to user       │
              └────────────────┘
```

---

## The File Map (What Each File Does)

Think of the project as a factory with departments. Each file is a department.

```
src/
│
├── main.tsx                    ← THE FRONT DOOR
│                                 Just mounts the React app. 11 lines.
│
├── App.tsx                     ← THE RECEPTIONIST
│                                 The entire UI. Handles user interaction,
│                                 displays messages, manages the chat.
│                                 1046 lines.
│
├── styles.css                  ← THE INTERIOR DESIGNER
│                                 Dark theme, glassmorphism, custom scrollbars.
│                                 90 lines.
│
├── lib/                        ← THE CORE PROCESSING DEPARTMENTS
│   ├── PDFExtractor.ts         ← PDF READING DEPARTMENT
│   │                             Takes a PDF file, extracts text page by page.
│   │                             Uses pdf.js library. 177 lines.
│   │
│   ├── Chunker.ts              ← TEXT SPLITTING DEPARTMENT
│   │                             Takes a long string, splits it into ~1000-char
│   │                             pieces with 200-char overlap. 215 lines.
│   │
│   └── VectorStore.ts          ← THE MEMORY DEPARTMENT
│                                 Stores text chunks + their vector embeddings.
│                                 Performs cosine similarity search to find
│                                 the Top-K most relevant chunks. 191 lines.
│
├── workers/                    ← THE AI DEPARTMENTS (run in separate threads)
│   ├── types.ts                ← THE LANGUAGE AGREEMENT
│   │                             TypeScript interfaces that define how the
│   │                             main thread and workers communicate. 100 lines.
│   │
│   ├── embedding-worker.ts     ← THE VECTOR FACTORY
│   │                             Runs the MiniLM-L6 AI model to convert text
│   │                             into 384-dimensional number arrays. 234 lines.
│   │
│   └── ner-worker.ts           ← THE REDACTION FACTORY
│                                 Runs a BERT NER model to detect person names,
│                                 organizations, locations. Then replaces them
│                                 with placeholders. 410 lines.
│
├── services/
│   └── llmService.ts           ← THE COMMUNICATION DEPARTMENT
│                                 Sends sanitized chunks to the Groq API.
│                                 Reads the streamed response in real-time.
│                                 153 lines.
│
├── utils/
│   └── rehydration.ts          ← THE TRANSLATION DEPARTMENT
│                                 Takes the AI's answer (with [PERSON_1]) and
│                                 replaces placeholders back to real values.
│                                 23 lines.
│
├── hooks/
│   └── useDocumentAI.ts        ← THE CEO / ORCHESTRATOR
│                                 THE most important file. Connects every
│                                 department together. Manages the entire
│                                 pipeline from PDF upload to final answer.
│                                 1181 lines.
│
└── components/
    └── ChatMessage.tsx          ← THE MESSAGE DISPLAY
                                  Renders a single chat bubble (user or
                                  assistant). 128 lines.
```

---

## Key Technologies (Quick Overview)

We'll deep-dive into each in Phase 1. For now, just know what they are:

| Technology | What It Is | Why We Need It |
|-----------|-----------|---------------|
| **TypeScript** | JavaScript with types | Catch bugs at compile time, not in production |
| **React 18** | UI library | Build interactive chat interface |
| **Vite** | Build tool / dev server | Fast development, handles Web Workers & WASM |
| **pdf.js** | Mozilla's PDF reader | Extract text from PDFs entirely in the browser |
| **Transformers.js** | Hugging Face's ML library for the browser | Run AI models (NER, Embeddings) locally without a server |
| **ONNX Runtime** | ML model execution engine | Actually runs the AI model computations (used by Transformers.js) |
| **Web Workers** | Browser threads | Run heavy AI computations without freezing the UI |
| **WebGPU / WASM** | Hardware acceleration | Make AI inference faster (GPU) or compatible (WASM fallback) |
| **Groq API** | Cloud LLM service | The only cloud call — sends sanitized text, gets AI answers |
| **Tailwind CSS** | Utility-first CSS | Quick, consistent styling |
| **react-dropzone** | Drag & drop library | Handle PDF file dropping |
| **uuid** | Unique ID generator | Track async worker requests |

---

## The "RAG" Pattern Explained

This project implements a pattern called **RAG — Retrieval-Augmented Generation**.

Without RAG:
```
User: "What is Rahul's salary?"
AI:   "I don't know who Rahul is." (the AI has no context)
```

With RAG:
```
User: "What is Rahul's salary?"

Step 1 (Retrieval): Search the document, find the paragraph that mentions Rahul's salary
Step 2 (Augmented):  Attach that paragraph to the AI prompt as "context"
Step 3 (Generation): AI reads the context and generates: "Rahul's salary is ₹25,00,000"
```

**RAG = Give the AI the specific paragraphs it needs to answer the question.**

The "Retrieval" part uses **vector search** (convert text to numbers, find the closest match).

Our project adds a critical extra step: **mask sensitive data before the AI sees it.**

```
Standard RAG:    Document → Retrieve → Send to AI → Get answer
Our Zero-Trust:  Document → Retrieve → MASK → Send to AI → Get masked answer → UNMASK
```

---

## What Makes This Project Impressive for Interviews

1. **It's entirely client-side** — No backend server. Everything runs in the browser.
2. **It uses AI models locally** — ML models run inside the browser using WebGPU/WASM.
3. **It solves a real security problem** — Data leakage prevention (DLP) for AI applications.
4. **It has genuine engineering depth** — Vector search, text chunking, NER, regex engines, Web Workers, streaming.
5. **It's NOT a tutorial project** — The vector store, chunker, sanitization engine, and worker protocol are all hand-written, not from a library.

---

## Before You Move On

Make sure you can answer these in your own words:

1. What problem does this project solve? *(Cloud AI seeing your sensitive data)*
2. What does "Zero Trust" mean here? *(Don't trust the cloud — mask everything before sending)*
3. What is RAG? *(Retrieve relevant document chunks, give them to the AI as context)*
4. What's the difference between our RAG and standard RAG? *(We add a masking step before sending to the AI)*
5. Does this project have a backend? *(No — everything runs in the browser except the LLM API call)*
6. What are the two AI models running locally? *(MiniLM-L6 for embeddings, BERT NER for name detection)*
7. Why are Web Workers needed? *(AI inference is heavy — would freeze the UI if run on the main thread)*

---

**Next Phase → [01_Project_Setup.md](./01_Project_Setup.md)** — We'll set up the project from scratch and understand every config file.
