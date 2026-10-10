import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { GEOFENCE_ENFORCEMENTS, type GeofenceDto, type GeofenceEnforcement, type GeofenceInput, type GeofenceTimeWindow } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { ApiError } from '@/lib/api-client';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree } from '@/features/locations/use-location-tree';
import { cn } from '@/lib/utils';
import { AR_NS } from '../i18n';
import { useGeofenceMutations } from '../api';
import { formatPolygon, parsePolygon } from '../geofence-model';

const ORG_WIDE = '__org__';
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** A fence outlines a place (site, building, yard…) of its branch (docs/locations.md). */
const PLACE_ROLES = ['place'] as const;

interface Branch { id: string; name: string }

/**
 * Create / edit a geofence: a circle (centre + radius, always — it is the preview anchor) and optionally a polygon, the
 * enforcement (block / allow-and-flag / log only), the GPS accuracy it demands, a grace distance, active dates and weekly
 * time windows. New fences apply to their branch (or the organisation) until assignments say otherwise.
 */
export function GeofenceDialog({ open, onOpenChange, fence, branches }: { open: boolean; onOpenChange: (o: boolean) => void; fence: GeofenceDto | null; branches: readonly Branch[] }) {
  const { t } = useTranslation(AR_NS);
  const { t: tc } = useTranslation();
  const { create, update } = useGeofenceMutations();
  const [name, setName] = useState(fence?.name ?? '');
  const [branchId, setBranchId] = useState<string>(fence?.branchId ?? ORG_WIDE);
  // the place the fence outlines: only organisations with place levels see it, and only a fence with a branch can have one
  const locations = useLocationTree();
  const [locationId, setLocationId] = useState<string | null>(fence?.locationId ?? null);
  const savedLocation = fence?.locationId ?? null;
  const showPlaces = locations.hasPlaceLevels || !!savedLocation;
  const archivedLocation = !!savedLocation && locations.byId.size > 0 && !locations.byId.has(savedLocation);
  const orgWide = branchId === ORG_WIDE;
  const changeBranch = (v: string) => { if (v !== branchId) setLocationId(null); setBranchId(v); };
  const [lat, setLat] = useState(fence ? String(fence.latitude) : '');
  const [lng, setLng] = useState(fence ? String(fence.longitude) : '');
  const [radius, setRadius] = useState(String(fence?.radiusM ?? 150));
  const [polygonText, setPolygonText] = useState(fence?.polygon ? formatPolygon(fence.polygon) : '');
  const [enforcement, setEnforcement] = useState<GeofenceEnforcement>(fence?.enforcement ?? 'soft_warn');
  const [accuracy, setAccuracy] = useState(String(fence?.accuracyThresholdM ?? 100));
  const [grace, setGrace] = useState(String(fence?.graceM ?? 0));
  const [activeFrom, setActiveFrom] = useState(fence?.activeFrom ?? '');
  const [activeTo, setActiveTo] = useState(fence?.activeTo ?? '');
  const [windows, setWindows] = useState<GeofenceTimeWindow[]>(fence?.timeWindows ?? []);
  const [isActive, setIsActive] = useState(fence?.isActive ?? true);
  const [touched, setTouched] = useState(false);

  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const polygon = parsePolygon(polygonText);
  const errors = {
    name: name.trim() ? undefined : t('geofences.errors.name'),
    lat: Number.isFinite(num(lat)) && num(lat) >= -90 && num(lat) <= 90 ? undefined : t('geofences.errors.latitude'),
    lng: Number.isFinite(num(lng)) && num(lng) >= -180 && num(lng) <= 180 ? undefined : t('geofences.errors.longitude'),
    radius: Number.isInteger(num(radius)) && num(radius) >= 30 && num(radius) <= 5000 ? undefined : t('geofences.errors.radius'),
    accuracy: Number.isInteger(num(accuracy)) && num(accuracy) >= 5 && num(accuracy) <= 5000 ? undefined : t('geofences.errors.accuracy'),
    grace: Number.isInteger(num(grace)) && num(grace) >= 0 && num(grace) <= 1000 ? undefined : t('geofences.errors.grace'),
    polygon: polygon.ok ? undefined : t('geofences.errors.polygon'),
    dates: activeFrom && activeTo && activeTo < activeFrom ? t('geofences.errors.dates') : undefined,
    windows: windows.some((w) => w.days.length === 0 || !w.start || !w.end) ? t('geofences.errors.windows') : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  const submit = () => {
    setTouched(true);
    if (invalid) return;
    const body: Omit<GeofenceInput, 'assignments'> = {
      name: name.trim(), branchId: orgWide ? null : branchId,
      // sent only where the field exists (null clears it; an organisation-wide fence has no place)
      ...(showPlaces ? { locationId: orgWide ? null : locationId } : {}),
      latitude: num(lat), longitude: num(lng), radiusM: num(radius),
      polygon: polygon.ok ? polygon.value : null, enforcement, accuracyThresholdM: num(accuracy), graceM: num(grace),
      activeFrom: activeFrom || null, activeTo: activeTo || null, timeWindows: windows.length ? windows : null, isActive,
    };
    const done = () => { toast.success(t('geofences.saved')); onOpenChange(false); };
    const fail = (e: unknown) => { if (e instanceof ApiError && e.status === 422) toast.error(e.message); else toastError(e); };
    if (fence) update.mutate({ id: fence.id, input: body }, { onSuccess: done, onError: fail });
    else create.mutate(body as GeofenceInput, { onSuccess: done, onError: fail });
  };
  const err = (k: keyof typeof errors) => (touched ? errors[k] : undefined);
  const setWindow = (i: number, patch: Partial<GeofenceTimeWindow>) => setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{fence ? t('geofences.edit') : t('geofences.new')}</DialogTitle><DialogDescription>{t('geofences.dialogHint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className={cn('grid gap-4', showPlaces ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
            <FormField label={t('geofences.fields.name')} htmlFor="gf-name" required error={err('name')}><Input id="gf-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></FormField>
            <FormField label={t('geofences.fields.branch')} htmlFor="gf-branch">
              <Select value={branchId} onValueChange={changeBranch}>
                <SelectTrigger id="gf-branch"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ORG_WIDE}>{t('geofences.fields.orgWide')}</SelectItem>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            {showPlaces ? (
              <FormField label={t('geofences.fields.location')} htmlFor="gf-location" optional hint={orgWide ? t('geofences.fields.locationNeedsSite') : t('geofences.fields.locationHint')}>
                <LocationPicker id="gf-location" value={orgWide ? null : locationId} roles={PLACE_ROLES} branchId={orgWide ? null : branchId} includeArchived={archivedLocation} disabled={orgWide} onChange={(v) => setLocationId(v)} />
              </FormField>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={t('geofences.fields.latitude')} htmlFor="gf-lat" required error={err('lat')}><Input id="gf-lat" inputMode="decimal" dir="ltr" className="tnum" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="23.5880" /></FormField>
            <FormField label={t('geofences.fields.longitude')} htmlFor="gf-lng" required error={err('lng')}><Input id="gf-lng" inputMode="decimal" dir="ltr" className="tnum" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="58.3829" /></FormField>
            <FormField label={t('geofences.fields.radius')} htmlFor="gf-radius" required error={err('radius')}><Input id="gf-radius" type="number" min={30} max={5000} className="tnum" value={radius} onChange={(e) => setRadius(e.target.value)} /></FormField>
          </div>
          <FormField label={t('geofences.fields.polygon')} htmlFor="gf-polygon" optional hint={t('geofences.fields.polygonHint')} error={err('polygon')}>
            <Textarea id="gf-polygon" rows={3} dir="ltr" className="font-mono text-xs" value={polygonText} onChange={(e) => setPolygonText(e.target.value)} placeholder={'23.5885, 58.3820\n23.5890, 58.3840\n23.5870, 58.3845'} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={t('geofences.fields.enforcement')} htmlFor="gf-enforcement" hint={t(`geofences.enforcementHint.${enforcement}`)}>
              <Select value={enforcement} onValueChange={(v) => setEnforcement(v as GeofenceEnforcement)}>
                <SelectTrigger id="gf-enforcement"><SelectValue /></SelectTrigger>
                <SelectContent>{GEOFENCE_ENFORCEMENTS.map((e) => <SelectItem key={e} value={e}>{t(`geofences.enforcement.${e}`)}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label={t('geofences.fields.accuracy')} htmlFor="gf-accuracy" error={err('accuracy')}><Input id="gf-accuracy" type="number" min={5} max={5000} className="tnum" value={accuracy} onChange={(e) => setAccuracy(e.target.value)} /></FormField>
            <FormField label={t('geofences.fields.grace')} htmlFor="gf-grace" error={err('grace')}><Input id="gf-grace" type="number" min={0} max={1000} className="tnum" value={grace} onChange={(e) => setGrace(e.target.value)} /></FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={t('geofences.fields.activeFrom')} htmlFor="gf-from" optional><Input id="gf-from" type="date" className="tnum" value={activeFrom} onChange={(e) => setActiveFrom(e.target.value)} /></FormField>
            <FormField label={t('geofences.fields.activeTo')} htmlFor="gf-to" optional error={err('dates')}><Input id="gf-to" type="date" className="tnum" value={activeTo} onChange={(e) => setActiveTo(e.target.value)} /></FormField>
            <div className="flex items-end gap-2 pb-2"><Switch id="gf-active" checked={isActive} onCheckedChange={setIsActive} /><Label htmlFor="gf-active">{t('geofences.fields.active')}</Label></div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('geofences.fields.windows')}</legend>
            <p className="text-xs text-muted-foreground">{t('geofences.fields.windowsHint')}</p>
            {windows.map((w, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2" data-testid="gf-window">
                <span className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1 text-xs">
                      <Checkbox checked={w.days.includes(d)} onCheckedChange={(c) => setWindow(i, { days: c ? [...w.days, d].sort() : w.days.filter((x) => x !== d) })} aria-label={t(`geofences.weekdays.${d}`)} />
                      {t(`geofences.weekdays.${d}`)}
                    </label>
                  ))}
                </span>
                <Input type="time" className="w-28 tnum" dir="ltr" aria-label={t('geofences.fields.start')} value={w.start} onChange={(e) => setWindow(i, { start: e.target.value })} />
                <span aria-hidden>–</span>
                <Input type="time" className="w-28 tnum" dir="ltr" aria-label={t('geofences.fields.end')} value={w.end} onChange={(e) => setWindow(i, { end: e.target.value })} />
                <Button type="button" size="icon" variant="ghost" aria-label={t('geofences.fields.removeWindow')} onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
            ))}
            {touched && errors.windows ? <p className="text-xs text-destructive" role="alert">{errors.windows}</p> : null}
            <Button type="button" size="sm" variant="outline" disabled={windows.length >= 14} onClick={() => setWindows((ws) => [...ws, { days: [1, 2, 3, 4, 5], start: '07:00', end: '19:00' }])}><Plus /> {t('geofences.fields.addWindow')}</Button>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending || update.isPending}>{t('geofences.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
