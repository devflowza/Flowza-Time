import { afterEach, describe, expect, it } from 'vitest';
import { captureAuthCallback, parseAuthCallback, resetAuthCallbackForTests, takeAuthLinkErrorAtLoad, withoutAuthLinkError } from './auth-callback';

const at = (path: string) => { const u = new URL(path, 'https://time.flowza.ai'); return { pathname: u.pathname, search: u.search, hash: u.hash }; };

describe('parseAuthCallback', () => {
  it('reads a token-hash reset link (the e-mail template of docs/go-live.md §5a)', () => {
    expect(parseAuthCallback(at('/auth/reset?token_hash=pkce_abc&type=recovery'))).toEqual({ pathname: '/auth/reset', type: 'recovery', tokenHash: 'pkce_abc', code: null, error: null });
  });

  it('reads a PKCE link', () => {
    expect(parseAuthCallback(at('/auth/reset?code=1f2e'))).toMatchObject({ code: '1f2e', tokenHash: null, error: null });
  });

  it("reads Supabase's error from the query string (PKCE) and from the fragment (implicit)", () => {
    const expired = { code: 'otp_expired', description: 'Email link is invalid or has expired' };
    expect(parseAuthCallback(at('/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')).error).toEqual(expired);
    expect(parseAuthCallback(at('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')).error).toEqual(expired);
    // an error without a code still counts
    expect(parseAuthCallback(at('/?error=access_denied')).error).toEqual({ code: 'access_denied', description: '' });
  });

  it('reads the recovery type an implicit link carries in the fragment', () => {
    expect(parseAuthCallback(at('/#access_token=x&type=recovery')).type).toBe('recovery');
  });

  it('carries nothing for an ordinary page or a route anchor', () => {
    expect(parseAuthCallback(at('/employees?page=2#top'))).toEqual({ pathname: '/employees', type: null, tokenHash: null, code: null, error: null });
  });
});

describe('withoutAuthLinkError', () => {
  it('drops only the error parameters, from both places', () => {
    expect(withoutAuthLinkError({ search: '?tab=raw&error=access_denied&error_code=otp_expired', hash: '#error_description=x' })).toEqual({ search: '?tab=raw', hash: '' });
    expect(withoutAuthLinkError({ search: '?error=a', hash: '#section' })).toEqual({ search: '', hash: '#section' });
  });

  it('answers null when there is nothing to drop', () => {
    expect(withoutAuthLinkError({ search: '?tab=raw', hash: '#top' })).toBeNull();
  });
});

describe('captureAuthCallback', () => {
  afterEach(() => { resetAuthCallbackForTests(); window.history.replaceState(null, '', '/'); });

  it('reads the link once, takes the error out of the address bar, and hands the error out once', () => {
    window.history.replaceState(null, '', '/?error=access_denied&error_code=otp_expired&error_description=gone');
    expect(captureAuthCallback().error).toEqual({ code: 'otp_expired', description: 'gone' });
    expect(window.location.search).toBe('');
    expect(takeAuthLinkErrorAtLoad()).toEqual({ code: 'otp_expired', description: 'gone' });
    expect(takeAuthLinkErrorAtLoad()).toBeNull();
  });

  it('leaves the error on the reset page, which explains it in place', () => {
    window.history.replaceState(null, '', '/auth/reset?error=access_denied&error_code=otp_expired');
    captureAuthCallback();
    expect(window.location.search).toBe('?error=access_denied&error_code=otp_expired');
  });
});
