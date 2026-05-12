import { describe, expect, it } from 'vitest';
import { documentObjectPath } from './documents';

describe('documentObjectPath', () => {
  it('builds <user>/<thread>/<doc>.<ext>', () => {
    expect(
      documentObjectPath({
        userId: 'u-1',
        threadId: 't-1',
        documentId: 'd-1',
        ext: 'pdf',
      }),
    ).toBe('u-1/t-1/d-1.pdf');
  });

  it('lowercases the extension', () => {
    expect(
      documentObjectPath({
        userId: 'u-1',
        threadId: 't-1',
        documentId: 'd-1',
        ext: 'PDF',
      }),
    ).toBe('u-1/t-1/d-1.pdf');
  });
});
