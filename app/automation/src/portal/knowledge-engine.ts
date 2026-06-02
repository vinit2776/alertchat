/**
 * Knowledge Engine — per-insurer context buckets and pre-flight gap analysis.
 *
 * Before portal automation runs, call analyzeGaps() to find out exactly which
 * fields are missing. The conversation layer asks ONLY for those fields.
 *
 * Each insurer has:
 *   knowledge/<id>/requirements.json  — declared required fields (maintained by devs)
 *   knowledge/<id>/learned.json       — fields discovered through portal failures (auto-written)
 *
 * To register a new insurer: create knowledge/<id>/requirements.json following the
 * uiic template. The engine falls back gracefully if the file doesn't exist yet.
 */

import fs   from 'fs';
import path from 'path';

// ── Types ───────────────────────────────────────────────────────────────────

export interface GapField {
  key:            string;
  label:          string;
  question:       string;
  type:           string;
  allowed_values?: string[];
  optional?:      boolean;
}

interface FieldSpec {
  key:              string;
  label:            string;
  source_priority:  string[];
  type:             string;
  ask_question:     string;
  optional?:        boolean;
  fallback?:        string;
  allowed_values?:  string[];
  skip_condition?:  string;
}

interface ComputedFieldSpec {
  key:        string;
  depends_on: string[];
  fn:         string;
}

interface ExcludedCondition {
  field:         string;
  value_pattern: string;
  message:       string;
}

interface InsurerRequirements {
  insurer_id:          string;
  version:             number;
  required_fields:     FieldSpec[];
  computed_fields:     ComputedFieldSpec[];
  optional_fields:     FieldSpec[];
  excluded_conditions: ExcludedCondition[];
}

interface LearnedFields {
  discovered_fields: (FieldSpec & { first_seen: string; occurrences: number })[];
  validation_fixes:  {
    field:         string;
    error_pattern: string;
    fix:           string;
    seen_count:    number;
  }[];
}

export interface GapAnalysis {
  insurer_id:     string;
  gaps:           GapField[];   // fields that must be asked in chat before portal attempt
  excluded:       string | null; // non-null = this insurer cannot quote this vehicle
  computed_ready: boolean;       // all computed-field dependencies are satisfied
}

// ── File helpers ─────────────────────────────────────────────────────────────

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

function loadRequirements(insurer_id: string): InsurerRequirements | null {
  try {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, insurer_id, 'requirements.json'), 'utf8');
    return JSON.parse(raw) as InsurerRequirements;
  } catch {
    return null;
  }
}

export { loadRequirements };

function loadLearned(insurer_id: string): LearnedFields {
  try {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, insurer_id, 'learned.json'), 'utf8');
    return JSON.parse(raw) as LearnedFields;
  } catch {
    return { discovered_fields: [], validation_fixes: [] };
  }
}

function saveLearned(insurer_id: string, data: LearnedFields): void {
  const dir = path.join(KNOWLEDGE_DIR, insurer_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'learned.json'), JSON.stringify(data, null, 2));
}

// ── Core gap analysis ────────────────────────────────────────────────────────

/**
 * Analyse what's missing for a given insurer before starting portal automation.
 *
 * @param insurer_id  Portal ID, e.g. "uiic"
 * @param allFields   Merged map of all known fields (OCR + chat answers)
 * @returns GapAnalysis with the list of fields that still need to be collected
 */
