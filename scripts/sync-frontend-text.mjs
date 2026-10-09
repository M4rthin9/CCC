import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.resolve(backend, '../Frontend');
const dashboard = path.resolve(backend, '../Dashboard');
const languages = ['th', 'en', 'zh', 'vi'];
const dictionaries = Object.fromEntries(languages.map(lang => [lang, JSON.parse(fs.readFileSync(path.join(frontend, `src/lib/i18n/locales/${lang}.json`), 'utf8'))]));
function category(key) {
  if (/^(chat|textChat)/i.test(key)) return 'chat';
  if (/^(ck)/.test(key)) return 'privacy';
  if (/^(tbl|table)/.test(key)) return 'tables';
  if (/^(ct|home|guide|ticket|dish|course|text(?:Cover|Chef|Craft|End|Folio|Home|SetTable))/.test(key)) return 'home';
  if (/^(pay|qr|slip|upload|bank|cross|account|transfer|refOn|amount|textPayment)/i.test(key)) return 'payment';
  if (/^(status|approve|notFound|cancel|textStatus)/i.test(key)) return 'status';
  if (/^(promo)/i.test(key)) return 'promotions';
  if (/^(text(?:Booking|Calendar|Prisoner|booking|validation)|booking|prisoner|visitor|relation|religion|allergy|selectDate|confirm|extra|step|lbl|err)/.test(key)) return 'booking';
  return 'general';
}
const catalog = Object.keys(dictionaries.th).sort().map(key => ({
  key,
  category: category(key),
  defaults: Object.fromEntries(languages.map(lang => [lang, dictionaries[lang][key] ?? dictionaries.th[key]])),
}));
const output = JSON.stringify(catalog, null, 2) + '\n';
for (const file of [path.join(backend, 'src/content/frontend-text.json'), path.join(dashboard, 'src/lib/content/frontend-text.json')]) {
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output) throw new Error(`Run node scripts/sync-frontend-text.mjs to update ${file}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, output);
  }
}
console.log(`${catalog.length} frontend text entries synchronized${process.argv.includes('--check') ? ' (verified)' : ''}.`);
