/**
 * Approval engine v2 (multilevel, Finance parity). Pure resolution/evaluation lives in `@flowza/domain` (approvals/);
 * this folder is the IO: routing at submit, decisions under FOR UPDATE, cancel / invalidate / reassign / ask-for-info,
 * delegations, one-click e-mail tokens, the unified inbox and the entity hooks that apply an outcome to its document.
 *
 * Entities plug in through `hooks/` (`entityHooks[entityType]`): corrections and leave today; the others in the
 * `approval_entity` enum route and decide but apply nothing until their hook exists (their requests are still visible,
 * decidable and audited).
 */
export * from './engine.js';
export * from './queries.js';
export * from './workflows.js';
export * from './delegations.js';
export * from './email-tokens.js';
export { entityHooks, hookFor, approvePermissionFor, approvePermissionsFor, holdsApprovePermission, viewPermissionFor, type EntityHook, type HookContext } from './hooks/index.js';
export { leaveUnits, leaveWorkingCalendar } from './hooks/leave.js';
export { hydrateRequests } from './dto.js';
