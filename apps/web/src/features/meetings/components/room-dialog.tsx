import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { meetingRoomInputSchema, meetingRoomUpdateSchema, type MeetingRoomDto, type MeetingRoomUpdateInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree } from '@/features/locations/use-location-tree';
import { useDepartmentOptions } from '@/features/organization/lookups';
import { useMeetingRoomMutations } from '../api';
import { MEETINGS_NS } from '../i18n';
import { ChipPicker, EmployeeChipPicker } from './chip-picker';

/** A meeting room is a place of the tree (room, floor, zone…), never a group or a branch (docs/locations.md). */
const PLACE_ROLES = ['place'] as const;
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Create or edit a meeting room. Creating picks the place of the location tree the room is (fixed afterwards: the readers are
 * the ACCESS terminals placed there); then its name, capacity and, for a restricted room, the departments and employees allowed
 * in. Editing sends only what changed (PATCH semantics: nothing is reset by omission).
 */
export function RoomDialog({ open, onOpenChange, room }: { open: boolean; onOpenChange: (open: boolean) => void; room: MeetingRoomDto | null }) {
  const { t } = useTranslation(MEETINGS_NS);
  const { t: tc } = useTranslation();
  const tree = useLocationTree();
  const departments = useDepartmentOptions();
  const { create, update } = useMeetingRoomMutations();
  const [locationId, setLocationId] = useState<string | null>(room?.locationId ?? null);
  const [name, setName] = useState(room?.name ?? '');
  const [capacity, setCapacity] = useState(room?.capacity ? String(room.capacity) : '');
  const [restricted, setRestricted] = useState(room?.restricted ?? false);
  const [allowedDepartmentIds, setAllowedDepartmentIds] = useState<string[]>(room?.allowedDepartmentIds ?? []);
  const [allowedEmployeeIds, setAllowedEmployeeIds] = useState<string[]>(room?.allowedEmployeeIds ?? []);
  const [active, setActive] = useState((room?.status ?? 'active') === 'active');
  const [touched, setTouched] = useState(false);

  const capacityValue = capacity.trim() === '' ? null : Number(capacity);
  const values = { name, capacity: capacityValue, restricted, allowedDepartmentIds, allowedEmployeeIds };
  const parsedCreate = meetingRoomInputSchema.safeParse({ locationId, ...values });
  const patch = useMemo<MeetingRoomUpdateInput>(() => {
    if (!room) return {};
    const p: MeetingRoomUpdateInput = {};
    if (name.trim() !== room.name) p.name = name;
    if (capacityValue !== room.capacity) p.capacity = capacityValue;
    if (restricted !== room.restricted) p.restricted = restricted;
    if (!sameIds(allowedDepartmentIds, room.allowedDepartmentIds)) p.allowedDepartmentIds = allowedDepartmentIds;
    if (!sameIds(allowedEmployeeIds, room.allowedEmployeeIds)) p.allowedEmployeeIds = allowedEmployeeIds;
    if ((active ? 'active' : 'inactive') !== room.status) p.status = active ? 'active' : 'inactive';
    return p;
  }, [room, name, capacityValue, restricted, allowedDepartmentIds, allowedEmployeeIds, active]);
  const parsedUpdate = meetingRoomUpdateSchema.safeParse(patch);
  const issue = (path: string) => {
    const parsed = room ? parsedUpdate : parsedCreate;
    return parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === path);
  };
  const pending = create.isPending || update.isPending;

  const onSave = () => {
    setTouched(true);
    if (room) {
      if (!parsedUpdate.success) return;
      if (Object.keys(parsedUpdate.data).length === 0) { onOpenChange(false); return; }
      update.mutate({ id: room.id, input: parsedUpdate.data }, { onSuccess: () => { toast.success(t('rooms.saved')); onOpenChange(false); }, onError: toastError });
      return;
    }
    if (!parsedCreate.success) return;
    create.mutate(parsedCreate.data, { onSuccess: () => { toast.success(t('rooms.created')); onOpenChange(false); }, onError: toastError });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{room ? t('rooms.editTitle', { name: room.name }) : t('rooms.add')}</DialogTitle>
          <DialogDescription>{t('rooms.hint')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <FormField label={t('rooms.fields.location')} htmlFor="room-location" required={!room} hint={room ? undefined : t('rooms.fields.locationHint')} error={touched && !room && !locationId ? tc('common.required') : undefined}>
            {room ? (
              <p id="room-location" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{[room.branchName, room.locationName].filter(Boolean).join(' › ') || '—'}</p>
            ) : (
              <LocationPicker id="room-location" value={locationId} roles={PLACE_ROLES} placeholder={t('rooms.fields.locationPlaceholder')} emptyText={t('rooms.fields.noPlaces')} aria-invalid={touched && !locationId}
                onChange={(id, node) => {
                  setLocationId(id);
                  // the place's own name is the natural name of the room
                  if (node && !name.trim()) setName(tree.nameOf(node));
                }} />
            )}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <FormField label={t('rooms.fields.name')} htmlFor="room-name" required error={touched && issue('name') ? tc('common.required') : undefined}>
              <Input id="room-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!issue('name')} />
            </FormField>
            <FormField label={t('rooms.fields.capacity')} htmlFor="room-capacity" optional error={issue('capacity') ? t('rooms.fields.capacityHint') : undefined}>
              <Input id="room-capacity" type="number" inputMode="numeric" min={1} max={1000} dir="ltr" className="tnum" value={capacity} onChange={(e) => setCapacity(e.target.value)} aria-invalid={!!issue('capacity')} />
            </FormField>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{t('rooms.fields.capacityHint')}</p>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch id="room-restricted" checked={restricted} onCheckedChange={setRestricted} className="mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="room-restricted">{t('rooms.fields.restricted')}</Label>
              <p className="text-xs text-muted-foreground">{t('rooms.fields.restrictedHint')}</p>
            </div>
          </div>
          {restricted ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('rooms.fields.allowedDepartments')} htmlFor="room-departments" optional>
                <ChipPicker id="room-departments" values={allowedDepartmentIds} onChange={setAllowedDepartmentIds} options={departments.options} loading={departments.isLoading} placeholder={t('rooms.fields.addDepartment')} listLabel={t('rooms.fields.allowedDepartments')} />
              </FormField>
              <FormField label={t('rooms.fields.allowedEmployees')} htmlFor="room-employees" optional>
                <EmployeeChipPicker id="room-employees" value={allowedEmployeeIds} onChange={setAllowedEmployeeIds} placeholder={t('rooms.fields.addEmployee')} listLabel={t('rooms.fields.allowedEmployees')} />
              </FormField>
            </div>
          ) : null}
          {room ? (
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Switch id="room-active" checked={active} onCheckedChange={setActive} className="mt-0.5" />
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor="room-active">{t('rooms.fields.active')}</Label>
                <p className="text-xs text-muted-foreground">{t('rooms.fields.activeHint')}</p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={pending} data-testid="room-save">{tc('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
