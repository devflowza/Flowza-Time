import { z } from 'zod';
import { INVITATION_EMAIL_JOB_TYPE, uuidSchema } from '@flowza/contracts';
import { withContext, writeAudit } from '@flowza/database';
import { event, randomToken, sha256Hex } from '@flowza/shared';
import type { HandlerRegistry, JobContext } from '../types.js';
import { parsePayload } from '../attendance/common.js';

/**
 * SEND_INVITATION_EMAIL (HR portal Prompt 6b, Finance B-68): e-mails one open invitation. The token in the e-mail is minted
 * HERE, at send time, and only its sha256 is stored (`invitations.delivery_token_hash`) — the plain token exists in the
 * e-mail and nowhere else, like the approval one-click links; nothing secret travels in the job payload. The hash is written
 * in the same transaction that sends: a send that throws rolls it back and the retry mints a fresh token. An invitation that
 * was accepted, revoked or has expired by the time the job runs is not sent.
 */
export const invitationEmailPayloadSchema = z.object({ organizationId: uuidSchema, invitationId: uuidSchema });

interface InvitationMail { locale: string; orgName: string; inviterName: string | null; employeeName: string | null; link: string; expiresAt: Date }

function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c); }

/** The invitation e-mail in the organisation's language (English / Arabic). */
export function invitationEmail(m: InvitationMail): { subject: string; html: string; text: string } {
  const date = m.expiresAt.toISOString().slice(0, 10);
  const ar = m.locale.toLowerCase().startsWith('ar');
  const who = m.inviterName ? (ar ? `${m.inviterName} يدعوك` : `${m.inviterName} invited you`) : (ar ? 'تمت دعوتك' : 'You have been invited');
  const subject = ar ? `دعوة للانضمام إلى ${m.orgName} على FlowZa Time` : `You're invited to ${m.orgName} on FlowZa Time`;
  const lead = ar ? `${who} للانضمام إلى ${m.orgName} على FlowZa Time${m.employeeName ? ` (${m.employeeName})` : ''}.` : `${who} to join ${m.orgName} on FlowZa Time${m.employeeName ? ` as ${m.employeeName}` : ''}.`;
  const cta = ar ? 'قبول الدعوة' : 'Accept the invitation';
  const note = ar ? `ينتهي الرابط في ${date} ويعمل مرة واحدة. سجّل الدخول بهذا البريد الإلكتروني نفسه.` : `The link expires on ${date} and works once. Sign in with this same e-mail address.`;
  const dir = ar ? ' dir="rtl"' : '';
  const html = `<div${dir}><p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(m.link)}">${escapeHtml(cta)}</a></p><p style="color:#667085;font-size:12px">${escapeHtml(note)}</p></div>`;
  const text = `${lead}\n\n${cta}: ${m.link}\n\n${note}\n`;
  return { subject, html, text };
}

export async function sendInvitationEmail({ job, deps, log }: JobContext) {
  const p = parsePayload(invitationEmailPayloadSchema, job.payload);
  return withContext(deps.db, { kind: 'system', organizationId: p.organizationId, jobId: job.id }, async (trx) => {
    const inv = await trx.selectFrom('invitations as i').innerJoin('organizations as o', 'o.id', 'i.organizationId')
      .leftJoin('userProfiles as u', 'u.id', 'i.invitedBy').leftJoin('employees as e', 'e.id', 'i.employeeId')
      .select(['i.id', 'i.email', 'i.expiresAt', 'i.acceptedAt', 'i.revokedAt', 'o.displayName as orgName', 'o.locale', 'u.fullName as inviterName', 'e.displayName as employeeName'])
      .where('i.organizationId', '=', p.organizationId).where('i.id', '=', p.invitationId).executeTakeFirst();
    const now = deps.now();
    const skip = !inv ? 'not_found' : inv.acceptedAt ? 'accepted' : inv.revokedAt ? 'revoked' : inv.expiresAt.getTime() <= now.getTime() ? 'expired' : null;
    if (skip || !inv) {
      log.info(event('invitation_email_skipped', { organizationId: p.organizationId, invitationId: p.invitationId, reason: skip }));
      return { sent: false, reason: skip };
    }
    const secret = randomToken(32);
    const updated = await trx.updateTable('invitations').set({ deliveryTokenHash: sha256Hex(secret), deliverySentAt: now })
      .where('organizationId', '=', p.organizationId).where('id', '=', inv.id).where('acceptedAt', 'is', null).where('revokedAt', 'is', null).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) return { sent: false, reason: 'closed' };
    const link = `${deps.config.WEB_PUBLIC_URL}/auth/invite?token=${encodeURIComponent(`${p.organizationId}.${secret}`)}`;
    const mail = invitationEmail({ locale: inv.locale, orgName: inv.orgName, inviterName: inv.inviterName?.trim() || null, employeeName: inv.employeeName, link, expiresAt: inv.expiresAt });
    const res = await deps.mailer.send({ to: inv.email, subject: mail.subject, html: mail.html, text: mail.text });
    // the address is already on the invitation row; the audit records the delivery, never the token
    await writeAudit(trx, { organizationId: p.organizationId, actorUserId: null, action: 'member.invitation_emailed', entityType: 'invitation', entityId: inv.id, newValue: { provider: res.provider, messageId: res.id }, jobId: job.id });
    log.info(event('invitation_emailed', { organizationId: p.organizationId, invitationId: inv.id, provider: res.provider }));
    return { sent: true };
  });
}

export function registerMemberHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: INVITATION_EMAIL_JOB_TYPE, handler: sendInvitationEmail, timeoutMs: 60_000 });
}