export function analyzeGaps(
  insurer_id: string,
  allFields:  Record<string, string>,
): GapAnalysis {
  const reqs    = loadRequirements(insurer_id);
  const learned = loadLearned(insurer_id);

  // No requirements file yet → nothing to check, let portal attempt proceed
  if (!reqs) {
    return { insurer_id, gaps: [], excluded: null, computed_ready: true };
  }

  // ── 1. Exclusion check ───────────────────────────────────────────────────
  let excluded: string | null = null;
  for (const cond of reqs.excluded_conditions) {
    const fieldVal = (allFields[cond.field] ?? '').toLowerCase();
    if (new RegExp(cond.value_pattern, 'i').test(fieldVal)) {
      excluded = cond.message;
      break;
    }
  }

  // ── 2. Merge declared + learned required fields ──────────────────────────
  // Learned fields with occurrences < 3 are treated as optional (field was seen
  // once or twice but not consistently required). Promoted to required at 3+.
  const learnedAsRequired = learned.discovered_fields
    .filter(f => f.occurrences >= 3)
    .map((f): FieldSpec => ({ ...f, optional: false }));

  const learnedAsOptional = learned.discovered_fields
    .filter(f => f.occurrences < 3)
    .map((f): FieldSpec => ({ ...f, optional: true }));

  const allRequired = [...reqs.required_fields, ...learnedAsRequired];

  // ── 3. Find gaps ─────────────────────────────────────────────────────────
  const gaps: GapField[] = [];

  for (const spec of allRequired) {
    if (spec.optional) continue;

    // Field is satisfied if it has any non-empty value
    const val = allFields[spec.key];
    if (val !== undefined && val !== '') continue;

    // Field has a fallback in requirements → won't block automation but good to ask
    // We still ask it unless it's truly optional
    if (spec.fallback !== undefined) continue;

    gaps.push({
      key:            spec.key,
      label:          spec.label,
      question:       spec.ask_question,
      type:           spec.type,
      allowed_values: spec.allowed_values,
      optional:       false,
    });
  }

  // Optionally include learned-optional fields so the AI can decide whether to ask
  for (const spec of learnedAsOptional) {
    const val = allFields[spec.key];
    if (val !== undefined && val !== '') continue;
    gaps.push({
      key:      spec.key,
      label:    spec.label,
      question: spec.ask_question,
      type:     spec.type,
      optional: true,
    });
  }

  // ── 4. Computed field readiness check ────────────────────────────────────
  const resolvedKeys = new Set([...Object.keys(allFields), ...gaps.map(g => g.key)]);
  const computed_ready = reqs.computed_fields.every(cf =>
    cf.depends_on.every(dep => resolvedKeys.has(dep) || allFields[dep] !== undefined)
  );

  return { insurer_id, gaps, excluded, computed_ready };
}

/**
 * Compute the union of gaps across all selected insurers.
 * Fields needed by at least one insurer that aren't satisfied yet are returned,
 * deduplicated by key (first insurer's question wins).
 */
export function analyzeGapsForAll(
  insurer_ids: string[],
  allFields:   Record<string, string>,
): { gaps: GapField[]; exclusions: Record<string, string> } {
  const seen       = new Map<string, GapField>();
  const exclusions: Record<string, string> = {};

  for (const id of insurer_ids) {
    const result = analyzeGaps(id, allFields);

    if (result.excluded) {
      exclusions[id] = result.excluded;
    }

    for (const gap of result.gaps) {
      if (!seen.has(gap.key)) {
        seen.set(gap.key, gap);
      }
    }
  }

  return { gaps: Array.from(seen.values()), exclusions };
}

// ── Learning loop write-backs ─────────────────────────────────────────────

/**
 * Called by the playbook runner when a portal form contains a field
 * not present in requirements.json. After 3 occurrences the field is
 * automatically treated as required in gap analysis.
 */
export function recordDiscoveredField(
  insurer_id: string,
  field: { key: string; label: string; ask_question: string; type: string },
): void {
  const learned  = loadLearned(insurer_id);
  const existing = learned.discovered_fields.find(f => f.key === field.key);

  if (existing) {
    existing.occurrences++;
  } else {
    learned.discovered_fields.push({
      key:              field.key,
      label:            field.label,
      source_priority:  ['chat'],
      type:             field.type,
      ask_question:     field.ask_question,
      first_seen:       new Date().toISOString().split('T')[0],
      occurrences:      1,
    });
  }

  saveLearned(insurer_id, learned);
}

/**
 * Called by the playbook runner when the portal shows a validation error
 * for a specific field. The fix description is stored so future runs can
 * reformat the value before submission.
 */
export function recordValidationFix(
  insurer_id: string,
  fix: { field: string; error_pattern: string; fix: string },
): void {
  const learned  = loadLearned(insurer_id);
  const existing = learned.validation_fixes.find(
    v => v.field === fix.field && v.error_pattern === fix.error_pattern,
  );

  if (existing) {
    existing.seen_count++;
  } else {
    learned.validation_fixes.push({ ...fix, seen_count: 1 });
  }

  saveLearned(insurer_id, learned);
}

/**
 * Returns known validation fixes for a field so the playbook runner can
 * reformat values before attempting to fill them.
 */
export function getValidationFixes(
  insurer_id: string,
  field_key:  string,
): { error_pattern: string; fix: string; seen_count: number }[] {
  const learned = loadLearned(insurer_id);
  return learned.validation_fixes.filter(v => v.field === field_key);
}
