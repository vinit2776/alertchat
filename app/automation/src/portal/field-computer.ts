/**
 * Derives the computed.* fields that motor playbooks need from raw confirmed fields.
 * Called in quote.routes.ts before runPlaybook so every playbook sees a consistent
 * enriched field map regardless of which portal is being filled.
 *
 * Source namespaces after this call:
 *   rc.*       → original OCR fields (registration_date, make, model, …)
 *   chat.*     → fields collected during conversation (ncb_percent, idv, …)
 *   computed.* → derived here (vehicle_type_code, cc_band, vehicle_zone, …)
 *
 * The playbook runner strips the namespace prefix before looking up in this map,
 * so all three namespaces live flat in the same Record<string, string>.
 */

// ── Zone lookup ──────────────────────────────────────────────────────────────
// Zone-A: major metros (population ≥ ~15 lakh). All others = Zone-B.
// Source: IRDAI circular + UIIC rating manual.
const ZONE_A_PREFIXES = new Set([
  'DL',       // Delhi (all)
  'MH01','MH02','MH03','MH04','MH05','MH06',   // Mumbai / Thane / Navi Mumbai
  'MH12','MH13','MH14',                          // Pune
  'KA01','KA02','KA03','KA04','KA05',            // Bangalore
  'TN01','TN02','TN03','TN04','TN05',            // Chennai
  'TN06','TN07','TN08','TN09','TN22',            // Chennai suburbs / kancheepuram
  'WB01','WB02','WB03','WB04','WB05','WB06',     // Kolkata
  'TS01','TS02','TS03','TS04','TS05',             // Hyderabad (Telangana)
  'AP01','AP02','AP03',                           // old AP / Vijayawada zone
  'GJ01','GJ05',                                  // Ahmedabad / Surat
  'RJ14',                                         // Jaipur
]);

