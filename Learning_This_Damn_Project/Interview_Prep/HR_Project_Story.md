# HR Project Story — Zero-Trust Edge-AI Privacy Shield

## The Elevator Pitch (30 seconds)
"I built a browser app that lets you chat with confidential PDFs without any data leaving your device. It extracts text, finds relevant paragraphs, masks all sensitive information — names, IDs, phone numbers — and only sends the masked version to the AI. The cloud never sees your real data."

## The STAR Format (for behavioral questions)

### Situation
"At my research center, we frequently worked with confidential documents — financial records, employee data, research papers with personally identifiable information. Team members wanted to use AI tools like ChatGPT for analysis, but uploading these documents meant sending all that sensitive data to external servers."

### Task
"I took on the challenge of building a system that would let people get AI-powered answers from their PDFs while maintaining complete data privacy. The key requirement: zero raw data should ever leave the browser."

### Action
"I designed a pipeline with five stages:
1. **PDF extraction** — Using Mozilla's pdf.js to read PDFs entirely in the browser
2. **Semantic search** — Splitting the text into chunks, converting them to vectors, and building an in-memory search index
3. **Triple-layer PII masking** — Regex for structured IDs (Aadhaar, PAN, email), a BERT NER model for names and organizations, and a global token ledger for cross-chunk consistency
4. **Secure AI integration** — Sending only masked text to the LLM via streaming, then replacing placeholders back with real values on the client side
5. **Transparency** — A built-in Privacy Inspector that lets users verify exactly what data was sent to the cloud

The hardest part was the sanitization architecture. I couldn't mask at document load time because that would destroy the semantic quality of the vector search. I designed a 'just-in-time' approach: the vector store indexes raw text for accurate search, but sanitization happens milliseconds before the LLM sees the data."

### Result
"The system successfully masks 20+ types of sensitive information with zero data egress. All AI inference (both the embedding model and the NER model) runs inside Web Workers, keeping the UI responsive at 60fps. The entire codebase is ~2500 lines of TypeScript with no backend server required."

---

## Resume Bullet Points (final version)

**Zero-Trust Edge-AI Privacy Shield** | *TypeScript, React 18, Web Workers, WebGPU, Transformers.js*
- Engineered a **browser-native RAG pipeline** with client-side PDF extraction, recursive text chunking (with configurable overlap), cosine-similarity vector search, and a streaming LLM integration — achieving **zero raw-data egress** to any external server.
- Designed a **Triple-Layer PII Sanitization Engine** (Deterministic Regex → NER model → Cross-Chunk Global Ledger) that intercepts Top-K retrieved chunks just-in-time before LLM handoff, tokenizing 20+ entity types (Aadhaar, PAN, GSTIN, UPI, etc.) with globally consistent `[ENTITY_N]` placeholders, and performs **right-to-left offset-stable string replacement** to eliminate index corruption.
- Architected all ML inference (BERT NER + MiniLM embeddings) inside **dedicated Web Workers** using a **Singleton lazy-init pattern** and asynchronous **Promise-based request/response protocol**, keeping the React UI thread at 60 FPS during heavy document processing.
