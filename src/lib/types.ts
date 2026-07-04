// Domain types mirroring the Postgres schema (supabase/migrations/0001_init.sql).
// These are the DB-shaped rows; the storefront maps them into its own
// Category/Design/ColorVariant view models in src/lib/catalog.ts.

export type ProductStatus = 'draft' | 'active' | 'archived';
export type ImageView = 'model' | 'product';
export type PaymentMethod = 'chapa' | 'bank_slip';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';
export type FulfillmentStatus =
  | 'pending_approval'
  | 'confirmed'
  | 'packed'
  | 'shipped'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';
export type DiscountType = 'percent' | 'fixed';
export type UserRole = 'admin' | 'customer';

export interface DbCategory {
  id: string;
  slug: string;
  name: string;
  sort: number;
}

export interface DbProduct {
  id: string;
  category_id: string;
  slug: string;
  name: string;
  description: string | null;
  base_price: number;
  status: ProductStatus;
  is_bestseller: boolean;
  rating: number | null;
  review_count: number | null;
  created_at: string;
}

export interface DbVariant {
  id: string;
  product_id: string;
  color_name: string;
  color_hex: string;
  sku: string | null;
}

export interface DbProductImage {
  id: string;
  product_id: string;
  variant_id: string | null;
  view: ImageView;
  url: string;
  alt: string | null;
  sort: number;
}

export interface DbInventory {
  id: string;
  variant_id: string;
  size: string;
  stock_qty: number;
  low_stock_threshold: number;
}

export interface DbProfile {
  id: string;
  full_name: string | null;
  phone: string | null;
  role: UserRole;
}

export interface DbOrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  name: string;
  image: string | null;
  size: string;
  color: string;
  unit_price: number;
  qty: number;
}

export interface DbOrder {
  id: string;
  human_id: string;
  customer_id: string | null;
  email: string | null;
  phone: string | null;
  ship_address: string | null;
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  currency: string;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  slip_url: string | null;
  chapa_tx_ref: string | null;
  approved_at: string | null;
  placed_at: string;
  updated_at: string;
  items?: DbOrderItem[];
}

export interface DbOrderEvent {
  id: string;
  order_id: string;
  status: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface DbDiscount {
  id: string;
  code: string;
  type: DiscountType;
  value: number;
  min_subtotal: number;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  used_count: number;
  active: boolean;
}

export interface DbSettings {
  id: number;
  store_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  socials: Record<string, string> | null;
  bank_details: { bank: string; name: string; account: string } | null;
  shipping_flat: number;
  free_ship_threshold: number | null;
  currency: string;
}

// A product with its nested variants/images/inventory, as fetched for the
// storefront catalog and the admin product editor.
export interface DbProductFull extends DbProduct {
  variants: DbVariant[];
  images: DbProductImage[];
  inventory: DbInventory[];
}
