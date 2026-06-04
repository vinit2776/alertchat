/**
 * Bajaj Allianz General Insurance — REST API client.
 *
 * Wraps the three main endpoints from TP WLS_REST_MOTOR_NEW.xls:
 *   - calculateMotorPremiumSig  → compute premium, returns transactionId
 *   - issuePolicy               → issue with AGENT_FLOAT, returns policyNumber
 *   - policypdfdownload         → download policy PDF as base64
 *   - getAllVehicleMaster        → vehicle master data for code lookup
 *   - getAllVehicleMake          → vehicle makes list
 *
 * Credentials are read from config at call time so hot-reload in dev works.
 * All dates are in DD-MON-YYYY format (Bajaj's requirement).
 */

import { config } from '../../config/env';

// ── Endpoint constants ────────────────────────────────────────────────────────

const UAT_BASE  = 'https://webservicesint.bajajallianz.com/BjazMotorWebservice';
const PROD_BASE = 'https://api.bagicpt.bajajallianz.com/ext/motor/aggregatorsrvc/BjazMotorWebservice';
const PDF_UAT   = 'https://devapivault.bajajallianz.com/sandbox/BjazDownloadPDFWs/policypdfdownload';
const PDF_PROD  = 'https://webservices.bajajallianz.com/BjazDownloadPDFWs/policypdfdownload';

function baseUrl()   { return config.bajaj.useProd ? PROD_BASE : UAT_BASE;  }
function pdfUrl()    { return config.bajaj.useProd ? PDF_PROD  : PDF_UAT;   }
function authBody()  {
  return {
    userid:   config.bajaj.userId,
    password: config.bajaj.password,
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function post<T>(path: string, body: object): Promise<T> {
  const url  = `${baseUrl()}/${path}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Bajaj API ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bajaj API ${path} returned non-JSON: ${text.slice(0, 300)}`);
  }

  // Bajaj returns errorcode: 0 on success, non-zero on failure
  const errorCode = json.errorcode ?? json.pErrorCode_out ?? json.errorCode;
  if (errorCode !== undefined && String(errorCode) !== '0') {
    const errors = json.errorlist ?? json.pError_out ?? [];
    const msg = Array.isArray(errors) && errors.length
      ? errors.map((e: any) => e.errormessage ?? e.errorMessage ?? JSON.stringify(e)).join('; ')
      : `Bajaj error code ${errorCode}`;
    throw new Error(`Bajaj API error: ${msg}`);
  }

  return json as T;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BajajPremiumResponse {
  transactionid:         number;
  premiumdetails?:       {
    totalpremium?:       number;
    odpremium?:          number;
    tppremium?:          number;
    ncbamount?:          number;
    servicetaxamount?:   number;
    vehicleidv?:         number;
  };
  premiumsummerylist?:   unknown[];
  errorcode:             number;
  errorlist?:            { errormessage: string }[];
}

export interface BajajIssueResponse {
  ppolicyref_out:        string;   // policy number e.g. OG-26-1801-00000001
  ppolicyissuedate_out?: string;
  ppartId_out?:          string;
  errorcode:             number;
  errorlist?:            { errormessage: string }[];
}

export interface BajajVehicleMakeEntry {
  vehiclemakecode: number;
  vehiclemake:     string;
}

export interface BajajVehicleMasterEntry {
  vehiclecode:        number;
  vehiclemakecode:    number;
  vehiclemake:        string;
  vehiclemodelcode:   number;
  vehiclemodel:       string;
  vehiclesubtypecode: number;
  vehiclesubtype:     string;
  fuel:               string;
  cubiccapacity:      number;
}

// ── Public API methods ────────────────────────────────────────────────────────

/** Step 1: Compute premium. Returns transactionId + premium breakdown. */
export async function calculatePremium(params: {
  vehiclecode:       number;
  city:              string;
  weomotpolicyin:    Record<string, unknown>;
  motextracover?:    Record<string, unknown>;
  paddoncoverlist?:  unknown[];
  transactionid?:    number;   // pass to recompute (IDV change)
}): Promise<BajajPremiumResponse> {
  return post<BajajPremiumResponse>('calculatemotorpremiumsig', {
    ...authBody(),
    vehiclecode:      params.vehiclecode,
    city:             params.city,
    weomotpolicyin:   params.weomotpolicyin,
    motextracover:    params.motextracover ?? {},
    paddoncoverlist:  params.paddoncoverlist ?? [],
    accessorieslist:  [],
    questlist:        [],
    detariffobj:      {},
    premiumdetails:   {},
    premiumsummerylist: [],
    errorlist:        [],
    errorcode:        0,
    transactionid:    params.transactionid ?? 0,
  });
}

/** Step 2: Issue policy (AGENT_FLOAT). Returns policy number. */
export async function issuePolicy(params: {
  transactionid:   number;
  custdetails:     Record<string, unknown>;
  weomotpolicyin:  Record<string, unknown>;
  premiumdetails:  unknown;
  premiumsummerylist: unknown[];
  motextracover?:  Record<string, unknown>;
}): Promise<BajajIssueResponse> {
  return post<BajajIssueResponse>('issuepolicy', {
    ...authBody(),
    transactionid:      params.transactionid,
    paymentmode:        'AGENT_FLOAT',
    ppremiumpayerid:    0,
    custdetails:        params.custdetails,
    weomotpolicyin:     params.weomotpolicyin,
    accessorieslist:    [],
    paddoncoverlist:    [],
    motextracover:      params.motextracover ?? {},
    premiumdetails:     params.premiumdetails,
    premiumsummerylist: params.premiumsummerylist,
    questlist:          [],
    potherdetails:      {},
    pMotDetariff:       {},
    rcptlist:           [],
    errorlist:          [],
    errorcode:          0,
  });
}

/** Download policy PDF. Returns base64-encoded PDF bytes. */
export async function downloadPolicyPdf(policyNumber: string): Promise<string> {
  const url = pdfUrl();
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify({
      ...authBody(),
      pdfmode:   'WS_POLICY_PDF',
      policynum: policyNumber,
    }),
  });

  const data: any = await res.json();
  return data.policyPdfByteArray ?? data.pdfdocument ?? '';
}

/** Fetch all vehicle makes for a product code. */
export async function getAllVehicleMakes(productcode: string): Promise<BajajVehicleMakeEntry[]> {
  const res: any = await post('getallvehiclemake', {
    ...authBody(),
    productcode,
  });
  return res.vehiclemakelist ?? res.vehicleMakeList ?? [];
}

/** Fetch full vehicle master for a make + product combination. */
export async function getAllVehicleMaster(
  productcode: string,
  vehiclemake:  string,
): Promise<BajajVehicleMasterEntry[]> {
  const res: any = await post('getallvehiclemaster', {
    ...authBody(),
    productcode,
    vehiclemake,
  });
  return res.vehiclemasterlist ?? res.vehicleMasterList ?? [];
}
