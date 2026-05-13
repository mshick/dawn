import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUser, del, dbMock } = vi.hoisted(() => ({
  getUser: vi.fn(),
  del: vi.fn().mockResolvedValue(undefined),
  dbMock: {
    selectFrom: vi.fn(),
    deleteFrom: vi.fn(),
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock('@/lib/storage/documents', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/storage/documents')>('@/lib/storage/documents');
  return { ...actual, deleteDocumentBlob: del };
});

vi.mock('@/lib/db/admin', () => ({ adminDb: dbMock }));

import { DELETE } from './route';

function ctx() {
  return { params: Promise.resolve({ id: 't', documentId: 'd' }) };
}
function req() {
  return new Request('http://test/api/threads/t/documents/d', { method: 'DELETE' });
}

// Builder mocks --------------------------------------------------------------
// ensureOwned (threads): selectFrom('threads').select(['id']).where(...).where(...).executeTakeFirst()
function ownedTrue() {
  return {
    select: () => ({
      where: () => ({ where: () => ({ executeTakeFirst: async () => ({ id: 't' }) }) }),
    }),
  };
}
function ownedFalse() {
  return {
    select: () => ({
      where: () => ({ where: () => ({ executeTakeFirst: async () => undefined }) }),
    }),
  };
}
// document lookup: selectFrom('documents').select([...]).where('id',=,d).where('thread_id',=,t).executeTakeFirst()
function docFound(storagePath = 'u/t/d.pdf') {
  return {
    select: () => ({
      where: () => ({
        where: () => ({ executeTakeFirst: async () => ({ id: 'd', storage_path: storagePath }) }),
      }),
    }),
  };
}
function docMissing() {
  return {
    select: () => ({
      where: () => ({ where: () => ({ executeTakeFirst: async () => undefined }) }),
    }),
  };
}

function deleteBuilder(executeSpy: ReturnType<typeof vi.fn>) {
  return { where: () => ({ where: () => ({ execute: executeSpy }) }) };
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: 'u' } } });
});
afterEach(() => vi.clearAllMocks());

describe('DELETE /api/threads/[id]/documents/[documentId]', () => {
  it('401 when unauthenticated', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(401);
  });

  it('404 when thread is not owned', async () => {
    dbMock.selectFrom.mockReturnValueOnce(ownedFalse());
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('404 when document is not in thread', async () => {
    dbMock.selectFrom
      .mockReturnValueOnce(ownedTrue()) // ensureOwned
      .mockReturnValueOnce(docMissing()); // document lookup
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('204 on happy path; deletes blob then row', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    dbMock.selectFrom.mockReturnValueOnce(ownedTrue()).mockReturnValueOnce(docFound('u/t/d.pdf'));
    dbMock.deleteFrom.mockReturnValueOnce(deleteBuilder(execute));

    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith('u/t/d.pdf');
    expect(execute).toHaveBeenCalledTimes(1);
    // Blob delete is attempted before the row delete.
    // Both mocks were called (asserted above), so invocationCallOrder[0] is defined.
    // biome-ignore lint/style/noNonNullAssertion: invocationCallOrder is non-empty after a confirmed call
    expect(del.mock.invocationCallOrder[0]!).toBeLessThan(
      // biome-ignore lint/style/noNonNullAssertion: same as above
      execute.mock.invocationCallOrder[0]!,
    );
  });

  it('still 204 when blob delete fails; row delete still runs', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    dbMock.selectFrom.mockReturnValueOnce(ownedTrue()).mockReturnValueOnce(docFound('u/t/d.pdf'));
    dbMock.deleteFrom.mockReturnValueOnce(deleteBuilder(execute));
    del.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(204);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
