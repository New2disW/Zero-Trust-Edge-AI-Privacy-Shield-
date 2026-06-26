# Phase 7: Talking to the LLM Securely — Streaming & Rehydration

> **Goal:** The sanitized chunks are ready. Now we send them to a cloud LLM (Groq API) and get an answer back in real-time via Server-Sent Events (SSE). Then we "rehydrate" the answer — replacing placeholder tokens back with the real names. By the end, you'll understand `llmService.ts`, SSE streaming, and `rehydration.ts`.

---

## What is Groq?

Groq is a cloud LLM API service, similar to OpenAI's API. You send a prompt, it returns an AI-generated response. We chose Groq because:
- Very fast inference (they use custom hardware)
- Free tier for development
- Supports Llama 3.1 (an open-source model)
- Compatible with the OpenAI API format

> **Important:** Groq is the ONLY network call in the entire project. Everything else runs locally.

---

## What is SSE (Server-Sent Events)?

Normally, an API call works like this:

```
❌ Regular HTTP (wait for full response):

Client: "What is Rahul's salary?"  ──────────▶  Server
                                                   │
        ...waiting 3 seconds...                    │ thinking...
                                                   │
Client:  ◀── "[PERSON_1]'s salary is ₹25,00,000"  Server

User sees NOTHING for 3 seconds, then the full answer appears at once.
```

SSE (streaming) works like this:

```
✅ SSE Streaming (word by word):

Client: "What is Rahul's salary?"  ──────────▶  Server
                                                   │
Client:  ◀── "[PERSON"                            │
Client:  ◀── "_1]'s"                              │
Client:  ◀── " salary"                            │
Client:  ◀── " is"                                │
Client:  ◀── " ₹25"                               │
Client:  ◀── ",00,000"                            │

User sees each word appear as it's generated — feels much faster!
```

---

## Building `llmService.ts` — Step by Step

### Step 1: Define the Types

```typescript
// The configuration for a completion request
interface CompletionOptions {
  apiKey: string;              // Groq API key
  model?: string;              // Which LLM model to use (default: llama-3.1-8b-instant)
  systemPrompt?: string;       // Instructions for the AI
  conversationHistory?: Array<{ role: string; content: string }>;
  userMessage: string;         // The user's question (sanitized)
  temperature?: number;        // Randomness (0 = deterministic, 1 = creative)
  maxTokens?: number;          // Maximum response length
  onDelta?: (text: string) => void;  // Called for each streamed word
}

// What we return
interface CompletionResult {
  content: string;     // The full response text
  finishReason: string; // 'stop' (normal), 'length' (hit max tokens)
}
```

### Step 2: The Main `streamCompletion` Function

```typescript
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;  // Low = focused, factual answers

export async function streamCompletion(
  options: CompletionOptions
): Promise<CompletionResult> {

  const {
    apiKey,
    model = DEFAULT_MODEL,
    systemPrompt,
    conversationHistory = [],
    userMessage,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    onDelta
  } = options;

  // Build the messages array (OpenAI format)
  const messages = [
    // System prompt: tell the AI how to behave
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    // Conversation history: previous messages for context
    ...conversationHistory,
    // The current user message
    { role: 'user', content: userMessage }
  ];

  // Make the API call with streaming enabled
  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true  // ← This enables SSE streaming!
    })
  });

  // Check for HTTP errors
  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'No response body');
    throw new Error(
      `Groq API error ${response.status}: ${response.statusText}. ${errorBody}`
    );
  }
```

### Step 3: Reading the SSE Stream

```typescript
  // Get the response body as a ReadableStream
  const body = response.body;
  if (!body) {
    throw new Error('Response body is empty.');
  }

  // Create a reader to consume the stream
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let fullContent = '';       // Accumulate the full response
  let finishReason = 'stop';  // Will be updated from the stream
  let buffer = '';            // Buffer for incomplete SSE lines

  try {
    while (true) {
      // Read the next chunk from the stream
      const { done, value } = await reader.read();
      if (done) break;

      // Decode bytes to text and add to buffer
      buffer += decoder.decode(value, { stream: true });

      // Split buffer into individual SSE lines
      // SSE format: each line starts with "data: " followed by JSON
      const lines = buffer.split('\n');

      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines (SSE uses blank lines as separators)
        if (!trimmed) continue;

        // Check for stream end signal
        if (trimmed === 'data: [DONE]') {
          continue;
        }

        // Parse the SSE data
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));  // Remove "data: " prefix
          const choice = json.choices?.[0];
          if (!choice) continue;

          // Extract the text delta (the new word/fragment)
          const delta = choice.delta?.content;
          if (delta) {
            fullContent += delta;

            // Call the onDelta callback so the UI can update in real-time
            if (onDelta) {
              onDelta(delta);
            }
          }

          // Check if the AI is done generating
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        } catch {
          // Skip malformed JSON lines (defensive)
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content: fullContent.trim(), finishReason };
}
```

