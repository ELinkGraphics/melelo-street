import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useCommerce, CommerceLayer, UNIT_PRICE } from './commerce';
import { fetchCatalog, type Category, type Design, type ColorVariant } from './lib/catalog';
import { supabase } from './lib/supabase';
import { initTelegram } from './lib/telegram';
import { fmtMoney, moneySymbol, setCurrencyCode } from './lib/currency';

// Admin-managed hero config (settings.hero); every field optional — defaults
// below match the built-in design. Transforms are per device; legacy configs
// stored a single scale/x/y at the top level and apply to both.
type HeroXform = { scale?: number; x?: number; y?: number };
type HeroCfg = {
  image?: string; placeholder?: string; title1?: string; title2?: string; tagline?: string;
  desktop?: HeroXform; mobile?: HeroXform;
} & HeroXform;

// Last-published hero config, cached so repeat visits paint the CORRECT hero
// from the first frame instead of flashing the bundled default until the
// settings query returns. index.html reads the same key to preload the image.
const HERO_CACHE_KEY = 'mlb_hero_v1';
function loadCachedHero(): HeroCfg {
  try { return JSON.parse(localStorage.getItem(HERO_CACHE_KEY) || 'null') ?? {}; }
  catch { return {}; }
}

// Blur-up hero: the tiny placeholder (data URI riding inside the hero config)
// shows instantly, the full image fades in over it once decoded — so slow
// networks see the right picture immediately, just soft instead of empty.
function HeroImage({ src, placeholder, className }: { src: string; placeholder?: string; className: string }) {
  const [ready, setReady] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setReady(imgRef.current?.complete ?? false);
  }, [src]);
  return (
    <div className="relative w-full h-full">
      {placeholder && !ready && (
        <img src={placeholder} alt="" aria-hidden className={`${className} absolute inset-0 blur-lg`} />
      )}
      <img
        ref={imgRef}
        src={src}
        alt="Hero model"
        fetchPriority="high"
        decoding="async"
        onLoad={() => setReady(true)}
        className={`${className} relative transition-opacity duration-500 ${ready || !placeholder ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
}

// Store info surfaced on the storefront (About panel, badges, legal pages) —
// all admin-managed via Settings.
type LegalKind = 'privacy' | 'terms' | 'returns';
type StoreInfo = {
  name?: string; email?: string; phone?: string;
  socials?: { instagram?: string; twitter?: string; tiktok?: string };
  legal?: Partial<Record<LegalKind, string>>;
  shippingFlat?: number; freeShipThreshold?: number | null;
  telegramBot?: string;
};

// Fallback policy text, shown until real policies are written in Admin → Settings.
const LEGAL_TITLES: Record<LegalKind, string> = {
  privacy: 'Privacy Policy', terms: 'Terms of Service', returns: 'Returns & Shipping',
};
const DEFAULT_LEGAL: Record<LegalKind, string> = {
  privacy:
    'We collect only what we need to fulfil your order: your name, delivery address, phone number and email. '
    + 'Payment details are handled by our payment providers and never stored on our servers. '
    + 'We use your contact details to send order confirmations and delivery updates, and we never sell or share your data with third parties for marketing.',
  terms:
    'All orders are subject to availability and confirmation of payment. Prices are shown in the store currency at checkout. '
    + 'An order is confirmed once payment is verified; you will receive a confirmation with a tracking link by email or Telegram. '
    + 'We reserve the right to cancel orders that cannot be fulfilled — any payment received for a cancelled order is refunded in full.',
  returns:
    'If something is wrong with your order — wrong size, wrong item or a defect — contact us within 7 days of delivery and we will make it right with an exchange or refund. '
    + 'Items must be unworn and in their original condition. Delivery times and fees are shown at checkout before you pay.',
};

function LegalModal({ kind, text, onClose }: { kind: LegalKind; text: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center p-4 pointer-events-auto">
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[80dvh] overflow-y-auto bg-zinc-950 border border-white/15 rounded-2xl p-6 md:p-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold uppercase tracking-tight">{LEGAL_TITLES[kind]}</h3>
          <button onClick={onClose} aria-label="Close" className="text-white/50 hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>
        <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

// Shared palette. `model`/`item` per color are left undefined until real per-color art
// is supplied; rendering falls back to the design's base image (+ a CSS tint placeholder).
const PALETTE: ColorVariant[] = [
  { name: 'White', hex: '#E8E0D6' },
  { name: 'Black', hex: '#1A1A1A', border: true },
  { name: 'Grey', hex: '#9A9A9A' },
  { name: 'Orange', hex: '#C85A17' },
];

const M1 = '/models/outfit_one_model.webp';
const M2 = '/models/outfit_two_model.webp';
const M3 = '/models/outfit_three_model.webp';
const M4 = '/models/outfit_four_model.webp';
const C1 = '/models/outfit_one_cloth.webp';
const C2 = '/models/outfit_two_cloth.webp';
const C3 = '/models/outfit_three_cloth.webp';
const C4 = '/models/outfit_four_cloth.webp';

// Real T-shirt art. Builds the 4 paths (White/Black × cloth/model) from the design slug.
// Drop the 8 PNGs into public/models/ using the exact Melelo-* names below.
const tee = (slug: 'DesignOne' | 'DesignTwo', name: string): Design => {
  const p = (color: 'White' | 'Black', view: '' | '-model') =>
    `/models/Melelo-${slug}-${color}-Tshirt${view}.webp`;
  return {
    id: `tee-${slug.toLowerCase()}`,
    name,
    model: p('White', '-model'), // base = white variant
    item: p('White', ''),
    colors: [
      { name: 'White', hex: '#E8E0D6', model: p('White', '-model'), item: p('White', '') },
      { name: 'Black', hex: '#1A1A1A', border: true, model: p('Black', '-model'), item: p('Black', '') },
    ],
  };
};

const FALLBACK_CATEGORIES: Category[] = [
  {
    id: 'tees', name: 'T-Shirts',
    designs: [
      tee('DesignOne', 'Comb Out'),
      tee('DesignTwo', 'First Class'),
    ],
  },
  // Hoodies still use the reused 4 model<->cloth pairings as placeholders.
  {
    id: 'hoodies', name: 'Hoodies',
    designs: [
      { id: 'hd-1', name: 'Tom Cinder 25', model: M2, item: C1, colors: PALETTE },
      { id: 'hd-2', name: 'DS1 Tech', model: M3, item: C2, colors: PALETTE },
      { id: 'hd-3', name: 'Horizon Shell', model: M4, item: C3, colors: PALETTE },
      { id: 'hd-4', name: 'Nokturn Layer', model: M1, item: C4, colors: PALETTE },
    ],
  },
];



// Img with async decode, lazy loading (unless `eager`), and a fade-in when the
// bytes arrive — late images ease in instead of popping. Cached images render
// instantly (the `complete` check covers loads that beat hydration).
function FadeImg({ eager, className, onLoad, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { eager?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => { if (ref.current?.complete) setLoaded(true); }, []);
  return (
    <img
      ref={ref}
      {...rest}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={e => { setLoaded(true); onLoad?.(e); }}
      className={`${className ?? ''} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}

// Renders a garment image recolored to `hex`. If `coloredSrc` (a real per-color image)
// is supplied it is used directly; otherwise the base `src` is shown with a mask-clipped
// color-blend overlay as a placeholder until real per-color art exists.
function Recolor({ src, coloredSrc, hex, alt, className, imgClassName, maskPosition = 'center', eager }: {
  src: string; coloredSrc?: string; hex: string; alt?: string; className?: string; imgClassName?: string; maskPosition?: string; eager?: boolean;
}) {
  if (coloredSrc) {
    return <FadeImg src={coloredSrc} alt={alt} className={imgClassName} eager={eager} />;
  }
  const maskStyle: React.CSSProperties = {
    backgroundColor: hex,
    mixBlendMode: 'color',
    WebkitMaskImage: `url(${src})`,
    maskImage: `url(${src})`,
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: maskPosition,
    maskPosition: maskPosition,
  };
  return (
    <div className={`relative ${className ?? ''}`}>
      <FadeImg src={src} alt={alt} className={imgClassName} eager={eager} />
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={maskStyle} />
    </div>
  );
}

// ---- Color-driven gallery: every (design × view) image-slot for one color ----
type Slot = { designIndex: number; view: 'product' | 'model'; src: string; coloredSrc?: string; hex: string; label: string };

// Renders one slot honoring the selected color: real per-color image if present, else a tinted
// product placeholder (model placeholders show the base image — no blend on large/lifestyle shots).
function SlotImage({ slot, imgClassName, maskPosition = 'center', eager }: { slot: Slot; imgClassName?: string; maskPosition?: string; eager?: boolean }) {
  if (slot.coloredSrc) return <FadeImg src={slot.coloredSrc} alt={slot.label} className={imgClassName} eager={eager} />;
  if (slot.view === 'product') {
    return <Recolor src={slot.src} hex={slot.hex} alt={slot.label} className="w-full h-full" imgClassName={imgClassName} maskPosition={maskPosition} eager={eager} />;
  }
  return <FadeImg src={slot.src} alt={slot.label} className={imgClassName} eager={eager} />;
}

// ---------------------------------------------------------------------------
// Reviews — live social proof in the detail panel. Only approved reviews are
// readable (RLS), so a plain table query is safe here.
// ---------------------------------------------------------------------------
function RatingStars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <div className="flex items-center gap-0.5 text-orange-400">
      {[1, 2, 3, 4, 5].map(n => (
        <svg key={n} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
          fill={n <= Math.round(value) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5">
          <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01z"/>
        </svg>
      ))}
    </div>
  );
}

