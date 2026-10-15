import { AwsClient } from 'aws4fetch';
import { AppError } from '@flowza/shared';
import type { Mailer } from '../deps.js';

/**
 * Amazon SES (API v2) as the worker's mailer — EMAIL_PROVIDER=ses.
 *
 * Why SES: one provider for every FlowZa product, in the launch region, paid per message (about USD 0.10 per 1,000).
 * FlowZa Sign moved to it on 2026-09-15 (its ADR 0189) and FlowZa Club followed (Club's `_shared/email/ses.ts`); this sends
 * the same way, from the same AWS account. Time keeps its own sending domain (`time.flowza.ai`, go-live §5c) and gets its
 * own configuration set and IAM key, so rotating another product's key never stops Time's mail and the other way round.
 *
 * HTTPS, signed with SigV4 by aws4fetch (the library Sign and Club trust with the same job), but sent with a plain fetch:
 * AwsClient.fetch retries a 5xx up to ten times on its own, and the job queue already retries a failed send with backoff.
 * Two retry loops stacked would mail one invitation several times. SES takes no idempotency key, so a send that times out
 * after SES accepted it can still be delivered twice when the queue retries it; that is the same exposure as before.
 *
 * Bounces and complaints: SES's account-level suppression list refuses a hard-bounced or complaining address on its own.
 * Delivery events are not wired to the e-mail log yet (the log's webhook is Resend's), so with SES a message reads *sent*.
 */

/** Variables that must all be set for EMAIL_PROVIDER=ses. The sender is EMAIL_FROM, shared with Resend. */
export const SES_REQUIRED = ['SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_REGION'] as const;

const REQUEST_TIMEOUT_MS = 15_000;

/** SES error types a retry can fix: the account's send rate (14 a second) or daily quota. Every other 4xx is permanent. */
const RETRYABLE_SES_ERRORS: ReadonlySet<string> = new Set(['TooManyRequestsException', 'LimitExceededException', 'ThrottlingException', 'Throttling']);

export interface SesSettings {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  from: string;
  configurationSet?: string;
}

type SesEnv = Partial<Record<(typeof SES_REQUIRED)[number] | 'SES_CONFIGURATION_SET' | 'EMAIL_FROM', string | undefined>>;

/** The SES settings, or why there are none: the variables still missing, or a region that is not one. */
export function sesSettings(env: SesEnv): { settings: SesSettings } | { problem: string } {
  const value = (k: keyof SesEnv) => env[k]?.trim() ?? '';
  const missing = [...SES_REQUIRED, 'EMAIL_FROM' as const].filter((k) => !value(k));
  if (missing.length) return { problem: `SES is not configured on this worker: set ${missing.join(', ')}` };
  const region = value('SES_REGION');
  // A residency label ("in") or a zone ("ap-south-1a") in place of a region signs for a region that does not exist, and
  // every send answers 403. Name the mistake instead.
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return { problem: `SES_REGION must be an AWS region such as ap-south-1, not "${region.slice(0, 40)}"` };
  return {
    settings: {
      accessKeyId: value('SES_ACCESS_KEY_ID'),
      secretAccessKey: value('SES_SECRET_ACCESS_KEY'),
      region,
      from: value('EMAIL_FROM'),
      configurationSet: value('SES_CONFIGURATION_SET') || undefined,
    },
  };
}

type MailMessage = Parameters<Mailer['send']>[0];

/** The SendEmail request body: simple content, UTF-8 on every part (subjects and bodies carry Arabic). */
export function sesSendBody(msg: MailMessage, settings: Pick<SesSettings, 'from' | 'configurationSet'>): Record<string, unknown> {
  return {
    FromEmailAddress: settings.from,
    Destination: { ToAddresses: [msg.to] },
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: msg.html, Charset: 'UTF-8' },
          ...(msg.text ? { Text: { Data: msg.text, Charset: 'UTF-8' } } : {}),
        },
      },
    },
    ...(settings.configurationSet ? { ConfigurationSetName: settings.configurationSet } : {}),
  };
}

/** A refusal from SES as the error the invitation and the e-mail log show: SES's own words, never the key. */
export function sesFailure(status: number, errorType: string, message: string): AppError {
  const retryable = status >= 500 || status === 429 || RETRYABLE_SES_ERRORS.has(errorType);
  const reason = [errorType, message].filter(Boolean).join(': ').slice(0, 300) || 'no reason given';
  return new AppError('PROVIDER_ERROR', `email send failed: SES HTTP ${status} ${reason}`, { retryable, details: { mailer: 'ses', reason: errorType || `http_${status}` } });
}

export function createSesMailer(settings: SesSettings, fetchImpl: typeof fetch = fetch): Mailer {
  const signer = new AwsClient({ accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, region: settings.region, service: 'ses' });
  const url = `https://email.${settings.region}.amazonaws.com/v2/email/outbound-emails`;
  return {
    async send(msg) {
      const request = await signer.sign(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(sesSendBody(msg, settings)),
      });
      let res: Response;
      try {
        res = await fetchImpl(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        const name = (err as Error).name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new AppError('PROVIDER_TIMEOUT', 'email send failed: SES did not answer in time', { retryable: true, details: { mailer: 'ses' } });
        }
        throw new AppError('PROVIDER_ERROR', `email send failed: SES could not be reached (${String((err as Error).message).slice(0, 200)})`, { retryable: true, details: { mailer: 'ses', reason: 'network' } });
      }
      const text = await res.text().catch(() => '');
      let body: { MessageId?: unknown; message?: unknown; Message?: unknown } = {};
      try { body = JSON.parse(text) as typeof body; } catch { /* SES answers JSON; anything else is reported as its status */ }
      if (!res.ok) {
        // x-amzn-ErrorType names the problem (MessageRejected for a sender off the verified domain, AccessDenied for a key
        // whose policy does not cover the identity or configuration set, UnrecognizedClient for a rotated key); the body's
        // message says it in words.
        const errorType = (res.headers.get('x-amzn-ErrorType') ?? '').split(':')[0]!.trim();
        const message = typeof body.message === 'string' ? body.message : typeof body.Message === 'string' ? body.Message : '';
        throw sesFailure(res.status, errorType, message);
      }
      return { id: typeof body.MessageId === 'string' ? body.MessageId : null, provider: 'ses' };
    },
  };
}
