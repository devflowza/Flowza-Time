import { useTranslation } from 'react-i18next';
import type { EmailMessageDto } from '@flowza/contracts';

/** True for a message the `console` mailer "sent": it never left the server (no e-mail provider configured on the worker). */
export function neverLeftServer(m: Pick<EmailMessageDto, 'status' | 'provider'>): boolean {
  return m.provider === 'console' && m.status === 'sent';
}

/** A skip reason code (worker / trigger) in words, or the text as it came (a provider's own message). */
export function useReasonText() {
  const { t } = useTranslation('email-log');
  // only a code is a key: a provider's sentence carries '.' and ':' (i18next's key and namespace separators)
  return (reason: string | null | undefined): string | null => (!reason ? null : /^[a-z_]+$/.test(reason) ? t(`reasons.${reason}`, { defaultValue: reason }) : reason);
}
