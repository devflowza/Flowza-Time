/**
 * The link an invitee opens to redeem an invitation.
 *
 * Handing an administrator a bare token is not a delivery mechanism — there is nowhere to paste it. Both places that
 * mint a token (a member invitation, and the owner invitation returned when a tenant is created) show this instead,
 * so onboarding works by sending the link even while outbound email is not configured.
 *
 * Built from the current origin rather than a configured base URL: the token is only ever displayed inside the app,
 * so the app's own origin is by definition the one the invitee should land on.
 */
export function invitationUrl(token: string): string {
  return `${window.location.origin}/auth/invite?token=${encodeURIComponent(token)}`;
}
