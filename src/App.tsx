import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { v4 as uuidv4 } from 'uuid';
import {
  ChatMessage,
  type ConversationMessage
} from '@/components/ChatMessage';
import {
  DEFAULT_SEMANTIC_THRESHOLD,
  useDocumentAI
} from '@/hooks/useDocumentAI';

const QUICK_PROMPTS = [
  {
    title: 'Summarize Document',
    prompt: 'Summarize this document and list the top 3 critical takeaways.',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    )
  },
  {
    title: 'Extract Dates & Details',
    prompt: 'Extract all important dates, deadlines, and key numbers mentioned in this document.',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    )
  },
  {
    title: 'Audit Confidential PII',
    prompt: 'What confidential PII or sensitive identities are mentioned in this PDF?',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    )
  }
];

function App() {
  const {
    phase,
    documentName,
    pageCount,
    chunkCount,
    results,
    error,
    queryStatusMessage,
    streamingMessage,
    embeddingWorker,
    nerWorker,
    processDocument,
    queryDocument,
    clearDocument
  } = useDocumentAI({
    semanticThreshold: DEFAULT_SEMANTIC_THRESHOLD
  });

  const [displayHistory, setDisplayHistory] = useState<ConversationMessage[]>([]);
  const [composer, setComposer] = useState('');
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [activeFileName, setActiveFileName] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isPrivacyShieldOn, setIsPrivacyShieldOn] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectedInspectorId, setSelectedInspectorId] = useState<string | null>(null);

  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isInitializing = phase === 'initializing';
  const isProcessing = phase === 'processing-document';
  const isQuerying = phase === 'querying';
  const hasDocument = Boolean(documentName);
  const canQuery = !isInitializing && !isProcessing && !isQuerying;
  const displayError = surfaceError ?? error;

  // Auto-scroll message feed
  useEffect(() => {
    if (!messageViewportRef.current) return;
    messageViewportRef.current.scrollTo({
      top: messageViewportRef.current.scrollHeight,
      behavior: 'smooth'
    });
  }, [displayHistory, streamingMessage?.content, isQuerying]);

  const {
    getRootProps,
    getInputProps,
    isDragActive,
    isDragReject,
    open: openFilePicker
  } = useDropzone({
    accept: {
      'application/pdf': ['.pdf']
    },
    maxFiles: 1,
    multiple: false,
    noClick: false,
    disabled: isInitializing || isProcessing || isQuerying,
    onDrop: async (acceptedFiles, fileRejections) => {
      await handleDrop(acceptedFiles, fileRejections);
    }
  });

  const handleDrop = async (
    acceptedFiles: File[],
    fileRejections: FileRejection[]
  ): Promise<void> => {
    if (fileRejections.length > 0) {
      setSurfaceError(formatRejection(fileRejections[0]));
      return;
    }

    const [file] = acceptedFiles;
    if (!file) return;

    setSurfaceError(null);
    setActiveFileName(file.name);

    try {
      await processDocument(file);
      setSidebarOpen(false);
    } catch (dropError) {
      setSurfaceError(
        dropError instanceof Error
          ? dropError.message
          : 'Failed to process the selected PDF.'
      );
    }
  };

  const submitQuery = async (queryText: string): Promise<void> => {
    const query = queryText.trim();
    if (!query || !canQuery) return;

    const userMessage: ConversationMessage = {
      id: uuidv4(),
      role: 'user',
      content: query,
      createdAt: Date.now()
    };

    setDisplayHistory((current) => [...current, userMessage]);
    setComposer('');
    setSurfaceError(null);

    try {
      const queryResult = await queryDocument(query, {
        privacyShieldEnabled: isPrivacyShieldOn
      });
      const assistantMessage: ConversationMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: queryResult.answer,
        createdAt: Date.now(),
        route: queryResult.route,
        routeMessage: queryResult.routeMessage,
        privacyShieldEnabled: queryResult.privacyShieldEnabled,
        metaIntentOverride: queryResult.metaIntentOverride,
        semanticScore: queryResult.semanticScore,
        semanticThreshold: queryResult.semanticThreshold,
        sanitizedInput: queryResult.sanitizedInput,
        sanitizedInputDictionary: queryResult.sanitizedInputDictionary,
        results: queryResult.redactedMatches,
        detail: queryResult.metaIntentOverride
          ? 'Document-level request detected. Local context was forced despite low semantic similarity.'
          : undefined
      };

      setDisplayHistory((current) => [...current, assistantMessage]);
      if (inspectorOpen) {
        setSelectedInspectorId(assistantMessage.id);
      }
    } catch (queryError) {
      setSurfaceError(
        queryError instanceof Error ? queryError.message : 'Query failed.'
      );
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitQuery(composer);
  };

  // 1. Enter-to-send, Shift+Enter for new line
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (composer.trim() && canQuery) {
        void submitQuery(composer);
      }
    }
  };

  const handleInspectMessage = (message: ConversationMessage): void => {
    setSelectedInspectorId(message.id);
    setInspectorOpen(true);
  };

  const handleDetachDocument = (): void => {
    setActiveFileName(null);
    setSurfaceError(null);
    clearDocument();
  };

  const liveAssistantMessage: ConversationMessage | null = streamingMessage
    ? {
        id: 'assistant-stream',
        role: 'assistant',
        content: streamingMessage.content || ' ',
        createdAt: streamingMessage.createdAt,
        route: streamingMessage.route,
        routeMessage: streamingMessage.routeMessage,
        privacyShieldEnabled: streamingMessage.privacyShieldEnabled,
        metaIntentOverride: streamingMessage.metaIntentOverride,
        semanticScore: streamingMessage.semanticScore,
        semanticThreshold: streamingMessage.semanticThreshold,
        sanitizedInput: streamingMessage.sanitizedInput,
        sanitizedInputDictionary: streamingMessage.sanitizedInputDictionary,
        results: streamingMessage.redactedMatches,
        detail: streamingMessage.metaIntentOverride
          ? 'Document-level request detected. Local context was forced despite low semantic similarity.'
          : undefined
      }
    : null;

  const inspectableMessages = useMemo(() => {
    const assistantMessages = displayHistory.filter(
      (message) =>
        message.role === 'assistant' &&
        (Boolean(message.sanitizedInput) || Boolean(message.results?.length))
    );

    return liveAssistantMessage
      ? [...assistantMessages, liveAssistantMessage]
      : assistantMessages;
  }, [displayHistory, liveAssistantMessage]);

  const activeInspectorMessage = useMemo(() => {
    if (selectedInspectorId) {
      const selected = inspectableMessages.find((m) => m.id === selectedInspectorId);
      if (selected) return selected;
    }
    return inspectableMessages.at(-1) ?? null;
  }, [inspectableMessages, selectedInspectorId]);

  const latestAssistantMessage = useMemo(
    () =>
      [...displayHistory]
        .reverse()
        .find((message) => message.role === 'assistant') ?? null,
    [displayHistory]
  );

  // Active hardware detection badge
  const activeHardware = useMemo(() => {
    if (embeddingWorker.device === 'webgpu' || nerWorker.device === 'webgpu') {
      return { label: 'WebGPU', badgeClass: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300' };
    }
    if (embeddingWorker.device === 'wasm' || nerWorker.device === 'wasm') {
      return { label: 'WASM (SIMD)', badgeClass: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-300' };
    }
    return { label: 'CPU Init', badgeClass: 'border-white/10 bg-white/5 text-slate-400' };
  }, [embeddingWorker.device, nerWorker.device]);

  const statusInfo = useMemo(() => {
    if (isInitializing) {
      return { text: 'Warming Edge ML Engines', tone: 'amber' as const };
    }
    if (isProcessing) {
      return { text: 'Indexing Document Locally', tone: 'amber' as const };
    }
    if (isQuerying) {
      return { text: queryStatusMessage ?? 'Reasoning...', tone: 'amber' as const };
    }
    if (hasDocument) {
      return { text: 'Document Grounded · Privacy Shield Active', tone: 'emerald' as const };
    }
    return { text: 'Zero-Trust Engine Ready', tone: 'emerald' as const };
  }, [isInitializing, isProcessing, isQuerying, queryStatusMessage, hasDocument]);

  return (
    // 2. Strict Single-Screen Viewport Lock (100dvh)
    <div className="h-screen h-dvh w-full overflow-hidden bg-[#070A0F] text-slate-100 flex flex-col font-sans ambient-glow">
      {/* Mobile Backdrop */}
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm lg:hidden"
        />
      ) : null}

      {/* Main App Container */}
      <div className="flex h-full w-full min-h-0 overflow-hidden">
        {/* Left Sidebar */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-white/10 bg-[#090D16]/95 backdrop-blur-2xl transition-transform duration-300 lg:static lg:z-0 lg:translate-x-0 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {/* Sidebar Header */}
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.25)]">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-semibold tracking-wider text-slate-100 uppercase">Privacy Shield</p>
                <p className="text-[10px] text-emerald-400/80 font-mono">100% Client-Side</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition lg:hidden"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Sidebar Content (Scrollable internally) */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-3.5">
            {/* Attach PDF Card */}
            <div className="glass-card p-3.5">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Attach PDF</span>
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-mono text-emerald-400">PDF ONLY</span>
              </div>

              <div
                {...getRootProps()}
                className={`group relative flex flex-col items-center justify-center rounded-xl border border-dashed p-4 text-center transition-all ${
                  isDragReject
                    ? 'border-rose-500/50 bg-rose-500/5'
                    : isDragActive
                      ? 'border-emerald-400/60 bg-emerald-500/10 shadow-[0_0_20px_rgba(16,185,129,0.2)]'
                      : 'border-white/15 bg-white/[0.02] hover:border-emerald-500/40 hover:bg-emerald-500/[0.03]'
                } ${isInitializing || isProcessing || isQuerying ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}
              >
                <input {...getInputProps()} />
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 transition group-hover:scale-105 group-hover:border-emerald-400/40 group-hover:text-emerald-400">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <p className="mt-2 text-xs font-medium text-slate-200">
                  {isDragActive ? 'Drop PDF here' : 'Select or drop a PDF'}
                </p>
                <p className="mt-1 text-[10px] text-slate-400 leading-normal">
                  Extracted, embedded & masked in-browser
                </p>
              </div>
            </div>

            {/* Current Document Card */}
            <div className="glass-card p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Active Document</span>
                {hasDocument ? (
                  <span className="flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                ) : null}
              </div>

              {hasDocument ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-lg border border-white/5 bg-black/20 p-2.5">
                    <svg className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <p className="truncate text-xs font-medium text-slate-100" title={documentName ?? ''}>
                      {documentName}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2 text-center">
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider">Pages</span>
                      <p className="mt-0.5 text-base font-semibold text-slate-100">{pageCount}</p>
                    </div>
                    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2 text-center">
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider">Chunks</span>
                      <p className="mt-0.5 text-base font-semibold text-emerald-400">{chunkCount}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleDetachDocument}
                    className="w-full rounded-lg border border-rose-500/20 bg-rose-500/5 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/10 hover:border-rose-500/30"
                  >
                    Detach Document
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-400 leading-relaxed">
                  No PDF attached. Running in general chat mode. Attach a document to enable client-side RAG.
                </p>
              )}
            </div>

            {/* Semantic Routing Status */}
            <div className="glass-card p-3.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Semantic Routing</span>
              <div className="mt-2.5 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Current Mode</span>
                  <span className={`font-medium ${hasDocument ? 'text-emerald-400' : 'text-cyan-400'}`}>
                    {hasDocument ? 'Document RAG' : 'General AI'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-normal">
                  {latestAssistantMessage?.routeMessage ??
                    'Queries with cosine match ≥ 12% ground on the PDF; other queries route to General AI.'}
                </p>
              </div>
            </div>

            {/* On-Device Hardware Telemetry */}
            <div className="glass-card p-3.5 space-y-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">On-Device Telemetry</span>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Embedding Engine</span>
                  <span className="font-mono text-[11px] text-slate-200">MiniLM-L6-v2 (q8)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Redaction Engine</span>
                  <span className="font-mono text-[11px] text-slate-200">bert-base-NER (q8)</span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-white/5">
                  <span className="text-slate-400">Active Accelerator</span>
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${activeHardware.badgeClass}`}>
                    {activeHardware.label}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Chat Column */}
        <section className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden bg-[#070A0F]/80">
          {/* Pinned Top Header */}
          <header className="h-14 shrink-0 border-b border-white/10 bg-[#090D16]/90 px-4 backdrop-blur-xl flex items-center justify-between gap-3 z-10">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/5 lg:hidden"
                title="Open Sidebar"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>

              <div className="flex items-center gap-2 min-w-0">
                <div className="hidden sm:flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.25)]">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                </div>
                <h1 className="truncate text-sm font-semibold text-slate-100 tracking-tight">
                  Zero-Trust Assistant
                </h1>
                <span className="hidden md:inline-flex rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                  Edge Privacy Shield
                </span>
              </div>
            </div>

            {/* Header Right Actions & Live Status */}
            <div className="flex items-center gap-2.5">
              {/* Telemetry Status Pill */}
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs">
                <span
                  className={`h-2 w-2 rounded-full ${
                    statusInfo.tone === 'emerald'
                      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                      : 'bg-amber-400 animate-pulse'
                  }`}
                />
                <span className="text-slate-300 font-medium text-[11px]">{statusInfo.text}</span>
              </div>

              {/* Hardware Runtime Badge */}
              <span className={`hidden md:inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-mono ${activeHardware.badgeClass}`}>
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" />
                  <line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" />
                  <line x1="15" y1="20" x2="15" y2="23" />
                </svg>
                {activeHardware.label}
              </span>

              {/* Privacy Shield Toggle Pill */}
              <button
                type="button"
                onClick={() => setIsPrivacyShieldOn((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  isPrivacyShieldOn
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                }`}
                title={isPrivacyShieldOn ? 'Privacy Shield Active (Masks PII)' : 'Privacy Shield Paused (Raw)'}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span className="hidden sm:inline">{isPrivacyShieldOn ? 'Shield ON' : 'Shield OFF'}</span>
              </button>

              {/* Payload Inspector Trigger */}
              <button
                type="button"
                onClick={() => {
                  setSelectedInspectorId(activeInspectorMessage?.id ?? null);
                  setInspectorOpen(true);
                }}
                disabled={!activeInspectorMessage}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
                title="Inspect sanitized transport payload"
              >
                <svg className="h-3.5 w-3.5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span className="hidden sm:inline">Inspector</span>
              </button>
            </div>
          </header>

          {/* Banner Error Notice */}
          {displayError ? (
            <div className="shrink-0 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs text-rose-300 flex items-center justify-between">
              <span>{displayError}</span>
              <button
                type="button"
                onClick={() => setSurfaceError(null)}
                className="text-rose-400 hover:text-rose-200 ml-2"
              >
                ✕
              </button>
            </div>
          ) : null}

          {/* Message Feed (Scrolls internally) */}
          <div ref={messageViewportRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-6">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
              {displayHistory.length === 0 && !liveAssistantMessage ? (
                // 3. Interactive Empty State (Hero)
                <div className="my-auto flex flex-col items-center justify-center text-center px-4 py-8">
                  <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-500/10 text-emerald-400 shadow-[0_0_35px_rgba(16,185,129,0.35)] animate-pulse-glow">
                    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                  </div>

                  <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight bg-gradient-to-r from-white via-emerald-100 to-cyan-200 bg-clip-text text-transparent">
                    Zero-Trust Document Intelligence
                  </h2>

                  <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">
                    Client-side Edge AI RAG. PDF extraction, vector embeddings, and multi-tier PII sanitization run locally on your device before cloud handoff.
                  </p>

                  {/* 3-Step Visual Trust Strip */}
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-[11px] text-slate-400">
                    <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
                      <span className="font-semibold text-emerald-400">1</span>
                      <span>Local PDF & Embeddings</span>
                    </div>
                    <span className="text-slate-600">→</span>
                    <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
                      <span className="font-semibold text-emerald-400">2</span>
                      <span>On-Device PII Masking</span>
                    </div>
                    <span className="text-slate-600">→</span>
                    <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
                      <span className="font-semibold text-emerald-400">3</span>
                      <span>Local Stream Rehydration</span>
                    </div>
                  </div>

                  {/* Quick-Prompt Starter Chips */}
                  <div className="mt-8 grid w-full max-w-xl grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {QUICK_PROMPTS.map((item) => (
                      <button
                        key={item.title}
                        type="button"
                        onClick={() => {
                          if (!hasDocument) {
                            openFilePicker();
                          } else {
                            void submitQuery(item.prompt);
                          }
                        }}
                        className="group flex flex-col items-start rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left transition hover:border-emerald-500/40 hover:bg-emerald-500/[0.04] hover:-translate-y-0.5"
                      >
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 text-emerald-400 transition group-hover:bg-emerald-500/20">
                          {item.icon}
                        </div>
                        <p className="mt-2 text-xs font-semibold text-slate-200 group-hover:text-emerald-300">
                          {item.title}
                        </p>
                        <p className="mt-0.5 text-[10px] text-slate-400 line-clamp-2">
                          {item.prompt}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {displayHistory.map((message) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      onInspect={handleInspectMessage}
                    />
                  ))}

                  {liveAssistantMessage ? (
                    <ChatMessage
                      key={liveAssistantMessage.id}
                      message={liveAssistantMessage}
                      isStreaming={true}
                      onInspect={handleInspectMessage}
                    />
                  ) : null}

                  {isQuerying && !liveAssistantMessage?.content ? (
                    <article className="flex justify-start animate-message-fade">
                      <div className="glass-panel px-4 py-3 flex items-center gap-3">
                        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-xs text-slate-300 font-medium">
                          {queryStatusMessage ?? 'Reasoning & sanitizing...'}
                        </span>
                      </div>
                    </article>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {/* Pinned Bottom Composer */}
          <footer className="shrink-0 p-3 sm:p-4 border-t border-white/10 bg-[#070A0F]/95 backdrop-blur-xl z-10">
            <div className="mx-auto w-full max-w-3xl">
              <form onSubmit={handleSubmit}>
                <div className="glass-panel rounded-2xl border border-white/15 bg-white/[0.03] p-2.5 transition duration-200 focus-within:border-emerald-400/50 focus-within:shadow-[0_0_24px_-8px_rgba(16,185,129,0.45)]">
                  {/* Textarea with Enter-to-send */}
                  <textarea
                    ref={textareaRef}
                    id="query"
                    rows={2}
                    value={composer}
                    onChange={(e) => setComposer(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      isInitializing
                        ? 'Warming local privacy engines...'
                        : isProcessing
                          ? `Indexing ${activeFileName ?? 'document'} locally...`
                          : hasDocument
                            ? 'Ask about this document, or chat naturally...'
                            : 'Message Zero-Trust Assistant...'
                    }
                    disabled={!canQuery}
                    className="max-h-32 w-full resize-none overflow-y-auto bg-transparent px-3 py-1.5 text-[15px] leading-6 text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
                  />

                  {/* Composer Footer Toolbar */}
                  <div className="mt-2 flex items-center justify-between gap-2 pt-2 border-t border-white/5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={openFilePicker}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-300 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-300 transition"
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                        <span className="hidden sm:inline">Attach PDF</span>
                      </button>

                      {hasDocument ? (
                        <span className="hidden md:inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono text-emerald-400">
                          {documentName}
                        </span>
                      ) : null}

                      {/* Keyboard shortcut helper */}
                      <span className="hidden lg:inline text-[11px] text-slate-500">
                        Enter ↵ to send · Shift+Enter for newline
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Send Button */}
                      <button
                        type="submit"
                        disabled={!composer.trim() || !canQuery}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-1.5 text-xs font-semibold text-slate-950 shadow-md shadow-emerald-500/20 transition hover:from-emerald-400 hover:to-cyan-400 hover:shadow-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                      >
                        <span>
                          {isInitializing
                            ? 'Warming'
                            : isProcessing
                              ? 'Indexing'
                              : isQuerying
                                ? 'Thinking...'
                                : 'Send'}
                        </span>
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </form>
            </div>
          </footer>
        </section>
      </div>

      {/* Payload Drawer / Privacy Inspector */}
      <PayloadDrawer
        isOpen={inspectorOpen}
        message={activeInspectorMessage}
        onClose={() => setInspectorOpen(false)}
      />
    </div>
  );
}

function PayloadDrawer({
  isOpen,
  message,
  onClose
}: {
  isOpen: boolean;
  message: ConversationMessage | null;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm animate-message-fade">
      <div className="h-full w-full max-w-[480px] overflow-y-auto border-l border-white/10 bg-[#090D16] p-5 shadow-2xl flex flex-col">
        {/* Drawer Header */}
        <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.8)]" />
              <p className="text-xs uppercase tracking-[0.2em] text-cyan-400 font-mono">
                Wire Transport Payload
              </p>
            </div>
            <h2 className="mt-1.5 text-xl font-bold text-slate-100">
              Privacy Inspector
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Inspect the exact sanitized payload sent to the LLM. Personal identities and sensitive accounts are replaced with synthetic tokens.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/10 transition"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Drawer Body */}
        {!message ? (
          <div className="my-auto rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center text-xs text-slate-400">
            No inspectable assistant payload is available yet. Run a query to review its redacted payload.
          </div>
        ) : (
          <div className="mt-4 space-y-4 flex-1">
            {/* Route Summary */}
            <div className="glass-card p-3.5 space-y-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Route Execution</span>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-emerald-300 font-medium">
                  {message.route === 'document' ? 'Local Document RAG' : 'General AI Mode'}
                </span>
                <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-cyan-300 font-medium">
                  {message.privacyShieldEnabled ?? true ? 'Privacy Shield Active' : 'Raw Transport'}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-slate-300">
                {message.routeMessage ?? 'Payload processed through on-device zero-trust privacy engine.'}
              </p>
            </div>

            {/* Sanitized User Query */}
            {message.sanitizedInput ? (
              <div className="glass-card p-3.5 space-y-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Sanitized User Input</span>
                <div className="rounded-lg border border-white/5 bg-black/40 p-3 font-mono text-xs text-slate-200 whitespace-pre-wrap">
                  {message.sanitizedInput}
                </div>
                {message.sanitizedInputDictionary && Object.keys(message.sanitizedInputDictionary).length > 0 ? (
                  <div className="space-y-1.5 pt-1">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400">Detected & Masked Tokens:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(message.sanitizedInputDictionary).map(([token, entry]) => (
                        <span
                          key={token}
                          className="rounded-md border border-emerald-500/30 bg-emerald-950/40 px-2 py-0.5 font-mono text-[11px] text-emerald-300"
                        >
                          {token} → {entry.original} ({entry.label})
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500">No PII detected in user input.</p>
                )}
              </div>
            ) : null}

            {/* Retrieved Context Chunks */}
            {(message.results ?? []).length > 0 ? (
              <div className="space-y-2.5">
                <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
                  Top-K Redacted Document Chunks ({message.results?.length})
                </span>

                {message.results?.map((result, idx) => {
                  const chunkDict = Object.entries(result.dictionary);
                  return (
                    <div key={result.id} className="glass-card p-3 space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-slate-200">
                          Chunk #{result.metadata?.chunkIndex ?? idx + 1}
                        </span>
                        <span className="font-mono text-emerald-400">
                          {(result.score * 100).toFixed(1)}% similarity
                        </span>
                      </div>

                      <div className="rounded-lg border border-white/5 bg-black/40 p-2.5 font-mono text-[11px] text-slate-300 max-h-36 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                        {result.redactedText}
                      </div>

                      {chunkDict.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {chunkDict.map(([token, entry]) => (
                            <span
                              key={token}
                              className="rounded border border-cyan-500/30 bg-cyan-950/30 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300"
                            >
                              {token} = {entry.original}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function formatRejection(rejection: FileRejection): string {
  const firstError = rejection.errors[0];
  switch (firstError?.code) {
    case 'file-invalid-type':
      return 'Only PDF files (.pdf) are supported for client-side analysis.';
    case 'too-many-files':
      return 'Please attach a single PDF file.';
    default:
      return firstError?.message ?? 'The selected file could not be attached.';
  }
}

export default App;
