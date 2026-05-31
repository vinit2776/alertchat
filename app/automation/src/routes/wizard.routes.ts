import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { getSession } from '../ai/conversation';
import { logEvent } from '../audit/logger';
import { InsurancePreference, ClaimsInfo } from '../types';

const router = Router();

// Required fields per insurance type (wizard knows exactly what's needed)
const REQUIRED: Record<string, string[]> = {
  motor:    ['registration_number', 'make', 'model', 'manufacturing_year',
             'fuel_type', 'ncb_percentage', 'previous_policy_expiry',
             'owner_mobile', 'owner_email'],
  health:   ['member_count', 'eldest_age', 'cover_type', 'sum_insured', 'tenure'],
  property: ['property_type', 'property_address', 'built_up_area', 'property_value', 'owner_mobile'],
  travel:   ['destination', 'departure_date', 'return_date', 'traveller_count', 'passport_numbers'],
};

// ── POST /api/wizard/:sessionId ────────────────────────────────────────────
// Submit all wizard data at once — no Claude API call needed.
// Merges OCR fields + manual overrides + claims-derived fields,
// then moves the session to 'confirming' if all required fields are present.
router.post('/:sessionId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    const state = getSession(sessionId);
    if (!state) {
      res.status(404).json({ success: false, message: 'Session not found' });
      return;
    }
    if (state.userId !== user.sub) {
      res.status(403).json({ success: false, message: 'Not your session' });
      return;
    }

    const {
      claimsInfo,
      preferences = [],
      manualFields = {},
    } = req.body as {
      claimsInfo:    ClaimsInfo;
      preferences:   InsurancePreference[];
      manualFields?: Record<string, string>;
    };

    if (!claimsInfo) {
      res.status(400).json({ success: false, message: 'claimsInfo is required' });
      return;
    }

    // ── Merge fields: OCR → manual overrides ──────────────────────────────
    const merged: Record<string, string> = {
      ...state.extractedFields,
      ...manualFields,
    };

    // ── Derive NCB from claims ─────────────────────────────────────────────
    if (claimsInfo.hasClaim) {
      merged.ncb_percentage   = '0';
      merged.has_previous_claim = 'true';
      if (claimsInfo.claimCount != null)  merged.claim_count  = String(claimsInfo.claimCount);
      if (claimsInfo.totalAmount != null) merged.claim_amount = String(claimsInfo.totalAmount);
    } else {
      merged.has_previous_claim = 'false';
      // Keep NCB from OCR or manualFields; if still absent, leave for the portal
    }

    // ── Store in session ───────────────────────────────────────────────────
    for (const [k, v] of Object.entries(merged)) {
      state.collectedFields[k] = v;
    }
    state.confirmedFields = { ...state.extractedFields, ...state.collectedFields };
    state.preferences     = preferences;
    state.claimsInfo      = claimsInfo;

    // ── Check what's still missing ─────────────────────────────────────────
    const required = REQUIRED[state.insuranceType] ?? [];
    state.missingRequired = required.filter(f => !state.confirmedFields[f]);

    state.status    = state.missingRequired.length === 0 ? 'confirming' : 'collecting';
    state.updatedAt = Date.now();

    logEvent({
      userId:    user.sub,
      userEmail: user.email,
      sessionId,
      action:    'fields_confirmed',
      outcome:   state.missingRequired.length === 0 ? 'success' : 'pending',
      meta: {
        fieldCount:   Object.keys(state.confirmedFields).length,
        missingCount: state.missingRequired.length,
        missing:      state.missingRequired,
        preferences,
        hasClaim:     claimsInfo.hasClaim,
        mode:         'wizard',
      },
    });

    res.json({
      success:        true,
      confirmedFields: state.confirmedFields,
      missing:        state.missingRequired,
      status:         state.status,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
