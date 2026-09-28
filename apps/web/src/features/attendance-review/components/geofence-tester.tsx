import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlaskConical } from 'lucide-react';
import type { GeofenceEvaluationDto, SelfPunchDirection } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, Checkbox, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toastError } from '@/lib/toast';
import { useEmployeeOptions } from '@/features/employees/api';
import { AR_NS } from '../i18n';
import { useGeofenceMutations } from '../api';

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = { allowed: 'success', flagged: 'warning', logged: 'info', denied_outside: 'danger', denied_mock: 'danger', no_fence: 'neutral' };

/**
 * Dry run: how would a punch by this employee at this location be judged now? The server runs the same evaluation a real
 * punch goes through (scopes, windows, accuracy, grace) and lists every fence it considered; nothing is recorded.
 */
export function GeofenceTester() {
  const { t } = useTranslation(AR_NS);
  const employees = useEmployeeOptions();
  const { evaluate } = useGeofenceMutations();
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [accuracy, setAccuracy] = useState('');
  const [direction, setDirection] = useState<SelfPunchDirection>('in');
  const [isMock, setIsMock] = useState(false);
  const [result, setResult] = useState<GeofenceEvaluationDto | null>(null);
  const hasPoint = lat.trim() !== '' && lng.trim() !== '' && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  const run = () => {
    if (!employeeId) return;
    evaluate.mutate({ employeeId, direction, ...(hasPoint ? { lat: Number(lat), lng: Number(lng) } : {}), ...(accuracy.trim() && Number(accuracy) > 0 ? { accuracy: Number(accuracy) } : {}), ...(isMock ? { isMock: true } : {}) }, { onSuccess: setResult, onError: toastError });
  };
  return (
    <Card data-testid="geofence-tester">
      <CardContent className="space-y-3 pt-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><FlaskConical className="size-4" aria-hidden />{t('geofences.tester.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('geofences.tester.hint')}</p>
        <div className="grid gap-3 md:grid-cols-6">
          <FormField label={t('geofences.tester.employee')} htmlFor="gft-employee" className="md:col-span-2"><Combobox id="gft-employee" value={employeeId} onChange={setEmployeeId} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} /></FormField>
          <FormField label={t('geofences.fields.latitude')} htmlFor="gft-lat"><Input id="gft-lat" inputMode="decimal" dir="ltr" className="tnum" value={lat} onChange={(e) => setLat(e.target.value)} /></FormField>
          <FormField label={t('geofences.fields.longitude')} htmlFor="gft-lng"><Input id="gft-lng" inputMode="decimal" dir="ltr" className="tnum" value={lng} onChange={(e) => setLng(e.target.value)} /></FormField>
          <FormField label={t('geofences.tester.accuracy')} htmlFor="gft-acc"><Input id="gft-acc" type="number" min={1} className="tnum" value={accuracy} onChange={(e) => setAccuracy(e.target.value)} /></FormField>
          <FormField label={t('geofences.tester.direction')} htmlFor="gft-dir">
            <Select value={direction} onValueChange={(v) => setDirection(v as SelfPunchDirection)}><SelectTrigger id="gft-dir"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="in">{t('selfies.direction.in')}</SelectItem><SelectItem value="out">{t('selfies.direction.out')}</SelectItem></SelectContent></Select>
          </FormField>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={isMock} onCheckedChange={(c) => setIsMock(c === true)} />{t('geofences.tester.mock')}</label>
          <Button size="sm" onClick={run} disabled={!employeeId} loading={evaluate.isPending}>{t('geofences.tester.run')}</Button>
        </div>
        {result ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" data-testid="geofence-tester-result">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t('geofences.tester.result')}</span>
              <Badge variant={TONE[result.verdict.verdict] ?? 'neutral'}>{t(`verdict.${result.verdict.verdict}`)}</Badge>
              <span className="text-xs text-muted-foreground">{t(`geofences.tester.reasons.${result.verdict.reason}`, { defaultValue: result.verdict.reason })}</span>
            </p>
            <p className="text-xs text-muted-foreground">{t('geofences.tester.rule', { mode: t(`geofences.tester.modes.${result.requireGeofence}`) })}{result.winningScope ? ` · ${t('geofences.tester.winning', { scope: t(`geofences.scope.${result.winningScope}`) })}` : ''}</p>
            {result.fences.length ? (
              <ul className="divide-y text-xs">
                {result.fences.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span><span className="font-medium">{f.name}</span> · {t(`geofences.scope.${f.scope}`)} · {t('geofences.tester.priority', { n: f.priority })}</span>
                    <span className="flex items-center gap-1.5">
                      {f.distanceM !== null ? <span className="tnum">{t('geofences.tester.distance', { meters: Math.round(f.distanceM) })}</span> : null}
                      {f.outcome ? <Badge variant={TONE[f.outcome] ?? 'neutral'} className="text-[10px]">{t(`verdict.${f.outcome}`)}</Badge> : !f.applicable ? <Badge variant="neutral" className="text-[10px]">{t('geofences.tester.inactive', { reason: f.inactiveReason ? t(`geofences.tester.inactiveReasons.${f.inactiveReason}`, { defaultValue: f.inactiveReason }) : '' })}</Badge> : <Badge variant="outline" className="text-[10px]">{t('geofences.tester.notConsidered')}</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted-foreground">{t('geofences.tester.noFences')}</p>}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
