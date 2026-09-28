import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { MessageCircleQuestion } from 'lucide-react';
import { ATTENDANCE_NOTE_CATEGORIES, type AttendanceNoteCategory, type AttendanceNoteDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { PA_NS } from '../attendance-i18n';
import { useNoteMutations } from '../attendance-api';

/**
 * Explain a day ("Add a reason"): a category and a few words, reviewed like a request by the line manager (or HR). The same
 * dialog edits a note still waiting for review and answers a reviewer's question (the note returns to review). With no
 * `date` the employee picks the day.
 */
export function NoteDialog({ open, onOpenChange, date, note, defaultCategory, maxDate }: {
  open: boolean; onOpenChange: (o: boolean) => void; date?: string | null; note?: AttendanceNoteDto | null; defaultCategory?: AttendanceNoteCategory; maxDate?: string;
}) {
  const { t } = useTranslation(PA_NS);
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const { create, update } = useNoteMutations();
  const [day, setDay] = useState(date ?? note?.attendanceDate ?? '');
  const [category, setCategory] = useState<AttendanceNoteCategory>(note?.category ?? defaultCategory ?? 'other');
  const [text, setText] = useState(note?.note ?? '');
  const [touched, setTouched] = useState(false);
  const editing = !!note;
  const answering = note?.status === 'info_requested';
  const tooShort = text.trim().length < 3;
  const missingDay = !editing && !day;
  const pending = create.isPending || update.isPending;

  const submit = () => {
    setTouched(true);
    if (tooShort || missingDay) return;
    const done = (key: string) => { toast.success(t(key)); onOpenChange(false); };
    if (note) {
      update.mutate({ id: note.id, input: { category, note: text.trim() } }, { onSuccess: () => done(answering ? 'notes.resubmitted' : 'notes.updated'), onError: (e) => toastMutationError(e, (to) => void navigate(to)) });
    } else {
      create.mutate({ date: day, category, note: text.trim() }, { onSuccess: () => done('notes.submitted'), onError: (e) => toastMutationError(e, (to) => void navigate(to)) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{answering ? t('notes.respond') : editing ? t('notes.edit') : t('notes.title')}</DialogTitle>
          <DialogDescription>{t('notes.hint')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {answering && note?.infoRequestMessage ? (
            <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-100" data-testid="note-question">
              <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>{t('notes.question', { question: note.infoRequestMessage })}</p>
            </div>
          ) : null}
          {editing || date ? (
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm"><span className="text-muted-foreground">{t('notes.date')}:</span> <span className="font-medium tnum">{fmtDate(day, 'EEEE, dd MMM yyyy')}</span></p>
          ) : (
            <FormField label={t('notes.date')} htmlFor="note-date" required error={touched && missingDay ? t('notes.dateRequired') : undefined}>
              <Input id="note-date" type="date" value={day} max={maxDate} onChange={(e) => setDay(e.target.value)} className="tnum" />
            </FormField>
          )}
          <FormField label={t('notes.category')} htmlFor="note-category" required>
            <Select value={category} onValueChange={(v) => setCategory(v as AttendanceNoteCategory)}>
              <SelectTrigger id="note-category"><SelectValue /></SelectTrigger>
              <SelectContent>{ATTENDANCE_NOTE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{t(`notes.categories.${c}`)}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <FormField label={t('notes.note')} htmlFor="note-text" required hint={t('notes.noteHint')} error={touched && tooShort ? t('notes.noteTooShort') : undefined}>
            <Textarea id="note-text" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={touched && tooShort ? true : undefined} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={pending}>{answering ? t('notes.sendAnswer') : editing ? t('notes.save') : t('notes.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
