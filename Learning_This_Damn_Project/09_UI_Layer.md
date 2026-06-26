# Phase 9: The UI Layer — React Components

> **Goal:** Build the visual interface: dropzone, chat, inspector drawer, settings panel. By the end, you'll understand how `App.tsx` and `ChatMessage.tsx` work and how the UI connects to the orchestration hook.

---

## Component Architecture

```
App.tsx (1046 lines)
├── Uses useDocumentAI() hook for all logic
│
├── IDLE state → DropZone view
│   ├── react-dropzone for file dropping
│   ├── Feature cards (Local Parsing, Browser Embeddings, JIT Redaction)
│   └── API key input + settings
│
├── INGESTING state → Processing overlay
│   ├── Pipeline step indicators (extract → chunk → embed → index)
│   └── Progress bar with sheen animation
│
├── READY/QUERYING state → Chat view
│   ├── Message list
│   │   ├── ChatMessage (system messages)
│   │   ├── ChatMessage (user messages)
│   │   └── ChatMessage (assistant messages with badges)
│   ├── Input field
│   ├── Settings sidebar
│   └── PayloadDrawer (privacy inspector)
│
└── Sub-components (defined inside App.tsx):
    ├── ToolPanel — Titled content card
    ├── ToolStep — Pipeline step indicator
    ├── WorkerCard — Worker status display
    └── PayloadDrawer — Side panel for inspecting sanitized payloads
```

---

## The Main App Component

```typescript
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { ChatMessage, type ConversationMessage } from '@/components/ChatMessage';
import { useDocumentAI } from '@/hooks/useDocumentAI';

function App() {
  // ─── Get everything from the orchestration hook ──────────
  const ai = useDocumentAI();

  // ─── Local UI state (not in the hook) ────────────────────
  const [inputValue, setInputValue] = useState('');
  const [inspectedMessage, setInspectedMessage] = useState<ConversationMessage | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ─── Auto-scroll to bottom when new messages arrive ──────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [ai.messages]);

  // ─── File drop handler ──────────────────────────────────
  const onDrop = useCallback(
    async (accepted: File[], rejections: FileRejection[]) => {
      if (rejections.length > 0) {
        // Show error for rejected files
        const errorMsg = formatRejection(rejections[0]);
        // ... display error
        return;
      }
      if (accepted.length > 0) {
        await ai.ingestDocument(accepted[0]);
      }
    },
    [ai.ingestDocument]
  );

  // ─── Configure react-dropzone ───────────────────────────
  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },  // Only PDFs
    maxFiles: 1,                                // One at a time
    disabled: ai.stage === 'ingesting'          // Disable during processing
  });
```

> **Why `useCallback` for `onDrop`?**
> `onDrop` is passed to `useDropzone` as a prop. Without `useCallback`, React would create a new function on every render, causing `useDropzone` to reconfigure unnecessarily. `useCallback` memoizes the function so it only changes when `ai.ingestDocument` changes.

---

## Conditional Rendering (State-Based UI)

```typescript
  return (
    <div className="flex min-h-screen flex-col items-center">
      {/* IDLE: Show dropzone */}
      {ai.stage === 'idle' && (
        <section className="w-full max-w-6xl">
          {/* Dropzone with drag-and-drop */}
          <div
            {...getRootProps()}
            className={`panel-surface group cursor-pointer p-8 ${
              isDragActive ? 'border-signal-cyan/60' : 'border-white/10'
            }`}
          >
            <input {...getInputProps()} />
            <h1>Drop a confidential PDF here for local analysis.</h1>
            {/* Feature cards, API key input, etc. */}
          </div>
        </section>
      )}

      {/* INGESTING: Show processing overlay */}
      {ai.stage === 'ingesting' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Progress bar */}
          {/* Step indicators */}
          {ai.pipelineSteps.map(step => (
            <ToolStep key={step.label} step={step} />
          ))}
        </div>
      )}

      {/* READY / QUERYING: Show chat interface */}
      {(ai.stage === 'ready' || ai.stage === 'querying') && (
        <div className="flex w-full max-w-4xl flex-1 flex-col">
          {/* Message list */}
          <div className="flex-1 overflow-y-auto space-y-6 p-4">
            {ai.messages.map(message => (
              <ChatMessage
                key={message.id}
                message={message}
                onInspect={(msg) => {
                  setInspectedMessage(msg);
                  setIsDrawerOpen(true);
                }}
              />
            ))}
            <div ref={messagesEndRef} />  {/* Auto-scroll anchor */}
          </div>

          {/* Input field */}
          <form onSubmit={handleSubmit} className="field-shell p-4">
            <input
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              placeholder="Ask about your document..."
              disabled={ai.isStreaming}
            />
            <button type="submit" disabled={ai.isStreaming || !inputValue.trim()}>
              Send
            </button>
          </form>
        </div>
      )}

      {/* Privacy Inspector Drawer */}
      <PayloadDrawer
        isOpen={isDrawerOpen}
        message={inspectedMessage}
        onClose={() => setIsDrawerOpen(false)}
      />
    </div>
  );
}
```

---

## The `ChatMessage` Component

Each chat message is a bubble with different styling based on role:

