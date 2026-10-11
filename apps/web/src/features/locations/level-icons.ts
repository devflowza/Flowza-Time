import type { LucideIcon } from 'lucide-react';
import {
  BedDouble, Building, Building2, Cog, DoorOpen, Globe, Landmark, Layers, LayoutGrid, Map, MapPin, MapPinned, Rows3, Shapes,
  ShieldCheck, SquareDashed, Store, University, Warehouse, Workflow,
} from 'lucide-react';
import type { LocationLevelIcon } from '@flowza/contracts';

/**
 * The picture of each level icon (`LOCATION_LEVEL_ICONS`, the `location_levels.icon` check constraint). Every value has its
 * own glyph so a chain like Headquarters → Branch → Site → Floor → Zone reads at a glance. None of them is directional, so
 * none mirrors in Arabic.
 */
export const LEVEL_ICONS: Readonly<Record<LocationLevelIcon, LucideIcon>> = {
  headquarters: Landmark,
  region: Map,
  country: Globe,
  city: MapPinned,
  branch: Building2,
  store: Store,
  site: MapPin,
  campus: University,
  building: Building,
  floor: Layers,
  zone: SquareDashed,
  area: LayoutGrid,
  section: Rows3,
  room: DoorOpen,
  line: Workflow,
  station: Cog,
  post: ShieldCheck,
  ward: BedDouble,
  warehouse: Warehouse,
  other: Shapes,
};

/** Whether a value is a known icon key (a newer server may send one this build does not know: it shows as `other`). */
export function isLevelIcon(icon: string | null | undefined): icon is LocationLevelIcon {
  return !!icon && Object.prototype.hasOwnProperty.call(LEVEL_ICONS, icon);
}
