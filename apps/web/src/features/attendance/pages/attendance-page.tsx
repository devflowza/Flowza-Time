import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { Calculator, ClipboardPlus } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useCan } from '@/features/me/use-me';
import { CorrectionDialog } from '@/features/corrections/components/correction-dialog';
import { DailyView } from '../components/daily-view';
import { MonthlyView } from '../components/monthly-view';
import { RawTransactionsTab } from '../components/raw-transactions-tab';
import { RecalculationsTab } from '../components/recalculations-tab';
import { PeriodLocksTab } from '../components/period-locks-tab';
import { RecalculateDialog } from '../components/recalculate-dialog';
import type { CorrectionPreset } from '../components/record-dialog';

const TABS = ['daily', 'monthly', 'raw', 'recalc', 'periods'] as const;
type Tab = (typeof TABS)[number];

/** /attendance?tab=daily|monthly|raw|recalc|periods — filters live in the same URL (shareable views). */
export default function AttendancePage() {
  const { t } = useTranslation('attendance');
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') ?? (params.get('employeeId') ? 'monthly' : 'daily');
  const visible = TABS.filter((tb) => (tb === 'raw' ? can('attendance.view_raw') : true));
  const tab: Tab = (visible as readonly string[]).includes(requested) ? (requested as Tab) : 'daily';
  const [correction, setCorrection] = useState<{ open: boolean; preset?: CorrectionPreset }>({ open: false });
  const [recalcOpen, setRecalcOpen] = useState(false);
  const setTab = (v: string) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('tab', v); n.delete('page'); return n; });
  const requestCorrection = (preset?: CorrectionPreset) => setCorrection({ open: true, preset });

  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} actions={
        <>
          {can('attendance.recalculate') ? <Button variant="outline" size="sm" onClick={() => setRecalcOpen(true)}><Calculator /> {t('recalc.title')}</Button> : null}
          {can('attendance.correct') ? <Button size="sm" onClick={() => requestCorrection()}><ClipboardPlus /> {t('record.requestCorrection')}</Button> : null}
        </>
      } />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {visible.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="daily">{tab === 'daily' ? <DailyView onRequestCorrection={can('attendance.correct') ? requestCorrection : undefined} /> : null}</TabsContent>
        <TabsContent value="monthly">{tab === 'monthly' ? <MonthlyView onRequestCorrection={can('attendance.correct') ? requestCorrection : undefined} /> : null}</TabsContent>
        <TabsContent value="raw">{tab === 'raw' ? <RawTransactionsTab /> : null}</TabsContent>
        <TabsContent value="recalc">{tab === 'recalc' ? <RecalculationsTab /> : null}</TabsContent>
        <TabsContent value="periods">{tab === 'periods' ? <PeriodLocksTab /> : null}</TabsContent>
      </Tabs>
      <CorrectionDialog key={`${correction.open}-${correction.preset?.employeeId ?? ''}-${correction.preset?.attendanceDate ?? ''}`} open={correction.open} onOpenChange={(o) => setCorrection((c) => ({ ...c, open: o }))} preset={correction.preset} onCreated={() => navigate('/corrections')} />
      <RecalculateDialog key={String(recalcOpen)} open={recalcOpen} onOpenChange={setRecalcOpen} />
    </div>
  );
}
