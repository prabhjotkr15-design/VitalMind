# VitalMind AI — Evaluation Framework Architecture

**Phase:** 6A (Foundation)
**Status:** Live in production
**Last updated:** April 2026

---

## 1. What we built and why

VitalMind generates daily health briefs for women with chronic conditions (endometriosis, PCOS, thyroid). These briefs correlate food logs, WHOOP biometrics, and symptom data into actionable insights — and they're written by Claude Opus 4.6.

**The problem:** LLMs hallucinate. When the brief says "you're carrying nearly 3 hours of sleep debt" and the actual number is 48 minutes, or when it says "under-eating directly suppresses HRV" (a causal claim from n=1 data), these errors are invisible to the user because the brief sounds authoritative. We needed a system that catches these errors automatically.

**The solution:** A multi-model judge system that evaluates every morning brief against two rubrics (grounding accuracy and medical safety), stores the verdicts in a database, and flags issues for human review.

**Result:** Brief grounding score improved from 4.3/10 to 9.0/10 after implementing the summarizer and prompt hardening. False positive rate in the judge dropped from ~50% to ~5%.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│                    DATA LAYER (Supabase)                     │
│                                                             │
│  users ← user_profiles ← whoop_tokens                      │
│  food_logs    symptom_logs    pending_meals                  │
│  ai_outputs (NEW)    eval_runs (NEW)                        │
└───────────────┬─────────────────────────┬───────────────────┘
                │                         │
    ┌───────────▼──────────┐   ┌──────────▼──────────┐
    │   BRIEF WRITER       │   │   QUALITY JUDGE      │
    │   daily-brief.js     │   │   quality-check.js   │
    │                      │   │                      │
    │  Opus 4.6            │   │  Sonnet 4 + GPT-4o   │
    │  Temperature: 0      │   │  Temperature: 0       │
    │  Writes the brief    │   │  Evaluates the brief  │
    └───────────┬──────────┘   └──────────┬───────────┘
                │                         │
                │     ┌───────────┐       │
                └────►│ SUMMARIZER│◄──────┘
                      │ whoop-    │
                      │ summarizer│
                      │ .js       │
                      └───────────┘
                 SINGLE SOURCE OF TRUTH
                 (pre-computed markdown)
