import { useId } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { cn } from '@/lib/utils';
import { fmtNumber } from '@/lib/format';

/**
 * Thin Recharts wrappers. Colours arrive as CSS variables (`var(--color-chart-present)`) so the charts follow the
 * tenant's dashboard style without re-rendering; animations are off because the app honours reduced motion globally
 * and Recharts does not read that preference itself.
 */

export interface Series { key: string; label: string; color: string }

const axisTick = { fontSize: 11, fill: 'var(--color-muted-foreground)' } as const;

function SeriesTooltip({ active, payload, label, series, totalLabel, format = fmtNumber }: Partial<TooltipContentProps<number, string>> & { series: Series[]; totalLabel?: string; format?: (value: number) => string }) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(payload.map((p) => [String(p.dataKey), p]));
  const total = payload.reduce((sum, p) => sum + Number(p.value ?? 0), 0);
  return (
    <div className="min-w-36 rounded-md border bg-card px-3 py-2 text-xs text-card-foreground shadow-md">
      <p className="mb-1.5 font-medium">{label}</p>
      {series.map((s) => {
        const p = byKey.get(s.key);
        if (!p) return null;
        return (
          <div key={s.key} className="flex items-center justify-between gap-4 py-0.5">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground"><span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />{s.label}</span>
            <span className="tnum font-medium">{format(Number(p.value ?? 0))}</span>
          </div>
        );
      })}
      {totalLabel ? <div className="mt-1 flex items-center justify-between gap-4 border-t pt-1"><span className="text-muted-foreground">{totalLabel}</span><span className="tnum font-semibold">{format(total)}</span></div> : null}
    </div>
  );
}

/**
 * Stacked bars, one category per row of `data`; the last series carries the rounded top. `format` renders the values in
 * the tooltip (counts by default, hours for the activity view) and `reference` draws the dashed target line behind them.
 */
export function StackedBars({ data, series, xKey, rtl, height = 260, totalLabel, format, allowDecimals = false, reference }: { data: Record<string, string | number>[]; series: Series[]; xKey: string; rtl: boolean; height?: number; totalLabel?: string; format?: (value: number) => string; allowDecimals?: boolean; reference?: { value: number; label: string } }) {
  return (
    <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 480, height }}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barCategoryGap="32%">
        <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={axisTick} reversed={rtl} interval="preserveStartEnd" minTickGap={14} />
        <YAxis tickLine={false} axisLine={false} tick={axisTick} width={32} allowDecimals={allowDecimals} orientation={rtl ? 'right' : 'left'} />
        <Tooltip cursor={{ fill: 'var(--color-muted)', opacity: 0.7 }} content={<SeriesTooltip series={series} totalLabel={totalLabel} format={format} />} />
        {reference ? <ReferenceLine y={reference.value} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" label={{ value: reference.label, position: rtl ? 'insideLeft' : 'insideRight', fontSize: 11, fill: 'var(--color-muted-foreground)' }} /> : null}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={28} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface DonutSlice { key: string; label: string; value: number; color: string }

function DonutTooltip({ active, payload }: Partial<TooltipContentProps<number, string>>) {
  const p = payload?.[0];
  if (!active || !p) return null;
  const slice = p.payload as DonutSlice | undefined;
  return (
    <div className="rounded-md border bg-card px-3 py-1.5 text-xs text-card-foreground shadow-md">
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: slice?.color }} aria-hidden />{p.name}</span>
      <span className="tnum ms-3 font-medium">{fmtNumber(Number(p.value ?? 0))}</span>
    </div>
  );
}

/** Ring chart with an HTML centre label (kept out of the SVG so it wraps, mirrors and scales like ordinary text). */
export function Donut({ slices, height = 190, center, className }: { slices: DonutSlice[]; height?: number; center?: { value: string; label: string }; className?: string }) {
  const data = slices.filter((s) => s.value > 0);
  const empty = data.length === 0;
  const shown = empty ? [{ key: 'empty', label: '', value: 1, color: 'var(--color-muted)' }] : data;
  return (
    <div className={cn('relative', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: height, height }}>
        <PieChart>
          <Pie data={shown} dataKey="value" nameKey="label" innerRadius="70%" outerRadius="100%" paddingAngle={shown.length > 1 ? 2 : 0} stroke="none" startAngle={90} endAngle={-270} isAnimationActive={false}>
            {shown.map((s) => <Cell key={s.key} fill={s.color} />)}
          </Pie>
          {empty ? null : <Tooltip content={<DonutTooltip />} />}
        </PieChart>
      </ResponsiveContainer>
      {center ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum text-2xl font-semibold leading-none">{center.value}</span>
          <span className="mt-1 text-xs text-muted-foreground">{center.label}</span>
        </div>
      ) : null}
    </div>
  );
}

/** A tiny area chart with no axes; reversed in RTL so time still runs in the reading direction. */
export function Sparkline({ values, color, rtl, height = 36 }: { values: number[]; color: string; rtl: boolean; height?: number }) {
  const id = useId();
  const gradient = `spark-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const ordered = rtl ? [...values].reverse() : values;
  const data = ordered.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 160, height }}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${gradient})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
