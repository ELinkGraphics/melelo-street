import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, X, Save, Package, Upload, Star } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';

const SIZES = ['S', 'M', 'L', 'XL'];
const money = (n: number) => `$${n.toFixed(2)}`;
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type Cat = { id: string; name: string; slug: string };
type VariantForm = {
  id?: string;
  color_name: string;
  color_hex: string;
  sku: string;
  stock: Record<string, number>;
  images: { model?: string; product?: string };
};
type ProductForm = {
  id?: string;
  category_id: string;
  name: string;
  slug: string;
  description: string;
  base_price: number;
  status: 'draft' | 'active' | 'archived';
  is_bestseller: boolean;
  variants: VariantForm[];
  removedVariantIds: string[];
};

const emptyVariant = (): VariantForm => ({
  color_name: '', color_hex: '#888888', sku: '',
  stock: { S: 0, M: 0, L: 0, XL: 0 }, images: {},
});
const emptyForm = (categoryId: string): ProductForm => ({
  category_id: categoryId, name: '', slug: '', description: '',
  base_price: 149, status: 'draft', is_bestseller: false,
  variants: [emptyVariant()], removedVariantIds: [],
});

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------
async function loadProductForm(id: string): Promise<ProductForm> {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from('products')
    .select(`
      id, category_id, name, slug, description, base_price, status, is_bestseller,
      variants:product_variants ( id, color_name, color_hex, sku, inventory:inventory ( size, stock_qty ) ),
      images:product_images ( variant_id, view, url )
    `)
    .eq('id', id)
    .single();
  if (error) throw error;
  const d = data as any;
  const images: any[] = d.images ?? [];
  const variants: VariantForm[] = (d.variants ?? []).map((v: any) => {
    const stock: Record<string, number> = { S: 0, M: 0, L: 0, XL: 0 };
    for (const inv of v.inventory ?? []) stock[inv.size] = inv.stock_qty;
    const imgs: { model?: string; product?: string } = {};
    for (const im of images) if (im.variant_id === v.id) imgs[im.view as 'model' | 'product'] = im.url;
    return { id: v.id, color_name: v.color_name, color_hex: v.color_hex, sku: v.sku ?? '', stock, images: imgs };
  });
  return {
    id: d.id, category_id: d.category_id, name: d.name, slug: d.slug,
    description: d.description ?? '', base_price: Number(d.base_price),
    status: d.status, is_bestseller: d.is_bestseller, variants, removedVariantIds: [],
  };
}

// Persist the whole product graph. Returns the (new or existing) product id.
async function saveProduct(form: ProductForm): Promise<string> {
  const sb = requireSupabase();
  const payload = {
    category_id: form.category_id,
    name: form.name.trim(),
    slug: form.slug.trim() || slugify(form.name),
    description: form.description,
    base_price: form.base_price,
    status: form.status,
    is_bestseller: form.is_bestseller,
  };

  let productId = form.id;
  if (productId) {
    const { error } = await sb.from('products').update(payload).eq('id', productId);
    if (error) throw error;
  } else {
    const { data, error } = await sb.from('products').insert(payload).select('id').single();
    if (error) throw error;
    productId = (data as any).id as string;
  }

  for (const vid of form.removedVariantIds) {
    await sb.from('product_variants').delete().eq('id', vid); // cascades inventory + images
  }

  for (const v of form.variants) {
    const vPayload = { product_id: productId, color_name: v.color_name.trim(), color_hex: v.color_hex, sku: v.sku || null };
    let variantId = v.id;
    if (variantId) {
      const { error } = await sb.from('product_variants').update(vPayload).eq('id', variantId);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('product_variants').insert(vPayload).select('id').single();
      if (error) throw error;
      variantId = (data as any).id as string;
    }
    const rows = SIZES.map(size => ({ variant_id: variantId, size, stock_qty: v.stock[size] ?? 0 }));
    const { error: invErr } = await sb.from('inventory').upsert(rows, { onConflict: 'variant_id,size' });
    if (invErr) throw invErr;
  }

  return productId!;
}

async function deleteProduct(id: string): Promise<void> {
  const { error } = await requireSupabase().from('products').delete().eq('id', id);
  if (error) throw error;
}

// Upload one image to Storage and (re)point the product_images row for that slot.
async function uploadImage(file: File, productId: string, variantId: string, view: 'model' | 'product'): Promise<string> {
  const sb = requireSupabase();
  const ext = file.name.split('.').pop() || 'png';
  const path = `${productId}/${variantId}-${view}-${Date.now()}.${ext}`;
  const { error: upErr } = await sb.storage.from('product-images').upload(path, file, { upsert: true, cacheControl: '3600' });
  if (upErr) throw upErr;
  const url = sb.storage.from('product-images').getPublicUrl(path).data.publicUrl;
  await sb.from('product_images').delete().eq('product_id', productId).eq('variant_id', variantId).eq('view', view);
  const { error: insErr } = await sb.from('product_images')
    .insert({ product_id: productId, variant_id: variantId, view, url, sort: 0 });
  if (insErr) throw insErr;
  return url;
}

