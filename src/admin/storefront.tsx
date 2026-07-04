import React, { useEffect, useRef, useState } from 'react';
import {
  Save, Loader2, Upload, RotateCcw, CheckCircle2,
  Image as ImageIcon, Monitor, Smartphone,
} from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { compressImage, IMMUTABLE_CACHE } from '../lib/imageUpload';
import { PageScaffold } from './ui';

type Xform = { scale: number; x: number; y: number };
type Device = 'desktop' | 'mobile';

const NO_XFORM: Xform = { scale: 1, x: 0, y: 0 };

// Mirrors the storefront's built-in defaults (App.tsx hero section).
const DEFAULTS = {
  image: '/models/hero_model.webp',
  title1: 'Melelo',
  title2: 'Brands',
  tagline: 'Chaotic authenticity.',
  desktop: { ...NO_XFORM },
  mobile: { ...NO_XFORM },
};

type HeroCfg = typeof DEFAULTS;

const input = 'w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

function Slider({ label, value, min, max, step, unit, onChange, onReset }: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void; onReset: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-zinc-500">{label}</label>
        <span className="text-xs font-mono text-zinc-300">
          {value}{unit}
          <button onClick={onReset} title="Reset" className="ml-2 text-zinc-600 hover:text-white align-middle"><RotateCcw size={11} /></button>
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-orange-500"
      />
    </div>
  );
}

// Accepts both the current shape ({desktop, mobile}) and the legacy one where
// scale/x/y lived at the top level — legacy values seed BOTH devices.
function normalize(raw: any): HeroCfg {
  const legacy: Xform | null = (raw?.scale != null || raw?.x != null || raw?.y != null)
    ? { scale: Number(raw.scale ?? 1), x: Number(raw.x ?? 0), y: Number(raw.y ?? 0) }
    : null;
  return {
    image: raw?.image ?? DEFAULTS.image,
    title1: raw?.title1 ?? DEFAULTS.title1,
    title2: raw?.title2 ?? DEFAULTS.title2,
    tagline: raw?.tagline ?? DEFAULTS.tagline,
    desktop: { ...NO_XFORM, ...(raw?.desktop ?? legacy ?? {}) },
    mobile: { ...NO_XFORM, ...(raw?.mobile ?? legacy ?? {}) },
  };
}

