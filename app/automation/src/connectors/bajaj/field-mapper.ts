/**
 * Bajaj field mapper.
 *
 * Converts the normalised + computed field map (output of computeMotorFields)
 * into the exact Bajaj API payload structures needed by client.ts.
 *
 * Key mapping notes (from the XLS integration kit):
 *   - poltype:  1=New Business, 2=Bajaj Renewal, 3=Other-company renewal
 *   - product4digitcode: 1801=Private Car Comprehensive, 1802=2W Comprehensive
 *   - vehicletypecode:   22=Private Car, 21=Two Wheeler
 *   - deptcode: always 18 (Motor line of business)
 *   - branchcode: city-based (see ncb-tables.ts)
 *   - All dates: DD-MON-YYYY format
 *   - zone: A or B (A = major metros per city master)
 */

import {
  computeCurrentNcb,
  resolveInsurerCode,
  resolveBranchCode,
  resolveFuelCode,
  toBajajDate,
  bajajPolicyEndDate,
} from './ncb-tables';
import { lookupVehicleCode } from './vehicle-master';

// ── Vehicle type helpers ──────────────────────────────────────────────────────

function isTwoWheeler(fields: Record<string, string>): boolean {
  const vc = fields.vehicle_class ?? '';
  return (
    vc.toLowerCase().includes('motorcycle') ||
    vc.toLowerCase().includes('scooter') ||
    vc.toLowerCase().includes('two wheel') ||
    vc.toLowerCase().includes('2-wh') ||
    fields.vehicle_type_code === '3'
  );
}

function productCode(fields: Record<string, string>): string {
  const isTW = isTwoWheeler(fields);
  // OD-only requested? Use 1870 (car) / 1871 (2W). Default to comprehensive.
  return isTW ? '1802' : '1801';
}

function vehicleTypeCode(fields: Record<string, string>): number {
  return isTwoWheeler(fields) ? 21 : 22;
}

function vehicleTypeName(fields: Record<string, string>): string {
  return isTwoWheeler(fields) ? 'Two Wheeler' : 'Private Car';
}

// ── poltype logic ─────────────────────────────────────────────────────────────

function resolvePolType(fields: Record<string, string>): number {
  const bt = (fields.business_type ?? '').toLowerCase();
  if (bt === 'new' || bt === 'nb') return 1;
  // If previous insurer is Bajaj itself, use Bajaj Renewal (2)
  const prevInsurer = (fields.previous_insurer ?? '').toLowerCase();
  if (prevInsurer.includes('bajaj')) return 2;
  return 3; // other-company renewal
}

// ── Bajaj zone from registration city ────────────────────────────────────────
// UIIC uses Zone-A/Zone-B; Bajaj uses A/B.
function bajajZone(fields: Record<string, string>): string {
  const zone = fields.vehicle_zone ?? fields.zone ?? 'Zone-B';
  return zone.includes('A') ? 'A' : 'B';
}

// ── Main mapper ───────────────────────────────────────────────────────────────

export interface BajajMappedPayload {
  vehiclecode:    number | null;   // null = vehicle not in cache
  city:           string;
  weomotpolicyin: Record<string, unknown>;
  custdetails?:   Record<string, unknown>;
  motextracover:  Record<string, unknown>;
  warnings:       string[];        // non-fatal mapping issues
}

