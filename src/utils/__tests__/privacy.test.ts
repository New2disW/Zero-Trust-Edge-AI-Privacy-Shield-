import { describe, it, expect } from 'vitest';
import {
  isTitleCaseEntity,
  normalizeLedgerKey,
  TOKEN_PATTERN,
  PII_DEFENSES,
  CHUNK_PII_DEFENSES
} from '@/utils/piiDefenses';
import { rehydrateResponse } from '@/utils/rehydration';
import { VectorStore } from '@/lib/VectorStore';
import { PDFExtractor } from '@/lib/PDFExtractor';

describe('Privacy Engine & PII Defenses', () => {
  describe('1. isTitleCaseEntity', () => {
    it('accepts capitalized names and rejects lowercase prose', () => {
      // Valid title-case entities
      expect(isTitleCaseEntity('John')).toBe(true);
      expect(isTitleCaseEntity('John Doe')).toBe(true);
      expect(isTitleCaseEntity('Jane Mary Smith')).toBe(true);
      expect(isTitleCaseEntity('Alice 1')).toBe(true);
      expect(isTitleCaseEntity('Robert Downey Jr')).toBe(true);

      // Rejects ordinary lowercase prose
      expect(isTitleCaseEntity('about the financial report')).toBe(false);
      expect(isTitleCaseEntity('the financial report')).toBe(false);
      expect(isTitleCaseEntity('financial report')).toBe(false);
      expect(isTitleCaseEntity('john doe')).toBe(false);
      expect(isTitleCaseEntity('apple')).toBe(false);

      // Rejects edge cases: empty strings, all uppercase, mixed lowercase start
      expect(isTitleCaseEntity('')).toBe(false);
      expect(isTitleCaseEntity('   ')).toBe(false);
      expect(isTitleCaseEntity('JOHN DOE')).toBe(false);
      expect(isTitleCaseEntity('john Doe')).toBe(false);
    });
  });

  describe('2. normalizeLedgerKey', () => {
    it('normalizes casing and extra whitespace consistently', () => {
      expect(normalizeLedgerKey('  John   Doe  ')).toBe('john doe');
      expect(normalizeLedgerKey('John Doe')).toBe('john doe');
      expect(normalizeLedgerKey('JOHN   DOE')).toBe('john doe');
      expect(normalizeLedgerKey('john doe')).toBe('john doe');
      expect(normalizeLedgerKey('Jane   Mary   Smith')).toBe('jane mary smith');
      expect(normalizeLedgerKey('  ALICE   SMITH  ')).toBe('alice smith');
    });
  });

  describe('3. DOB rule', () => {
    it('matches birth dates and ignores ordinary dates in PII_DEFENSES', () => {
      const dobRule = PII_DEFENSES.find((defense) => defense.tag === '[INPUT_DOB]');
      expect(dobRule).toBeDefined();

      const regex = new RegExp(dobRule!.regex.source, dobRule!.regex.flags);

      // Matches birth-date formats preceded by keywords
      const match1 = regex.exec('DOB: 12/05/1998');
      expect(match1).not.toBeNull();
      expect(match1![dobRule!.captureGroup ?? 0]).toBe('12/05/1998');

      regex.lastIndex = 0;
      const match2 = regex.exec('d.o.b. 1998-05-12');
      expect(match2).not.toBeNull();
      expect(match2![dobRule!.captureGroup ?? 0]).toBe('1998-05-12');

      regex.lastIndex = 0;
      const match3 = regex.exec('date of birth: 12/05/1998');
      expect(match3).not.toBeNull();
      expect(match3![dobRule!.captureGroup ?? 0]).toBe('12/05/1998');

      regex.lastIndex = 0;
      const match4 = regex.exec('birth date: 12-05-1998');
      expect(match4).not.toBeNull();
      expect(match4![dobRule!.captureGroup ?? 0]).toBe('12-05-1998');

      regex.lastIndex = 0;
      const match5 = regex.exec('born on 12/05/1998');
      expect(match5).not.toBeNull();
      expect(match5![dobRule!.captureGroup ?? 0]).toBe('12/05/1998');

      // Ignores ordinary invoice/document dates
      regex.lastIndex = 0;
      expect(regex.exec('Invoice dated 12/05/2026')).toBeNull();

      regex.lastIndex = 0;
      expect(regex.exec('Created on 10/11/2023')).toBeNull();

      regex.lastIndex = 0;
      expect(regex.exec('Statement date: 2024-06-15')).toBeNull();
    });

    it('matches birth dates and ignores ordinary dates in CHUNK_PII_DEFENSES', () => {
      const dobRule = CHUNK_PII_DEFENSES.find((defense) => defense.tag === '[DOB]');
      expect(dobRule).toBeDefined();

      const regex = new RegExp(dobRule!.regex.source, dobRule!.regex.flags);

      // Matches birth dates
      const match1 = regex.exec('DOB: 12/05/1998');
      expect(match1).not.toBeNull();
      expect(match1![dobRule!.captureGroup ?? 0]).toBe('12/05/1998');

      // Ignores ordinary invoice/document dates
      regex.lastIndex = 0;
      expect(regex.exec('Invoice dated 12/05/2026')).toBeNull();
    });
  });

  describe('4. TOKEN_PATTERN', () => {
    it('matches underscored tokens and rejects non-tokens', () => {
      // Underscored tokens
      expect(TOKEN_PATTERN.test('[ACCOUNT_NUM_1]')).toBe(true);
      expect(TOKEN_PATTERN.test('[IP_ADDRESS_2]')).toBe(true);
      expect(TOKEN_PATTERN.test('[UPI_ID_1]')).toBe(true);
      expect(TOKEN_PATTERN.test('[PERSON_1]')).toBe(true);
      expect(TOKEN_PATTERN.test('[PERSON_10]')).toBe(true);
      expect(TOKEN_PATTERN.test('[MEDICAL_ID_99]')).toBe(true);
      expect(TOKEN_PATTERN.test('[EMPLOYEE_ID_42]')).toBe(true);

      // Rejects tokens without numeric suffixes or invalid formats
      expect(TOKEN_PATTERN.test('[PERSON]')).toBe(false);
      expect(TOKEN_PATTERN.test('[123]')).toBe(false);
      expect(TOKEN_PATTERN.test('[person_1]')).toBe(false);
      expect(TOKEN_PATTERN.test('hello')).toBe(false);
      expect(TOKEN_PATTERN.test('[]')).toBe(false);
    });
  });

  describe('5. rehydrateResponse', () => {
    it('replaces longer tokens before shorter prefixes to avoid partial replacements', () => {
      const text = 'Identified [PERSON_10] and [PERSON_1] in the report.';
      const dictionary: Record<string, string> = {
        '[PERSON_1]': 'Alice',
        '[PERSON_10]': 'Bob'
      };

      const result = rehydrateResponse(text, dictionary);
      expect(result).toBe('Identified Bob and Alice in the report.');

      // Also verify with account number tokens
      const text2 = 'Accounts [ACCOUNT_NUM_10] and [ACCOUNT_NUM_1] were audited.';
      const dictionary2: Record<string, string> = {
        '[ACCOUNT_NUM_1]': '11112222',
        '[ACCOUNT_NUM_10]': '99998888'
      };

      const result2 = rehydrateResponse(text2, dictionary2);
      expect(result2).toBe('Accounts 99998888 and 11112222 were audited.');
    });
  });

  describe('6. VectorStore.search', () => {
    it('ranks cosine similarity matches accurately', () => {
      const store = new VectorStore<{ name: string }>();

      store.add({
        id: 'item-a',
        text: 'Document about physics',
        embedding: [1, 0, 0],
        metadata: { name: 'Physics' }
      });
      store.add({
        id: 'item-b',
        text: 'Document about science and arts',
        embedding: [0.70710678, 0.70710678, 0],
        metadata: { name: 'ScienceArts' }
      });
      store.add({
        id: 'item-c',
        text: 'Document about arts',
        embedding: [0, 1, 0],
        metadata: { name: 'Arts' }
      });

      // Query vector perfectly aligned with item-a
      const results = store.search([1, 0, 0], 2);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('item-a');
      expect(results[0].score).toBeCloseTo(1.0, 4);
      expect(results[0].metadata?.name).toBe('Physics');

      expect(results[1].id).toBe('item-b');
      expect(results[1].score).toBeCloseTo(0.7071, 3);
      expect(results[1].metadata?.name).toBe('ScienceArts');

      // Verify Float32Array cloning on returned results
      expect(results[0].embedding).toBeInstanceOf(Float32Array);
    });

    it('enforces dimension validation on add and search', () => {
      const store = new VectorStore();

      store.add({
        text: 'Initial 3D vector',
        embedding: [1, 0, 0]
      });

      // Adding vector with mismatched dimension must throw
      expect(() => {
        store.add({
          text: 'Invalid 2D vector',
          embedding: [1, 0]
        });
      }).toThrow(/dimension mismatch/i);

      // Searching with mismatched dimension must throw
      expect(() => {
        store.search([1, 0]);
      }).toThrow(/dimension mismatch/i);
    });
  });

  describe('7. PDFExtractor.extractTextFromItems', () => {
    it('separates items on different vertical lines without fusing words into OBTANUJA', () => {
      const items = [
        { str: 'DOB', transform: [1, 0, 0, 1, 50, 100], width: 25 },
        { str: 'TANUJA YUVRAJ PAWAR', transform: [1, 0, 0, 1, 50, 85], width: 140 }
      ];

      const extracted = PDFExtractor.extractTextFromItems(items);

      expect(extracted).not.toContain('OBTANUJA');
      expect(extracted).not.toContain('DOBTANUJA');
      expect(extracted).toBe('DOB\nTANUJA YUVRAJ PAWAR');
    });

    it('separates spaced form cells on the same line with a single space', () => {
      const items = [
        { str: 'DOB', transform: [1, 0, 0, 1, 50, 100], width: 25 },
        { str: 'TANUJA YUVRAJ PAWAR', transform: [1, 0, 0, 1, 95, 100], width: 140 }
      ];

      const extracted = PDFExtractor.extractTextFromItems(items);

      expect(extracted).not.toContain('OBTANUJA');
      expect(extracted).not.toContain('DOBTANUJA');
      expect(extracted).toBe('DOB TANUJA YUVRAJ PAWAR');
    });

    it('handles hasEOL flags and spacer items cleanly', () => {
      const items = [
        { str: 'DOB', transform: [1, 0, 0, 1, 50, 100], width: 25 },
        { str: '', hasEOL: true, transform: [1, 0, 0, 1, 75, 100] },
        { str: 'TANUJA YUVRAJ PAWAR', transform: [1, 0, 0, 1, 50, 99.5], width: 140 }
      ];

      const extracted = PDFExtractor.extractTextFromItems(items);

      expect(extracted).not.toContain('OBTANUJA');
      expect(extracted).not.toContain('DOBTANUJA');
      expect(extracted).toBe('DOB\nTANUJA YUVRAJ PAWAR');
    });

    it('normalizes excessive horizontal whitespace without collapsing newlines', () => {
      const items = [
        { str: 'Patient    ID:   12345', transform: [1, 0, 0, 1, 50, 100], width: 120, hasEOL: true },
        { str: 'Name:     Tanuja   Pawar', transform: [1, 0, 0, 1, 50, 80], width: 130 }
      ];

      const extracted = PDFExtractor.extractTextFromItems(items);

      expect(extracted).toBe('Patient ID: 12345\nName: Tanuja Pawar');
    });
  });
});