type ProductReview = {
  rating: number; body: string | null; photos: string[];
  reviewer_name: string | null; created_at: string;
};

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);

function ProductReviews({ productId }: { productId: string }) {
  const [reviews, setReviews] = useState<ProductReview[] | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setReviews(null);
    // Fallback (bundled) catalog has non-uuid ids — no live reviews to show.
    if (!supabase || !isUuid(productId)) { setReviews([]); return; }
    supabase
      .from('reviews')
      .select('rating,body,photos,reviewer_name,created_at')
      .eq('product_id', productId)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data }) => { if (alive) setReviews((data as ProductReview[]) ?? []); });
    return () => { alive = false; };
  }, [productId]);

  if (!supabase || !isUuid(productId)) return null;

  return (
    <div className="mt-8 border-t border-white/10 pt-6 pb-2">
      <h5 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-4">
        Reviews{reviews && reviews.length > 0 ? ` (${reviews.length})` : ''}
      </h5>
      {reviews === null ? (
        <p className="text-sm text-zinc-500">Loading reviews…</p>
      ) : reviews.length === 0 ? (
        <p className="text-sm text-zinc-500">No reviews yet — be the first after your order arrives.</p>
      ) : (
        <div className="space-y-5">
          {reviews.map((r, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 flex-wrap">
                <RatingStars value={r.rating} size={13} />
                <span className="text-sm font-semibold">{r.reviewer_name || 'Verified buyer'}</span>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-full px-2 py-0.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                  Verified buyer
                </span>
                <span className="text-xs text-zinc-500 ml-auto">
                  {new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </div>
              {r.body && <p className="text-sm text-zinc-300 mt-2 leading-relaxed">{r.body}</p>}
              {r.photos?.length > 0 && (
                <div className="flex gap-2 mt-2.5">
                  {r.photos.map(url => (
                    <button key={url} onClick={() => setLightbox(url)} className="w-16 h-16 rounded-lg overflow-hidden bg-black/40 border border-white/10 hover:border-orange-500/60 transition-colors">
                      <img src={url} alt="Customer photo" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {lightbox && (
        <div
          className="fixed inset-0 z-[130] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="Customer photo" className="max-w-full max-h-full rounded-xl object-contain" />
          <button aria-label="Close photo" className="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [activeSectionState, setActiveSectionState] = useState<'hero' | 'collection'>('hero');
  const activeSectionRef = useRef<'hero' | 'collection'>('hero');
  // Catalog: color is the master filter; the gallery is every (design × view) image-slot for that color.
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [selectedColor, setSelectedColor] = useState(0); // index into the category's color set
  const [galleryIndex, setGalleryIndex] = useState(0);
  const galleryIndexRef = useRef(0);

  // Live catalog from Supabase; seeded with the bundled fallback so the site
  // renders instantly and still works when Supabase isn't configured.
  const [categories, setCategories] = useState<Category[]>(FALLBACK_CATEGORIES);
  useEffect(() => {
    fetchCatalog().then(cats => { if (cats.length) setCategories(cats); }).catch(() => {});
  }, []);

  // Telegram Mini App: ready/expand when running inside Telegram (no-op otherwise).
  useEffect(() => { initTelegram(); }, []);

  // Admin-managed hero + store info (contact, socials, legal, currency,
  // shipping) — one settings fetch feeds the hero, the About panel, the
  // trust badges and the money formatter.
  const [hero, setHero] = useState<HeroCfg>(loadCachedHero);
  const [store, setStore] = useState<StoreInfo>({});
  useEffect(() => {
    supabase?.from('settings')
      .select('hero,store_name,contact_email,contact_phone,socials,legal,currency,shipping_flat,free_ship_threshold,telegram_bot_username')
      .eq('id', 1).maybeSingle().then(({ data }) => {
        const s = data as any;
        if (!s) return;
        if (s.hero) {
          setHero(s.hero as HeroCfg);
          try { localStorage.setItem(HERO_CACHE_KEY, JSON.stringify(s.hero)); } catch { /* private mode */ }
        }
        if (s.currency) setCurrencyCode(s.currency);
        setStore({
          name: s.store_name ?? undefined,
          email: s.contact_email ?? undefined,
          phone: s.contact_phone ?? undefined,
          socials: s.socials ?? undefined,
          legal: s.legal ?? undefined,
          shippingFlat: s.shipping_flat != null ? Number(s.shipping_flat) : undefined,
          freeShipThreshold: s.free_ship_threshold != null ? Number(s.free_ship_threshold) : null,
          telegramBot: s.telegram_bot_username ?? undefined,
        });
      });
  }, []);

  const category = categories[categoryIndex] ?? categories[0];
  const colors = category.designs[0].colors;             // color set is consistent within a category
  const colorIndex = Math.min(selectedColor, colors.length - 1);
  const colorName = colors[colorIndex].name;
  // Gallery = the designs of this category. Each design is shown as a MOCKUP (the non-"-model"
  // file) in the dock, and as the "-model" image in the center. Scrolling selects a design;
  // color stays fixed.
  const designsList = category.designs;
  const designAt = Math.min(galleryIndex, designsList.length - 1);
  galleryIndexRef.current = designAt;
  const design = designsList[designAt];
  const color = design.colors.find(c => c.name === colorName) ?? design.colors[0];
  const itemSrc = color.item ?? design.item;        // mockup (flat) in the current color
  const unitPrice = design.price ?? UNIT_PRICE;     // live DB price; constant for the bundled fallback
  // Per-size stock for the active color. `stock` is undefined for the bundled
  // fallback catalog, in which case every size is treated as available.
  const sizeInStock = (sz: string) => {
    const st = color.stock;
    return !st || (st[sz] ?? 0) > 0;
  };
  const activeDesignIndex = designAt;
  const galleryLenRef = useRef(designsList.length);
  galleryLenRef.current = designsList.length;

  // Build a renderable slot for a design + view, honoring the selected color.
  const slotFor = (d: Design, dIndex: number, view: 'product' | 'model'): Slot => {
    const cv = d.colors.find(c => c.name === colorName) ?? d.colors[0];
    return {
      designIndex: dIndex, view, label: d.name, hex: cv.hex,
      src: view === 'model' ? d.model : d.item,
      coloredSrc: view === 'model' ? cv.model : cv.item,
    };
  };
  const centerSlot = slotFor(design, designAt, 'model'); // center is ALWAYS the -model image

  const selectCategory = (i: number) => {
    if (i === categoryIndex) return;
    const newColors = categories[i].designs[0].colors;
    const keep = newColors.findIndex(c => c.name === colorName); // preserve color by name across categories
    setCategoryIndex(i);
    setGalleryIndex(0);
    setSelectedColor(keep >= 0 ? keep : 0);
  };

  // Browse the gallery; color stays fixed (used by scroll/swipe + thumbnail clicks).
  const setGallery = (index: number) => {
    setGalleryIndex(Math.max(0, Math.min(index, galleryLenRef.current - 1)));
  };

  const isScrolling = useRef(false);
  const lastWheelTime = useRef(0);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const [showDetailsState, setShowDetailsState] = useState(false);
  const showDetailsRef = useRef(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  );
  const isMobileRef = useRef(isMobile);
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutOpenRef = useRef(false);
  const setAboutOpenWrapped = (val: boolean) => { aboutOpenRef.current = val; setAboutOpen(val); };
  const [legalOpen, setLegalOpen] = useState<LegalKind | null>(null);

  // Search
  const [searchOpenState, setSearchOpenState] = useState(false);
  const searchOpenRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  const setSearchOpen = (val: boolean) => {
    searchOpenRef.current = val;
    setSearchOpenState(val);
    if (!val) setSearchQuery(''); // Clear query when closing
  };

  const searchResults = React.useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const results: { categoryIndex: number, designIndex: number, category: Category, design: Design }[] = [];
    categories.forEach((cat, cIdx) => {
      cat.designs.forEach((des, dIdx) => {
        if (des.name.toLowerCase().includes(query) || cat.name.toLowerCase().includes(query)) {
          results.push({ categoryIndex: cIdx, designIndex: dIdx, category: cat, design: des });
        }
      });
    });
    return results;
  }, [searchQuery, categories]);

  const [addedToast, setAddedToast] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setAddedToast(msg);
    setTimeout(() => setAddedToast(null), 2000);
  };

  // Commerce (cart → checkout → success → orders → tracking)
  const commerce = useCommerce();
  const commerceOpenRef = useRef(false);
  commerceOpenRef.current = commerce.view !== 'closed';
  const [detailSize, setDetailSize] = useState('M');
  const [detailQty, setDetailQty] = useState(1);

  const setShowDetails = (val: boolean) => {
    showDetailsRef.current = val;
    setShowDetailsState(val);
  };

  const setActiveSection = (section: 'hero' | 'collection') => {
    activeSectionRef.current = section;
    setActiveSectionState(section);
  };

  // Lock input while an animation plays (>= longest transition: 600ms exit + 600ms enter)
  const lockScroll = () => {
    isScrolling.current = true;
    setTimeout(() => {
      isScrolling.current = false;
    }, 1300);
  };

  // Move between hero and collection. dir > 0 = enter collection, dir < 0 = back to hero.
  const changeSection = (dir: 1 | -1) => {
    if (isScrolling.current || showDetailsRef.current || commerceOpenRef.current) return;
    if (activeSectionRef.current === 'hero') {
      if (dir > 0) {
        setActiveSection('collection');
        setGalleryIndex(0);
        lockScroll();
      }
    } else if (dir < 0) {
      setActiveSection('hero');
      lockScroll();
    }
  };

  // Browse the gallery images of the current color (color stays fixed — no reset).
  const changeGallery = (dir: 1 | -1) => {
    if (isScrolling.current || showDetailsRef.current || commerceOpenRef.current) return;
    if (activeSectionRef.current !== 'collection') return;
    setGalleryIndex(prev => {
      const next = dir > 0 ? Math.min(prev + 1, galleryLenRef.current - 1) : Math.max(prev - 1, 0);
      if (next !== prev) lockScroll();
      return next;
    });
  };

  // Desktop: vertical wheel/swipe enters collection then browses the gallery (top boundary returns to hero).
  const navigateVertical = (dir: 1 | -1) => {
    if (isScrolling.current || showDetailsRef.current || commerceOpenRef.current) return;
    if (activeSectionRef.current === 'hero') {
      changeSection(1);
    } else if (dir > 0) {
      changeGallery(1);
    } else {
      // scrolling up: previous gallery image, or back to hero at the top
      if (galleryIndexRef.current > 0) changeGallery(-1);
      else changeSection(-1);
    }
  };

  useEffect(() => {
    // H3 fix: ignore momentum events by requiring a 120ms idle gap
    const handleWheel = (e: WheelEvent) => {
      const now = Date.now();
      const gap = now - lastWheelTime.current;
      lastWheelTime.current = now;

      // If events arrive < 120ms apart, they're part of the same inertial scroll
      if (gap < 120 && gap > 0) return;

      // Desktop only: vertical wheel drives the whole experience.
      if (Math.abs(e.deltaY) > 30) {
        navigateVertical(e.deltaY > 0 ? 1 : -1);
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      touchStartY.current = e.touches[0].clientY;
      touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const deltaY = touchStartY.current - e.changedTouches[0].clientY;
      const deltaX = touchStartX.current - e.changedTouches[0].clientX;
      const horizontal = Math.abs(deltaX) > Math.abs(deltaY);

      if (isMobileRef.current) {
        // Mobile: horizontal swipe = browse gallery images, vertical swipe = change section.
        if (horizontal && Math.abs(deltaX) > 50) {
          changeGallery(deltaX > 0 ? 1 : -1);
        } else if (!horizontal && Math.abs(deltaY) > 50) {
          changeSection(deltaY > 0 ? 1 : -1);
        }
      } else {
        // Desktop: vertical swipe mirrors the wheel.
        if (!horizontal && Math.abs(deltaY) > 50) {
          navigateVertical(deltaY > 0 ? 1 : -1);
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        navigateVertical(1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        navigateVertical(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        changeGallery(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        changeGallery(-1);
      } else if (e.key === 'Escape') {
        if (aboutOpenRef.current) setAboutOpenWrapped(false);
        else if (searchOpenRef.current) setSearchOpen(false);
        else if (commerceOpenRef.current) commerce.setView('closed');
        else if (showDetailsRef.current) setShowDetails(false);
        else setMenuOpen(false);
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: true });
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Track viewport so gestures (axis) and the dock (orientation) can adapt. < 768px = Tailwind `md`.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => {
      isMobileRef.current = mq.matches;
      setIsMobile(mq.matches);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Premium: preload the category's images so swatch/gallery switches are instant —
  // but only when the network is idle, and the ACTIVE color first, so the preloads
  // never compete with the hero/center image on slow connections.
  useEffect(() => {
    const preload = (urls: Iterable<string>) => { for (const src of urls) { const img = new Image(); img.src = src; } };
    const active = new Set<string>();
    const rest = new Set<string>();
    category.designs.forEach(d => {
      d.colors.forEach(cv => {
        const bucket = cv.name === colorName ? active : rest;
        bucket.add(cv.item ?? d.item);
        bucket.add(cv.model ?? d.model);
      });
    });
    const idle = (cb: () => void, timeout: number) =>
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(cb, { timeout })
        : window.setTimeout(cb, Math.min(timeout, 1500));
    idle(() => preload(active), 2000);
    idle(() => preload(rest), 6000);
  }, [category, colorName]);

  return (
    <div className="w-full h-[100dvh] bg-zinc-900 text-white font-sans selection:bg-orange-500 selection:text-white overflow-hidden relative flex flex-col">
      {/* SVG Sketch Filter Definition */}
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <filter id="sketch-filter">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.06"
            numOctaves="2"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="6"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>

      {/* Stable Background */}
      <div className="absolute inset-0 bg-black">
        <img
          src="/bg.webp"
          alt="Background texture"
          fetchPriority="high"
          decoding="async"
          className="w-full h-full object-cover"
        />
      </div>

      {/* Gradient overlay to ensure text legibility */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent pointer-events-none z-0"></div>

      {/* Navigation - Fixed at top of hero */}
      <nav className={`fixed top-0 left-0 right-0 z-50 w-full flex items-center justify-between px-6 py-4 md:px-10 md:py-6 transition-colors duration-500 ${activeSectionState === 'collection' ? 'bg-gradient-to-b from-black/70 via-black/25 to-transparent' : ''}`}>

        {/* Left Side: Logo + Nav Links */}
        <div className="flex items-center gap-4 md:gap-16">
          {/* Burger — shown wherever the inline links are hidden (< lg) */}
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="lg:hidden text-white hover:text-orange-300 transition-colors pointer-events-auto"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></svg>
          </button>

          <div className="flex items-center">
            <img src="/logo.webp" alt="Brand Logo" className="h-8 md:h-10 object-contain drop-shadow-lg origin-left" />
          </div>

          <div className="hidden lg:flex items-center gap-8">
            <a href="#" onClick={(e: React.MouseEvent) => { e.preventDefault(); setActiveSection('collection'); setGalleryIndex(0); }} className="text-sm font-medium tracking-widest text-white hover:text-orange-300 transition-colors uppercase">Collection</a>
            <button onClick={commerce.openAccount} className="text-sm font-medium tracking-widest text-zinc-400 hover:text-orange-300 transition-colors uppercase cursor-pointer">Track Order</button>
            <button onClick={() => setAboutOpenWrapped(true)} className="text-sm font-medium tracking-widest text-zinc-400 hover:text-orange-300 transition-colors uppercase cursor-pointer">About</button>
          </div>
        </div>

        {/* Right Side: Button + Icons */}
        <div className="flex items-center gap-5 md:gap-7 pointer-events-auto">
          <button onClick={() => { setActiveSection('collection'); setGalleryIndex(0); }} className="hidden md:block bg-[#EFEFEF] text-black px-6 py-2 md:px-7 md:py-2.5 rounded-full text-[13px] font-semibold hover:bg-white transition-colors">
            Shop Now
          </button>

          <div className="flex items-center gap-4 md:gap-5 text-white">
            {/* Search — visible on all sizes */}
            <button onClick={() => setSearchOpen(true)} aria-label="Search" className="hover:text-orange-300 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            </button>
            {/* Account — hidden only on very small screens, show on sm+ */}
            <button onClick={commerce.openAccount} aria-label="My orders" className="hidden sm:block hover:text-orange-300 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="10" r="3" /><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662" /></svg>
            </button>
            <button onClick={commerce.openCart} aria-label="Cart" className="hover:text-orange-300 transition-colors relative">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>
              {commerce.cartCount > 0 && (
                <span className="absolute -top-1 -right-2 bg-orange-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full leading-none">{commerce.cartCount}</span>
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile menu drawer */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              key="menu-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 bg-black/60 z-[90] pointer-events-auto lg:hidden"
            />
            <motion.div
              key="menu-panel"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
              className="fixed top-0 left-0 bottom-0 w-[78%] max-w-xs bg-zinc-950/95 z-[95] pointer-events-auto lg:hidden flex flex-col p-8 pt-10 border-r border-white/10 will-change-transform transform-gpu"
            >
              <button
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="self-end text-white/60 hover:text-white transition-colors mb-10"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>

              <div className="flex flex-col gap-6">
                <a
                  href="#"
                  onClick={(e: React.MouseEvent) => { e.preventDefault(); setMenuOpen(false); setActiveSection('collection'); setGalleryIndex(0); }}
                  className="text-2xl font-medium tracking-wide uppercase transition-colors text-white hover:text-orange-300"
                >
                  Collection
                </a>
                <button
                  onClick={() => { setMenuOpen(false); setAboutOpenWrapped(true); }}
                  className="text-2xl font-medium tracking-wide uppercase text-zinc-400 hover:text-orange-300 transition-colors text-left"
                >
                  About
                </button>
                <button
                  onClick={() => { setMenuOpen(false); commerce.openCart(); }}
                  className="text-2xl font-medium tracking-wide uppercase text-zinc-400 hover:text-orange-300 transition-colors text-left flex items-center gap-3"
                >
                  Cart
                  {commerce.cartCount > 0 && (
                    <span className="bg-orange-500 text-black text-xs font-bold min-w-[24px] h-6 px-1 flex items-center justify-center rounded-full">{commerce.cartCount}</span>
                  )}
                </button>
                <button
                  onClick={() => { setMenuOpen(false); commerce.openAccount(); }}
                  className="text-2xl font-medium tracking-wide uppercase text-zinc-400 hover:text-orange-300 transition-colors text-left"
                >
                  My Orders
                </button>
              </div>

              <button onClick={() => { setMenuOpen(false); setActiveSection('collection'); setGalleryIndex(0); }} className="mt-auto bg-[#EFEFEF] text-black px-6 py-3 rounded-full text-sm font-semibold hover:bg-white transition-colors">
                Shop Now
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {activeSectionState === 'hero' && (
          <motion.div
            key="hero"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="absolute inset-0 z-10 pointer-events-none md:pt-[110px] md:flex md:items-stretch md:justify-between md:pl-24 md:pr-16 lg:pl-36 lg:pr-24"
          >
            {/* Title — left column on desktop, bottom overlay on mobile (kept first so desktop flex puts it on the left) */}
            <div className="absolute inset-x-0 bottom-20 px-8 pointer-events-auto z-20 md:static md:w-1/2 md:px-0 md:bottom-auto md:flex md:flex-col md:justify-center md:h-full">
              <h1 className="text-7xl md:text-8xl lg:text-[10rem] leading-[0.85] tracking-tighter font-montserrat flex flex-col">
                <span className="font-light">{hero.title1 ?? 'Melelo'}</span>
                <span className="font-extrabold">{hero.title2 ?? 'Brands'}</span>
              </h1>
              <p className="mt-6 md:mt-8 text-zinc-300 max-w-md text-base md:text-lg tracking-wide uppercase font-medium">
                {hero.tagline ?? 'Chaotic authenticity.'}
              </p>
            </div>

            {/* Model — centered & dominant on mobile, right column on desktop */}
            <div className="absolute inset-0 flex items-center justify-center z-10 md:static md:w-1/2 md:h-full md:justify-end md:items-end">
              {/* Wrapper applies the admin-managed offset/scale ON TOP of the
                  responsive base transforms on the img (nested transforms compose).
                  Desktop and mobile each use their own transform. */}
              {(() => {
                const xf = (isMobile ? hero.mobile : hero.desktop) ?? hero;
                const s = xf.scale ?? 1, x = xf.x ?? 0, y = xf.y ?? 0;
                return (
              <div
                className="w-full h-full will-change-transform"
                style={s !== 1 || x !== 0 || y !== 0
                  ? { transform: `translate(${x}px, ${y}px) scale(${s})` }
                  : undefined}
              >
                <HeroImage
                  src={hero.image ?? '/models/hero_model.webp'}
                  placeholder={hero.placeholder || undefined}
                  className="w-full h-full object-contain object-center drop-shadow-[0_12px_30px_rgba(0,0,0,0.45)] scale-[3.2] translate-y-6 md:object-bottom md:origin-bottom md:scale-[2.5] md:-translate-x-24 md:translate-y-12"
                />
              </div>
                );
              })()}
            </div>

            {/* Mobile: tap or swipe up to enter the collection */}
            <motion.button
              onClick={() => { setActiveSection('collection'); setGalleryIndex(0); }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6, duration: 0.6 }}
              aria-label="Explore collection"
              className="md:hidden absolute bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex flex-col items-center gap-1.5 text-white/85 drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)]"
            >
              <span className="text-[11px] font-semibold uppercase tracking-[0.25em]">Explore collection</span>
              <motion.span
                animate={{ y: [0, -6, 0] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                className="text-orange-400"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
              </motion.span>
            </motion.button>
          </motion.div>
        )}

        {activeSectionState === 'collection' && (
          <motion.div
            key="collection"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="absolute inset-0 z-10"
          >


            {/* Main display — the selected gallery image of the current color. Crossfades on change. */}
            <motion.div
              className="absolute inset-0 flex items-end justify-start w-full pointer-events-none z-[60]"
              animate={{ x: showDetailsState && isMobile ? '-100%' : 0 }}
              transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
            >
              <motion.div
                animate={{ x: !isMobile && showDetailsState ? '-5%' : isMobile ? '0%' : '20%', scale: isMobile ? 1.15 : (showDetailsState ? 2.1 : 1.95), y: isMobile ? '0%' : '-13%' }}
                transition={{ duration: 0.7, ease: [0.25, 0.1, 0.25, 1] }}
                className="absolute top-0 h-full origin-bottom md:origin-top left-0 w-full md:left-[10%] md:w-[65%] will-change-transform transform-gpu"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={centerSlot.coloredSrc ?? `${centerSlot.src}-${colorName}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4 }}
                    className="absolute inset-0"
                  >
                    {/* Center is always the model (-model) image of the active design + color. */}
                    <SlotImage slot={centerSlot} eager imgClassName="w-full h-full object-contain object-bottom md:object-top drop-shadow-[0_12px_30px_rgba(0,0,0,0.45)]" maskPosition="center top" />
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            </motion.div>

            {/* Bottom scrim for info + dock legibility (mobile only) */}
            <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black via-black/70 to-transparent z-[62] pointer-events-none md:hidden" />

            {/* Hero Content Layer */}
            <AnimatePresence>
              {!showDetailsState && (
                <motion.div
                  initial={{ opacity: 0, x: -50 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -50 }}
                  transition={{ duration: 0.6 }}
                  className="absolute inset-0 flex justify-between items-center pl-10 pr-6 md:pl-24 md:pr-16 lg:pl-36 lg:pr-24 pb-6 pt-[80px] md:pt-[110px] lg:pt-[120px] w-full h-full z-[65] md:z-10 pointer-events-none"
                >

                  {/* Left Side: Text and Interaction Area */}
                  <div className="w-full max-w-xl md:max-w-2xl lg:max-w-3xl pointer-events-none flex flex-col justify-end pb-28 md:justify-center md:pb-0 h-full">

                    {/* Category chips — icon only, expand on hover to show label */}
                    <div className="hidden md:flex gap-2 mb-6 pointer-events-auto" style={{ maxWidth: '280px' }}>
                      {categories.map((cat, i) => (
                        <button
                          key={cat.id}
                          onClick={() => selectCategory(i)}
                          className={`group flex items-center gap-0 rounded-full border transition-all duration-300 cursor-pointer overflow-hidden ${i === categoryIndex
                            ? 'bg-orange-500 border-orange-500 text-black w-auto px-3 py-2'
                            : 'border-white/20 text-zinc-300 hover:border-white/50 hover:text-white backdrop-blur-md bg-black/20 w-9 h-9 hover:w-auto hover:px-3 hover:py-2 p-2'}`}
                        >
                          <span className="shrink-0">
                          {cat.id === 'tees' && (
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/></svg>
                          )}
                          {cat.id === 'hoodies' && (
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C9 2 6 4 6 7v4H3l1 11h16l1-11h-3V7c0-3-3-5-6-5z"/><path d="M9 2v6"/><path d="M15 2v6"/><circle cx="12" cy="14" r="2"/></svg>
                          )}
                          </span>
                          <span className={`text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap overflow-hidden transition-all duration-300 ${i === categoryIndex
                            ? 'max-w-[80px] ml-1.5 opacity-100'
                            : 'max-w-0 ml-0 opacity-0 group-hover:max-w-[80px] group-hover:ml-1.5 group-hover:opacity-100'}`}>
                            {cat.name}
                          </span>
                        </button>
                      ))}
                    </div>

                    {/* Dynamic Shirt Display Card */}
                    <div className="hidden md:block relative w-[140px] h-[140px] md:w-[160px] md:h-[160px] lg:w-[180px] lg:h-[180px] max-w-full pointer-events-auto">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={`${design.id}-${selectedColor}`}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 1.05 }}
                          transition={{ duration: 0.5 }}
                          className="absolute inset-0 flex items-center justify-center"
                        >
                          {/* Sketch Frame Container */}
                          <div className="relative p-3 md:p-4 w-[155%] h-[110%] flex items-center justify-center">
                            {/* The hand-drawn border layer */}
                            <div
                              className="absolute inset-0 pointer-events-none z-20"
                              style={{
                                border: '4px solid rgba(255,255,255,0.4)',
                                borderRadius: '16px',
                                filter: 'url(#sketch-filter)',
                              }}
                            />

                            {/* T-Shirt Content */}
                            <div className="relative z-10 w-[180%] h-[150%]">
                              <Recolor
                                src={design.item}
                                coloredSrc={color.item}
                                hex={color.hex}
                                alt={design.name}
                                className="w-full h-full"
                                imgClassName="w-full h-full object-contain drop-shadow-2xl scale-110"
                              />
                            </div>
                          </div>
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    {/* Color Swatches — the master control. Keeps the current gallery slot (no reset). */}
                    <div className="hidden md:flex items-center gap-3 mt-5 md:mt-6 pointer-events-auto">
                      {colors.map((swatch, i) => (
                        <button
                          key={swatch.name}
                          onClick={() => setSelectedColor(i)}
                          className={`w-5 h-5 md:w-6 md:h-6 rounded-full transition-all duration-300 hover:scale-110 ${i === colorIndex ? 'ring-2 ring-white ring-offset-2 ring-offset-transparent' : ''}`}
                          style={{ backgroundColor: swatch.hex, border: swatch.border ? '1px solid rgba(255,255,255,0.2)' : 'none' }}
                          title={swatch.name}
                        />
                      ))}
                    </div>

                    {/* Mobile category pills — small, no background, sits above the look info */}
                    <div className="flex md:hidden items-center gap-4 mb-4 pointer-events-auto">
                      {categories.map((cat, i) => (
                        <button
                          key={cat.id}
                          onClick={() => selectCategory(i)}
                          className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${i === categoryIndex ? 'text-orange-400' : 'text-white/50 hover:text-white'}`}
                        >
                          <span className="shrink-0">
                            {cat.id === 'tees' && (
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/></svg>
                            )}
                            {cat.id === 'hoodies' && (
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C9 2 6 4 6 7v4H3l1 11h16l1-11h-3V7c0-3-3-5-6-5z"/><path d="M9 2v6"/><path d="M15 2v6"/><circle cx="12" cy="14" r="2"/></svg>
                            )}
                          </span>
                          {cat.name}
                        </button>
                      ))}
                    </div>

                    {/* Dynamic Info for the active design (derived from the gallery slot) */}
                    <div className="md:mt-8 pointer-events-auto">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={activeDesignIndex}
                          initial={{ opacity: 0, y: 15 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -15 }}
                          transition={{ duration: 0.4 }}
                        >
                          <p className="text-xs md:text-sm font-medium tracking-[0.2em] text-orange-400 uppercase mb-1 md:mb-2">
                            {category.name} · Look {String(activeDesignIndex + 1).padStart(2, '0')}
                          </p>
                          <h3 className="text-2xl md:text-3xl font-display font-medium text-white mb-1">
                            {design.name}
                          </h3>
                          <p className="text-xs text-zinc-400 mb-2 md:mb-4">Color · <span className="text-white">{color.name}</span></p>
                          {/* Mobile color swatches (desktop has its own row above) */}
                          <div className="flex md:hidden items-center gap-3 mb-4">
                            {colors.map((swatch, i) => (
                              <button
                                key={swatch.name}
                                onClick={() => setSelectedColor(i)}
                                title={swatch.name}
                                className={`w-6 h-6 rounded-full transition-all hover:scale-110 ${i === colorIndex ? 'ring-2 ring-white ring-offset-2 ring-offset-transparent' : ''}`}
                                style={{ backgroundColor: swatch.hex, border: swatch.border ? '1px solid rgba(255,255,255,0.25)' : 'none' }}
                              />
                            ))}
                          </div>
                          <button
                            onClick={() => setShowDetails(true)}
                            className="px-6 py-2.5 rounded-full text-xs font-semibold border border-zinc-500/50 bg-black/20 text-white hover:bg-white hover:text-black transition-colors backdrop-blur-md">
                            View details
                          </button>
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>

                </motion.div>
              )}
            </AnimatePresence>

            {/* Vertical Divider — between hero (left) and product panel (right) */}
            <AnimatePresence>
              {!showDetailsState && (
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }}
                  className="hidden md:block absolute right-[14%] top-0 bottom-0 w-[1px] z-40 pointer-events-none">
                  <div
                    className="w-full h-full"
                    style={{
                      background: 'linear-gradient(to bottom, transparent 8%, rgba(255,255,255,0.15) 30%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0.15) 70%, transparent 92%)',
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Right Side: Product Carousel Panel */}
            <AnimatePresence>
              {!showDetailsState && (
                <motion.div
                  initial={{ opacity: 0, x: 50 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 50 }} transition={{ duration: 0.6 }}
                  className="absolute bottom-0 inset-x-0 h-24 md:right-0 md:top-0 md:bottom-0 md:inset-x-auto md:translate-y-0 md:h-auto md:w-[14%] flex items-center justify-center pointer-events-none z-[82] md:z-40">

                  {/* Mobile: solid black bottom with feathered top edge (takes over the old category bar's look) */}
                  <div className="md:hidden absolute inset-0 bg-gradient-to-t from-black via-black to-transparent pointer-events-none" />

                  {/* Mobile: glass dock platform — the active item is always centered on it */}
                  <div className="md:hidden absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[78%] max-w-[320px] h-[72px] rounded-[22px] bg-white/[0.06] border border-white/10 backdrop-blur-xl shadow-[0_12px_34px_rgba(0,0,0,0.55)] pointer-events-none overflow-hidden">
                    <div className="absolute top-0 inset-x-8 h-px bg-gradient-to-r from-transparent via-orange-400/70 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-orange-500/[0.07] to-transparent" />
                  </div>

                  {/* Mobile: soft orange spotlight behind the centered active mockup */}
                  <div
                    className="md:hidden absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 rounded-full pointer-events-none"
                    style={{ background: 'radial-gradient(circle, rgba(234,138,40,0.34) 0%, rgba(234,138,40,0) 70%)' }}
                  />

                  {/* Mobile: vibrant active highlight tile framing the centered mockup */}
                  <div className="md:hidden absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[66px] h-[66px] rounded-2xl pointer-events-none bg-gradient-to-br from-orange-500/35 via-orange-500/10 to-transparent ring-1 ring-orange-400/50 shadow-[0_0_28px_rgba(234,138,40,0.45)]" />

                  {/* Active Item Highlight Panel — orange selection backdrop (desktop vertical band) */}
                  <div
                    className="hidden md:block absolute left-0 right-0 z-20 pointer-events-none"
                    style={{
                      height: '200px',
                      top: '50%',
                      marginTop: '-100px',
                      background: 'linear-gradient(90deg, transparent 0%, rgba(255, 98, 0, 0.08) 15%, rgba(200,90,23,0.17) 50%, rgba(200,90,23,0.0) 85%, transparent 100%)',
                    }}
                  />

                  {/* Gallery — one MOCKUP per design (the non-"-model" flat), in the current color only */}
                  <div className="relative w-full h-full flex items-center justify-center pointer-events-auto overflow-hidden">
                    {designsList.map((d, index) => {
                      const g = slotFor(d, index, 'product');
                      const distance = index - designAt;
                      const isActive = distance === 0;
                      const absDistance = Math.abs(distance);

                      // Main axis: horizontal strip on mobile, vertical column on desktop.
                      const mainAxis = isMobile
                        ? { x: distance * 62, y: 0 }
                        : { x: 0, y: distance * 200 };

                      const itemScale = isMobile
                        ? (isActive ? 1.08 : 0.72)
                        : (isActive ? 1 : Math.max(0.5, 0.65 - (absDistance - 1) * 0.15));
                      const itemOpacity = isMobile
                        ? (isActive ? 1 : Math.max(0.4, 0.65 - (absDistance - 1) * 0.2))
                        : (isActive ? 1 : Math.max(0.05, 0.22 - (absDistance - 1) * 0.12));
                      const itemBlur = isMobile
                        ? 0
                        : (isActive ? 0 : Math.min(14, 8 + (absDistance - 1) * 4));

                      return (
                        <motion.div
                          key={d.id}
                          initial={false}
                          animate={{
                            ...mainAxis,
                            scale: itemScale,
                            opacity: itemOpacity,
                          }}
                          transition={{ duration: 0.85, ease: [0.32, 0.72, 0, 1] }}
                          // Perf: static blur via style; only transform/opacity animate.
                          style={{ zIndex: isActive ? 30 : 10 - absDistance, filter: itemBlur ? `blur(${itemBlur}px)` : undefined }}
                          className="absolute w-14 h-14 md:w-[180px] md:h-[200px] flex items-center justify-center cursor-pointer will-change-transform transform-gpu"
                          onClick={() => { if (!isActive) setGallery(index); }}
                        >
                          <SlotImage
                            slot={g}
                            imgClassName={`w-full h-full object-contain object-center ${isActive
                              ? 'drop-shadow-[0_0_24px_rgba(234,138,40,0.3)]'
                              : 'drop-shadow-[0_8px_24px_rgba(0,0,0,0.4)]'}`}
                          />
                        </motion.div>
                      );
                    })}
                  </div>

                  {/* Mobile: tappable page dots showing the active look */}
                  <div className="md:hidden absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 pointer-events-auto z-30">
                    {designsList.map((d, index) => {
                      const on = index === designAt;
                      return (
                        <button
                          key={d.id}
                          onClick={() => setGallery(index)}
                          aria-label={`View ${d.name}`}
                          className={`rounded-full transition-all duration-300 ${on ? 'w-5 h-1.5 bg-orange-400 shadow-[0_0_8px_rgba(234,138,40,0.7)]' : 'w-1.5 h-1.5 bg-white/30 hover:bg-white/60'}`}
                        />
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>



          </motion.div>
        )}
      </AnimatePresence>

      {/* Detail Information Panel (Moved outside stacking context so z-index works against root navbar) */}
      <AnimatePresence>
        {showDetailsState && activeSectionState === 'collection' && (
          <motion.div
            key="details-panel"
            initial={{ opacity: 0, x: isMobile ? '100%' : 100 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: isMobile ? '100%' : 100 }}
            transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute right-0 top-0 bottom-0 w-full md:w-[45%] bg-zinc-950/95 md:bg-black/60 backdrop-blur-md z-[60] flex flex-col pointer-events-auto border-l border-white/10 will-change-transform transform-gpu"
          >
            {/* Close — floating circular control, always reachable */}
            <button
              onClick={() => setShowDetails(false)}
              aria-label="Close details"
              className="absolute top-5 right-5 md:top-8 md:right-8 w-10 h-10 rounded-full bg-white/10 border border-white/15 backdrop-blur-md text-white/70 hover:text-white hover:bg-white/20 transition-colors flex items-center justify-center z-[80] cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>

            {/* Scrollable content — the sticky buy bar below stays pinned */}
            <div className="flex-1 overflow-y-auto hide-scrollbar px-6 pt-16 pb-4 md:px-16 md:pt-24">

              {/* Garment preview — tinted glow platform + crossfade on color change */}
              <div className="relative w-full h-56 md:h-52 mb-5 flex items-center justify-center">
                <div aria-hidden className="absolute bottom-3 left-1/2 -translate-x-1/2 w-52 h-14 rounded-[50%] blur-2xl opacity-50" style={{ background: color.hex }} />
                <AnimatePresence mode="wait">
                  <motion.div
                    key={`${design.id}-${color.name}`}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.03 }}
                    transition={{ duration: 0.35 }}
                    className="relative z-10 h-full flex items-center justify-center"
                  >
                    <Recolor
                      src={design.item}
                      coloredSrc={color.item}
                      hex={color.hex}
                      alt={design.name}
                      className="h-full flex items-center justify-center"
                      imgClassName="h-full w-auto object-contain drop-shadow-2xl"
                    />
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Bestseller badge (only when flagged in the catalog) + live social proof */}
              <div className="flex items-center justify-between mb-4">
                {design.bestseller ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-orange-300 bg-orange-500/15 border border-orange-500/30 rounded-full px-3 py-1">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>
                    Bestseller
                  </span>
                ) : <span />}
                {(design.reviewCount ?? 0) > 0 && design.rating != null && (
                  <div className="flex items-center gap-1.5">
                    <RatingStars value={design.rating} size={14} />
                    <span className="text-xs text-zinc-400">{design.rating.toFixed(1)} ({design.reviewCount})</span>
                  </div>
                )}
              </div>

            <h4 className="text-orange-400 text-sm tracking-widest uppercase mb-2 font-semibold">
              {category.name} · Look {String(activeDesignIndex + 1).padStart(2, '0')}
            </h4>
            <h2 className="text-4xl md:text-5xl font-black uppercase tracking-tighter mb-6">
              {design.name}
            </h2>

            <div className="space-y-6">
              <div>
                <h5 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-3">
                  Color · <span className="text-white normal-case">{color.name}</span>
                </h5>
                <div className="flex gap-3">
                  {colors.map((swatch, i) => (
                    <button
                      key={swatch.name}
                      onClick={() => setSelectedColor(i)}
                      title={swatch.name}
                      className={`w-8 h-8 rounded-full transition-all hover:scale-110 ${i === colorIndex ? 'ring-2 ring-white ring-offset-2 ring-offset-black' : ''}`}
                      style={{ backgroundColor: swatch.hex, border: swatch.border ? '1px solid rgba(255,255,255,0.25)' : 'none' }}
                    />
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <h5 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Select Size</h5>
                  <span className="text-xs text-zinc-500">True to size · model wears M</span>
                </div>
                <div className="flex gap-2.5">
                  {['S', 'M', 'L', 'XL'].map(size => {
                    const oos = !sizeInStock(size);
                    return (
                      <button
                        key={size}
                        onClick={() => { if (!oos) setDetailSize(size); }}
                        disabled={oos}
                        title={oos ? 'Out of stock' : undefined}
                        className={`flex-1 h-12 rounded-xl border flex items-center justify-center text-sm font-bold transition-all ${oos
                          ? 'border-zinc-800 text-zinc-600 line-through cursor-not-allowed'
                          : detailSize === size
                            ? 'border-orange-500 bg-orange-500 text-black shadow-[0_4px_16px_rgba(234,138,40,0.35)]'
                            : 'border-zinc-600 text-zinc-300 hover:border-orange-500 hover:text-orange-400'}`}
                      >
                        {size}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <h5 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-3">Quantity</h5>
                <div className="flex items-center gap-1 border border-zinc-600 rounded-full w-max p-1">
                  <button onClick={() => setDetailQty(q => Math.max(1, q - 1))} aria-label="Decrease quantity" className="w-10 h-10 rounded-full flex items-center justify-center text-xl text-zinc-300 hover:bg-white/10 hover:text-white transition-colors">−</button>
                  <span className="w-10 text-center font-semibold text-lg">{detailQty}</span>
                  <button onClick={() => setDetailQty(q => Math.min(9, q + 1))} aria-label="Increase quantity" className="w-10 h-10 rounded-full flex items-center justify-center text-xl text-zinc-300 hover:bg-white/10 hover:text-white transition-colors">+</button>
                </div>
              </div>
            </div>

            {/* Trust signals — driven by real settings so every claim is true */}
            <div className="grid grid-cols-3 gap-2 mt-8">
              <div className="flex flex-col items-center gap-1.5 rounded-xl bg-white/5 border border-white/10 px-2 py-3 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-orange-300"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>
                <span className="text-[10px] font-medium text-zinc-300 leading-tight">
                  {store.shippingFlat === 0
                    ? 'Free shipping'
                    : store.freeShipThreshold != null
                      ? `Free over ${moneySymbol()}${store.freeShipThreshold}`
                      : 'Nationwide delivery'}
                </span>
              </div>
              <button onClick={() => setLegalOpen('returns')} className="flex flex-col items-center gap-1.5 rounded-xl bg-white/5 border border-white/10 px-2 py-3 text-center cursor-pointer hover:border-orange-500/40 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-orange-300"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
                <span className="text-[10px] font-medium text-zinc-300 leading-tight">Returns policy</span>
              </button>
              <div className="flex flex-col items-center gap-1.5 rounded-xl bg-white/5 border border-white/10 px-2 py-3 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-orange-300"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
                <span className="text-[10px] font-medium text-zinc-300 leading-tight">Secure checkout</span>
              </div>
            </div>

            <ProductReviews productId={design.id} />
            </div>

            {/* Sticky purchase bar — always visible so buying is one tap away */}
            <div className="shrink-0 border-t border-white/10 bg-black/85 backdrop-blur-xl px-6 pt-4 md:px-16 md:pb-8" style={{ paddingBottom: 'calc(1.1rem + env(safe-area-inset-bottom))' }}>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <div className="text-2xl md:text-3xl font-bold leading-none">{fmtMoney(unitPrice * detailQty)}</div>
                  <div className="text-[11px] text-zinc-400 mt-1">{detailQty} × {fmtMoney(unitPrice)} · {color.name} / {detailSize}</div>
                </div>
                <div className={`flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${sizeInStock(detailSize) ? 'text-emerald-400' : 'text-red-400'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${sizeInStock(detailSize) ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
                  {sizeInStock(detailSize) ? 'In stock' : 'Out of stock'}
                </div>
              </div>
              <div className="flex gap-2.5">
                <button
                  onClick={() => {
                    commerce.addToCart({
                      designId: design.id,
                      name: `${design.name} ${category.name}`,
                      image: itemSrc,
                      size: detailSize,
                      color: color.name,
                      price: unitPrice,
                      qty: detailQty,
                    });
                    setDetailQty(1);
                    setShowDetails(false);
                    commerce.openCart();
                  }}
                  disabled={!sizeInStock(detailSize)}
                  className="flex-1 flex items-center justify-center gap-2 bg-white/10 border border-white/20 text-white py-4 rounded-full font-bold uppercase tracking-wide text-sm hover:bg-white hover:text-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/10 disabled:hover:text-white">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>
                  Add
                </button>
                <button
                  onClick={() => {
                    commerce.addToCart({
                      designId: design.id,
                      name: `${design.name} ${category.name}`,
                      image: itemSrc,
                      size: detailSize,
                      color: color.name,
                      price: unitPrice,
                      qty: detailQty,
                    });
                    setDetailQty(1);
                    setShowDetails(false);
                    commerce.setView('checkout');
                  }}
                  disabled={!sizeInStock(detailSize)}
                  className="flex-[1.6] flex items-center justify-center gap-2 bg-orange-500 text-white py-4 rounded-full font-bold uppercase tracking-wide text-sm hover:bg-orange-400 transition-colors shadow-[0_6px_24px_rgba(234,138,40,0.5)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-orange-500">
                  {sizeInStock(detailSize) ? 'Buy Now' : 'Out of stock'}
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                </button>
              </div>
              <div className="flex items-center justify-center gap-1.5 mt-3 text-[11px] text-zinc-500">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Secure checkout · encrypted payment
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search Modal */}
      <AnimatePresence>
        {searchOpenState && (
          <motion.div
            key="search-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 bg-black/85 backdrop-blur-md z-[100] flex flex-col pointer-events-auto"
          >
            <div className="w-full max-w-5xl mx-auto px-6 py-12 md:py-24 flex flex-col h-full">
              {/* Search Input Header */}
              <div className="flex items-center gap-4 border-b border-white/20 pb-4 relative">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" className="text-white/50 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                <input 
                  autoFocus
                  type="text"
                  placeholder="Search for jackets, hoodies, or looks..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="bg-transparent w-full text-2xl md:text-5xl font-light outline-none placeholder:text-white/20 pr-24"
                />
                <button 
                  onClick={() => setSearchOpen(false)}
                  className="text-white/50 hover:text-white absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-2 text-sm uppercase tracking-widest font-semibold transition-colors"
                >
                  <span className="hidden md:inline text-xs text-white/30 border border-white/20 rounded px-2 py-1 mr-2">ESC</span>
                  Close
                </button>
              </div>

              {/* Search Results Area */}
              <div className="flex-1 overflow-y-auto mt-8 hide-scrollbar">
                {searchQuery.trim() !== '' && searchResults.length === 0 && (
                  <div className="text-zinc-500 text-xl py-12 text-center">No results found for "{searchQuery}"</div>
                )}
                
                {searchResults.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 pb-20">
                    {searchResults.map((res, idx) => (
                      <button
                        key={`${res.category.id}-${res.design.id}-${idx}`}
                        onClick={() => {
                          setSearchOpen(false);
                          setCategoryIndex(res.categoryIndex);
                          setGalleryIndex(res.designIndex);
                          setSelectedColor(0);
                          setActiveSection('collection');
                          setShowDetails(true);
                        }}
                        className="group flex items-center gap-6 p-4 rounded-2xl hover:bg-white/5 transition-colors border border-transparent hover:border-white/10 text-left"
                      >
                        <div className="w-20 h-24 shrink-0 bg-white/5 rounded-xl flex items-center justify-center p-2 overflow-hidden relative">
                          <img 
                            src={res.design.item} 
                            alt={res.design.name} 
                            className="w-full h-full object-contain object-center group-hover:scale-110 transition-transform duration-500 drop-shadow-md" 
                          />
                        </div>
                        <div>
                          <h4 className="text-xs font-semibold text-orange-400 tracking-wider uppercase mb-1">{res.category.name}</h4>
                          <h3 className="text-xl font-bold uppercase tracking-tight">{res.design.name}</h3>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* About Modal — slides from bottom to top */}
      <AnimatePresence>
        {aboutOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              key="about-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
              onClick={() => setAboutOpenWrapped(false)}
              className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] pointer-events-auto"
            />
            {/* Panel */}
            <motion.div
              key="about-panel"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
              className="fixed inset-x-0 bottom-0 z-[105] pointer-events-auto max-h-[85dvh] overflow-y-auto hide-scrollbar will-change-transform transform-gpu"
              style={{ background: '#0A0A0A' }}
            >
              {/* Close handle */}
              <div className="sticky top-0 z-10 flex justify-center pt-4 pb-2" style={{ background: '#0A0A0A' }}>
                <button
                  onClick={() => setAboutOpenWrapped(false)}
                  className="w-12 h-1.5 rounded-full bg-white/20 hover:bg-white/40 transition-colors cursor-pointer"
                  aria-label="Close About"
                />
              </div>

              <div className="px-8 md:px-16 lg:px-24 pb-16 pt-4">
                {/* Header */}
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white uppercase">About</h2>
                  <button
                    onClick={() => setAboutOpenWrapped(false)}
                    className="text-white/40 hover:text-white transition-colors flex items-center gap-2 text-sm font-medium cursor-pointer"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                    Close
                  </button>
                </div>

                {/* Divider */}
                <div className="h-px w-full bg-white/15 mb-10" />

                {/* Brand statement */}
                <p className="text-white/80 text-lg md:text-xl leading-relaxed max-w-3xl mb-10">
                  Melelo Brands is a contemporary streetwear label born from the intersection of chaotic authenticity and meticulous craft. We design for the modern explorer — those who move between worlds without compromise.
                </p>

                {/* Divider */}
                <div className="h-px w-full bg-white/15 mb-10" />

                {/* Info Grid — contact, socials and legal all come from Settings */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-16 mb-10">
                  <div>
                    <h4 className="text-xs font-semibold tracking-[0.2em] text-white/40 uppercase mb-4">Contact</h4>
                    {store.email && (
                      <a href={`mailto:${store.email}`} className="block text-white text-sm leading-relaxed hover:text-orange-400 transition-colors">{store.email}</a>
                    )}
                    {store.phone && (
                      <a href={`tel:${store.phone}`} className="block text-white text-sm leading-relaxed mt-1 hover:text-orange-400 transition-colors">{store.phone}</a>
                    )}
                    <p className="text-white/60 text-sm leading-relaxed mt-1">Addis Ababa, Ethiopia</p>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold tracking-[0.2em] text-white/40 uppercase mb-4">Follow</h4>
                    <div className="flex flex-col gap-2">
                      {([
                        ['Instagram', store.socials?.instagram],
                        ['Twitter / X', store.socials?.twitter],
                        ['TikTok', store.socials?.tiktok],
                      ] as const).map(([label, url]) => (url && url !== '#')
                        ? <a key={label} href={url} target="_blank" rel="noreferrer" className="text-white text-sm hover:text-orange-400 transition-colors">{label}</a>
                        : null)}
                      {store.telegramBot && (
                        <a href={`https://t.me/${store.telegramBot}`} target="_blank" rel="noreferrer" className="text-white text-sm hover:text-orange-400 transition-colors">
                          Shop on Telegram
                        </a>
                      )}
                    </div>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold tracking-[0.2em] text-white/40 uppercase mb-4">Legal</h4>
                    <div className="flex flex-col gap-2">
                      {(['privacy', 'terms', 'returns'] as LegalKind[]).map(kind => (
                        <button key={kind} onClick={() => setLegalOpen(kind)} className="text-white text-sm text-left hover:text-orange-400 transition-colors cursor-pointer">
                          {LEGAL_TITLES[kind]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Divider */}
                <div className="h-px w-full bg-white/15 mb-8" />

                {/* Footer copyright */}
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <p className="text-white/30 text-xs tracking-widest uppercase">© {new Date().getFullYear()} {store.name ?? 'Melelo Brands'}. All rights reserved.</p>
                  <img src="/logo.webp" alt="Melelo Logo" className="h-6 opacity-30" />
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Legal pages (privacy / terms / returns) — content managed in Admin → Settings */}
      {legalOpen && (
        <LegalModal
          kind={legalOpen}
          text={store.legal?.[legalOpen]?.trim() || DEFAULT_LEGAL[legalOpen]}
          onClose={() => setLegalOpen(null)}
        />
      )}

      {/* Toast Notification — shows briefly when item added to bag */}
      <AnimatePresence>
        {addedToast && (
          <motion.div
            key="toast"
            initial={{ y: -60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -60, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
            className="fixed top-20 left-4 right-4 z-[90] pointer-events-auto md:left-auto md:right-6 md:w-auto md:min-w-[280px]"
          >
            <div className="bg-zinc-900/95 backdrop-blur-md border border-white/15 rounded-2xl px-5 py-4 shadow-[0_12px_40px_rgba(0,0,0,0.5)] flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400"><path d="M20 6 9 17l-5-5"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">Added to bag</p>
                <p className="text-xs text-zinc-400 truncate">{addedToast}</p>
              </div>
              <button
                onClick={() => commerce.openCart()}
                className="text-xs font-bold uppercase tracking-wider text-orange-400 hover:text-orange-300 transition-colors shrink-0"
              >
                View
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Commerce overlays: cart → checkout → success → account → tracking */}
      <CommerceLayer c={commerce} />
    </div>
  );
}
