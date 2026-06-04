/**
 * Bajaj vehicle master cache.
 *
 * Bajaj requires a numeric vehiclecode derived from the combination of:
 *   Make (e.g. MARUTI) + Model (e.g. SWIFT) + SubType/Variant (e.g. LXI) + Fuel (P/D/C)
 *
 * The master has thousands of entries and must be fetched from Bajaj's API.
 * We cache it locally as JSON (refreshed on demand or scheduled daily).
 *
 * Cache file: portal/knowledge/bajaj/vehicle-master-cache.json
 *
 * Before credentials are available, the cache is empty and lookup() returns null
 * with a clear message. Once credentials are set, call refreshCache() to populate.
 */

import fs   from 'fs';
import path from 'path';
import { getAllVehicleMakes, getAllVehicleMaster, BajajVehicleMasterEntry } from './client';

// ── Cache file ────────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(__dirname, '../../../portal/knowledge/bajaj/vehicle-master-cache.json');

interface VehicleMasterCache {
  refreshedAt: string;                        // ISO timestamp
  entries:     BajajVehicleMasterEntry[];
}

let _memory: VehicleMasterCache | null = null;

function loadCache(): VehicleMasterCache {
  if (_memory) return _memory;
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    _memory   = JSON.parse(raw);
    return _memory!;
  } catch {
    return { refreshedAt: '', entries: [] };
  }
}

function saveCache(cache: VehicleMasterCache): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  _memory = cache;
}

// ── Vehicle code lookup ────────────────────────────────────────────────────────

interface LookupResult {
  vehiclecode:        number;
  vehiclemakecode:    number;
  vehiclemodelcode:   number;
  vehiclesubtypecode: number;
  vehiclemake:        string;
  vehiclemodel:       string;
  vehiclesubtype:     string;
  fuel:               string;
}

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Look up a vehicle code by make + model + subtype + fuel.
 * Subtype matching is fuzzy — falls back to the first entry for make+model+fuel
 * if the subtype doesn't match exactly (many RCs don't include the variant).
 */
export function lookupVehicleCode(
  make:     string,
  model:    string,
  subtype:  string,
  fuel:     string,
): LookupResult | null {
  const cache   = loadCache();
  if (!cache.entries.length) return null;

  const nMake    = normalize(make);
  const nModel   = normalize(model);
  const nSubtype = normalize(subtype);
  const nFuel    = fuel.toUpperCase().slice(0, 1);  // P/D/C/L/E

  // Exact match
  const exact = cache.entries.find(e =>
    normalize(e.vehiclemake)    === nMake &&
    normalize(e.vehiclemodel)   === nModel &&
    normalize(e.vehiclesubtype) === nSubtype &&
    e.fuel.toUpperCase() === nFuel,
  );
  if (exact) return toResult(exact);

  // Make + model + fuel match (ignore subtype — common when RC only has make/model)
  const loose = cache.entries.find(e =>
    normalize(e.vehiclemake)  === nMake &&
    normalize(e.vehiclemodel) === nModel &&
    e.fuel.toUpperCase() === nFuel,
  );
  if (loose) return toResult(loose);

  // Partial model match (e.g. "SWIFT DZIRE" vs "SWIFT")
  const partial = cache.entries.find(e =>
    normalize(e.vehiclemake).includes(nMake) &&
    (normalize(e.vehiclemodel).includes(nModel) || nModel.includes(normalize(e.vehiclemodel))) &&
    e.fuel.toUpperCase() === nFuel,
  );
  if (partial) return toResult(partial);

  return null;
}

function toResult(e: BajajVehicleMasterEntry): LookupResult {
  return {
    vehiclecode:        e.vehiclecode,
    vehiclemakecode:    e.vehiclemakecode,
    vehiclemodelcode:   e.vehiclemodelcode,
    vehiclesubtypecode: e.vehiclesubtypecode,
    vehiclemake:        e.vehiclemake,
    vehiclemodel:       e.vehiclemodel,
    vehiclesubtype:     e.vehiclesubtype,
    fuel:               e.fuel,
  };
}

// ── Cache refresh ─────────────────────────────────────────────────────────────

/**
 * Refresh the local vehicle master cache from Bajaj's API.
 * Fetches all makes first, then fetches the full master per make.
 * Call this once after credentials are configured, then on a daily schedule.
 *
 * Product codes:
 *   1801 = Private Car (Comprehensive)
 *   1802 = Two Wheeler (Comprehensive)
 */
export async function refreshVehicleCache(
  productCodes: string[] = ['1801', '1802'],
  onProgress?: (msg: string) => void,
): Promise<{ added: number; errors: string[] }> {
  const allEntries: BajajVehicleMasterEntry[] = [];
  const errors: string[] = [];

  for (const productCode of productCodes) {
    try {
      onProgress?.(`Fetching vehicle makes for product ${productCode}…`);
      const makes = await getAllVehicleMakes(productCode);

      for (const makeEntry of makes) {
        try {
          const master = await getAllVehicleMaster(productCode, makeEntry.vehiclemake);
          allEntries.push(...master);
        } catch (err: any) {
          errors.push(`${makeEntry.vehiclemake}: ${err.message}`);
        }
      }
    } catch (err: any) {
      errors.push(`product ${productCode}: ${err.message}`);
    }
  }

  const cache: VehicleMasterCache = {
    refreshedAt: new Date().toISOString(),
    entries:     allEntries,
  };
  saveCache(cache);

  onProgress?.(`Vehicle cache refreshed: ${allEntries.length} entries saved`);
  return { added: allEntries.length, errors };
}

/** Returns cache metadata (age, entry count). */
export function getCacheStatus(): { refreshedAt: string; entryCount: number; staleHours: number } {
  const cache = loadCache();
  const ageMs = cache.refreshedAt
    ? Date.now() - new Date(cache.refreshedAt).getTime()
    : Infinity;
  return {
    refreshedAt: cache.refreshedAt || 'never',
    entryCount:  cache.entries.length,
    staleHours:  Math.floor(ageMs / 3_600_000),
  };
}
