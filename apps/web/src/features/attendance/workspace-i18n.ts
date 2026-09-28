import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance-workspace.json';
import ar from '@/locales/ar/attendance-workspace.json';
import attendanceEn from '@/locales/en/attendance.json';
import attendanceAr from '@/locales/ar/attendance.json';

/**
 * The HR attendance workspace strings (HR portal Prompt 6a). Imported for its side effect by every component that reads the
 * `attendanceWorkspace` namespace, so a component renders translated wherever it is mounted (the employee profile, a test)
 * without depending on the attendance routes having been imported first. Registration is idempotent.
 */
registerNamespace('attendanceWorkspace', en, ar);
registerNamespace('attendance', attendanceEn, attendanceAr);

export const ATTENDANCE_WORKSPACE_NS = 'attendanceWorkspace';
