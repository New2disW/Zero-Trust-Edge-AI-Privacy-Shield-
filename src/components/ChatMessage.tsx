import React, { useState } from 'react';
import type { RedactedSearchResult } from '@/hooks/useDocumentAI';

function parseInlineMarkdown(text: string): React.ReactNode[] {
  // Matches `**bold**`, `code`, or `*italic*`
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  const parts = text.split(regex);

  return parts.map((part, index) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={index} className="font-semibold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={index}
          className="rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-emerald-300"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return (
        <em key={index} className="italic text-slate-200">
          {part.slice(1, -1)}
        </em>
      );
    }
    return part;
  });
}

function renderMarkdown(content: string, isStreaming = false): React.ReactNode {
  if (!content) {
    return isStreaming ? (
      <span className="inline-block h-4 w-1.5 ml-1 -mb-0.5 bg-emerald-400 animate-cursor rounded-full" />
    ) : null;
  }

  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let currentList: { type: 'bullet' | 'numbered'; items: string[] } | null = null;
  let currentParagraph: string[] = [];
  let cursorAttached = false;

  const cursorNode = isStreaming ? (
    <span
      key="streaming-cursor"
      className="inline-block h-4 w-1.5 ml-1.5 -mb-0.5 bg-emerald-400 animate-cursor rounded-full align-middle"
    />
  ) : null;

  const flushParagraph = (key: string | number, isLast = false) => {
    if (currentParagraph.length > 0) {
      const pText = currentParagraph.join('\n');
      const attachCursor = isStreaming && isLast && !cursorAttached;
      if (attachCursor) cursorAttached = true;
      blocks.push(
        <p key={`p-${key}`} className="my-2 leading-7 first:mt-0 last:mb-0">
          {parseInlineMarkdown(pText)}
          {attachCursor ? cursorNode : null}
        </p>
      );
      currentParagraph = [];
    }
  };

  const flushList = (key: string | number, isLast = false) => {
    if (currentList) {
      const attachCursor = isStreaming && isLast && !cursorAttached;
      if (attachCursor) cursorAttached = true;
      if (currentList.type === 'bullet') {
        blocks.push(
          <ul
            key={`ul-${key}`}
            className="my-2.5 list-disc pl-5 space-y-1 text-slate-200 first:mt-0 last:mb-0"
          >
            {currentList.items.map((item, i) => (
              <li key={i} className="leading-7">
                {parseInlineMarkdown(item)}
                {attachCursor && i === currentList!.items.length - 1 ? cursorNode : null}
              </li>
            ))}
          </ul>
        );
      } else {
        blocks.push(
          <ol
            key={`ol-${key}`}
            className="my-2.5 list-decimal pl-5 space-y-1 text-slate-200 first:mt-0 last:mb-0"
          >
            {currentList.items.map((item, i) => (
              <li key={i} className="leading-7">
                {parseInlineMarkdown(item)}
                {attachCursor && i === currentList!.items.length - 1 ? cursorNode : null}
              </li>
            ))}
          </ol>
        );
      }
      currentList = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph(i);
      flushList(i);
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph(i);
      flushList(i);
      const level = headingMatch[1].length;
      const hText = headingMatch[2];
      if (level === 1) {
        blocks.push(
          <h1 key={`h-${i}`} className="my-3 text-lg font-bold text-slate-100 first:mt-0">
            {parseInlineMarkdown(hText)}
          </h1>
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={`h-${i}`} className="my-2.5 text-base font-semibold text-slate-100 first:mt-0">
            {parseInlineMarkdown(hText)}
          </h2>
        );
      } else {
        blocks.push(
          <h3 key={`h-${i}`} className="my-2 text-[15px] font-semibold text-slate-100 first:mt-0">
            {parseInlineMarkdown(hText)}
          </h3>
        );
      }
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph(i);
      if (currentList && currentList.type !== 'bullet') {
        flushList(i);
      }
      if (!currentList) {
        currentList = { type: 'bullet', items: [] };
      }
      currentList.items.push(bulletMatch[1]);
      continue;
    }

    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph(i);
      if (currentList && currentList.type !== 'numbered') {
        flushList(i);
      }
      if (!currentList) {
        currentList = { type: 'numbered', items: [] };
      }
      currentList.items.push(numberedMatch[1]);
      continue;
    }

    if (currentList) {
      flushList(i);
    }
    currentParagraph.push(line);
  }

  if (currentParagraph.length > 0) {
    flushParagraph('final', true);
  } else if (currentList) {
    flushList('final', true);
  }

  if (isStreaming && !cursorAttached) {
    blocks.push(cursorNode);
  }

  return <div className="space-y-1">{blocks}</div>;
}

export interface ConversationMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  detail?: string;
  createdAt: number;
  route?: 'document' | 'general';
  routeMessage?: string;
  privacyShieldEnabled?: boolean;
  metaIntentOverride?: boolean;
  semanticScore?: number;
  semanticThreshold?: number;
  sanitizedInput?: string;
  sanitizedInputDictionary?: Record<
    string,
    {
      label: string;
      original: string;
    }
  >;
  results?: RedactedSearchResult[];
}

interface ChatMessageProps {
  message: ConversationMessage;
  isStreaming?: boolean;
  onInspect?: (message: ConversationMessage) => void;
}

