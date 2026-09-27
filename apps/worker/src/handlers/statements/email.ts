/**
 * The monthly statement email: one clear call to action (open the review link), in the organisation's locale.
 * Inline styles only (email clients), every dynamic value escaped, and a plain-text alternative for filters and
 * screen readers. The link is the credential — the copy says not to forward it.
 */
export interface StatementEmailInput {
  locale: 'en' | 'ar';
  company: string;
  employeeName: string;
  periodLabel: string;
  link: string;
}

const COPY = {
  en: {
    subject: (company: string, period: string) => `${company} — your attendance statement for ${period}`,
    greeting: (name: string) => `Dear ${name},`,
    body: (period: string) =>
      `Your attendance statement for ${period} is ready. Please review your sign-in and sign-out times, add a comment on any day that does not look right, and sign the statement to confirm it.`,
    button: 'Review & sign your statement',
    note: 'This link is personal — please do not forward this email. If a time looks wrong, add a comment on that day and your reporting manager will review it.',
    footer: (company: string) => `Sent by ${company} via FlowZa Time.`,
  },
  ar: {
    subject: (company: string, period: string) => `${company} — كشف الحضور لشهر ${period}`,
    greeting: (name: string) => `عزيزي/عزيزتي ${name}،`,
    body: (period: string) =>
      `كشف الحضور الخاص بك لشهر ${period} جاهز. يرجى مراجعة أوقات تسجيل الدخول والخروج، وإضافة تعليق على أي يوم يبدو غير صحيح، ثم التوقيع لتأكيد الكشف.`,
    button: 'مراجعة الكشف والتوقيع',
    note: 'هذا الرابط شخصي — يرجى عدم إعادة توجيه هذه الرسالة. إذا بدا لك وقت غير صحيح، أضف تعليقاً على ذلك اليوم وسيراجعه مديرك المباشر.',
    footer: (company: string) => `أُرسلت بواسطة ${company} عبر FlowZa Time.`,
  },
} as const;

export function statementEmail(input: StatementEmailInput): { subject: string; html: string; text: string } {
  const t = COPY[input.locale];
  const dir = input.locale === 'ar' ? 'rtl' : 'ltr';
  const company = escapeHtml(input.company);
  const subject = t.subject(input.company, input.periodLabel);
  const html = `<!doctype html>
<html dir="${dir}" lang="${input.locale}">
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Segoe UI,Tahoma,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;">
      <div style="background:#101828;padding:20px 28px;">
        <p style="margin:0;color:#ffffff;font-size:16px;font-weight:600;">${company}</p>
      </div>
      <div style="padding:28px;direction:${dir};text-align:${dir === 'rtl' ? 'right' : 'left'};">
        <p style="margin:0 0 14px;color:#101828;font-size:15px;">${escapeHtml(t.greeting(input.employeeName))}</p>
        <p style="margin:0 0 22px;color:#475467;font-size:14px;line-height:1.65;">${escapeHtml(t.body(input.periodLabel))}</p>
        <p style="margin:0 0 26px;text-align:center;">
          <a href="${escapeAttr(input.link)}" style="display:inline-block;background:#175cd3;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 26px;border-radius:8px;">${escapeHtml(t.button)}</a>
        </p>
        <p style="margin:0 0 6px;color:#98a2b3;font-size:12px;line-height:1.6;">${escapeHtml(t.note)}</p>
      </div>
    </div>
    <p style="margin:14px 4px 0;color:#98a2b3;font-size:11px;text-align:center;">${escapeHtml(t.footer(input.company))}</p>
  </div>
</body>
</html>`;
  const text = `${t.greeting(input.employeeName)}\n\n${t.body(input.periodLabel)}\n\n${t.button}: ${input.link}\n\n${t.note}\n${t.footer(input.company)}`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** URL in an href: escape quotes/ampersands; the URL itself is worker-built, never user input. */
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