export function StorefrontPage() {
  const [cfg, setCfg] = useState<HeroCfg | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requireSupabase().from('settings').select('hero').eq('id', 1).maybeSingle().then(({ data, error }) => {
      if (error) { setErr(error.message); return; }
      setCfg(normalize((data as any)?.hero));
    });
  }, []);

  const patch = (p: Partial<HeroCfg>) => { setSaved(false); setCfg(c => c ? { ...c, ...p } : c); };
  const patchXform = (p: Partial<Xform>) => {
    setSaved(false);
    setCfg(c => c ? { ...c, [device]: { ...c[device], ...p } } : c);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setErr(null);
    try {
      const sb = requireSupabase();
      const { blob, ext, contentType } = await compressImage(file, 1600, 0.85);
      const path = `hero/hero-${Date.now()}.${ext}`;
      const { error: upErr } = await sb.storage.from('product-images').upload(path, blob, { cacheControl: IMMUTABLE_CACHE, contentType });
      if (upErr) throw upErr;
      patch({ image: sb.storage.from('product-images').getPublicUrl(path).data.publicUrl });
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const save = async () => {
    if (!cfg) return;
    setBusy(true); setErr(null); setSaved(false);
    const { error } = await requireSupabase().from('settings').update({ hero: cfg }).eq('id', 1);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSaved(true);
  };

  const xf = cfg?.[device] ?? NO_XFORM;

  return (
    <PageScaffold
      title="Storefront"
      subtitle="Hero section — image, per-device position & headline"
      actions={
        <button onClick={save} disabled={busy || !cfg}
          className="inline-flex items-center gap-2 bg-orange-500 text-black font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-orange-400 transition-colors disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Publish
        </button>
      }
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}
      {saved && (
        <div className="mb-4 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300 flex items-center gap-2">
          <CheckCircle2 size={16} /> Published — reload the storefront to see it live.
        </div>
      )}
      {!cfg ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Device switch — controls BOTH the preview and which transform the sliders edit */}
          <div className="inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 p-1 mb-4">
            <button onClick={() => setDevice('desktop')}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${device === 'desktop' ? 'bg-orange-500 text-black' : 'text-zinc-300 hover:text-white'}`}>
              <Monitor size={13} /> Desktop
            </button>
            <button onClick={() => setDevice('mobile')}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${device === 'mobile' ? 'bg-orange-500 text-black' : 'text-zinc-300 hover:text-white'}`}>
              <Smartphone size={13} /> Mobile
            </button>
          </div>

          <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start">
            {/* Live preview */}
            {device === 'desktop' ? (
              <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black aspect-video select-none">
                <img src="/bg.webp" alt="" className="absolute inset-0 w-full h-full object-cover opacity-90" />
                <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent" />
                <div className="absolute inset-0 flex items-center justify-between px-[6%]">
                  <div className="z-10 max-w-[50%]">
                    <h1 className="leading-[0.85] tracking-tighter text-[clamp(2rem,6vw,4.5rem)]">
                      <span className="block font-light">{cfg.title1 || ' '}</span>
                      <span className="block font-extrabold">{cfg.title2 || ' '}</span>
                    </h1>
                    <p className="mt-3 text-zinc-300 uppercase tracking-wide font-medium text-[clamp(0.6rem,1.4vw,0.9rem)]">{cfg.tagline}</p>
                  </div>
                  <div className="relative w-1/2 h-full flex items-end justify-center overflow-visible">
                    <div
                      className="w-full h-[85%] will-change-transform"
                      style={{ transform: `translate(${xf.x}px, ${xf.y}px) scale(${xf.scale})`, transformOrigin: 'bottom center' }}
                    >
                      <img src={cfg.image} alt="Hero model" className="w-full h-full object-contain object-bottom drop-shadow-[0_12px_30px_rgba(0,0,0,0.45)]" />
                    </div>
                  </div>
                </div>
                <span className="absolute bottom-2 right-3 text-[10px] uppercase tracking-wider text-white/30">Desktop preview · approximate</span>
              </div>
            ) : (
              <div className="flex justify-center">
                {/* Phone frame — mirrors the mobile hero: dominant centered model, headline overlaid at the bottom */}
                <div className="relative overflow-hidden rounded-[2rem] border border-white/15 bg-black aspect-[9/19] w-[280px] select-none shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
                  <img src="/bg.webp" alt="" className="absolute inset-0 w-full h-full object-cover opacity-90" />
                  <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div
                      className="w-full h-full will-change-transform"
                      style={{ transform: `translate(${xf.x}px, ${xf.y}px) scale(${xf.scale})` }}
                    >
                      {/* scale-[1.6] approximates the storefront's mobile base zoom inside this small frame */}
                      <img src={cfg.image} alt="Hero model" className="w-full h-full object-contain object-center scale-[1.6] translate-y-2 drop-shadow-[0_12px_30px_rgba(0,0,0,0.45)]" />
                    </div>
                  </div>
                  <div className="absolute inset-x-0 bottom-10 px-5 z-10">
                    <h1 className="leading-[0.85] tracking-tighter text-3xl">
                      <span className="block font-light">{cfg.title1 || ' '}</span>
                      <span className="block font-extrabold">{cfg.title2 || ' '}</span>
                    </h1>
                    <p className="mt-2 text-zinc-300 uppercase tracking-wide font-medium text-[10px]">{cfg.tagline}</p>
                  </div>
                  <span className="absolute bottom-2 right-4 text-[9px] uppercase tracking-wider text-white/30">Mobile preview · approximate</span>
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="space-y-4">
              {/* Image (shared across devices) */}
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><ImageIcon size={15} /> Image</h3>
                <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
                <button onClick={() => fileRef.current?.click()} disabled={uploading}
                  className="w-full flex items-center justify-center gap-2 border border-dashed border-white/25 rounded-xl px-4 py-4 text-sm text-zinc-300 hover:border-orange-500 hover:text-white transition-colors disabled:opacity-50">
                  {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                  {uploading ? 'Uploading…' : 'Upload new hero image'}
                </button>
                <p className="text-[11px] text-zinc-600 break-all">Current: {cfg.image}</p>
                {cfg.image !== DEFAULTS.image && (
                  <button onClick={() => patch({ image: DEFAULTS.image })} className="text-xs font-semibold text-zinc-400 hover:text-white inline-flex items-center gap-1">
                    <RotateCcw size={12} /> Restore original image
                  </button>
                )}
              </section>

              {/* Transform — per device */}
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                    {device === 'desktop' ? <Monitor size={14} /> : <Smartphone size={14} />}
                    Size & position · {device}
                  </h3>
                  <button
                    onClick={() => setCfg(c => c ? { ...c, [device]: { ...NO_XFORM } } : c)}
                    className="text-[11px] font-semibold text-zinc-500 hover:text-white inline-flex items-center gap-1">
                    <RotateCcw size={11} /> Reset all
                  </button>
                </div>
                <Slider label="Scale" value={xf.scale} min={0.4} max={2} step={0.05} unit="×"
                  onChange={v => patchXform({ scale: v })} onReset={() => patchXform({ scale: 1 })} />
                <Slider label="Horizontal (− left · + right)" value={xf.x} min={-250} max={250} step={5} unit="px"
                  onChange={v => patchXform({ x: v })} onReset={() => patchXform({ x: 0 })} />
                <Slider label="Vertical (− up · + down)" value={xf.y} min={-250} max={250} step={5} unit="px"
                  onChange={v => patchXform({ y: v })} onReset={() => patchXform({ y: 0 })} />
                <p className="text-[11px] text-zinc-600">
                  Desktop and mobile are adjusted independently — switch the device tab above to tune the other.
                </p>
              </section>

              {/* Text (shared across devices) */}
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Headline</h3>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">Line 1 (light)</label>
                  <input className={input} value={cfg.title1} onChange={e => patch({ title1: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">Line 2 (bold)</label>
                  <input className={input} value={cfg.title2} onChange={e => patch({ title2: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">Tagline</label>
                  <input className={input} value={cfg.tagline} onChange={e => patch({ tagline: e.target.value })} />
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </PageScaffold>
  );
}
