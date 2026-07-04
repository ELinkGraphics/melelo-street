import { supabase } from './supabase';

// ---- Storefront view models (shared with App.tsx) ----
// A color/variant of a design. `model`/`item` are per-color art; when absent the
// renderer falls back to the design's base image + a CSS tint. `stock` maps size → qty.
export type ColorVariant = {
  name: string;
  hex: string;
  border?: boolean;
  model?: string;
  item?: string;
  stock?: Record<string, number>;
};
export type Design = { id: string; name: string; model: string; item: string; colors: ColorVariant[]; price?: number };
export type Category = { id: string; name: string; designs: Design[] };

// Dark swatches get a hairline border so they read against the dark UI.
function isDark(hex: string): boolean {
  const h = hex.replace('#', '');
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // Perceived luminance (Rec. 601).
  return 0.299 * r + 0.587 * g + 0.114 * b < 0.22;
}

type Img = { variant_id: string | null; view: 'model' | 'product'; url: string; sort: number };

// Prefer a variant-specific image; fall back to the product-level (variant_id null) image.
function pickImage(images: Img[], variantId: string | null, view: 'model' | 'product'): string | undefined {
  const exact = images.find(i => i.variant_id === variantId && i.view === view);
  if (exact) return exact.url;
  const base = images.find(i => i.variant_id === null && i.view === view);
  return base?.url;
}

// Fetch the live catalog and map it into the storefront's Category[] shape.
// Returns [] when Supabase isn't configured or on error — callers keep their fallback.
export async function fetchCatalog(): Promise<Category[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('products')
    .select(`
      id, slug, name, base_price, is_bestseller, created_at,
      category:categories!inner ( id, slug, name, sort ),
      variants:product_variants ( id, color_name, color_hex, inventory:inventory ( size, stock_qty ) ),
      images:product_images ( variant_id, view, url, sort )
    `)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[catalog] fetch failed, using fallback:', error.message);
    return [];
  }

  const groups = new Map<string, { cat: any; products: any[] }>();
  for (const p of (data ?? []) as any[]) {
    const cat = p.category;
    if (!cat) continue;
    if (!groups.has(cat.id)) groups.set(cat.id, { cat, products: [] });
    groups.get(cat.id)!.products.push(p);
  }

  const categories: Category[] = [...groups.values()]
    .sort((a, b) => (a.cat.sort ?? 0) - (b.cat.sort ?? 0))
    .map(({ cat, products }) => ({
      id: cat.slug,
      name: cat.name,
      designs: products.map((p): Design => {
        const images: Img[] = p.images ?? [];
        const variants: any[] = p.variants ?? [];
        const first = variants[0];
        const baseModel = pickImage(images, null, 'model') ?? (first && pickImage(images, first.id, 'model'));
        const baseItem = pickImage(images, null, 'product') ?? (first && pickImage(images, first.id, 'product'));
        const colors: ColorVariant[] = variants.map(v => {
          const stock: Record<string, number> = {};
          for (const inv of (v.inventory ?? [])) stock[inv.size] = inv.stock_qty;
          return {
            name: v.color_name,
            hex: v.color_hex,
            border: isDark(v.color_hex),
            model: pickImage(images, v.id, 'model'),
            item: pickImage(images, v.id, 'product'),
            stock,
          };
        });
        return { id: p.id, name: p.name, model: baseModel ?? '', item: baseItem ?? '', colors, price: Number(p.base_price) };
      }),
    }));

  return categories;
}
