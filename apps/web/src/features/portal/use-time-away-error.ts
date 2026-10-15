import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { fmtMinutes } from '@/lib/format';
import { toast } from '@/lib/toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { PA_NS } from './attendance-i18n';
import { timeAwayRefusal } from './time-away-model';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * A refused time-away write in the employee's words (quota, policy, sequence — `details.reason`), with the API's figures;
 * anything else as the API said it (a locked period explained).
 */
export function useTimeAwayErrorToast() {
  const { t } = useTranslation(PA_NS);
  return (e: unknown) => {
    const reason = timeAwayRefusal(e);
    if (!reason) { toastMutationError(e); return; }
    const d = e instanceof ApiError ? e.details ?? {} : {};
    toast.error(t(`timeAway.errors.${reason}`, { used: fmtMinutes(num(d['usedMinutes'])), quota: fmtMinutes(num(d['quotaMinutes'])), max: fmtMinutes(num(d['maxMinutes'])) }));
  };
}
