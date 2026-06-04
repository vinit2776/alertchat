/**
 * Bajaj Allianz static lookup tables derived from Motor Integration Kit XLS.
 *
 * Sources:
 *   - NCB table:            "NCB and PREV NCB" sheet
 *   - Insurer codes:        "Prev Insurance Company Codes" sheet
 *   - Branch codes:         derived from branch code master (Mumbai=1901 as default)
 *   - Date formatter:       Bajaj uses DD-MON-YYYY (01-JAN-2025), not DD/MM/YYYY
 */

// ── NCB escalation table ─────────────────────────────────────────────────────
// prevNcb (%) → currentNcb (%) when no claim on prior policy
const NCB_ESCALATION: Record<number, number> = {
  0:  20,
  20: 25,
  25: 35,
  35: 45,
  45: 50,
  50: 50,
};

/**
 * Compute the current NCB percentage to send to Bajaj.
 * @param prevNcbPct  - The NCB from the previous policy (0-50)
 * @param hasClaim    - true if a claim was lodged under the previous policy
 */
export function computeCurrentNcb(prevNcbPct: number, hasClaim: boolean): number {
  if (hasClaim) return 0;
  return NCB_ESCALATION[prevNcbPct] ?? (prevNcbPct >= 50 ? 50 : 20);
}

// ── Previous insurance company codes ─────────────────────────────────────────
// Maps common insurer name fragments → Bajaj company code
export const PREV_INSURER_CODES: { name: string; code: number }[] = [
  { name: 'New India',          code: 1  },
  { name: 'Tata AIG',           code: 2  },
  { name: 'United India',       code: 3  },
  { name: 'UIIC',               code: 3  },
  { name: 'National Insurance', code: 4  },
  { name: 'Oriental',           code: 5  },
  { name: 'Bajaj Allianz',      code: 6  },
  { name: 'Bajaj',              code: 6  },
  { name: 'ICICI Lombard',      code: 8  },
  { name: 'IFFCO Tokio',        code: 9  },
  { name: 'Reliance',           code: 10 },
  { name: 'Royal Sundaram',     code: 11 },
  { name: 'HDFC ERGO',          code: 12 },
  { name: 'Cholamandalam',      code: 13 },
  { name: 'Future Generali',    code: 17 },
  { name: 'Universal Sompo',    code: 18 },
  { name: 'Shriram',            code: 20 },
  { name: 'Bharti AXA',         code: 21 },
  { name: 'SBI General',        code: 24 },
  { name: 'Acko',               code: 33 },
  { name: 'Go Digit',           code: 34 },
  { name: 'Digit',              code: 34 },
];

/**
 * Fuzzy-match an insurer name to its Bajaj company code.
 * Returns 1 (New India) as a safe default if no match is found.
 */
export function resolveInsurerCode(name: string): number {
  if (!name) return 1;
  const lower = name.toLowerCase();
  for (const entry of PREV_INSURER_CODES) {
    if (lower.includes(entry.name.toLowerCase())) return entry.code;
  }
  return 1; // New India as safe default
}

// ── Branch code lookup ────────────────────────────────────────────────────────
// Maps registration city (uppercase) → Bajaj branch code.
// This is a partial list covering major cities. For unlisted cities the default
// is 1901 (Mumbai branch) which Bajaj supports as a fallback for brokers.
const BRANCH_CODES: Record<string, number> = {
  MUMBAI:       1901,
  NAVI_MUMBAI:  1901,
  THANE:        1901,
  DELHI:        1101,
  NEW_DELHI:    1101,
  BENGALURU:    2101,
  BANGALORE:    2101,
  CHENNAI:      3101,
  HYDERABAD:    4101,
  PUNE:         2601,
  AHMEDABAD:    2401,
  KOLKATA:      3201,
  JAIPUR:       2201,
  LUCKNOW:      2301,
  CHANDIGARH:   1201,
  BHOPAL:       2701,
  PATNA:        3401,
  INDORE:       2701,
  NAGPUR:       1901,
  COIMBATORE:   3101,
  KOCHI:        3301,
  COCHIN:       3301,
  SURAT:        2401,
  VADODARA:     2401,
  BARODA:       2401,
  VISAKHAPATNAM: 4101,
};

/**
 * Resolve city name → Bajaj branch code.
 * Normalises the city string before lookup.
 */
export function resolveBranchCode(city: string): number {
  if (!city) return 1901;
  const normalised = city.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return BRANCH_CODES[normalised] ?? BRANCH_CODES[city.toUpperCase()] ?? 1901;
}

// ── Fuel code mapping ─────────────────────────────────────────────────────────
// Bajaj fuel codes: P=Petrol, D=Diesel, C=CNG, L=LPG, E=Electric
export function resolveFuelCode(fuelType: string): string {
  const lower = fuelType.toLowerCase();
  if (lower.includes('diesel'))                    return 'D';
  if (lower.includes('cng') || lower.includes('compressed')) return 'C';
  if (lower.includes('lpg'))                       return 'L';
  if (lower.includes('electric') || lower.includes('ev'))    return 'E';
  return 'P'; // default Petrol
}

// ── Date formatter ────────────────────────────────────────────────────────────
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

/**
 * Convert any date string (DD/MM/YYYY or YYYY-MM-DD) to Bajaj format DD-MON-YYYY.
 * Returns null if the input cannot be parsed.
 */
export function toBajajDate(input: string): string | null {
  if (!input) return null;

  let d: Date | null = null;

  // DD/MM/YYYY
  let m = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    d = new Date(year, parseInt(m[2]) - 1, parseInt(m[1]));
  }

  // YYYY-MM-DD
  if (!d) {
    m = input.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  }

  if (!d || isNaN(d.getTime())) return null;

  const dd  = String(d.getDate()).padStart(2, '0');
  const mon = MONTHS[d.getMonth()];
  const yy  = d.getFullYear();
  return `${dd}-${mon}-${yy}`;
}

/**
 * Add one year to a date string and return in Bajaj format.
 * Used to compute termEndDate = termStartDate + 1 year - 1 day.
 */
export function bajajPolicyEndDate(startDateStr: string): string | null {
  const m = startDateStr.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/);
  if (!m) return null;
  const monIdx = MONTHS.indexOf(m[2]);
  const d = new Date(parseInt(m[3]), monIdx, parseInt(m[1]));
  // End date = start + 1 year - 1 day
  d.setFullYear(d.getFullYear() + 1);
  d.setDate(d.getDate() - 1);
  return `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}
