import type { StatementStatus } from '@flowza/contracts';

/** Badge tone per statement status, shared by the list and the detail page. */
export const STATUS_BADGE: Record<StatementStatus, 'secondary' | 'success' | 'warning' | 'danger'> = {
  ISSUED: 'secondary',
  PENDING_APPROVAL: 'warning',
  FINALIZED: 'success',
  VOID: 'danger',
};
