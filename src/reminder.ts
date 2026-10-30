import fs from 'fs';
import { WASocket, WAMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { DayContext, GeminiConfig, weeklyEncouragement } from './encouragement';

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
  gemini?: GeminiConfig;
}

interface ReminderState {
  date: string;
  sentTo: string[];
}

// What a given day needs to say; null when there is nothing to send
interface DayPlan {
  uniform?: string;
  todayHoliday?: string;
  tomorrowHoliday?: string;
}

// Dates are handled as UTC Date objects shifted to WIB, so only getUTC* methods are used
function wibToday(): Date {
  const now = new Date(Date.now() + WIB_OFFSET_MS);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function wibHour(): number {
  return new Date(Date.now() + WIB_OFFSET_MS).getUTCHours();
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Weeks run Monday to Sunday and are keyed by their Monday
function weekStart(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
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

// Holidays for the whole week of the given day, plus the Monday after it
function fetchWeekHolidays(day: Date): Promise<Holidays> {
  const monday = weekStart(day);
  return fetchHolidays([monday.getUTCFullYear(), addDays(monday, 7).getUTCFullYear()]);
}

function planDay(today: Date, holidays: Holidays | null): DayPlan | null {
  const tomorrow = addDays(today, 1);
  const plan: DayPlan = {};
  if (isSchoolDay(today)) {
    const holiday = holidays?.get(dateKey(today));
    if (holiday) plan.todayHoliday = holiday.join(', ');
    else plan.uniform = uniformFor(today);
  }
  // Holidays on Saturday/Sunday don't matter; a Monday holiday is announced on Sunday
  const tomorrowHoliday = isSchoolDay(tomorrow) ? holidays?.get(dateKey(tomorrow)) : undefined;
  if (tomorrowHoliday) plan.tomorrowHoliday = tomorrowHoliday.join(', ');
  return plan.uniform || plan.todayHoliday || plan.tomorrowHoliday ? plan : null;
}

function describeDay(day: Date, plan: DayPlan): string {
  const parts: string[] = [];
  if (plan.uniform) parts.push(`anak pakai seragam ${plan.uniform}`);
  if (plan.todayHoliday) parts.push(`hari libur ${plan.todayHoliday}, anak tidak sekolah`);
  if (plan.tomorrowHoliday) parts.push(`besok libur ${plan.tomorrowHoliday}`);
  return `${formatDate(day)}: ${parts.join('; ')}`;
}

// Returns the reminder for the given day, or null when there is nothing to send.
// holidays is null when the holiday API could not be reached.
export function buildReminder(today: Date, holidays: Holidays | null, encouragement?: string): string | null {
  const plan = planDay(today, holidays);
  if (!plan) return null;

  const lines: string[] = [];
  if (plan.todayHoliday) lines.push(`Hari ini, ${formatDate(today)}, libur: ${plan.todayHoliday}.`);
  if (plan.uniform) lines.push(`Seragam SD hari ini, ${formatDate(today)}:\n*${plan.uniform}*`);
  if (plan.tomorrowHoliday) lines.push(`Besok, ${formatDate(addDays(today, 1))}, libur: ${plan.tomorrowHoliday}. Tidak sekolah.`);
  if (!holidays && isSchoolDay(today)) lines.push('Catatan: info hari libur tidak bisa dicek hari ini.');
  if (encouragement) lines.push(encouragement);
  return lines.join('\n\n');
}

// The day's encouragement line, from the set generated for its week. Only generated
// when the holidays are known, so the week's context is right; failures just skip the line.
async function encouragementFor(ctx: ReminderContext, day: Date, holidays: Holidays | null, store: boolean): Promise<string | undefined> {
  if (!ctx.gemini || !holidays) return undefined;
  const monday = weekStart(day);
  const days: DayContext[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const plan = planDay(d, holidays);
    if (plan) days.push({ date: dateKey(d), description: describeDay(d, plan) });
  }
  try {
    const byDate = await weeklyEncouragement(dateKey(monday), days, ctx.gemini, store);
    return byDate[dateKey(day)];
  } catch (error) {
    console.error('✗ Failed to generate encouragement:', (error as Error).message);
    return undefined;
  }
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
    holidays = await fetchWeekHolidays(today);
  } catch (error) {
    console.error('✗ Failed to fetch holidays:', (error as Error).message);
    if (hour < HOLIDAY_WAIT_UNTIL_HOUR) return; // retry on the next check
  }

  if (!planDay(today, holidays)) {
    writeState({ date: key, sentTo: ctx.recipients });
    return;
  }
  const text = buildReminder(today, holidays, await encouragementFor(ctx, today, holidays, true))!;

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
    holidays = await fetchWeekHolidays(day);
  } catch (error) {
    console.error('✗ Failed to fetch holidays:', (error as Error).message);
  }
  // Only the current week's lines are saved; previews of other weeks are generated on the fly
  const sameWeek = dateKey(weekStart(day)) === dateKey(weekStart(wibToday()));
  const encouragement = planDay(day, holidays) ? await encouragementFor(ctx, day, holidays, sameWeek) : undefined;
  const reminder = buildReminder(day, holidays, encouragement) || `(Tidak ada pengingat untuk ${formatDate(day)})`;
  const selfJid = jidNormalizedUser(ctx.getSock().user!.id);
  await ctx.getSock().sendMessage(selfJid, { text: `Pratinjau pengingat:\n\n${reminder}` });
  return true;
}
