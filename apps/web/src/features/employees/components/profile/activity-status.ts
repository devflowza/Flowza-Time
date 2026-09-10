/** Badge tone per attendance status, shared by the profile's attendance and activity tabs. */
export const STATUS_TONE: Record<string, 'success' | 'danger' | 'info' | 'neutral' | 'warning'> = {
  PRESENT: 'success', ABSENT: 'danger', LEAVE: 'info', HOLIDAY: 'neutral', WEEKLY_OFF: 'neutral', HALF_DAY: 'warning',
  MISSING_PUNCH: 'warning', PENDING: 'neutral', NOT_JOINED: 'neutral', EXITED: 'neutral',
};