export function mapToBajajPayload(
  fields: Record<string, string>,
): BajajMappedPayload {
  const warnings: string[] = [];

  // ── Vehicle code lookup ──────────────────────────────────────────────────
  const make    = fields.make    ?? '';
  const model   = fields.model   ?? '';
  const subtype = fields.vehicle_subtype ?? fields.variant ?? '';
  const fuel    = resolveFuelCode(fields.fuel_type ?? fields.fuel ?? 'Petrol');

  const vehicleLookup = lookupVehicleCode(make, model, subtype, fuel);
  if (!vehicleLookup) {
    warnings.push(
      `Vehicle code not found for "${make} ${model} ${subtype}" (${fuel}). ` +
      'Run vehicle cache refresh or specify the exact Bajaj vehiclecode.',
    );
  }

  // ── Dates ────────────────────────────────────────────────────────────────
  const riskStartRaw = fields.risk_start_date ?? fields.previous_policy_expiry ?? '';
  const termStart    = toBajajDate(riskStartRaw) ?? toBajajDate(new Date().toLocaleDateString('en-IN')) ?? '';
  const termEnd      = bajajPolicyEndDate(termStart) ?? '';
  const regDate      = toBajajDate(fields.registration_date ?? fields.date_of_registration ?? '') ?? '';
  const prvExpiry    = toBajajDate(fields.previous_policy_expiry ?? '') ?? '';

  if (!termStart) warnings.push('Could not determine term start date');
  if (!regDate)   warnings.push('Registration date missing or invalid');

  // ── NCB ──────────────────────────────────────────────────────────────────
  const prevNcbPct    = parseInt(fields.ncb_percentage ?? fields.ncb_percent ?? '0', 10) || 0;
  const hasClaim      = (fields.claims_last_year ?? '0') !== '0';
  const currentNcb    = computeCurrentNcb(prevNcbPct, hasClaim);

  // ── Registration city ────────────────────────────────────────────────────
  // Bajaj needs the district/city name, not the RTO code.
  // The city is stored in fields.registration_city (from knowledge engine question)
  // or can be derived from rto_code as a fallback.
  const city       = (fields.registration_city ?? fields.rto_city ?? '').toUpperCase() || 'MUMBAI';
  const branchCode = resolveBranchCode(city);

  // ── Previous insurer ─────────────────────────────────────────────────────
  const polType          = resolvePolType(fields);
  const prvInsCompCode   = resolveInsurerCode(fields.previous_insurer ?? '');
  const prvPolicyRef     = fields.previous_policy_number ?? fields.prvpolicyref ?? '';

  if (polType !== 1 && !prvPolicyRef) {
    warnings.push('Previous policy number missing for renewal — required by Bajaj');
  }

  // ── IDV ──────────────────────────────────────────────────────────────────
  const idvRaw = fields.idv ? parseInt(fields.idv, 10) : 0;

  // ── weomotpolicyin ────────────────────────────────────────────────────────
  const weomotpolicyin: Record<string, unknown> = {
    contractId:          0,
    poltype:             polType,
    product4digitcode:   parseInt(productCode(fields), 10),
    deptcode:            18,
    branchcode:          branchCode,
    termstartdate:       termStart,
    termenddate:         termEnd,
    vehicletypecode:     vehicleTypeCode(fields),
    vehicletype:         vehicleTypeName(fields),
    miscvehtype:         0,
    vehiclemakecode:     vehicleLookup?.vehiclemakecode    ?? 0,
    vehiclemake:         vehicleLookup?.vehiclemake        ?? make.toUpperCase(),
    vehiclemodelcode:    vehicleLookup?.vehiclemodelcode   ?? 0,
    vehiclemodel:        vehicleLookup?.vehiclemodel       ?? model.toUpperCase(),
    vehiclesubtypecode:  vehicleLookup?.vehiclesubtypecode ?? 0,
    vehiclesubtype:      vehicleLookup?.vehiclesubtype     ?? subtype.toUpperCase(),
    fuel,
    zone:                bajajZone(fields),
    engineno:            fields.engine_number  ?? '',
    chassisno:           fields.chassis_number ?? '',
    registrationno:      (fields.registration_number ?? '').replace(/\s/g, ''),
    registrationdate:    regDate,
    registrationlocation: city,
    regilocother:        city,
    carryingcapacity:    parseInt(fields.seating_capacity ?? '5', 10),
    cubiccapacity:       parseInt(fields.cubic_capacity ?? '1298', 10),
    yearmanf:            fields.manufacturing_year ?? String(new Date().getFullYear()),
    color:               '',
    vehicleidv:          idvRaw || 0,
    ncb:                 currentNcb,
    addloading:          0,
    addloadingon:        '',
    spdiscrate:          0,
    elecacctotal:        0,
    nonelecacctotal:     0,
    prvpolicyref:        polType === 1 ? '' : prvPolicyRef,
    prvexpirydate:       polType === 1 ? '' : prvExpiry,
    prvinscompany:       polType === 1 ? 1 : prvInsCompCode,
    prvncb:              polType === 1 ? 0 : prevNcbPct,
    prvclaimstatus:      hasClaim ? '1' : '0',
    automembership:      '',
    partnertype:         'P',
  };

  // ── motextracover ─────────────────────────────────────────────────────────
  const motextracover: Record<string, unknown> = {
    geogextn:             '',
    noofpersonspa:        0,
    suminsuredpa:         0,
    suminsuredtotalnamedpa: 0,
    cngvalue:             0,
    noofemployeeslle:     0,
    noofpersonsllo:       0,
    fibreglassvalue:      0,
    sidecarvalue:         0,
    nooftrailers:         0,
    totaltrailervalue:    0,
    voluntaryexcess:      0,
    covernoteno:          '',
    covernotedate:        '',
  };

  // ── custdetails (needed for issuePolicy, not for quote) ───────────────────
  const custdetails: Record<string, unknown> | undefined =
    fields.owner_name
      ? buildCustDetails(fields)
      : undefined;

  return {
    vehiclecode:    vehicleLookup?.vehiclecode ?? null,
    city,
    weomotpolicyin,
    motextracover,
    custdetails,
    warnings,
  };
}

function buildCustDetails(fields: Record<string, string>): Record<string, unknown> {
  const fullName  = fields.owner_name ?? '';
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? '';
  const surname   = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
  const middleName = nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '';

  const dob = fields.owner_dob ?? fields.dob ?? '';

  return {
    partTempId:    '',
    firstName,
    middleName,
    surname,
    addLine1:      fields.owner_address_1 ?? fields.owner_address ?? '',
    addLine2:      fields.owner_address_2 ?? '',
    addLine3:      fields.owner_city ?? '',
    addLine5:      fields.owner_state ?? '',
    pincode:       fields.owner_pincode ?? '',
    email:         fields.owner_email ?? '',
    mobile:        fields.owner_mobile ?? '',
    polAddLine1:   fields.owner_address_1 ?? fields.owner_address ?? '',
    polAddLine2:   fields.owner_address_2 ?? '',
    polAddLine3:   fields.owner_city ?? '',
    polAddLine5:   fields.owner_state ?? '',
    polPincode:    fields.owner_pincode ?? '',
    cpType:        'P',
    dateOfBirth:   dob ? (toBajajDate(dob) ?? '') : '',
    title:         fields.owner_title ?? 'Mr',
    // PAN goes in mobileAlerts field (Bajaj's quirky field mapping)
    mobileAlerts:  fields.pan_number ?? '',
    // Aadhaar goes in availableTime field
    availableTime: fields.aadhaar_last4 ? `XXXX XXXX XXXX ${fields.aadhaar_last4}` : '',
  };
}
