import catalog from '../content/frontend-text.json';

export const CONTENT_LANGUAGES = ['th', 'en', 'zh', 'vi'] as const;
type ContentLanguage = (typeof CONTENT_LANGUAGES)[number];
export type FrontendContent = Partial<Record<ContentLanguage, Record<string, string>>>;
export type FrontendChanges = Partial<Record<ContentLanguage, Record<string, string | null>>>;
const entries = new Map(catalog.map((entry) => [entry.key, entry]));
const MAX_TEXT_LENGTH = 10000;
const MAX_CONTENT_BYTES = 512000;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const placeholders = (value: string): string[] => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();

function validText(lang: ContentLanguage, key: string, value: unknown): value is string {
  const entry = entries.get(key);
  return (
    !!entry &&
    typeof value === 'string' &&
    value.length <= MAX_TEXT_LENGTH &&
    JSON.stringify(placeholders(value)) === JSON.stringify(placeholders(entry.defaults[lang]))
  );
}

/** Expose only registered public text; never pass arbitrary settings to visitors. */
export function publicFrontendContent(raw: unknown): FrontendContent {
  const result: FrontendContent = {};
  if (!object(raw)) return result;
  for (const lang of CONTENT_LANGUAGES) {
    const values = raw[lang];
    if (!object(values)) continue;
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) if (validText(lang, key, value)) clean[key] = value;
    if (Object.keys(clean).length) result[lang] = clean;
  }
  return result;
}

/** null restores one default; a patch never replaces other languages or keys. */
export function applyFrontendChanges(current: unknown, changes: unknown): FrontendContent {
  if (!object(changes)) throw new Error('ข้อความต้องเป็น object');
  const result = publicFrontendContent(current);
  for (const [language, values] of Object.entries(changes)) {
    if (!CONTENT_LANGUAGES.includes(language as ContentLanguage) || !object(values)) throw new Error('ภาษาไม่ถูกต้อง');
    const lang = language as ContentLanguage;
    const next = { ...result[lang] };
    for (const [key, value] of Object.entries(values)) {
      if (!entries.has(key) || (value !== null && !validText(lang, key, value))) {
        throw new Error(`ข้อความ ${key} ไม่ถูกต้อง กรุณาคงตัวแปร เช่น {n} และใช้ไม่เกิน ${MAX_TEXT_LENGTH} ตัวอักษร`);
      }
      if (value === null) delete next[key];
      else next[key] = value as string;
    }
    if (Object.keys(next).length) result[lang] = next;
    else delete result[lang];
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_CONTENT_BYTES)
    throw new Error('ข้อความรวมมีขนาดใหญ่เกินไป');
  return result;
}
