import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { BulkEmployeeAction, EmploymentStatus } from '@flowza/contracts';
import { ApiError } from '@/lib/api-client';
import { useLocalName } from '@/lib/local-name';
import { toast, toastError } from '@/lib/toast';
import { useOrgId } from '@/features/me/use-me';
import { useEmployeeMutations } from '../api';
import { cachedPeople } from './api';

export type AssignManagerInput = Omit<Extract<BulkEmployeeAction, { action: 'assign_manager' }>, 'action'>;

/** Employees who left are not on the chart and cannot be anybody's manager (the API refuses them too). */
export const LEFT_EMPLOYMENT: readonly EmploymentStatus[] = ['terminated', 'resigned'];

/** Why somebody in the request was left as they were (the API changes only the employees whose line actually moves). */
export type UnchangedReason = 'already' | 'alreadySecondary' | 'noManager' | 'noSecondary';
export function unchangedReason(input: Pick<AssignManagerInput, 'managerEmployeeId' | 'line'>): UnchangedReason {
  const secondary = input.line === 'secondary';
  if (input.managerEmployeeId === null) return secondary ? 'noSecondary' : 'noManager';
  // the dotted line is also left alone for anyone whose line manager already is that person (the API skips them)
  return secondary ? 'alreadySecondary' : 'already';
}

/**
 * The employees a "reporting cycle" refusal names (400 VALIDATION_ERROR, issue on `managerEmployeeId`, `details.employeeIds`),
 * or null for any other error. A change dated before a joining date or an open employment record also names employees in
 * `details.employeeIds` (its issue is on `effectiveFrom`); that one keeps the server's message, which gives their numbers and dates.
 */
export function cycleEmployeeIds(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return null;
  const issues = err.details?.['issues'];
  const onManager = Array.isArray(issues) && issues.some((i: unknown) => typeof i === 'object' && i !== null && (i as { path?: unknown }).path === 'managerEmployeeId');
  if (!onManager) return null;
  const ids = err.details?.['employeeIds'];
  if (!Array.isArray(ids)) return null;
  const named = ids.filter((id): id is string => typeof id === 'string');
  return named.length ? named : null;
}

function listFormat(lng: string | undefined, items: string[]): string {
  try { return new Intl.ListFormat(lng, { style: 'long', type: 'conjunction' }).format(items); } catch { return items.join(', '); }
}

/**
 * The one write behind every reporting-line edit (bulk dialog, card and row menus, add reports, drag-and-drop): the synchronous
 * `assign_manager` bulk action. The employees and org chart queries refresh on success (useEmployeeMutations). The toast says
 * how many changed and why the others were left as they were; a refusal because the line would go round in a circle names the
 * selected people the manager already reports to, in the reader's language, so HR knows whom to take out of the selection.
 */
export function useAssignManager() {
  const { t, i18n } = useTranslation('employees');
  const qc = useQueryClient();
  const orgId = useOrgId();
  const localName = useLocalName();
  const { bulk } = useEmployeeMutations();

  const onCycle = (ids: string[]) => {
    const people = cachedPeople(qc, orgId);
    const names = ids.map((id) => { const p = people.get(id); return p ? localName(p.displayName, p.displayNameAr) : id; });
    toast.error(t('assignManager.cycleTitle'), { description: t('assignManager.cycle', { names: listFormat(i18n.resolvedLanguage ?? i18n.language, names) }) });
  };

  const assign = (input: AssignManagerInput, onDone?: () => void) =>
    bulk.mutate({ action: 'assign_manager', ...input }, {
      onSuccess: (res) => {
        const requested = new Set(input.employeeIds).size;
        const updated = res.kind === 'sync' ? res.updated : requested;
        const why = t(`assignManager.why.${unchangedReason(input)}`);
        if (updated === 0) toast.info(t('assignManager.noChanges'), { description: why });
        else if (updated < requested) toast.success(t('bulk.updated', { count: updated }), { description: `${t('assignManager.unchanged', { count: requested - updated })} ${why}` });
        else toast.success(t('bulk.updated', { count: updated }));
        onDone?.();
      },
      onError: (err) => {
        const loops = cycleEmployeeIds(err);
        if (loops) onCycle(loops);
        else toastError(err);
      },
    });
  return { assign, isPending: bulk.isPending };
}
