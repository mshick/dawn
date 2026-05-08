import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adminCreateUser = vi.fn();
const adminGenerateLink = vi.fn();
const verifyOtp = vi.fn();
const createAdminClient = vi.fn(() => ({
  auth: {
    admin: {
      createUser: adminCreateUser,
      generateLink: adminGenerateLink,
    },
  },
}));
const createServerClient = vi.fn(async () => ({
  auth: {
    verifyOtp,
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: createServerClient,
}));

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/dev/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dev/login', () => {
  const originalFlag = process.env.DEV_AUTH_ENABLED;

  beforeEach(() => {
    process.env.DEV_AUTH_ENABLED = '1';
    adminCreateUser.mockReset();
    adminGenerateLink.mockReset();
    verifyOtp.mockReset();
    createAdminClient.mockClear();
    createServerClient.mockClear();
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.DEV_AUTH_ENABLED;
    } else {
      process.env.DEV_AUTH_ENABLED = originalFlag;
    }
  });

  it('returns 404 and never touches Supabase when gate is off', async () => {
    delete process.env.DEV_AUTH_ENABLED;
    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('returns 400 when body fails validation', async () => {
    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it.each([
    ['//evil.com'],
    ['http://evil.com'],
    ['evil.com'],
    ['\\evil.com'],
  ])('returns 400 when next=%s is not a safe relative path', async (next) => {
    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com', next }));

    expect(res.status).toBe(400);
  });

  it('creates user, generates link, verifies otp, and returns next', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok-abc' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'alice@example.com', next: '/chat' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: '/chat' });

    expect(adminCreateUser).toHaveBeenCalledWith({
      email: 'alice@example.com',
      email_confirm: true,
    });
    expect(adminGenerateLink).toHaveBeenCalledWith({
      type: 'magiclink',
      email: 'alice@example.com',
    });
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    const verifyArg = verifyOtp.mock.calls[0]?.[0];
    expect(verifyArg).toMatchObject({ token_hash: 'tok-abc' });
  });

  it('defaults next to /chat when omitted', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'bob@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: '/chat' });
  });

  it('swallows "already registered" createUser error and still verifies', async () => {
    adminCreateUser.mockResolvedValue({
      data: { user: null },
      error: {
        message: 'A user with this email address has already been registered',
        code: 'user_already_exists',
        status: 422,
      },
    });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'existing@example.com' }));

    expect(res.status).toBe(200);
    expect(verifyOtp).toHaveBeenCalled();
  });

  it('swallows "already registered" via message regex when code is absent', async () => {
    adminCreateUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'User already exists', status: 422 },
    });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'msg@example.com' }));

    expect(res.status).toBe(200);
    expect(verifyOtp).toHaveBeenCalled();
  });

  it('returns 500 when createUser fails for an unrelated reason', async () => {
    adminCreateUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'boom', status: 500 },
    });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(500);
    expect(adminGenerateLink).not.toHaveBeenCalled();
  });

  it('returns 500 when generateLink fails', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: null,
      error: { message: 'link failed' },
    });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(500);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('returns 500 when verifyOtp fails', async () => {
    adminCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    adminGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'tok' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: null, error: { message: 'verify failed' } });

    const { POST } = await import('./route');

    const res = await POST(postRequest({ email: 'a@example.com' }));

    expect(res.status).toBe(500);
  });
});