// ---------------------------------------------------------------------------
// Products list page
// ---------------------------------------------------------------------------
export function ProductsPage() {
  const [cats, setCats] = useState<Cat[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProductForm | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const sb = requireSupabase();
      const [catsRes, prodRes] = await Promise.all([
        sb.from('categories').select('id,name,slug').order('sort'),
        sb.from('products').select(
          'id,name,base_price,status,is_bestseller,category:categories(name),variants:product_variants(id,inventory:inventory(stock_qty))'
        ).order('created_at'),
      ]);
      if (prodRes.error) throw prodRes.error;
      setCats((catsRes.data ?? []) as any);
      setRows(prodRes.data ?? []);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openEdit = async (id: string) => {
    try { setEditing(await loadProductForm(id)); }
    catch (e: any) { setErr(e.message ?? String(e)); }
  };

  const stockOf = (r: any) =>
    (r.variants ?? []).reduce((n: number, v: any) =>
      n + (v.inventory ?? []).reduce((m: number, i: any) => m + (i.stock_qty ?? 0), 0), 0);

  return (
    <PageScaffold
      title="Catalog"
      subtitle="Products, variants & inventory"
      actions={
        <button
          onClick={() => setEditing(emptyForm(cats[0]?.id ?? ''))}
          disabled={!cats.length}
          className="inline-flex items-center gap-2 bg-orange-500 text-black font-semibold text-sm px-4 py-2.5 rounded-xl hover:bg-orange-400 transition-colors disabled:opacity-40"
        >
          <Plus size={16} /> New product
        </button>
      }
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Package} title="No products" hint="Create your first product, or run the seed migration." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-3">Product</th>
                <th className="text-left font-medium px-4 py-3 hidden sm:table-cell">Category</th>
                <th className="text-left font-medium px-4 py-3">Price</th>
                <th className="text-left font-medium px-4 py-3 hidden sm:table-cell">Stock</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} onClick={() => openEdit(r.id)} className="border-t border-white/5 hover:bg-white/[0.04] cursor-pointer">
                  <td className="px-4 py-3 font-medium">
                    {r.name}
                    {r.is_bestseller && <Star size={12} className="inline ml-2 text-orange-300 fill-orange-300" />}
                  </td>
                  <td className="px-4 py-3 text-zinc-400 hidden sm:table-cell">{r.category?.name ?? '—'}</td>
                  <td className="px-4 py-3">{money(Number(r.base_price))}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-zinc-300">{stockOf(r)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-semibold uppercase px-2 py-1 rounded-full ${r.status === 'active' ? 'bg-green-500/15 text-green-400' : r.status === 'draft' ? 'bg-amber-500/15 text-amber-400' : 'bg-white/10 text-zinc-400'}`}>{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ProductEditor
          initial={editing}
          cats={cats}
          onClose={() => setEditing(null)}
          onSavedForm={setEditing}
          onChanged={load}
        />
      )}
    </PageScaffold>
  );
}

