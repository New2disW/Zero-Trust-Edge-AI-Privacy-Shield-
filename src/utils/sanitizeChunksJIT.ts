import type {
  TokenClassificationOutput,
  TokenClassificationPipelineType
} from '@huggingface/transformers';

interface RegexRule {
  label: string;
  regex: RegExp;
}

interface ReplacementSpan {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
}

export interface SanitizeChunksJITResult {
  sanitizedChunks: string[];
  privacyLedger: Record<string, string>;
}

const REGEX_PII_RULES: RegexRule[] = [
  // ── Explicit Person Names (Full Name, Emergency Contact) ──
  {
    label: 'PERSON',
    regex: /(?:full name|name|emergency contact|contact name|customer name)\s*[:\-]?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*(?:\s\d+)?)\b/gi
  },
  // ── Bank / financial account numbers (8-18 digits, standalone) ──
  {
    label: 'ACCOUNT_NUM',
    regex: /(?:(?:account|acct|a\/c)(?:\s*(?:no|number|num|#))?\s*[:\-]?\s*)(\d{8,18})\b/gi
  },
  // ── Routing / bank routing number (8-12 digits after keyword) ──
  {
    label: 'ROUTING',
    regex: /(?:routing\s*(?:no|number|num|#)?\s*[:\-]?\s*)(\d{8,12})\b/gi
  },
  // ── Existing high-confidence structured PII ──
  {
    label: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    label: 'PHONE',
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g
  },
  {
    label: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    label: 'CC',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g
  },
  // ── Indian PAN (e.g. ABCDE3123F) ──
  {
    label: 'PAN',
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g
  },
  // ── Indian Aadhaar (e.g. 4567 8912 1003) ──
  {
    label: 'AADHAAR',
    regex: /\b\d{4}\s\d{4}\s\d{4}\b/g
  },
  // ── Passport number (e.g. P0000003 or A1234567) ──
  {
    label: 'PASSPORT',
    regex: /\b[A-Z]\d{7}\b/g
  },
  // ── Indian IFSC code (e.g. NTBK0000003) ──
  {
    label: 'IFSC',
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g
  },
  // ── Date of Birth (dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, mm/dd/yyyy) ──
  {
    label: 'DOB',
    regex: /\b(?:\d{2}[\/-]\d{2}[\/-]\d{4}|\d{4}[\/-]\d{2}[\/-]\d{2})\b/g
  },
  // ── IP addresses (IPv4) ──
  {
    label: 'IP_ADDRESS',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g
  },
  // ── Medical / health insurance IDs (e.g. MED000003, INS-12345) ──
  {
    label: 'MEDICAL_ID',
    regex: /\b(?:MED|INS|HLT|HLTH|MID|HEALTH)[-]?\d{4,12}\b/gi
  },
  // ── Employee / staff IDs (e.g. EMP00003, STAFF-123) ──
  {
    label: 'EMPLOYEE_ID',
    regex: /\b(?:EMP|STAFF|HR|EMPID)[-]?\d{3,10}\b/gi
  },
  // ── Indian Voter ID (e.g. ABC1234567) ──
  {
    label: 'VOTER_ID',
    regex: /\b[A-Z]{3}\d{7}\b/g
  },
  // ── Indian vehicle registration (e.g. DL01AB1234) ──
  {
    label: 'VEHICLE_REG',
    regex: /\b[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}\b/g
  },
  // ── US Driver's License (common patterns) ──
  {
    label: 'DRIVERS_LICENSE',
    regex: /\b(?:DL|D\.?L\.?)\s*[:#-]?\s*[A-Z0-9]{6,12}\b/gi
  },
  // ── UPI IDs (e.g. user@upi, user@paytm) ──
  {
    label: 'UPI_ID',
    regex: /\b[A-Za-z0-9._%+-]+@(?:upi|paytm|ybl|okhdfcbank|okaxis|okicici|apl|ibl)\b/gi
  },
  // ── Usernames (after keyword, e.g. username: arjun_user_3) ──
  {
    label: 'USERNAME',
    regex: /(?:username|user\s*id|login\s*id|user\s*name)\s*[:\-]?\s*([A-Za-z0-9._-]{3,30})\b/gi
  },
  // ── Physical addresses (multi-part, e.g. "Flat 103, Green Valley..." after address keyword) ──
  {
    label: 'ADDRESS',
    regex: /(?:address|residence|addr)\s*[:\-]?\s*(.{10,120})(?=\n|$)/gi
  }
];

const SANITIZED_TOKEN_PATTERN = /\[[A-Z]+_\d+\]/;
const NER_LABELS = new Set<string>(['PERSON', 'ORG', 'LOCATION', 'MISC']);

/**
 * Just-In-Time sanitize only the chunks that are about to be sent to the LLM.
 *
 * Why this utility exists:
 * - We do NOT want to sanitize the whole document during ingestion because that would
 *   damage retrieval quality and create unnecessary memory pressure.
 * - We DO want to sanitize the final Top-K chunks right before model handoff.
 *
 * The function works in two tiers:
 * 1. Regex pass for high-confidence structured PII (email / phone / SSN / credit card)
 * 2. NER pass for softer named entities (person / org / location)
 *
 * Every replacement is written into a shared privacy ledger. That ledger is global
 * for the current call, so if "John Doe" appears in 8 different chunks it will keep
 * reusing the exact same token, e.g. [PERSON_1].
 */
export async function sanitizeChunksJIT(
  rawChunks: string[],
  nerPipeline: TokenClassificationPipelineType
): Promise<SanitizeChunksJITResult> {
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    return {
      sanitizedChunks: [],
      privacyLedger: {}
    };
  }

  const privacyLedger: Record<string, string> = {};

  // `tokenByFingerprint` gives us deduplication.
  // Example:
  //   PERSON::john doe -> [PERSON_1]
  // So whenever "John Doe" shows up again later, we reuse [PERSON_1].
  const tokenByFingerprint = new Map<string, string>();

  // `countersByLabel` gives us sequential numbering per entity type.
  // Example:
  //   PERSON -> 2 means the next person token becomes [PERSON_3]
  const countersByLabel = new Map<string, number>();

  const getOrCreateToken = (label: string, originalValue: string): string => {
    const normalizedValue = normalizeLedgerValue(originalValue);
    const fingerprint = `${label}::${normalizedValue.toLowerCase()}`;
    const existingToken = tokenByFingerprint.get(fingerprint);

    if (existingToken) {
      return existingToken;
    }

    const nextIndex = (countersByLabel.get(label) ?? 0) + 1;
    countersByLabel.set(label, nextIndex);

    const token = `[${label}_${nextIndex}]`;
    tokenByFingerprint.set(fingerprint, token);

    // We intentionally store the first-seen original surface form so the frontend
    // can rehydrate the answer back to something human-readable later.
    privacyLedger[token] = originalValue;

    return token;
  };

  // Tier 1: regex-based structured PII replacement.
  // This is cheap, deterministic, and great for things the NER model may miss.
  const regexSanitizedChunks = rawChunks.map((chunk) =>
    sanitizeStructuredPII(chunk, getOrCreateToken)
  );

  // Tier 2: named-entity recognition over the regex-cleaned text.
  // We only keep PERSON / ORG / LOCATION and ignore everything else.
  const nerOutputs = await nerPipeline(regexSanitizedChunks, {
    ignore_labels: ['O']
  });

  const normalizedOutputs = Array.isArray(nerOutputs[0])
    ? (nerOutputs as TokenClassificationOutput[])
    : [nerOutputs as TokenClassificationOutput];

  const sanitizedChunks = regexSanitizedChunks.map((chunk, index) =>
    sanitizeNamedEntities(chunk, normalizedOutputs[index] ?? [], getOrCreateToken)
  );

  return {
    sanitizedChunks,
    privacyLedger
  };
}

/**
 * Replace structured PII using regex rules.
 *
 * We do this before NER because structured items are high-confidence and do not
 * require model inference. This also reduces noise before we run the AI pass.
 */
function sanitizeStructuredPII(
  sourceText: string,
  getOrCreateToken: (label: string, originalValue: string) => string
): string {
  let sanitizedText = sourceText;

  for (const rule of REGEX_PII_RULES) {
    rule.regex.lastIndex = 0;

    sanitizedText = sanitizedText.replace(rule.regex, (...args: string[]) => {
      const fullMatch = args[0];

      // If the regex has a capture group (args[1] is a captured string),
      // only replace the captured portion within the full match.
      const capturedValue =
        args.length > 3 && typeof args[1] === 'string' && args[1].length > 0
          ? args[1]
          : null;

      const originalValue = (capturedValue ?? fullMatch).trim();

      if (!originalValue || SANITIZED_TOKEN_PATTERN.test(originalValue)) {
        return fullMatch;
      }

      const token = getOrCreateToken(rule.label, originalValue);

      if (capturedValue) {
        return fullMatch.replace(capturedValue, token);
      }

      return token;
    });
  }

  return sanitizedText;
}

/**
 * Replace PERSON / ORG / LOCATION entities detected by the local NER model.
 *
 * Important implementation detail:
 * Transformers.js often emits token-level labels like:
 *   B-PER  "John"
 *   I-PER  "Doe"
 *
 * We first merge adjacent compatible predictions into a single span ("John Doe"),
 * then collapse any overlaps, then replace from right-to-left so string indexes
 * remain stable while we edit the text.
 */
function sanitizeNamedEntities(
  sourceText: string,
  predictions: TokenClassificationOutput,
  getOrCreateToken: (label: string, originalValue: string) => string
): string {
  const spans = collapseOverlaps(aggregateEntitySpans(sourceText, predictions));

  if (spans.length === 0) {
    return sourceText;
  }

  // Replace from the end of the string toward the beginning.
  // This prevents earlier replacements from shifting the indexes of later spans.
  const replacements = [...spans].sort((left, right) => right.start - left.start);
  let sanitizedText = sourceText;

  for (const span of replacements) {
    const originalValue = span.text.trim();

    if (!originalValue || SANITIZED_TOKEN_PATTERN.test(originalValue)) {
      continue;
    }

    const token = getOrCreateToken(span.label, originalValue);

    sanitizedText =
      sanitizedText.slice(0, span.start) +
      token +
      sanitizedText.slice(span.end);
  }

  return sanitizedText;
}

/**
 * Merge token-level predictions into human-meaningful spans.
 *
 * Example:
 *   "John" (B-PER) + "Doe" (I-PER) => one PERSON span "John Doe"
 */
function aggregateEntitySpans(
  sourceText: string,
  predictions: TokenClassificationOutput
): ReplacementSpan[] {
  const spans: ReplacementSpan[] = [];
  let currentSpan: ReplacementSpan | null = null;

  for (const prediction of predictions) {
    if (
      typeof prediction.start !== 'number' ||
      typeof prediction.end !== 'number' ||
      prediction.end <= prediction.start
    ) {
      continue;
    }

    const text = sourceText.slice(prediction.start, prediction.end).trim();

    if (!text || SANITIZED_TOKEN_PATTERN.test(text)) {
      continue;
    }

    const { prefix, label } = parseEntityLabel(prediction.entity);

    if (!label || !NER_LABELS.has(label)) {
      continue;
    }

    const nextSpan: ReplacementSpan = {
      start: prediction.start,
      end: prediction.end,
      label,
      text,
      score: prediction.score
    };

    const canExtend =
      currentSpan !== null &&
      prefix !== 'B' &&
      currentSpan.label === nextSpan.label &&
      nextSpan.start <= currentSpan.end + 1;

    if (!canExtend || currentSpan === null) {
      if (currentSpan) {
        spans.push(currentSpan);
      }

      currentSpan = nextSpan;
      continue;
    }

    currentSpan.end = Math.max(currentSpan.end, nextSpan.end);
    currentSpan.text = sourceText.slice(currentSpan.start, currentSpan.end).trim();
    currentSpan.score = (currentSpan.score + nextSpan.score) / 2;
  }

  if (currentSpan) {
    spans.push(currentSpan);
  }

  return spans.filter((span) => span.text.length > 0);
}

/**
 * Resolve overlapping entity spans.
 *
 * Models sometimes emit overlapping guesses. We keep the best / most useful span:
 * - if the labels are the same, merge them
 * - otherwise prefer the higher-confidence span
 * - if confidence ties, prefer the longer span
 */
function collapseOverlaps(spans: ReplacementSpan[]): ReplacementSpan[] {
  const sortedSpans = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end
  );
  const collapsed: ReplacementSpan[] = [];

  for (const span of sortedSpans) {
    const previous = collapsed.at(-1);

    if (!previous || span.start >= previous.end) {
      collapsed.push({ ...span });
      continue;
    }

    if (previous.label === span.label) {
      previous.end = Math.max(previous.end, span.end);
      previous.text =
        previous.text.length >= span.text.length ? previous.text : span.text;
      previous.score = Math.max(previous.score, span.score);
      continue;
    }

    const preferCurrent =
      span.score > previous.score ||
      (span.score === previous.score &&
        span.end - span.start > previous.end - previous.start);

    if (preferCurrent) {
      collapsed[collapsed.length - 1] = { ...span };
    }
  }

  return collapsed;
}

function parseEntityLabel(entity: string): {
  prefix: 'B' | 'I' | null;
  label: ReplacementSpan['label'] | null;
} {
  const [prefix, rawLabel] = entity.includes('-')
    ? (entity.split('-', 2) as [string, string])
    : [null, entity];

  return {
    prefix: prefix === 'B' || prefix === 'I' ? prefix : null,
    label: normalizeEntityLabel(rawLabel)
  };
}

function normalizeEntityLabel(label: string | null): string | null {
  switch (label) {
    case 'PER':
      return 'PERSON';
    case 'ORG':
      return 'ORG';
    case 'LOC':
      return 'LOCATION';
    case 'MISC':
      return 'MISC';
    default:
      return null;
  }
}

function normalizeLedgerValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
