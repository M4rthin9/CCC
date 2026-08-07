const bkkFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function nowUtc(): string {
  return new Date().toISOString();
}

// 'yyyy-MM-dd HH:mm:ss' in Asia/Bangkok (parity with GAS Session.getScriptTimeZone()).
export function bangkokNow(): string {
  const parts = bkkFormat.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// 'yyyy-MM-dd' in Asia/Bangkok.
export function bangkokNowISO(): string {
  return bangkokNow().slice(0, 10);
}

// ISO date N months ago (calendar month arithmetic, local time) — parity with GAS archive cutoff.
export function nowMinusMonthsISO(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return (
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  );
}

// ISO date one year ago (local time) — parity with GAS discipline expiry.
export function oneYearAgoISO(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return (
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  );
}
