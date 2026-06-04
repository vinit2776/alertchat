// ── Insurance types ────────────────────────────────────────────────────────

export type InsuranceType = 'motor' | 'health' | 'property' | 'travel';

// ── Knowledge engine ───────────────────────────────────────────────────────

export interface GapField {
  key:             string;
  label:           string;
  question:        string;
  type:            string;
  allowed_values?: string[];
  optional?:       boolean;
}

// ── Document OCR ───────────────────────────────────────────────────────────

export type DocumentType = 'RC' | 'PAN' | 'AADHAAR' | 'DRIVING_LICENCE' | 'POLICY' | 'OTHER';

export interface ExtractedDocument {
  docType:    DocumentType;
  fields:     Record<string, string>;   // field name → extracted value
  confidence: number;                   // 0–1
  rawText:    string;
}

// ── Insurance company registry ─────────────────────────────────────────────

export interface InsuranceCompany {
  id:                  string;
  name:                string;
  logoUrl:             string;
  portalUrl:           string;
  insuranceTypes:      InsuranceType[];
  playbookVersion:     string;
  enabled:             boolean;
  credentialSecretKey: string;
  lastTestedAt:        string | null;
  createdAt:           string;
  updatedAt:           string;
}

// ── Session state machine ──────────────────────────────────────────────────

export type SessionStatus =
  | 'collecting'    // gathering fields via chat
  | 'confirming'    // user reviewing collected fields
  | 'filling'       // browser automation filling form
  | 'complete'      // quote generated
  | 'error';        // something went wrong

export type InsurancePreference =
  | 'cheapest_premium'
  | 'private_insurer'
  | 'govt_insurer'
  | 'cashless_network'
  | 'higher_idv'
  | 'addon_zero_dep'
  | 'addon_engine_protect'
  | 'addon_rsa'
  | 'addon_personal_accident';

export interface ClaimsInfo {
  hasClaim:        boolean;
  claimCount?:     number;
  totalAmount?:    number;   // ₹
}

export interface SessionState {
  sessionId:       string;
  userId:          string;
  insuranceType:   InsuranceType;
  selectedCompanies: string[];          // portal IDs to quote from
  extractedFields: Record<string, string>;   // from document OCR
  collectedFields: Record<string, string>;   // from chat Q&A or wizard
  confirmedFields: Record<string, string>;   // after user confirmation
  missingRequired: string[];
  currentStep:     string;
  status:          SessionStatus;
  preferences?:    InsurancePreference[];    // from wizard
  claimsInfo?:     ClaimsInfo;              // from wizard
  createdAt:       number;
  updatedAt:       number;
}

// ── Quote results ──────────────────────────────────────────────────────────

export interface QuoteResult {
  id:           string;
  sessionId:    string;
  userId:       string;
  portalId:     string;
  portalName:   string;
  insType:      InsuranceType;
  regNumber:    string | null;
  vehicleMake:  string | null;
  vehicleModel: string | null;
  premium:      number | null;
  idv:          number | null;
  quoteData:    Record<string, unknown>;
  screenshotKey: string | null;
  createdAt:    string;
  expiresAt:    string;
}

// ── Audit events ───────────────────────────────────────────────────────────

export type AuditAction =
  | 'session_start'
  | 'document_uploaded'
  | 'ocr_complete'
  | 'ocr_failed'
  | 'field_collected_chat'
  | 'fields_confirmed'
  | 'browser_context_assigned'
  | 'browser_context_queued'
  | 'portal_login'
  | 'form_step_filled'
  | 'form_step_failed'
  | 'quote_generated'
  | 'quote_failed'
  | 'session_end'
  | 'admin_action';

export type AuditOutcome = 'success' | 'failure' | 'pending';

export interface AuditEvent {
  id?:           string;
  ts?:           string;
  userId:        string;
  userEmail:     string;
  sessionId:     string;
  portalId?:     string;
  insType?:      InsuranceType;
  action:        AuditAction;
  outcome:       AuditOutcome;
  durationMs?:   number;
  meta?:         Record<string, unknown>;
}

// ── JWT payload (mirrors backend) ─────────────────────────────────────────

export type UserRole = 'super_admin' | 'chat_user';

export interface JwtPayload {
  sub:      string;
  username: string;
  email:    string;
  role:     UserRole;
  iat?:     number;
  exp?:     number;
}
