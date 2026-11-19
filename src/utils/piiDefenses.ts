export interface PIIDefense {
  regex: RegExp;
  tag: string;
  captureGroup?: number;
  requireTitleCase?: boolean;
}

export const TOKEN_PATTERN = /\[[A-Z][A-Z0-9_]*_\d+\]/;

export function isTitleCaseEntity(value: string): boolean {
  return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+\d+)?$/.test(value);
}

export function normalizeLedgerKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeTokenLabel(label: string): string {
  return (
    label
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'ENTITY'
  );
}

export function canonicalizeTokenLabel(label: string): string {
  return normalizeTokenLabel(label).replace(/^INPUT_/, '') || 'ENTITY';
}

export const PII_DEFENSES: PIIDefense[] = [
  // ── Explicit Person Names (Full Name, Emergency Contact) ──
  {
    regex:
      /(?:full name|name|emergency contact|contact name|customer name)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+\d+)?)\b/gi,
    tag: '[INPUT_PERSON]',
    captureGroup: 1,
    requireTitleCase: true
  },
  // ── Bank account numbers (after keyword) ──
  {
    regex:
      /(?:(?:account|acct|a\/c)(?:\s*(?:no|number|num|#))?\s*[:\-]?\s*)(\d{8,18})\b/gi,
    tag: '[INPUT_ACCOUNT_NUM]',
    captureGroup: 1
  },
  // ── Routing / bank routing number ──
  {
    regex: /((?:bank\s+)?routing\s+number(?:\s*[:#-])?\s*)(\d{8,12})\b/gi,
    tag: '[INPUT_ROUTING]',
    captureGroup: 2
  },
  // ── Email ──
  {
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    tag: '[INPUT_EMAIL]'
  },
  // ── Phone numbers ──
  {
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    tag: '[INPUT_PHONE]'
  },
  // ── Credit card ──
  {
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    tag: '[INPUT_CC]'
  },
  // ── US SSN ──
  {
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    tag: '[INPUT_SSN]'
  },
  // ── Indian PAN ──
  {
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    tag: '[INPUT_PAN]'
  },
  // ── Indian Aadhaar ──
  {
    regex: /\b\d{4}\s\d{4}\s\d{4}\b/g,
    tag: '[INPUT_AADHAAR]'
  },
  // ── Passport ──
  {
    regex: /\b[A-Z]\d{7}\b/g,
    tag: '[INPUT_PASSPORT]'
  },
  // ── IFSC ──
  {
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    tag: '[INPUT_IFSC]'
  },
  // ── Date of Birth ──
  {
    regex:
      /(?:\b(?:dob|d\.o\.b\.|date\s+of\s+birth|birth\s+date|born\s+on)\s*[:\-]?\s*)(\d{2}[\/-]\d{2}[\/-]\d{4}|\d{4}[\/-]\d{2}[\/-]\d{2})\b/gi,
    tag: '[INPUT_DOB]',
    captureGroup: 1
  },
  // ── IP address ──
  {
    regex:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    tag: '[INPUT_IP]'
  },
  // ── Medical / Insurance IDs ──
  {
    regex: /\b(?:MED|INS|HLT|HLTH|MID|HEALTH)[-]?\d{4,12}\b/gi,
    tag: '[INPUT_MEDICAL_ID]'
  },
  // ── Employee IDs ──
  {
    regex: /\b(?:EMP|STAFF|HR|EMPID)[-]?\d{3,10}\b/gi,
    tag: '[INPUT_EMPLOYEE_ID]'
  },
  // ── UPI IDs ──
  {
    regex:
      /\b[A-Za-z0-9._%+-]+@(?:upi|paytm|ybl|okhdfcbank|okaxis|okicici|apl|ibl)\b/gi,
    tag: '[INPUT_UPI_ID]'
  },
  // ── Person names (contextual) ──
  {
    regex:
      /(?:my name is|i am|this is|manager|boss|colleague|director|mr\.|mrs\.|ms\.|dr\.)(?:,)?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gi,
    tag: '[INPUT_PERSON]',
    captureGroup: 1,
    requireTitleCase: true
  },
  // ── Location (contextual) ──
  {
    regex:
      /(?:lives in|from|located in|traveling to|based in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gi,
    tag: '[INPUT_LOCATION]',
    captureGroup: 1,
    requireTitleCase: true
  },
  // ── Person names after prepositions ──
  {
    regex:
      /(?:for|about|regarding)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/gi,
    tag: '[INPUT_PERSON]',
    captureGroup: 1,
    requireTitleCase: true
  }
];

export const CHUNK_PII_DEFENSES: PIIDefense[] = [
  // ── Explicit Person Names (Full Name, Emergency Contact) ──
  {
    regex:
      /(?:full name|name|emergency contact|contact name|customer name)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+\d+)?)\b/gi,
    tag: '[PERSON]',
    captureGroup: 1,
    requireTitleCase: true
  },
  // ── Bank account numbers (after keyword) ──
  {
    regex:
      /(?:(?:account|acct|a\/c)(?:\s*(?:no|number|num|#))?\s*[:\-]?\s*)(\d{8,18})\b/gi,
    tag: '[ACCOUNT_NUM]',
    captureGroup: 1
  },
  // ── Routing / bank routing number ──
  {
    regex: /((?:bank\s+)?routing\s+number(?:\s*[:#-])?\s*)(\d{8,12})\b/gi,
    tag: '[ROUTING]',
    captureGroup: 2
  },
  // ── Email ──
  {
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    tag: '[EMAIL]'
  },
  // ── Phone numbers ──
  {
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    tag: '[PHONE]'
  },
  // ── Credit card ──
  {
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    tag: '[CC]'
  },
  // ── US SSN ──
  {
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    tag: '[SSN]'
  },
  // ── Indian PAN ──
  {
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    tag: '[PAN]'
  },
  // ── Indian Aadhaar ──
  {
    regex: /\b\d{4}\s\d{4}\s\d{4}\b/g,
    tag: '[AADHAAR]'
  },
  // ── Passport ──
  {
    regex: /\b[A-Z]\d{7}\b/g,
    tag: '[PASSPORT]'
  },
  // ── IFSC ──
  {
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    tag: '[IFSC]'
  },
  // ── Date of Birth ──
  {
    regex:
      /(?:\b(?:dob|d\.o\.b\.|date\s+of\s+birth|birth\s+date|born\s+on)\s*[:\-]?\s*)(\d{2}[\/-]\d{2}[\/-]\d{4}|\d{4}[\/-]\d{2}[\/-]\d{2})\b/gi,
    tag: '[DOB]',
    captureGroup: 1
  },
  // ── IP address ──
  {
    regex:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    tag: '[IP_ADDRESS]'
  },
  // ── Medical / Insurance IDs ──
  {
    regex: /\b(?:MED|INS|HLT|HLTH|MID|HEALTH)[-]?\d{4,12}\b/gi,
    tag: '[MEDICAL_ID]'
  },
  // ── Employee IDs ──
  {
    regex: /\b(?:EMP|STAFF|HR|EMPID)[-]?\d{3,10}\b/gi,
    tag: '[EMPLOYEE_ID]'
  },
  // ── Indian Voter ID ──
  {
    regex: /\b[A-Z]{3}\d{7}\b/g,
    tag: '[VOTER_ID]'
  },
  // ── Indian vehicle registration ──
  {
    regex: /\b[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}\b/g,
    tag: '[VEHICLE_REG]'
  },
  // ── Driver's License ──
  {
    regex: /\b(?:DL|D\.?L\.?)\s*[:#-]?\s*[A-Z0-9]{6,12}\b/gi,
    tag: '[DRIVERS_LICENSE]'
  },
  // ── UPI IDs ──
  {
    regex:
      /\b[A-Za-z0-9._%+-]+@(?:upi|paytm|ybl|okhdfcbank|okaxis|okicici|apl|ibl)\b/gi,
    tag: '[UPI_ID]'
  },
  // ── Usernames (after keyword) ──
  {
    regex:
      /(?:username|user\s*id|login\s*id|user\s*name)\s*[:\-]?\s*([A-Za-z0-9._-]{3,30})\b/gi,
    tag: '[USERNAME]',
    captureGroup: 1
  },
  // ── Physical addresses (after keyword) ──
  {
    regex: /(?:address|residence|addr)\s*[:\-]?\s*(.{10,120})(?=\n|$)/gi,
    tag: '[ADDRESS]',
    captureGroup: 1
  }
];
