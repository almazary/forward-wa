import fs from 'fs';
import { WASocket, WAMessage, jidNormalizedUser } from '@whiskeysockets/baileys';

// Daily reminder of the kids' school uniform, sent at 05:00 WIB
const SEND_HOUR = 5;
// Keep retrying until this hour (bot offline at 05:00, STB rebooted, holiday API down)
const SEND_UNTIL_HOUR = 9;
// If the holiday API is down, wait this long before sending without holiday info
const HOLIDAY_WAIT_UNTIL_HOUR = 6;
const CHECK_INTERVAL_MS = 60_000;
const STATE_FILE = 'reminder-state.json';
const HOLIDAY_API = 'https://api-harilibur.pages.dev/api';
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMAND = /^\/seragam(?:\s+(\d{4}-\d{2}-\d{2}))?\s*$/i;

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTH_NAMES = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Date -> holiday names
export type Holidays = Map<string, string[]>;

interface ReminderContext {
  getSock: () => WASocket;
  isConnected: () => boolean;
  recipients: string[];
}

interface ReminderState {
  date: string;
  sentTo: string[];
}

// Dates are handled as UTC Date objects shifted to WIB, so only getUTC* methods are used
function wibToday(): Date {
  const now = new Date(Date.now() + WIB_OFFSET_MS);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function wibHour(): number {
  return new Date(Date.now() + WIB_OFFSET_MS).getUTCHours();
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDate(d: Date): string {
  return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function isSchoolDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

function uniformFor(d: Date): string {
  switch (d.getUTCDay()) {
    case 1:
    case 2:
      return 'Merah Putih';
    case 3:
    case 4:
      return 'Batik';
    default: {
      // Friday: depends on which Friday of the month it is
      const week = Math.ceil(d.getUTCDate() / 7);
      const uniform = week === 2 || week === 3 ? 'HW' : week === 4 ? 'Tapak Suci' : 'Olahraga';
      return `${uniform} (Jumat ke-${week})`;
    }
  }
}

export async function fetchHolidays(years: number[]): Promise<Holidays> {
  const holidays: Holidays = new Map();
  for (const year of new Set(years)) {
    const res = await fetch(`${HOLIDAY_API}?year=${year}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Holiday API returned ${res.status}`);
    const list = await res.json() as { holiday_date: string; holiday_name: string; is_national_holiday: boolean }[];
    for (const h of list) {
      if (!h.is_national_holiday) continue; // skip regional observances (e.g. Balinese holy days)
      // The API does not zero-pad days ("2026-06-1")
      const [y, m, d] = h.holiday_date.split('-').map(Number);
      const key = dateKey(new Date(Date.UTC(y, m - 1, d)));
      const names = holidays.get(key) || [];
      if (!names.includes(h.holiday_name)) names.push(h.holiday_name);
      holidays.set(key, names);
    }
  }
  return holidays;
}

// Returns the reminder for the given day, or null when there is nothing to send.
// holidays is null when the holiday API could not be reached.
export function buildReminder(today: Date, holidays: Holidays | null): string | null {
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const todayHoliday = holidays?.get(dateKey(today));
  // Holidays on Saturday/Sunday don't matter; a Monday holiday is announced on Sunday
  const tomorrowHoliday = isSchoolDay(tomorrow) ? holidays?.get(dateKey(tomorrow)) : undefined;
  const lines: string[] = [];

  if (isSchoolDay(today)) {
    if (todayHoliday) {
      lines.push(`🏖️ Hari ini ${formatDate(today)} libur: ${todayHoliday.join(', ')}.`);
    } else {
      lines.push(`👕 Seragam SD hari ini, ${formatDate(today)}:\n*${uniformFor(today)}*`);
    }
  }
  if (tomorrowHoliday) {
    lines.push(`📅 Besok, ${formatDate(tomorrow)}, libur: ${tomorrowHoliday.join(', ')}. Tidak sekolah.`);
  }
  if (!lines.length) return null;
  if (!holidays && isSchoolDay(today)) {
    lines.push('⚠️ Info hari libur tidak bisa dicek hari ini.');
  }
  return lines.join('\n\n');
}

function readState(): ReminderState | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return undefined;
  }
}

function writeState(state: ReminderState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

let checking = false;

async function check(ctx: ReminderContext): Promise<void> {
  const hour = wibHour();
  if (hour < SEND_HOUR || hour >= SEND_UNTIL_HOUR || !ctx.isConnected()) return;

  const today = wibToday();
  const key = dateKey(today);
  const state = readState();
  const sentTo = state?.date === key ? state.sentTo : [];
  const pending = ctx.recipients.filter(number => !sentTo.includes(number));
  if (!pending.length) return;

  let holidays: Holidays | null = null;
  try {
    holidays = await fetchHolidays([today.getUTCFullYear(), new Date(today.getTime() + DAY_MS).getUTCFullYear()]);
  } catch (error) {
    console.error('✗ Failed to fetch holidays:', (error as Error).message);
    if (hour < HOLIDAY_WAIT_UNTIL_HOUR) return; // retry on the next check
  }

  const text = buildReminder(today, holidays);
  if (!text) {
    writeState({ date: key, sentTo: ctx.recipients });
    return;
  }

  for (const number of pending) {
    try {
      await ctx.getSock().sendMessage(`${number}@s.whatsapp.net`, { text });
      sentTo.push(number);
      writeState({ date: key, sentTo });
      console.log(`✓ Uniform reminder sent to ${number}`);
    } catch (error) {
      console.error(`✗ Failed to send uniform reminder to ${number}:`, error);
    }
  }
}

export function startReminder(ctx: ReminderContext): void {
  if (!ctx.recipients.length) return;
  const run = () => {
    if (checking) return;
    checking = true;
    check(ctx)
      .catch(error => console.error('✗ Reminder error:', error))
      .finally(() => { checking = false; });
  };
  setInterval(run, CHECK_INTERVAL_MS);
  run();
}

// "/seragam" (or "/seragam 2026-08-24") in your own chat previews the reminder there only
export async function handleReminderCommand(ctx: ReminderContext, msg: WAMessage): Promise<boolean> {
  const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
  const match = COMMAND.exec(text);
  if (!match) return false;

  const day = match[1] ? new Date(`${match[1]}T00:00:00Z`) : wibToday();
  let holidays: Holidays | null = null;
  try {
    holidays = await fetchHolidays([day.getUTCFullYear(), new Date(day.getTime() + DAY_MS).getUTCFullYear()]);
  } catch (error) {
    console.error('✗ Failed to fetch holidays:', (error as Error).message);
  }
  const reminder = buildReminder(day, holidays) || `(Tidak ada pengingat untuk ${formatDate(day)})`;
  const selfJid = jidNormalizedUser(ctx.getSock().user!.id);
  await ctx.getSock().sendMessage(selfJid, { text: `Pratinjau pengingat:\n\n${reminder}` });
  return true;
}
