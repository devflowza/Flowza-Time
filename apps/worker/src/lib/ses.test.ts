import { describe, expect, it, vi } from 'vitest';
import { createSesMailer, sesSendBody, sesSettings, type SesSettings } from './ses.js';
import { deliveryErrorText } from '../handlers/members/index.js';

const settings: SesSettings = {
  accessKeyId: 'AKIAEXAMPLEKEY000000',
  secretAccessKey: 'secret/example/key/never/sent/0000000000',
  region: 'ap-south-1',
  from: 'FlowZa Time <no-reply@time.flowza.ai>',
  configurationSet: 'flowza-time-transactional',
};
const msg = { to: 'owner@example.com', subject: 'دعوة إلى FlowZa Time', html: '<p>Hi</p>', text: 'Hi' };

/** A fetch that records the signed request and answers with the given status, error type and JSON body. */
function fakeFetch(status: number, body: unknown, errorType?: string) {
  const seen: Request[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    seen.push(input as Request);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (errorType) headers.set('x-amzn-ErrorType', `${errorType}:http://internal.amazon.com/coral/com.amazonaws.sesv2/`);
    return new Response(JSON.stringify(body), { status, headers });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}

describe('sesSettings', () => {
  it('names every variable still missing, so a half-configured SES says what to set', () => {
    expect(sesSettings({ SES_REGION: 'ap-south-1', EMAIL_FROM: 'a@b.c', SES_ACCESS_KEY_ID: '  ' })).toEqual({
      problem: 'SES is not configured on this worker: set SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY',
    });
  });

  it('refuses a region that is not one (a zone or a residency label signs for nowhere and every send answers 403)', () => {
    for (const region of ['ap-south-1a', 'in', 'Mumbai']) {
      const r = sesSettings({ SES_ACCESS_KEY_ID: 'k', SES_SECRET_ACCESS_KEY: 's', SES_REGION: region, EMAIL_FROM: 'a@b.c' });
      expect(r).toMatchObject({ problem: expect.stringContaining('SES_REGION must be an AWS region') });
    }
  });

  it('trims the values and leaves the configuration set out when it is empty', () => {
    expect(sesSettings({ SES_ACCESS_KEY_ID: ' k ', SES_SECRET_ACCESS_KEY: 's', SES_REGION: 'ap-south-1', EMAIL_FROM: 'a@b.c', SES_CONFIGURATION_SET: '' }))
      .toEqual({ settings: { accessKeyId: 'k', secretAccessKey: 's', region: 'ap-south-1', from: 'a@b.c', configurationSet: undefined } });
  });
});

describe('sesSendBody', () => {
  it('sends UTF-8 simple content and omits the text part and the configuration set when there are none', () => {
    const body = sesSendBody({ to: 'x@example.com', subject: 's', html: '<b>h</b>' }, { from: 'f@time.flowza.ai' });
    expect(body).toEqual({
      FromEmailAddress: 'f@time.flowza.ai',
      Destination: { ToAddresses: ['x@example.com'] },
      Content: { Simple: { Subject: { Data: 's', Charset: 'UTF-8' }, Body: { Html: { Data: '<b>h</b>', Charset: 'UTF-8' } } } },
    });
  });
});

describe('createSesMailer', () => {
  it('posts a SigV4-signed SendEmail to the region and returns SES’s message id', async () => {
    const { impl, seen } = fakeFetch(200, { MessageId: '0109019a-ses-message-id' });
    const res = await createSesMailer(settings, impl).send(msg);
    expect(res).toEqual({ id: '0109019a-ses-message-id', provider: 'ses' });

    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails');
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY000000\/\d{8}\/ap-south-1\/ses\/aws4_request, SignedHeaders=[^,]*host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(req.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    const body = JSON.parse(await req.text()) as Record<string, unknown>;
    expect(body).toMatchObject({ FromEmailAddress: settings.from, Destination: { ToAddresses: ['owner@example.com'] }, ConfigurationSetName: 'flowza-time-transactional' });
    expect(JSON.stringify(body)).not.toContain(settings.secretAccessKey);
  });

  it('fails at once on a refusal no retry can fix, in SES’s own words, which the invitation shows', async () => {
    const { impl } = fakeFetch(400, { message: 'Email address is not verified. The following identities failed the check in region AP-SOUTH-1: no-reply@flowza.example' }, 'MessageRejected');
    const err = await createSesMailer(settings, impl).send(msg).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false, details: { mailer: 'ses', reason: 'MessageRejected' } });
    expect(deliveryErrorText(err)).toBe('email send failed: SES HTTP 400 MessageRejected: Email address is not verified. The following identities failed the check in region AP-SOUTH-1: no-reply@flowza.example');
  });

  it('treats a key SES does not accept as permanent (a rotated or wrong key fails the same way every time)', async () => {
    const { impl } = fakeFetch(403, { message: 'The security token included in the request is invalid.' }, 'UnrecognizedClientException');
    await expect(createSesMailer(settings, impl).send(msg)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: false, message: expect.stringContaining('UnrecognizedClientException') });
  });

  it('retries throttling and SES’s own failures', async () => {
    for (const [status, type] of [[429, 'TooManyRequestsException'], [400, 'LimitExceededException'], [500, 'InternalFailure'], [503, '']] as const) {
      const { impl } = fakeFetch(status, { message: 'try again' }, type || undefined);
      await expect(createSesMailer(settings, impl).send(msg)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    }
  });

  it('retries a network failure and reports a timeout as the provider not answering', async () => {
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(createSesMailer(settings, down).send(msg)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true, message: expect.stringContaining('could not be reached') });

    const slow = vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as unknown as typeof fetch;
    const err = await createSesMailer(settings, slow).send(msg).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true });
    expect(deliveryErrorText(err)).toBe('The e-mail provider did not answer in time.');
  });
});