```

**Key design principle:** Both the brief writer (Opus) and the judges (Sonnet + GPT-4o) consume the same pre-computed markdown summary. This eliminates disagreements caused by different interpretations of raw WHOOP API data (UTC vs PST, milliseconds vs hours, etc.).

---

## 3. Components

### 3.1 The Summarizer (`api/whoop-summarizer.js`)

**What it does:** Converts raw input data (WHOOP recovery, sleep, workouts + food logs + user profile) into a clean, human-readable markdown summary.

**Key transformations:**
- All timestamps converted from UTC to PST
- All durations converted from milliseconds to "Xh Ym" format
- Percentage changes pre-computed (day-over-day, week-over-week)
- Food logs grouped by PST date with daily totals
- Each date labeled with relative reference ("yesterday", "2 days ago")
- Days since last workout computed

**Why this matters:** When both the brief writer and the judges work from the same pre-computed summary, they can't disagree about what the data says. The judges only need to verify whether the brief accurately reflects the summary — not whether the brief accurately parsed WHOOP's quirky API.

**Accepts `referenceDate` option:** When evaluating old briefs, the summarizer uses the brief's creation date as "today" instead of the wall clock. This prevents temporal grounding errors.

### 3.2 The Brief Writer (`api/daily-brief.js`)

**Model:** Claude Opus 4.6
**Temperature:** 0
**Persona:** Inflammation system specialist with expertise in endo/PCOS
**Input:** Markdown summary from the summarizer
**Output:** HTML brief with 3 sections: verdict, connected story, actions

**Prompt directives (new, post-hardening):**
1. Use ONLY numbers from the DATA SUMMARY — do not recompute
2. Use CORRELATIONAL language only ("was followed by", "coincided with")
3. Frame suggestions as OPTIONS ("you might consider", "one approach is")
4. Avoid ALARMING language ("starving", "plummeted", "crisis")
5. No medication recommendations, diagnoses, or prognoses

**Logs to:** `ai_outputs` table (input_data + output_text + model)

### 3.3 The Judge (`api/quality-check.js`)

**Models:** Claude Sonnet 4 + GPT-4o (different architecture = different blind spots)
**Temperature:** 0 (deterministic judgments)
**Granularity:** Per-paragraph (verdict, connected_story, actions evaluated separately)

**Two rubrics:**
1. **Grounding rubric** (inline in code) — does the output match the data summary? Every number, food, time, workout mentioned must exist in the summary.
2. **Medical rubric** (loaded from `api/rubrics/medical-v0.1.md`) — does the output violate clinical scope or safety guardrails?

**Combination logic:**
- Grounding score: MIN of two judges (pessimistic)
- Unsupported claims: UNION (if either flags it, it surfaces)
- Medical violations: UNION
- If judges disagree by >3 points: `disagreement_flag = true`
- If any critical violation OR disagreement: `needs_human_review = true`

**Partial failure handling:** If one judge's API fails, continue with the other. Flag `partial_run = true`.

**Cost tracking:** Token usage per judge per paragraph, computed from actual usage × model pricing.

**Stores to:** `eval_runs` table (full verdict + raw judge responses + cost)

### 3.4 Medical Rubric (`api/rubrics/medical-v0.1.md`)

**Status:** AI-drafted, reviewed by PM, NOT clinically reviewed.

**7 sections:**
1. Scope violations (no meds, no diagnoses, no prognoses, no contradicting doctors, no emergency guidance)
2. Endometriosis guardrails (no causal claims, pattern observation OK, no cycle phase without data)
3. PCOS guardrails (no specific diet claims, no weight-centric framing, no insulin resistance diagnosis)
4. Thyroid guardrails (no supplement recommendations, no thyroid function interpretation)
5. Tone guardrails (not dismissive [critical severity for endo], not alarming, not prescriptive)
6. Claim accuracy (numerical, temporal, causal vs correlational)
7. Output format for judges

**Sources:** ACOG 2026 endometriosis guideline, 2023 International PCOS Guideline (Monash/ASRM/Endocrine Society), AACE/ATA hypothyroidism guidelines.

**Each rule tagged with:** confidence level (verified/inferred/general_knowledge) + source URL.

**Action required:** OB/GYN and endocrinologist review before scaling beyond 20 users.

---

## 4. Database schema (new tables)

### `ai_outputs`
Logs every Claude call made by VitalMind agents.

| Column | Type | Description |
|---|---|---|
| id | uuid (PK) | Auto-generated |
| agent_name | text | "morning_brief", "pattern_detective", etc. |
| user_id | uuid (FK → users) | Which user |
| model | text | "claude-opus-4-6" |
| input_data | jsonb | Full input sent to Claude |
| output_text | text | Claude's response |
| created_at | timestamp | When the call was made |

Index: `(user_id, agent_name, created_at DESC)`

### `eval_runs`
Stores judge verdicts on AI outputs.

| Column | Type | Description |
|---|---|---|
| id | uuid (PK) | Auto-generated |
| ai_output_id | uuid (FK → ai_outputs) | Which output was judged |
| judge_models | text[] | ["claude-sonnet-4-20250514", "gpt-4o"] |
| grounding_score_overall | numeric | Average across paragraphs |
| paragraph_verdicts | jsonb | Per-paragraph combined verdicts |
| medical_verdicts | jsonb | All medical violations found |
| disagreement_flag | boolean | Judges disagreed by >3 points |
| needs_human_review | boolean | Critical violation or disagreement |
| raw_judge_responses | jsonb | Full raw responses + summary used |
| cost_usd | numeric | Total eval cost |
| created_at | timestamp | When the eval ran |

Indexes: `(ai_output_id)`, `(needs_human_review, created_at DESC)`

Both tables have RLS enabled with `service_role_full_access` policies.

---

## 5. How to use it

### Generate + log a brief (happens automatically every morning)
The daily brief cron job (n8n, user-configured time) calls `POST /api/daily-brief`. Each brief is automatically logged to `ai_outputs`.

### Judge a brief (on-demand)
```bash
# Judge the most recent brief for a user
curl -X POST https://vitalmindai.community/api/quality-check/brief \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "099e1efc-680d-4f15-95cd-635045d01f59"}'

# Judge a specific brief by ID
curl -X POST https://vitalmindai.community/api/quality-check/brief \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"ai_output_id": "49e9a782-7fa2-463b-bdc7-3248af2ea22d"}'
```

### View eval history in Supabase
```sql
-- All evals, most recent first
SELECT id, grounding_score_overall, needs_human_review, cost_usd, created_at
FROM eval_runs ORDER BY created_at DESC;

-- Only evals that need human review
SELECT * FROM eval_runs WHERE needs_human_review = true ORDER BY created_at DESC;

