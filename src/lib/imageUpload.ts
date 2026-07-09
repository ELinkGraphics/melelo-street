// Client-side image compression for uploads: downscale to a sane resolution
// and encode WebP before sending. A 4 MB phone photo becomes ~100-300 KB, so
// uploads are fast on slow networks and every later viewer downloads less.
// Falls back to the original file if decoding/encoding isn't available.
export async function compressImage(
  file: File,
  maxDim = 1600,
  quality = 0.85,
): Promise<{ blob: Blob; ext: string; contentType: string }> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/webp', quality));
    if (!blob || blob.size === 0) throw new Error('encode failed');
    // If WebP somehow came out larger (tiny inputs), keep the original.
    if (blob.size >= file.size) throw new Error('no gain');
    return { blob, ext: 'webp', contentType: 'image/webp' };
  } catch {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    return { blob: file, ext, contentType: file.type || 'application/octet-stream' };
  }
}

// Uploaded filenames are unique (timestamps/uuids), so they can be cached forever.
export const IMMUTABLE_CACHE = '31536000';

// Tiny blurred preview (~1 KB data URI) stored alongside the image URL. The
// storefront paints it instantly (it ships inside the settings row / cache)
// and fades the full image in over it — no grey hole on slow networks.
export async function makePlaceholder(file: File, width = 24, quality = 0.5): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file);
    const w = width;
    const h = Math.max(1, Math.round(bmp.height * (width / bmp.width)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/webp', quality));
    if (!blob || blob.size === 0 || blob.size > 4096) return null;
    return await new Promise<string | null>(res => {
      const r = new FileReader();
      r.onload = () => res(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => res(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
