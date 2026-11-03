// api/models.js
// The one place where VitalMind names the Claude models it uses.
//
// Why this file exists: Anthropic retired claude-sonnet-4-20250514 on
// June 15, 2026. It was typed out in 12 separate places, so when it was
// retired, WhatsApp, the dashboard, the Health Investigator, evening
// summaries and evals all broke at once.
//
// When Anthropic retires a model, change the name below and nothing else.
// Upcoming dates (check https://platform.claude.com/docs/en/about-claude/model-deprecations):
//   claude-sonnet-4-6  — may be retired from Feb 17, 2027
//   claude-opus-4-6    — may be retired from Feb 5, 2027
// Anthropic emails a deprecation notice about 60 days before retiring a model.

export const MODELS = {
  // Quick, cheaper model: WhatsApp routing, text meal logging, clarifying
  // questions, follow-up replies, Health Investigator, evening summary,
  // dashboard insights, and the Claude eval judge.
  fast: 'claude-sonnet-4-6',

  // Strongest model: morning brief, photo meal logging, pattern detective,
  // on-demand insights and workout-plan analysis.
  deep: 'claude-opus-4-6',
};
