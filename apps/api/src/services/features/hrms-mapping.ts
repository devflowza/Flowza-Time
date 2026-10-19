import { HRMS_EMPLOYEE_FIELDS, HRMS_ORG_UNIT_FIELDS, type HrmsPresetDefinition, type ImportKind } from '@flowza/contracts';
import type { RawObject } from '../imports.service.js';

/** One HR-system record as the import pipeline's raw object, plus the source fields nothing was mapped to. */
export interface MappedRecord { object: RawObject; ignored: string[] }

const fold = (s: string) => s.trim().toLowerCase();

/** A value as text: numbers and booleans as written, null / blank → absent (an absent field leaves the stored value alone). */
function asText(v: string | number | boolean | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = typeof v === 'string' ? v.trim() : String(v);
  return s === '' ? undefined : s;
}

/**
 * Translates one record of the HR system into FlowZa's import fields (docs/integrations/hrms.md §3):
 *  - a source field named in the mapping (case-insensitive) goes to its FlowZa field;
 *  - otherwise a source field that already IS a FlowZa field name (case-insensitive) is taken as it is — the `generic` preset;
 *  - anything else is ignored (and reported in the batch summary, so a misspelt mapping shows up).
 * Status, gender and employment-type labels (Arabic or English) are translated with the value mappings, case-insensitively;
 * a value that is not in them is passed on as written (the row validation then accepts a FlowZa value or reports it).
 * When two source fields map to the same FlowZa field, the first non-empty one wins.
 */
export function mapHrmsRecord(kind: ImportKind, record: Record<string, string | number | boolean | null>, mapping: HrmsPresetDefinition): MappedRecord {
  const targets: readonly string[] = kind === 'ORG_UNITS' ? HRMS_ORG_UNIT_FIELDS : HRMS_EMPLOYEE_FIELDS;
  const fieldMap = new Map<string, string>(Object.entries(kind === 'ORG_UNITS' ? mapping.orgUnitMapping : mapping.employeeMapping).map(([k, v]) => [fold(k), v]));
  const ownNames = new Map(targets.map((t) => [fold(t), t]));
  const object: RawObject = {};
  const ignored: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    const target = fieldMap.get(fold(field)) ?? ownNames.get(fold(field));
    if (!target) { ignored.push(field); continue; }
    const text = asText(value);
    if (text !== undefined && object[target] === undefined) object[target] = text;
  }
  if (kind === 'EMPLOYEES') {
    const translate = (field: string, values: Record<string, string>) => {
      const v = object[field];
      if (v === undefined) return;
      const table = new Map(Object.entries(values).map(([k, x]) => [fold(k), x]));
      const hit = table.get(fold(v));
      if (hit) object[field] = hit;
    };
    translate('employmentStatus', mapping.statusMapping);
    translate('gender', mapping.genderMapping);
    translate('employmentType', mapping.employmentTypeMapping);
  }
  return { object, ignored };
}
