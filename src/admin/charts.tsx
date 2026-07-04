import React, { useState } from 'react';

// Chart primitives for the admin dashboard (dark surface zinc-950).
// Palette validated with the dataviz six-checks validator for dark mode:
//   single series / sequential: #ea580c (orange-600)
//   categorical pair:           #ea580c + #0284c7 (CVD ΔE 94 — passes)
export const SERIES_1 = '#ea580c';
export const SERIES_2 = '#0284c7';

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// Top-rounded bar path (4px data-end radius, square baseline corners).
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

// "Nice" axis maximum so gridlines land on round numbers.
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

export type BarDatum = { label: string; value: number; sub?: string };

// Vertical bar chart: single series, hover tooltip, recessive grid.
export function Bars({ data, height = 170, money = false, color = SERIES_1 }: {
  data: BarDatum[]; height?: number; money?: boolean; color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return <p className="text-sm text-zinc-500 py-8 text-center">No data in this range.</p>;

  const W = 600, H = height, padL = 42, padB = 20, padT = 14;
  const plotW = W - padL - 6, plotH = H - padT - padB;
  const max = niceMax(Math.max(...data.map(d => d.value)));
  const step = plotW / data.length;
  const barW = Math.max(3, Math.min(28, step - 2)); // ≥2px surface gap between bars
  const y = (v: number) => padT + plotH * (1 - v / max);
  const gridVals = [max, max / 2];
  // Sparse x labels — avoid collisions.
  const every = Math.ceil(data.length / 7);
  const fmt = (v: number) => (money ? fmtMoney(v) : String(v));

  const h = hover != null ? data[hover] : null;

  return (
    <div className="relative">
      {h && (
        <div className="absolute -top-1 left-1/2 -translate-x-1/2 z-10 pointer-events-none rounded-lg bg-zinc-800 border border-white/10 px-3 py-1.5 text-xs shadow-xl whitespace-nowrap">
          <span className="text-zinc-400">{h.sub ?? h.label} · </span>
          <span className="font-semibold text-white">{fmt(h.value)}</span>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Bar chart" onMouseLeave={() => setHover(null)}>
        {/* Recessive grid + axis labels (ink tokens, never series color) */}
        {gridVals.map(g => (
          <g key={g}>
            <line x1={padL} x2={W - 6} y1={y(g)} y2={y(g)} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
            <text x={padL - 6} y={y(g) + 3.5} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.45)">{fmt(g)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - 6} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
        {data.map((d, i) => {
          const bx = padL + i * step + (step - barW) / 2;
          const by = y(d.value);
          const bh = Math.max(d.value > 0 ? 2 : 0, y(0) - by);
          return (
            <g key={i}>
              {/* Hit target wider than the mark */}
              <rect x={padL + i * step} y={padT} width={step} height={plotH} fill="transparent"
                onMouseEnter={() => setHover(i)} />
              {bh > 0 && (
                <path d={barPath(bx, y(0) - bh, barW, bh, 4)} fill={color}
                  opacity={hover == null || hover === i ? 1 : 0.45} style={{ transition: 'opacity 120ms' }}
                  pointerEvents="none" />
              )}
              {i % every === 0 && (
                <text x={padL + i * step + step / 2} y={H - 5} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.45)">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Horizontal labeled bar rows — for category splits and funnels. Every row is
// directly labeled, so identity never rides on color alone.
export function HBarList({ rows, money = false }: {
  rows: { label: string; value: number; color?: string; sub?: string }[];
  money?: boolean;
}) {
  const max = Math.max(1, ...rows.map(r => r.value));
  const fmt = (v: number) => (money ? fmtMoney(v) : v.toLocaleString());
  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={i}>
          <div className="flex items-baseline justify-between text-sm mb-1">
            <span className="text-zinc-300">{r.label}{r.sub && <span className="text-zinc-500 text-xs ml-1.5">{r.sub}</span>}</span>
            <span className="font-semibold text-white">{fmt(r.value)}</span>
          </div>
          <div className="h-2.5 rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, backgroundColor: r.color ?? SERIES_1, transition: 'width 300ms' }} />
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-zinc-500 py-4 text-center">No data in this range.</p>}
    </div>
  );
}

export function ChartCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
      </div>
      {children}
    </div>
  );
}
