import { cacheGet, cachePut } from '../cache/kv';
import { Env } from '../types';

// The Mini-QR parsed in slipverify.ts proves a slip is genuine and unused, but
// carries only bank code + transaction id — no amount, no payee, no time. Those
// are printed as text, so a vision model transcribes them and slipverify.ts
// matches them against the booking. This is the "no bank Open API" substitute.

const DEFAULT_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const DEFAULT_DAILY_MAX = 300;
const OCR_TIMEOUT_MS = 20_000;

export interface SlipOcrFields {
  /** Transferred amount in baht, as printed. */
  amount: number | null;
  /** Slip timestamp exactly as printed (Thai or Latin digits, any format). */
  dateTimeText: string | null;
  /** Reference 1 / เลขที่อ้างอิง 1, when the slip is a bill payment. */
  ref1: string | null;
  receiverName: string | null;
  /** Trailing visible digits of the receiving account, e.g. "1234" of "xxx-x-x1234-x". */
  receiverAccountTail: string | null;
  senderName: string | null;
}

export interface SlipOcrOutcome {
  fields: SlipOcrFields | null;
  /** Why no fields came back — surfaced in slip_ocr_json for the dashboard. */
  skipReason?: 'disabled' | 'no_binding' | 'daily_budget' | 'model_error' | 'unparsable';
  model?: string;
  at: string;
}

const PROMPT = [
  'You are reading a Thai bank or e-wallet transfer slip.',
  'Transcribe ONLY what is literally printed. Never guess, never compute, never translate.',
  'Return JSON with these keys, using null for anything not clearly visible:',
  'amount (number, baht, no currency symbol or thousands separator),',
  'dateTimeText (the date and time string exactly as printed),',
  'ref1 (the value labelled Ref1 / Ref.1 / เลขที่อ้างอิง 1, NOT the transaction id),',
  'receiverName (the name money was sent TO),',
  'receiverAccountTail (only the visible digits of the receiving account number),',
  'senderName (the name money was sent FROM).',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: ['number', 'null'] },
    dateTimeText: { type: ['string', 'null'] },
    ref1: { type: ['string', 'null'] },
    receiverName: { type: ['string', 'null'] },
    receiverAccountTail: { type: ['string', 'null'] },
    senderName: { type: ['string', 'null'] },
  },
  required: ['amount', 'dateTimeText', 'ref1', 'receiverName', 'receiverAccountTail', 'senderName'],
} as const;

function isEnabled(env: Env): boolean {
  return String(env.SLIP_OCR_ENABLED || '') === 'true';
}

function dailyMax(env: Env): number {
  const n = parseInt(String(env.SLIP_OCR_DAILY_MAX || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_MAX;
}

/**
 * Day-bucketed spend guard for the Workers AI free allocation (10,000
 * Neurons/day). Unlike `checkRateLimit` this fails **closed**: a KV read that
 * throws must not open the tap on a metered resource.
 */
async function consumeDailyBudget(env: Env, max: number): Promise<boolean> {
  const key = 'ai:slipocr:' + new Date().toISOString().slice(0, 10);
  try {
    const used = parseInt((await cacheGet(env.CACHE_KV, key)) || '0', 10) || 0;
    if (used >= max) return false;
    // Two days of TTL so a request near midnight UTC cannot resurrect a
    // yesterday bucket that outlived its own day.
    await cachePut(env.CACHE_KV, key, String(used + 1), 48 * 60 * 60);
    return true;
  } catch {
    return false;
  }
}

function coerceFields(raw: unknown): SlipOcrFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, 200) : null;
  };
  const amount = typeof r.amount === 'number' ? r.amount : parseFloat(String(r.amount ?? '').replace(/[^\d.]/g, ''));
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    dateTimeText: str(r.dateTimeText),
    ref1: str(r.ref1),
    receiverName: str(r.receiverName),
    receiverAccountTail: str(r.receiverAccountTail),
    senderName: str(r.senderName),
  };
}

/** The model answers in a `response` string that may be fenced or padded. */
function parseModelJson(response: unknown): SlipOcrFields | null {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const direct = coerceFields((response as Record<string, unknown>).response ?? response);
    if (direct) return direct;
  }
  const text = typeof response === 'string' ? response : String((response as { response?: unknown })?.response ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return coerceFields(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/**
 * Transcribe a slip image. Callers must only reach this for slips that already
 * passed the Mini-QR and duplicate checks — that gate, plus the daily budget,
 * is what keeps inference inside the free allocation.
 */
export async function extractSlipFields(env: Env, dataUri: string): Promise<SlipOcrOutcome> {
  const at = new Date().toISOString();
  if (!isEnabled(env)) return { fields: null, skipReason: 'disabled', at };
  if (!env.AI) return { fields: null, skipReason: 'no_binding', at };
  if (!(await consumeDailyBudget(env, dailyMax(env)))) return { fields: null, skipReason: 'daily_budget', at };

  const model = String(env.SLIP_OCR_MODEL || DEFAULT_MODEL);
  try {
    const run = env.AI.run(
      model as Parameters<Ai['run']>[0],
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        max_tokens: 400,
        temperature: 0,
      } as never
    ) as Promise<unknown>;

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('slip_ocr_timeout')), OCR_TIMEOUT_MS)
    );
    const fields = parseModelJson(await Promise.race([run, timeout]));
    if (!fields) return { fields: null, skipReason: 'unparsable', model, at };
    return { fields, model, at };
  } catch {
    return { fields: null, skipReason: 'model_error', model, at };
  }
}