// ---------------------------------------------------------------------------
// Editor drawer
// ---------------------------------------------------------------------------
function ProductEditor({
  initial, cats, onClose, onSavedForm, onChanged,
}: {
  initial: ProductForm;
  cats: Cat[];
  onClose: () => void;
  onSavedForm: (f: ProductForm) => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<ProductForm>(initial);
  const [slugTouched, setSlugTouched] = useState<boolean>(!!initial.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setForm(initial); setSlugTouched(!!initial.id); }, [initial]);

  const patch = (p: Partial<ProductForm>) => setForm(f => ({ ...f, ...p }));
  const patchVariant = (i: number, p: Partial<VariantForm>) =>
    setForm(f => ({ ...f, variants: f.variants.map((v, idx) => idx === i ? { ...v, ...p } : v) }));

  const addVariant = () => setForm(f => ({ ...f, variants: [...f.variants, emptyVariant()] }));
  const removeVariant = (i: number) => setForm(f => {
    const v = f.variants[i];
    return {
      ...f,
      variants: f.variants.filter((_, idx) => idx !== i),
      removedVariantIds: v.id ? [...f.removedVariantIds, v.id] : f.removedVariantIds,
    };
  });

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!form.category_id) throw new Error('Pick a category.');
      if (!form.name.trim()) throw new Error('Name is required.');
      const id = await saveProduct(form);
      onChanged();
      onSavedForm(await loadProductForm(id)); // reopen in edit mode → image slots enabled
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!form.id || !confirm('Delete this product? This cannot be undone.')) return;
    setBusy(true); setErr(null);
    try { await deleteProduct(form.id); onChanged(); onClose(); }
    catch (e: any) { setErr(e.message ?? String(e)); setBusy(false); }
  };

  const input = 'w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-zinc-950 border-l border-white/10 h-full flex flex-col">
        <header className="h-16 shrink-0 flex items-center justify-between px-5 border-b border-white/10">
          <h2 className="font-semibold">{form.id ? 'Edit product' : 'New product'}</h2>
          <button onClick={onClose} aria-label="Close"><X size={20} className="text-zinc-400 hover:text-white" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {err && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

          {/* Details */}
          <section className="space-y-3">
            <label className="block text-xs uppercase tracking-wider text-zinc-400">Name</label>
            <input className={input} value={form.name}
              onChange={e => { const name = e.target.value; patch({ name, slug: slugTouched ? form.slug : slugify(name) }); }} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">Slug</label>
                <input className={input} value={form.slug}
                  onChange={e => { setSlugTouched(true); patch({ slug: e.target.value }); }} />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">Category</label>
                <select className={input} value={form.category_id} onChange={e => patch({ category_id: e.target.value })}>
                  {cats.map(c => <option key={c.id} value={c.id} className="bg-zinc-900">{c.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">Description</label>
              <textarea className={input} rows={3} value={form.description} onChange={e => patch({ description: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">Price</label>
                <input type="number" min={0} step="1" className={input} value={form.base_price}
                  onChange={e => patch({ base_price: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">Status</label>
                <select className={input} value={form.status} onChange={e => patch({ status: e.target.value as any })}>
                  <option value="draft" className="bg-zinc-900">Draft</option>
                  <option value="active" className="bg-zinc-900">Active</option>
                  <option value="archived" className="bg-zinc-900">Archived</option>
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
              <input type="checkbox" checked={form.is_bestseller} onChange={e => patch({ is_bestseller: e.target.checked })} />
              Mark as bestseller
            </label>
          </section>

          {/* Variants & inventory */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Colors & inventory</h3>
              <button onClick={addVariant} className="inline-flex items-center gap-1 text-xs font-semibold text-orange-400 hover:text-orange-300"><Plus size={14} /> Add color</button>
            </div>
            {!form.id && <p className="text-xs text-zinc-500">Save the product to enable image uploads per color.</p>}
            {form.variants.map((v, i) => (
              <div key={v.id ?? `new-${i}`} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <input type="color" value={v.color_hex} onChange={e => patchVariant(i, { color_hex: e.target.value })}
                    className="w-9 h-9 rounded-lg bg-transparent border border-white/15 cursor-pointer shrink-0" />
                  <input className={input} placeholder="Color name (e.g. Black)" value={v.color_name}
                    onChange={e => patchVariant(i, { color_name: e.target.value })} />
                  <input className={`${input} max-w-[120px]`} placeholder="SKU" value={v.sku}
                    onChange={e => patchVariant(i, { sku: e.target.value })} />
                  <button onClick={() => removeVariant(i)} aria-label="Remove color" className="text-zinc-500 hover:text-red-400 shrink-0"><Trash2 size={16} /></button>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {SIZES.map(size => (
                    <div key={size}>
                      <label className="block text-[10px] uppercase text-zinc-500 mb-1 text-center">{size}</label>
                      <input type="number" min={0} value={v.stock[size] ?? 0}
                        onChange={e => patchVariant(i, { stock: { ...v.stock, [size]: Number(e.target.value) } })}
                        className="w-full bg-white/5 border border-white/15 rounded-lg px-2 py-1.5 text-sm text-center outline-none focus:border-orange-500" />
                    </div>
                  ))}
                </div>
                {v.id && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <ImageSlot label="Model image" url={v.images.model} productId={form.id!} variantId={v.id} view="model"
                      onUploaded={url => patchVariant(i, { images: { ...v.images, model: url } })} onError={setErr} />
                    <ImageSlot label="Product image" url={v.images.product} productId={form.id!} variantId={v.id} view="product"
                      onUploaded={url => patchVariant(i, { images: { ...v.images, product: url } })} onError={setErr} />
                  </div>
                )}
              </div>
            ))}
          </section>
        </div>

        <footer className="shrink-0 border-t border-white/10 p-4 flex items-center gap-3">
          {form.id && (
            <button onClick={remove} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-400 hover:text-red-300 disabled:opacity-50">
              <Trash2 size={16} /> Delete
            </button>
          )}
          <button onClick={save} disabled={busy}
            className="ml-auto inline-flex items-center gap-2 bg-orange-500 text-black font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-orange-400 transition-colors disabled:opacity-50">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function ImageSlot({
  label, url, productId, variantId, view, onUploaded, onError,
}: {
  label: string; url?: string; productId: string; variantId: string;
  view: 'model' | 'product'; onUploaded: (url: string) => void; onError: (m: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try { onUploaded(await uploadImage(file, productId, variantId, view)); }
    catch (err: any) { onError(err.message ?? String(err)); }
    finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  };
  return (
    <div>
      <p className="text-[10px] uppercase text-zinc-500 mb-1">{label}</p>
      <input ref={ref} type="file" accept="image/*" onChange={onFile} className="hidden" />
      <button onClick={() => ref.current?.click()}
        className="w-full aspect-square rounded-lg border border-dashed border-white/20 bg-black/30 flex items-center justify-center overflow-hidden hover:border-orange-500 transition-colors relative">
        {url ? <img src={url} alt={label} className="w-full h-full object-contain" /> : <Upload size={18} className="text-zinc-500" />}
        {busy && <div className="absolute inset-0 bg-black/60 flex items-center justify-center"><Loader2 size={18} className="animate-spin text-orange-400" /></div>}
      </button>
    </div>
  );
}