function rtoToZone(rtoOrRegNum: string): string {
  // Accept full reg number like "TN07DD0877" or just "TN07"
  const upper = rtoOrRegNum.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix4 = upper.slice(0, 4);  // e.g. "TN07"
  const prefix2 = upper.slice(0, 2);  // e.g. "TN"

  if (ZONE_A_PREFIXES.has(prefix4)) return 'Zone-A';
  if (prefix2 === 'DL') return 'Zone-A';   // any Delhi plate
  return 'Zone-B';
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function parseDate(s: string): Date | null {
  if (!s) return null;
  // DD/MM/YYYY or DD-MM-YYYY
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
    return new Date(year, parseInt(mo) - 1, parseInt(d));
  }
  // YYYY-MM-DD
  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(parseInt(y), parseInt(mo) - 1, parseInt(d));
  }
  // Try native parse as last resort
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDDMMYYYY(d: Date): string {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ── KW band mapping ──────────────────────────────────────────────────────────
// UIIC cubicCapacity select option values when battery-operated is checked.
function kwBand(kwStr: string): string {
  const kw = parseFloat(kwStr);
  if (isNaN(kw) || kw > 65) return '100';   // Exceeding 65 KW (most modern EVs)
  if (kw <= 3)               return '3';
  if (kw <= 7)               return '7';
  if (kw <= 16)              return '16';
  if (kw <= 30)              return '30';
  if (kw <= 65)              return '65';
  return '100';
}

// ── IDV calculation ───────────────────────────────────────────────────────────
// Computes a conservative IDV estimate when the user hasn't provided one.
// Formula: approx_exshowroom × depreciation_factor
//
// Approximate exshowroom prices (conservative lower-bound) by CC band (₹):
//   Two-wheeler: ≤1000cc ~ ₹80k, Petrol car: ≤1000cc ~ ₹5L, 1001-1500 ~ ₹8L, >1500 ~ ₹15L
// We use the lower bound so the depreciated IDV stays below even the cheapest vehicle
// in that band, avoiding UIIC's "IDV cannot exceed exshowroom price" error.
//
// IRDAI motor depreciation schedule (for IDV calculation):
//   Not exceeding 6 months : 5%
//   6 months – 1 year      : 15%
//   1–2 years              : 20%
//   2–3 years              : 30%
//   3–4 years              : 40%
//   4–5 years              : 50%
//   > 5 years              : negotiated (use ~60%)
//
// We set IDV = exshowroom × (1 - depreciation%) and round down to nearest 10,000.
// This gives a safe default well below the cap.

function irdaiDepreciationFactor(ageMonths: number): number {
  if (ageMonths <= 6)  return 0.95;
  if (ageMonths <= 12) return 0.85;
  if (ageMonths <= 24) return 0.80;
  if (ageMonths <= 36) return 0.70;
  if (ageMonths <= 48) return 0.60;
  if (ageMonths <= 60) return 0.50;
  return 0.40;
}

function approxExshowroom(isTwoWheeler: boolean, ccBandVal: string, rawCc?: number): number {
  if (isTwoWheeler) {
    // Use actual CC if available to differentiate commuters vs premium bikes
    const cc = rawCc ?? 0;
    if (cc > 300) return 160_000;  // ~₹1.6L (RE Meteor 350, KTM Duke, etc.)
    if (cc > 150) return 110_000;  // ~₹1.1L (Bajaj Pulsar 200, Honda CB300, mid-range)
    return 70_000;                 // ~₹70k (entry scooters, commuter 100-150cc)
  }
  // Private car — conservative lower bounds per CC band
  if (ccBandVal === '1000') return 500_000;   // ~₹5L (e.g. old Maruti Alto 800 ~₹3.5-5L)
  if (ccBandVal === '1500') return 800_000;   // ~₹8L (e.g. Maruti Swift base ~₹6-8L)
  return 1_500_000;                           // ~₹15L (e.g. Creta base ~₹11-15L)
}

export function computeDefaultIdv(
  registrationDateStr: string,
  isTwoWheeler: boolean,
  ccBandVal: string,
  rawCc?: number,  // optional: actual cubic capacity from OCR (improves two-wheeler base price)
): number {
  const regDate = parseDate(registrationDateStr);
  const today   = new Date();
  const ageMonths = regDate
    ? Math.max(0, (today.getFullYear() - regDate.getFullYear()) * 12
                + (today.getMonth()   - regDate.getMonth()))
    : 36; // safe fallback: assume 3 years old

  const exshow   = approxExshowroom(isTwoWheeler, ccBandVal, rawCc);
  const factor   = irdaiDepreciationFactor(ageMonths);
  const raw      = exshow * factor;
  // Round down to nearest 10,000 for a clean, conservative figure
  return Math.floor(raw / 10_000) * 10_000;
}

// ── CC band mapping ──────────────────────────────────────────────────────────
// Private car bands (UIIC #cubicCapacity option values when vehicleType=18):
//   1000="Up to 1000 CC", 1500="1001 to 1500 CC", 2000="Exceeding 1500 CC"
function ccBandCar(ccStr: string): string {
  const cc = parseFloat(ccStr.replace(/[^0-9.]/g, ''));
  if (isNaN(cc)) return '1500';
  if (cc <= 1000) return '1000';
  if (cc <= 1500) return '1500';
  return '2000';
}

// Two-wheeler bands (UIIC #cubicCapacity option values when vehicleType=3):
//   70="Less Than 75 CC", 150="76-150 CC", 350="151-350 CC", 400="Exceeding 350 CC"
function ccBandTwoWheeler(ccStr: string): string {
  const cc = parseFloat(ccStr.replace(/[^0-9.]/g, ''));
  if (isNaN(cc)) return '150';   // default: most common commuter range
  if (cc <= 75)  return '70';
  if (cc <= 150) return '150';
  if (cc <= 350) return '350';
  return '400';
}

// Legacy alias used before vehicle_type_code is known
function ccBand(ccStr: string): string {
  return ccBandCar(ccStr);
}

// ── Main export ──────────────────────────────────────────────────────────────

export function computeMotorFields(raw: Record<string, string>): Record<string, string> {
  const f: Record<string, string> = { ...raw };

  const fuelType     = (f.fuel_type ?? '').toLowerCase();
  const vehicleClass = (f.vehicle_class ?? '').toLowerCase();
  const regNum       = (f.registration_number ?? f.reg_number ?? '').toUpperCase();

  // ── registration_date fallback ─────────────────────────────────────────────
  // If the user provided manufacturing_year (e.g. "2023") but not registration_date
  // (which the portal requires as DD/MM/YYYY), derive a plausible default.
  // We use Jan 1 of the manufacturing year — not perfectly accurate but prevents
  // the "missing required field: Date of Registration" portal error.
  // The chat should ideally collect the exact date, but this is a safe fallback.
  if (!f.registration_date && !f.date_of_registration) {
    const yr = f.manufacturing_year ?? f.year_of_manufacture ?? '';
    const yearNum = parseInt(yr.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(yearNum) && yearNum >= 1990 && yearNum <= new Date().getFullYear()) {
      f.registration_date = `01/01/${yearNum}`;
    }
  }

  // ── is_electric ────────────────────────────────────────────────────────────
  if (!f.is_electric) {
    if (fuelType.includes('electric') || fuelType === 'ev' || fuelType.includes('battery')) {
      f.is_electric = 'true';
    }
  }

  // ── vehicle_type_code ──────────────────────────────────────────────────────
  // UIIC vehicleType select values: 18=Private Car, 3=Motorcycle/Scooter
  if (!f.vehicle_type_code) {
    const isTwoWheeler =
      vehicleClass.includes('motorcycle') || vehicleClass.includes('m-cycle') ||
      vehicleClass.includes('scooter')    || vehicleClass.includes('two wheel') ||
      vehicleClass.includes('2-wh')       || vehicleClass.includes('2wh');
    f.vehicle_type_code = isTwoWheeler ? '3' : '18';
  }

  // ── cc_band ────────────────────────────────────────────────────────────────
  // For electric: KW band option value. For ICE: CC band option value.
  // IMPORTANT: UIIC's #cubicCapacity select has DIFFERENT option values depending on
  // vehicle type:
  //   Two-wheeler (type=3):  70/150/350/400  (Less Than 75 / 76-150 / 151-350 / >350 CC)
  //   Private car  (type=18): 1000/1500/2000 (Up to 1000 / 1001-1500 / >1500 CC)
  //   EV (battery-operated): 3/7/16/30/65/100 (KW bands)
  if (!f.cc_band) {
    if (f.is_electric === 'true') {
      const kw = f.kilowatt ?? f.kw ?? f.kw_rating ?? '';
      f.cc_band = kw ? kwBand(kw) : '100';   // default Exceeding 65 KW for modern EVs
    } else {
      const cc = f.cubic_capacity ?? f.cc ?? f.engine_cc ?? '';
      const isTwoWheeler = f.vehicle_type_code === '3';
      if (isTwoWheeler) {
        f.cc_band = cc ? ccBandTwoWheeler(cc) : '150';  // default 76-150 CC
      } else {
        f.cc_band = cc ? ccBandCar(cc) : '1500';        // default 1001-1500 CC
      }
    }
  }

  // ── business_type ──────────────────────────────────────────────────────────
  if (!f.business_type) {
    const hasPrevPolicy =
      !!(f.previous_policy_expiry || f.policy_end || f.ncb_percentage || f.ncb_percent);
    f.business_type = hasPrevPolicy ? 'Renewal' : 'New';
  }

  // ── risk_start_date ────────────────────────────────────────────────────────
  // UIIC expects DD/MM/YYYY. Start = day after previous policy expiry, or today.
  if (!f.risk_start_date) {
    const prevExpiryStr = f.previous_policy_expiry ?? f.policy_end ?? '';
    const prevExpiry    = parseDate(prevExpiryStr);
    if (prevExpiry && !isNaN(prevExpiry.getTime())) {
      const nextDay = new Date(prevExpiry);
      nextDay.setDate(nextDay.getDate() + 1);
      f.risk_start_date = formatDDMMYYYY(nextDay);
    } else {
      f.risk_start_date = formatDDMMYYYY(new Date());
    }
  }

  // ── vehicle_zone ───────────────────────────────────────────────────────────
  if (!f.vehicle_zone) {
    // If rto_code is only a 2-char state code (e.g. "TN"), fall back to the full
    // registration number so rtoToZone can extract the 4-char district prefix.
    const rtoCodeRaw = f.rto_code ?? '';
    const rtoForZone = rtoCodeRaw.replace(/[^A-Za-z0-9]/g, '').length >= 4
      ? rtoCodeRaw
      : (regNum || rtoCodeRaw);
    f.vehicle_zone = rtoToZone(rtoForZone);
  }

  // ── ncb_percent (normalise ncb_percentage alias) ───────────────────────────
  // playbook reads from chat.ncb_percent → looks up "ncb_percent" key
  if (!f.ncb_percent && f.ncb_percentage) {
    f.ncb_percent = f.ncb_percentage.replace('%', '').trim();
  }

  // ── normalise date formats to DD/MM/YYYY ───────────────────────────────────
  // OCR often returns DD-MM-YYYY or YYYY-MM-DD. Portal forms expect DD/MM/YYYY.
  // Normalise all date fields so the playbook runner always gets the right format.
  const dateFields = [
    'registration_date', 'date_of_registration',
    'policy_start', 'policy_end', 'previous_policy_expiry',
    'manufacturing_date',
  ] as const;
  for (const df of dateFields) {
    if (f[df]) {
      const parsed = parseDate(f[df]);
      if (parsed && !isNaN(parsed.getTime())) {
        f[df] = formatDDMMYYYY(parsed);
      }
    }
  }

  // ── idv default ────────────────────────────────────────────────────────────
  // Auto-compute a conservative IDV if the user hasn't provided one.
  // Prevents "IDV cannot exceed exshowroom price" errors from portal validation.
  // The user can override by passing idv in chat.idv.
  if (!f.idv && f.is_electric !== 'true') {
    const regDateStr = f.registration_date ?? f.date_of_registration ?? '';
    const isTwoWheeler = f.vehicle_type_code === '3';
    const band = f.cc_band ?? '1500';
    // Pass raw CC so two-wheeler IDV uses a better base price (RE 349cc vs basic 110cc)
    const rawCcNum = parseFloat((f.cubic_capacity ?? f.cc ?? '').replace(/[^0-9.]/g, ''));
    const computed_idv = computeDefaultIdv(regDateStr, isTwoWheeler, band, isNaN(rawCcNum) ? undefined : rawCcNum);
    if (computed_idv > 0) {
      f.idv = String(computed_idv);
      f.idv_auto_computed = 'true';  // flag so callers can show "estimated IDV" to user
    }
  }

  return f;
}