```typescript
// From ChatMessage.tsx
export function ChatMessage({ message, onInspect }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  // System messages: centered, pill-shaped
  if (message.role === 'system') {
    return (
      <article className="flex justify-center">
        <div className="rounded-full border border-white/10 bg-white/[0.04]
                        px-4 py-2 text-xs text-slate-400">
          {message.content}
        </div>
      </article>
    );
  }

  return (
    <article className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-[28px] px-5 py-4 ${
        isUser
          ? 'bg-[#303030] text-slate-100'           // User: dark bubble, right-aligned
          : 'w-full bg-transparent text-slate-100'   // Assistant: full-width, left-aligned
      }`}>

        {/* Assistant header badges */}
        {isAssistant && (
          <div className="flex gap-2 text-[11px] uppercase text-slate-500">
            <span>Assistant</span>

            {/* Route badge: Document or General */}
            {message.route && (
              <span className={`rounded-full px-2.5 py-1 ${
                message.route === 'document'
                  ? 'bg-emerald-400/10 text-emerald-300'
                  : 'bg-white/[0.05] text-slate-400'
              }`}>
                {message.route === 'document' ? 'Document' : 'General'}
              </span>
            )}

            {/* Privacy shield badge */}
            {message.route === 'document' && (
              <span className={`rounded-full px-2.5 py-1 ${
                message.privacyShieldEnabled
                  ? 'bg-emerald-400/10 text-emerald-300'
                  : 'bg-amber-400/10 text-amber-300'
              }`}>
                {message.privacyShieldEnabled ? 'Shielded Payload' : 'Raw Payload'}
              </span>
            )}
          </div>
        )}

        {/* Message content */}
        <p className="whitespace-pre-wrap text-[15px] leading-8">
          {message.content}
        </p>

        {/* Semantic score and Inspect button */}
        {isAssistant && (
          <div className="mt-4 flex gap-3 text-xs text-slate-500">
            {typeof message.semanticScore === 'number' && (
              <span>
                {(message.semanticScore * 100).toFixed(1)}% match
              </span>
            )}
            {onInspect && (
              <button onClick={() => onInspect(message)}>
                Inspect Sanitized Payload
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
```

---

## The PayloadDrawer (Privacy Inspector)

This is a side panel that shows exactly what was sent to the LLM:

```typescript
function PayloadDrawer({ isOpen, message, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <div className="h-full w-full max-w-[460px] border-l border-white/10 bg-[#171717] p-5">

        <h2>Privacy Inspector</h2>
        <p>Review the exact redacted payload prepared for transport.</p>

        {/* Route summary */}
        <ToolPanel title="Route Summary">
          <span>{message.route === 'document' ? 'Local Document' : 'General AI'}</span>
          <span>{message.privacyShieldEnabled ? 'Privacy Shield On' : 'Off'}</span>
        </ToolPanel>

        {/* Sanitized user input */}
        {message.sanitizedInput && (
          <ToolPanel title="Sanitized User Input">
            <p>{message.sanitizedInput}</p>
            {/* Show tokens: [PERSON_1] · PERSON */}
            {Object.entries(message.sanitizedInputDictionary ?? {}).map(([token, entry]) => (
              <span key={token}>{token} · {entry.label}</span>
            ))}
          </ToolPanel>
        )}

        {/* Each sanitized chunk */}
        {(message.results ?? []).map((result, index) => (
          <ToolPanel key={result.id} title={`Chunk ${index}`}>
            <span>{(result.score * 100).toFixed(1)}% similarity</span>
            <p>{result.redactedText}</p>
            {Object.entries(result.dictionary).map(([token, entry]) => (
              <span key={token}>{token} · {entry.label}</span>
            ))}
          </ToolPanel>
        ))}
      </div>
    </div>
  );
}
```

This is one of the most impressive features for interviews — you can show the interviewer that the system is transparent about what data was sanitized and what was sent to the cloud.

---

## UI Design Patterns

### Glassmorphism
The `.panel-surface` class creates a frosted-glass effect:
```css
.panel-surface {
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);       /* Nearly transparent */
  box-shadow: 0 24px 80px rgba(2, 6, 23, 0.48);
  backdrop-filter: blur(48px);                  /* Frosted glass */
}
```

### Dark Theme
Everything uses the `ink` color palette with `color-scheme: dark`. Text is `slate-100` to `slate-400` for hierarchy.

### Responsive Layout
Tailwind breakpoints (`sm:`, `md:`, `lg:`) ensure the layout works on all screen sizes.

---

## Interview Questions

### Basic
- **Q:** "How does the UI update in real-time during LLM streaming?"
- **A:** "The `streamCompletion` function accepts an `onDelta` callback. Each time a new word arrives from the SSE stream, the callback runs `rehydrate` on the accumulated text and updates the specific assistant message in the React state using an immutable `map()` operation."

### Intermediate
- **Q:** "What's the PayloadDrawer for?"
- **A:** "It's a transparency feature. Users can click 'Inspect Sanitized Payload' on any assistant message to see the exact data that was sent to the cloud. It shows: the sanitized user input, each sanitized chunk with its similarity score, and all PII placeholder tokens. This builds trust in the zero-trust system — the user can verify that sensitive data was properly masked."

### Advanced
- **Q:** "How do you handle auto-scrolling efficiently?"
- **A:** "I use a `useRef` on an empty `<div>` at the bottom of the message list. A `useEffect` that depends on `messages` calls `scrollIntoView({ behavior: 'smooth' })` on this ref whenever the messages array changes. This is more efficient than computing scroll positions manually."

---

**Next Phase → [10_Interview_Mastery.md](./10_Interview_Mastery.md)** — The final phase: complete interview preparation.
