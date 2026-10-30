// Lesson timetable of SD Muhammadiyah Pahandut, school year 2026/2027
// (from "JADWAL PELAJARAN T.A. 2026-2027.pdf"), for the classes our kids are in.
// Daily routines (Tahfiz, shalat, breaks) are left out.

// "Pekan n" in the timetable notes = the n-th occurrence of that weekday in the month
type Lesson = string | ((week: number) => string | null);

interface ClassDay {
  lessons: Lesson[];
  dismissal?: string;
}

const muhadasah = (week: number) => `Muhadasah ${week === 2 || week === 4 ? 'B. Inggris' : 'B. Arab'}`;
// Garasi (Gerakan Rabu Literasi): class A in weeks 1 & 3, class B in weeks 2 & 4
const garasi = (classLetter: 'A' | 'B') => (week: number) =>
  (classLetter === 'A' ? week === 1 || week === 3 : week === 2 || week === 4) ? 'Garasi' : null;

// Keyed by class, then by day of week (1 = Monday ... 5 = Friday)
const SCHEDULE: Record<string, Record<number, ClassDay>> = {
  '2B': {
    1: { lessons: ['Matematika', 'B. Inggris', 'B. Indonesia'], dismissal: '13.45' },
    2: { lessons: ['Al-Islam', 'Pancasila', 'Seni', 'B. Indonesia'], dismissal: '13.45' },
    3: { lessons: ['PJOK', garasi('B'), 'B. Indonesia', 'Matematika'], dismissal: '13.45' },
    4: { lessons: ['Pancasila', 'KMD', 'B. Arab', 'B. Indonesia'], dismissal: '13.45' },
    5: { lessons: ['Kokurikuler', 'B. Dayak'], dismissal: '10.15' }
  },
  '4A': {
    1: { lessons: ['Al-Islam', 'B. Indonesia', 'B. Arab', muhadasah] },
    2: { lessons: ['PJOK', 'IPAS', 'Pancasila', muhadasah] },
    3: { lessons: ['B. Dayak', garasi('A'), 'Matematika', 'B. Inggris'] },
    4: { lessons: ['KMD', 'Matematika', 'IPAS'] },
    5: { lessons: ['Seni', 'Kokurikuler/IT', 'Pengembangan Diri'], dismissal: '13.15' }
  }
};

export interface ClassPlan {
  className: string;
  lessons: string[];
  dismissal?: string;
  bringSportswear: boolean;
}

export function classPlans(day: Date): ClassPlan[] {
  const week = Math.ceil(day.getUTCDate() / 7);
  const plans: ClassPlan[] = [];
  for (const [className, days] of Object.entries(SCHEDULE)) {
    const classDay = days[day.getUTCDay()];
    if (!classDay) continue;
    const lessons = classDay.lessons
      .map(lesson => typeof lesson === 'function' ? lesson(week) : lesson)
      .filter((lesson): lesson is string => !!lesson);
    plans.push({ className, lessons, dismissal: classDay.dismissal, bringSportswear: lessons.includes('PJOK') });
  }
  return plans;
}
