import { toast } from '@/lib/toast';

/**
 * The toast of a holiday / calendar change: what was saved and — when the API queued a recalculation of past days (a queue
 * job id, AGENTS.md "Job ids are not interchangeable") — a "View" action to the page that follows it, never `/sync/<id>`.
 */
export function toastHolidaySaved(title: string, recalculationJobId: string | null | undefined, navigate: (to: string) => void, labels: { description: string; view: string }): void {
  if (!recalculationJobId) { toast.success(title); return; }
  toast.success(title, { description: labels.description, action: { label: labels.view, onClick: () => navigate('/attendance?tab=recalc') } });
}
