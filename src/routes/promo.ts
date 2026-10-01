import { MAX_PROMO_IMAGE_BYTES } from '../constants';
import { sanitizeStr } from '../config';
import { hasPermission } from '../db/queries/roles';
import { logEvent } from '../services/logger';
import { parseDataUri, slipsBucket } from '../services/slipStorage';
import {
  PROMO_IMAGE_TYPES,
  deletePromoImage,
  getPromoConfig,
  getPromoImage,
  isPromoImageId,
  promoImageUrl,
  putPromoImage,
} from '../services/promo';
import { Env } from '../types';

// Same gate as saveSettings: the image is useless until a settings save lists it.
async function canManagePromo(env: Env, username: string): Promise<boolean> {
  return hasPermission(env.DB, username, 'manage_users');
}

/** Upload one advert image (data URI). The caller adds the returned id to `promo.ads`. */
export async function handleUploadPromoImage(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string },
  origin: string
): Promise<Record<string, unknown>> {
  if (!(await canManagePromo(env, user.username))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์จัดการโฆษณา' };
  }
  if (!slipsBucket(env)) return { status: 'error', message: 'ยังไม่ได้ตั้งค่าที่เก็บรูปภาพ (R2)' };

  const img = parseDataUri(String(body.image || ''));
  if (!img || !PROMO_IMAGE_TYPES[img.contentType]) {
    return { status: 'error', message: 'รองรับเฉพาะไฟล์ JPG, PNG, WEBP หรือ GIF' };
  }
  if (img.bytes.length > MAX_PROMO_IMAGE_BYTES) {
    return { status: 'error', message: 'ไฟล์ใหญ่เกินไป (สูงสุด 3MB)' };
  }

  const id = await putPromoImage(env, img);
  if (!id) return { status: 'error', message: 'อัปโหลดรูปภาพไม่สำเร็จ' };
  await logEvent(env, user.username, 'upload_promo_image', '', { id, bytes: img.bytes.length }, 'success');
  return { status: 'ok', id, url: promoImageUrl(origin, id) };
}

/** Remove an advert image that is no longer listed in `promo.ads`. */
export async function handleDeletePromoImage(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await canManagePromo(env, user.username))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์จัดการโฆษณา' };
  }
  const id = sanitizeStr(body.id, 64);
  if (!isPromoImageId(id)) return { status: 'error', message: 'รหัสรูปภาพไม่ถูกต้อง' };

  // Deleting an image the popup still shows would leave a broken slide, so the
  // ad has to come off the saved list first.
  const promo = await getPromoConfig(env);
  if (promo.ads.some((a) => a.id === id)) {
    return { status: 'error', message: 'รูปภาพนี้ยังถูกใช้งานอยู่ กรุณานำออกจากรายการก่อน' };
  }

  await deletePromoImage(env, id);
  await logEvent(env, user.username, 'delete_promo_image', '', { id }, 'success');
  return { status: 'ok' };
}

/** Public, binary: advert images are meant to be seen by anyone, and an id is never reused. */
export async function handleGetPromoImage(env: Env, url: URL): Promise<Response> {
  const img = await getPromoImage(env, url.searchParams.get('id') || '');
  if (!img) return new Response('Not found', { status: 404 });
  return new Response(img.body, {
    headers: {
      'Content-Type': img.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
