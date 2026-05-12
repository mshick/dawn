import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUser, inngestSend, upload, del, dbMock } = vi.hoisted(() => ({
  getUser: vi.fn(),
  inngestSend: vi.fn().mockResolvedValue({ ids: ['evt'] }),
  upload: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  dbMock: {
    selectFrom: vi.fn(),
    insertInto: vi.fn(),
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: inngestSend } }));

vi.mock('@/lib/storage/documents', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/storage/documents')>('@/lib/storage/documents');
  return {
    ...actual,
    uploadDocumentBlob: upload,
    deleteDocumentBlob: del,
  };
});

vi.mock('@/lib/db/admin', () => ({ adminDb: dbMock }));

import { POST } from './route';

function makeReq(file: File): Request {
  const fd = new FormData();
  fd.set('file', file);
  return new Request('http://test/api/threads/t/documents', {
    method: 'POST',
    body: fd,
  });
}
function ctx() {
  return { params: Promise.resolve({ id: 't' }) };
}

function chainOwned() {
  // ensureOwned chain
  return {
    select: () => ({
      where: () => ({
        where: () => ({ executeTakeFirst: async () => ({ id: 't' }) }),
      }),
    }),
  };
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: 'u' } } });
  // Default chained-builder behavior — overridden per test.
  dbMock.selectFrom.mockReturnValue(chainOwned());
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/threads/[id]/documents', () => {
  it('401 when unauthenticated', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeReq(new File(['x'], 'a.txt', { type: 'text/plain' })), ctx());
    expect(res.status).toBe(401);
  });

  it('413 when oversize', async () => {
    const big = new File([new Uint8Array(26 * 1024 * 1024)], 'a.pdf', {
      type: 'application/pdf',
    });
    const res = await POST(makeReq(big), ctx());
    expect(res.status).toBe(413);
  });

  it('415 when mime unsupported', async () => {
    const res = await POST(makeReq(new File(['x'], 'a.png', { type: 'image/png' })), ctx());
    expect(res.status).toBe(415);
  });
});