### SSE Data Format (What the server actually sends)

```
data: {"id":"chatcmpl-xyz","choices":[{"delta":{"content":"[PERSON"}}]}

data: {"id":"chatcmpl-xyz","choices":[{"delta":{"content":"_1]'s"}}]}

data: {"id":"chatcmpl-xyz","choices":[{"delta":{"content":" salary"}}]}

data: {"id":"chatcmpl-xyz","choices":[{"delta":{"content":" is"}}]}

data: {"id":"chatcmpl-xyz","choices":[{"delta":{"content":" ₹25,00,000"}}]}

data: {"id":"chatcmpl-xyz","choices":[{"finish_reason":"stop"}]}

data: [DONE]
```

Each line is a separate event. We parse them one by one and extract the `content` field.

---

## The System Prompt

In `useDocumentAI.ts`, the system prompt tells the AI how to behave:

```typescript
const SYSTEM_PROMPT_DOCUMENT = `You are a precise, helpful document assistant.

CONTEXT CHUNKS (from the user's local document):
{chunks}

RULES:
1. Answer ONLY using information from the context chunks above.
2. Context may contain privacy placeholders like [PERSON_1], [EMAIL_1], etc.
   Use them exactly as written. Do NOT try to guess original values.
3. If the answer is not in the context, say so clearly.
4. Be concise and factual.`;
```

The `{chunks}` placeholder is replaced with the sanitized Top-K chunks:

```
CONTEXT CHUNKS:
Chunk 0 (91.2% match):
[PERSON_1]'s annual compensation is ₹25,00,000. [PERSON_1] works in
the Finance department and reports to [PERSON_2].

Chunk 1 (87.5% match):
[PERSON_1] joined the company on [DATE_1]. [PERSON_1]'s employee ID
is EMP-4521. Contact: [EMAIL_1].
```

---

## Rehydration: Putting the Names Back

The LLM responds with placeholder tokens. We need to replace them with the real values before showing the answer to the user.

### `rehydration.ts` — 23 Lines That Complete the Circle

```typescript
/**
 * Replace every privacy placeholder in `text` with the original value
 * found in the merged PII dictionary.
 *
 * Tokens are sorted longest-first so that [PERSON_10] is replaced
 * before [PERSON_1] — preventing prefix collisions.
 */
export function rehydrate(
  text: string,
  dictionary: Record<string, { label: string; original: string }>
): string {
  // Get all tokens (e.g., "[PERSON_1]", "[EMAIL_1]", "[PAN_1]")
  const tokens = Object.keys(dictionary);

  if (tokens.length === 0) return text;

  // CRITICAL: Sort longest token first!
  // Why? "[PERSON_10]" contains "[PERSON_1]" as a prefix.
  // If we replace [PERSON_1] first, we'd corrupt [PERSON_10].
  tokens.sort((a, b) => b.length - a.length);

  let result = text;
  for (const token of tokens) {
    const entry = dictionary[token];
    if (entry?.original) {
      // Replace ALL occurrences of this token
      result = result.replaceAll(token, entry.original);
    }
  }

  return result;
}
```

**The prefix collision problem:**

```
Dictionary: {
  "[PERSON_1]": { original: "Rahul" },
  "[PERSON_10]": { original: "Priya" }
}

AI response: "[PERSON_10] manages [PERSON_1]"

❌ Replace shortest first:
   Replace [PERSON_1] → "Rahul"
   Text becomes: "[PERSONRahul0] manages Rahul"  ← CORRUPTED!
   "[PERSON_10]" was partially matched by "[PERSON_1]"

✅ Replace longest first:
   Replace [PERSON_10] → "Priya"
   Text becomes: "Priya manages [PERSON_1]"
   Replace [PERSON_1] → "Rahul"
   Text becomes: "Priya manages Rahul"  ← CORRECT!
```

---

## The Complete Flow Visualized

```
User types: "What is Rahul Sharma's salary?"
                    │
                    ▼
         ┌─────────────────────┐
         │  SANITIZE INPUT     │
         │                     │
         │  "Rahul Sharma" →   │
         │  [PERSON_1]         │
         │                     │
         │  Sanitized query:   │
         │  "What is           │
         │  [PERSON_1]'s       │
         │  salary?"           │
         └─────────┬───────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │  BUILD PROMPT       │
         │                     │
         │  System: You are... │
         │  Chunks:            │
         │  "[PERSON_1]'s      │
         │   salary is ₹25L"   │
         │  User: "What is     │
         │  [PERSON_1]'s       │
         │  salary?"           │
         └─────────┬───────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │  GROQ API (SSE)     │
         │                     │
         │  Streams:           │
         │  "[PERSON_1]'s"     │
         │  " salary"          │
         │  " is"              │
         │  " ₹25,00,000"     │
         └─────────┬───────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │  REHYDRATE          │
         │                     │
         │  [PERSON_1] →       │
         │  "Rahul Sharma"     │
         │                     │
         │  Final answer:      │
         │  "Rahul Sharma's    │
         │   salary is         │
         │   ₹25,00,000"      │
         └─────────────────────┘
                   │
                   ▼
            User sees: "Rahul Sharma's salary is ₹25,00,000"
```

---

## Development Simulation

### Attempt 1: "I'll use the non-streaming API"
```typescript
const response = await fetch(GROQ_ENDPOINT, {
  body: JSON.stringify({ ...params, stream: false })
});
const json = await response.json();
```
**Problem:** The user stares at a blank screen for 2-5 seconds while the LLM generates the full response. Feels slow and unresponsive.

### Attempt 2: "I'll use WebSockets for streaming"
**Problem:** Overkill. WebSockets maintain a persistent bidirectional connection. We only need one-directional streaming (server → client). SSE is simpler and HTTP-native.

### Attempt 3: "I'll use fetch + SSE streaming"
```typescript
const response = await fetch(url, { body: JSON.stringify({ stream: true }) });
const reader = response.body.getReader();
// Read chunk by chunk...
```
**This is the final solution.** Standard `fetch()` with a `ReadableStream` reader. No special libraries needed.

> **Interview Line:** "I use Server-Sent Events for streaming. The LLM response is consumed via `response.body.getReader()`, decoded chunk by chunk, and each delta is passed to an `onDelta` callback that updates the UI in real-time. This gives the user immediate feedback — they see words appearing as the model generates them."

---

## Semantic Routing

Not every user question is about the document. "What's the weather?" doesn't need document context.

The system auto-detects whether to use document chunks or not:

```typescript
// In useDocumentAI.ts
type SemanticRoute = 'document' | 'general';

function determineRoute(
  topScore: number,      // Highest similarity score from vector search
  threshold: number,     // e.g., 0.35
  userQuery: string
): { route: SemanticRoute; reason: string } {

  // Meta-intent patterns: always route to document mode
  const META_PATTERNS = [
    /\bsummar/i,          // "summarize", "summary"
    /\bthis\s+(?:document|pdf|file|report)/i,
    /\bwhat\s+(?:does|is)\s+(?:this|the)\s+(?:document|pdf)/i,
    /\bkey\s+(?:points|findings|takeaways)/i
  ];

  const hasMetaIntent = META_PATTERNS.some(p => p.test(userQuery));

  if (hasMetaIntent) {
    return { route: 'document', reason: 'Meta-intent detected' };
  }

  if (topScore >= threshold) {
    return { route: 'document', reason: `Score ${topScore} >= threshold ${threshold}` };
  }

  return { route: 'general', reason: `Score ${topScore} < threshold ${threshold}` };
}
```

---

## Interview Questions

### Basic
- **Q:** "How does your app communicate with the LLM?"
- **A:** "I send a POST request to the Groq API with `stream: true`. The response comes back as Server-Sent Events — I read them line by line using a `ReadableStream` reader, parse each `data:` line as JSON, and extract the text delta."

### Intermediate
- **Q:** "What is rehydration and why is it needed?"
- **A:** "The LLM receives sanitized text with placeholders like `[PERSON_1]`. Its response also uses these placeholders. Rehydration is the process of replacing each placeholder back with the original value before displaying to the user. I sort tokens longest-first to prevent prefix collisions (e.g., `[PERSON_10]` vs `[PERSON_1]`)."

### Advanced
- **Q:** "What's the difference between SSE and WebSockets?"
- **A:** "SSE is unidirectional (server → client), uses standard HTTP, and automatically reconnects. WebSockets are bidirectional, use a separate protocol (`ws://`), and need manual reconnection logic. For LLM streaming, we only need server-to-client data flow, so SSE is simpler and sufficient."

### Trap
- **Q:** "The rehydration uses `replaceAll`. What's the time complexity?"
- **A:** "Each `replaceAll` is O(n) where n is the text length. With k tokens, the total is O(k × n). For typical responses (~500 chars, ~5 tokens), this is negligible. But if we had thousands of tokens, I'd switch to a single-pass approach using a regex with alternation or a trie-based replacer."

---

**Next Phase → [08_Orchestration.md](./08_Orchestration.md)** — We'll study the `useDocumentAI.ts` hook that wires everything together.