export function ChatMessage({ message, isStreaming = false, onInspect }: ChatMessageProps) {
  const [showProtectedEntities, setShowProtectedEntities] = useState(false);

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  if (message.role === 'system') {
    return (
      <article className="flex justify-center animate-message-fade">
        <div className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs text-slate-400">
          {message.content}
        </div>
      </article>
    );
  }

  // Aggregate all unique protected entities across input and retrieved chunks
  const protectedItems: Array<{ token: string; label: string; original: string; source: 'input' | 'document' }> = [];
  const seenTokens = new Set<string>();

  if (message.sanitizedInputDictionary) {
    for (const [token, entry] of Object.entries(message.sanitizedInputDictionary)) {
      if (!seenTokens.has(token)) {
        seenTokens.add(token);
        protectedItems.push({
          token,
          label: entry.label,
          original: entry.original,
          source: 'input'
        });
      }
    }
  }

  if (message.results) {
    for (const result of message.results) {
      if (result.dictionary) {
        for (const [token, entry] of Object.entries(result.dictionary)) {
          if (!seenTokens.has(token)) {
            seenTokens.add(token);
            protectedItems.push({
              token,
              label: entry.label,
              original: entry.original,
              source: 'document'
            });
          }
        }
      }
    }
  }

  const protectedCount = protectedItems.length;

  return (
    <article
      className={`flex w-full animate-message-fade ${
        isUser ? 'justify-end' : 'justify-start'
      }`}
    >
      {isUser ? (
        <div className="max-w-[85%] sm:max-w-xl md:max-w-2xl rounded-2xl rounded-br-sm border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-slate-100 shadow-sm backdrop-blur-md">
          <p className="whitespace-pre-wrap text-[15px] leading-7 font-normal">
            {message.content}
          </p>
          <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-emerald-400/60 font-mono">
            <span>You</span>
          </div>
        </div>
      ) : (
        <div className="w-full glass-panel p-4.5 sm:p-5 text-slate-100 shadow-md transition-all">
          {/* Assistant Header */}
          <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-400 shadow-sm">
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <span className="text-xs font-semibold tracking-wide text-slate-200">
                Zero-Trust Assistant
              </span>

              {message.route ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${
                    message.route === 'document'
                      ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                  }`}
                >
                  {message.route === 'document' ? 'Document RAG' : 'General AI'}
                  {typeof message.semanticScore === 'number' && message.route === 'document' && !message.metaIntentOverride ? (
                    <span className="opacity-80">· {(message.semanticScore * 100).toFixed(0)}%</span>
                  ) : null}
                </span>
              ) : null}

              {message.metaIntentOverride ? (
                <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] text-cyan-300">
                  Intent Override
                </span>
              ) : null}
            </div>

            {/* Privacy Shield indicator badge */}
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                message.privacyShieldEnabled ?? true
                  ? 'text-emerald-400/90'
                  : 'text-amber-400/90'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  message.privacyShieldEnabled ?? true
                    ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                    : 'bg-amber-400'
                }`}
              />
              {message.privacyShieldEnabled ?? true
                ? 'Shield Active'
                : 'Raw Context'}
            </span>
          </div>

          {/* Assistant Content */}
          <div className="relative text-[15px] leading-7 text-slate-200">
            {renderMarkdown(message.content, isStreaming)}
          </div>

          {message.detail ? (
            <div className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-300/90">
              {message.detail}
            </div>
          ) : null}

          {/* Privacy Proof: Shield Protected Entities Accordion */}
          {protectedCount > 0 ? (
            <div className="mt-4 pt-3 border-t border-white/5">
              <button
                type="button"
                onClick={() => setShowProtectedEntities((prev) => !prev)}
                className="group flex w-full items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-3.5 py-2 text-xs text-emerald-300 transition hover:bg-emerald-500/[0.08]"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className="h-3.5 w-3.5 text-emerald-400 transition-transform group-hover:scale-110"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                  <span className="font-medium">
                    Shield Protected {protectedCount} {protectedCount === 1 ? 'Entity' : 'Entities'}
                  </span>
                  <span className="text-[10px] text-emerald-400/60">
                    (Masked before cloud transmission)
                  </span>
                </div>

                <svg
                  className={`h-4 w-4 text-emerald-400/70 transition-transform duration-200 ${
                    showProtectedEntities ? 'rotate-180' : ''
                  }`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {showProtectedEntities ? (
                <div className="mt-2.5 rounded-xl border border-white/10 bg-black/40 p-3.5 space-y-2.5 text-xs animate-message-fade">
                  <p className="text-[11px] text-slate-400">
                    The LLM only ever saw synthetic tokens. Values were rehydrated locally on your device:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {protectedItems.map((item) => (
                      <div
                        key={item.token}
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-950/40 px-2.5 py-1 font-mono text-[11px]"
                      >
                        <span className="font-semibold text-emerald-400">{item.token}</span>
                        <span className="text-slate-500">⇄</span>
                        <span className="text-slate-200 font-sans">{item.original}</span>
                        <span className="ml-1 rounded bg-white/10 px-1 py-0.2 text-[9px] uppercase tracking-wider text-slate-400">
                          {item.label}
                        </span>
                      </div>
                    ))}
                  </div>

                  {onInspect ? (
                    <div className="pt-1.5 flex justify-end">
                      <button
                        type="button"
                        onClick={() => onInspect(message)}
                        className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 transition"
                      >
                        <span>Open Payload Inspector</span>
                        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12h14M12 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Footer Inspector Button if no protected entities */}
          {protectedCount === 0 && onInspect && (message.sanitizedInput || message.results?.length) ? (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => onInspect(message)}
                className="text-[11px] text-slate-400 hover:text-slate-200 transition"
              >
                Inspect Transport Payload →
              </button>
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}
