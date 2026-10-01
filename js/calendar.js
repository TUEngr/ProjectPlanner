// Working-day calendar. Dates are handled as integer "day numbers" (days since
// 1970-01-01, UTC) to avoid time-zone and DST problems. Tasks are scheduled in
// "working-day indices": index 0 is the first working day on or after the
// project start; negative indices are working days before it.

const MS_PER_DAY = 86400000;
const MAX_STEPS = 100000; // guard against runaway loops (~380 years of workdays)

export function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const n = Date.UTC(+m[1], +m[2] - 1, +m[3]) / MS_PER_DAY;
  return toISO(n) === m[0] ? n : null; // rejects 2026-02-30 etc.
}

export function toISO(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function todayDay() {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY;
}

// 0 = Sunday ... 6 = Saturday. Day 0 (1970-01-01) was a Thursday.
export function dayOfWeek(n) {
  return (((n + 4) % 7) + 7) % 7;
}

export class Calendar {
  constructor(startISO, holidays = []) {
    this.origin = parseISO(startISO);
    if (this.origin === null) throw new Error(`Invalid project start date: ${startISO}`);
    this.holidays = new Set();
    for (const h of holidays) {
      const n = parseISO(h.date);
      if (n !== null) this.holidays.add(n);
    }
    this.fwd = []; // fwd[i]  = day number of working index i (i >= 0)
    this.back = []; // back[k] = day number of working index -(k+1)
  }

  isWorkday(n) {
    const dow = dayOfWeek(n);
    return dow !== 0 && dow !== 6 && !this.holidays.has(n);
  }

  // Working index -> day number.
  day(i) {
    if (i >= 0) {
      while (this.fwd.length <= i) {
        let n = this.fwd.length ? this.fwd[this.fwd.length - 1] + 1 : this.origin;
        n = this._step(n, +1);
        this.fwd.push(n);
      }
      return this.fwd[i];
    }
    const k = -i - 1;
    while (this.back.length <= k) {
      let n = (this.back.length ? this.back[this.back.length - 1] : this.origin) - 1;
      n = this._step(n, -1);
      this.back.push(n);
    }
    return this.back[k];
  }

  // Day number -> working index of the first working day on or after it.
  index(n) {
    if (n >= this.day(0)) {
      let i = 0;
      while (this.day(i) < n) {
        if (++i > MAX_STEPS) throw new Error('Date too far from project start');
      }
      return i;
    }
    let i = 0;
    while (this.day(i - 1) >= n) {
      if (--i < -MAX_STEPS) throw new Error('Date too far from project start');
    }
    return i;
  }

  _step(n, dir) {
    for (let s = 0; !this.isWorkday(n); s++) {
      if (s > MAX_STEPS) throw new Error('No working days found');
      n += dir;
    }
    return n;
  }
}
