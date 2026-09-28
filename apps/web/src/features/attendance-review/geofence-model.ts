/** "lat, lng" per line → [[lat, lng], …]; empty text = no polygon. 3–100 valid points, or it is refused. */
export function parsePolygon(text: string): { ok: true; value: Array<[number, number]> | null } | { ok: false } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: true, value: null };
  if (lines.length < 3 || lines.length > 100) return { ok: false };
  const points: Array<[number, number]> = [];
  for (const line of lines) {
    const parts = line.split(/[,\s;]+/).filter(Boolean).map(Number);
    if (parts.length !== 2) return { ok: false };
    const [lat, lng] = parts as [number, number];
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false };
    points.push([lat, lng]);
  }
  return { ok: true, value: points };
}

export const formatPolygon = (points: ReadonlyArray<readonly [number, number]>): string => points.map(([lat, lng]) => `${lat}, ${lng}`).join('\n');