-- Average grounding score over time
SELECT DATE(created_at) as eval_date, AVG(grounding_score_overall) as avg_score
FROM eval_runs GROUP BY DATE(created_at) ORDER BY eval_date;
```

---

## 6. Cost model

| Component | Cost per eval | Notes |
|---|---|---|
| Sonnet judge (per paragraph) | ~$0.02 | 3 paragraphs × $0.02 = $0.06 |
| GPT-4o judge (per paragraph) | ~$0.015 | 3 paragraphs × $0.015 = $0.045 |
| **Total per brief eval** | **~$0.10-0.18** | Depends on brief length |
| **Weekly (7 briefs)** | **~$0.70-1.26** | |
| **Monthly (30 briefs)** | **~$3-5.40** | |

At 100 daily active users with daily briefs: ~$300-540/month for full eval coverage. At 1,000 DAU: sample 10% for ~$300-540/month.

---

## 7. Results

### Before Phase 6A (raw data to Opus, no eval)
- Brief grounding: unmeasured, estimated 4-5/10
- Fabricated numbers: common (sleep debt, calorie totals, percentages)
- Medical violations: frequent (causal claims, prescriptive language, alarming tone)
- No audit trail

### After Phase 6A
- Brief grounding: **9.0/10** (measured)
- Fabricated numbers: **0** critical, 2 minor
- Medical violations: **1** minor (borderline correlational phrasing)
- Full audit trail in eval_runs with raw judge responses

---

## 8. Known limitations

1. **On-demand only.** Eval doesn't run automatically after every brief. Automation is Phase 6B.
2. **Only morning_brief.** Pattern detective, food analyzer, and symptom parser are not yet logged or evaluated.
3. **Medical rubric is not clinically reviewed.** v0.1 is AI-drafted. Must get OB/GYN sign-off before production scale.
4. **Two judges, not three.** Adding Gemini as a third judge (tiebreaker) is Phase 6B.
5. **No XLSX export yet.** Currently JSON only. Excel export planned for Phase 6B.
6. **PST hardcoded.** All timezone conversions assume -7 UTC. Multi-timezone support requires user timezone in profile.
7. **Paragraph parser is regex-based.** If Opus changes its HTML structure (e.g., uses `<div>` instead of `<p>`), the parser falls back to whole-brief mode.

---

## 9. Roadmap

### Phase 6B (next)
- [ ] Automated eval after every brief (judge runs as a post-step in daily-brief.js)
- [ ] Log pattern-detective and food-analyzer to ai_outputs
- [ ] XLSX export endpoint for eval history
- [ ] Weekly eval summary email to PM
- [ ] Add Gemini as third judge (tiebreaker)
- [ ] Trend dashboard (grounding score over time, violation frequency by type)

### Phase 6C (later)
- [ ] Consistency check: re-run same meals through food analyzer, measure variance
- [ ] Clinical rubric v1.0 after OB/GYN review
- [ ] Auto-rollback: if grounding drops below 6 for 3 consecutive briefs, revert to previous prompt
- [ ] Safety check: separate agent that reviews all outbound messages for emergency signals

---

## 10. File inventory

| File | Purpose |
|---|---|
| `api/whoop-summarizer.js` | Shared summarizer — converts raw data to clean markdown |
| `api/quality-check.js` | Judge module — runs Sonnet + GPT-4o evaluations |
| `api/rubrics/medical-v0.1.md` | Medical safety rubric with clinical sources |
| `api/daily-brief.js` | Morning brief writer (now uses summarizer) |
| `api/index.js` | Route: `POST /api/quality-check/brief` (CRON_SECRET protected) |

---

## 11. Key design decisions and rationale

| Decision | Rationale |
|---|---|
| Different model for judge vs writer | Avoids recursive bias. Opus writes, Sonnet+GPT-4o judge. |
| Temperature 0 for both | Deterministic outputs. Same brief judged twice = same verdict. |
| Pre-computed summary instead of raw data | Eliminates unit conversion errors (ms→hours, UTC→PST). Both writer and judges see identical ground truth. |
| Per-paragraph evaluation | More precise than whole-brief. Identifies which section needs improvement. Costs ~3x more but worth it at current scale. |
| MIN grounding (pessimistic) | If either judge flags something, we surface it. Better to over-flag than to miss. |
| UNION of violations | Same principle — false positives are cheaper than false negatives for health content. |
| Fail open on partial judge failure | If one API is down, we still get partial eval. Better than no eval. |
| Medical rubric in separate .md file | Clinician can review without reading code. Versioned separately. |
| referenceDate for temporal grounding | Evaluating old briefs uses the brief's creation date as "today", not the eval date. |

---

**Document maintained by:** Prabhjot (PM) + Claude (AI pair)
**Last verified against production:** April 15, 2026
