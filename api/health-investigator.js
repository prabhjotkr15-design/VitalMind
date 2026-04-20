// api/health-investigator.js
// The Health Investigator Agent — VitalMind's core agentic AI.
//
// This is NOT a scheduled pipeline. It's an autonomous reasoning agent that:
// 1. Receives an event (anomaly detected in user's health data)
// 2. Forms hypotheses about what caused the anomaly
// 3. Uses tools to gather evidence (food, sleep, recovery, symptoms, past patterns)
// 4. Reasons about the evidence and decides what to check next
// 5. Communicates findings to the user (WhatsApp or email)
// 6. Stores learned patterns for future investigations
// 7. Logs every step for observability and debugging
//
// Architecture: Claude tool use API (ReAct pattern: reason → act → observe → repeat)
// Model: Sonnet 4 (cost-efficient for 5-15 tool calls per investigation)
// Safety: max 15 steps, $0.50 cost, 5 minute timeout, medical rubric enforced

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { TOOL_SCHEMAS, executeTool, postAgentMessage, getPendingMessages } from './agent-tools.js';
import { getUserTimezone } from './timezone-utils.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// =====================================================================
// Safety rails
// =====================================================================

const MAX_STEPS = 20;
const MAX_COST_USD = 0.50;
const MAX_TIME_MS = 5 * 60 * 1000; // 5 minutes
const MODEL = 'claude-sonnet-4-20250514';

// Pricing per million tokens
const PRICING = { input: 3.00, output: 15.00 };

function computeCost(inputTokens, outputTokens) {
  return (inputTokens * PRICING.input + outputTokens * PRICING.output) / 1_000_000;
}

// =====================================================================
// System prompt for the investigator
// =====================================================================

function buildSystemPrompt(userProfile, eventData, pendingMessages) {
  const conditionsText = userProfile?.conditions?.filter(c => c !== 'none').join(', ') || 'none reported';
  const dietText = userProfile?.diet?.filter(d => d !== 'none').join(', ') || 'none specified';
  const goalText = userProfile?.goal || 'overall health';

  let contextFromOtherAgents = '';
  if (pendingMessages && pendingMessages.length > 0) {
    contextFromOtherAgents = '\n\nRECENT MESSAGES FROM OTHER AGENTS (context you should be aware of):\n';
    for (const msg of pendingMessages.slice(0, 5)) {
      contextFromOtherAgents += `- [${msg.from_agent}] ${msg.message_type}: ${JSON.stringify(msg.payload)}\n`;
    }
  }

  return `You are the Health Investigator for VitalMind, a health intelligence platform for women with chronic conditions. You are investigating a health anomaly for a specific user.

USER PROFILE:
- Conditions: ${conditionsText}
- Dietary approach: ${dietText}
- Health goal: ${goalText}

ANOMALY DETECTED:
${JSON.stringify(eventData, null, 2)}
${contextFromOtherAgents}

YOUR INVESTIGATION PROCESS:
1. Start by forming a hypothesis about what might have caused this anomaly.
2. Use your tools to gather evidence. Start with the most likely cause and work outward.
3. After each piece of evidence, reason about what it tells you. Does it support or contradict your hypothesis?
4. If your hypothesis is contradicted, form a new one and gather more evidence.
5. Check past patterns — has this happened before? What was the cause then?
6. When you have enough evidence (usually 3-5 tool calls), form your conclusion.
7. Decide how to communicate: WhatsApp for timely actionable findings, email for longer detailed explanations.
8. BEFORE concluding, ALWAYS call store_pattern for any correlation you found with at least 2 data points. This is how you build memory — future investigations and morning briefs will reference your stored patterns. Do this BEFORE sending any message or concluding.

CRITICAL RULES:
1. CORRELATIONAL LANGUAGE ONLY. You are observing patterns in n=1 data. Say "was followed by", "coincided with", "tends to be associated with". NEVER say "caused", "directly leads to", "because of".
2. FRAME SUGGESTIONS AS OPTIONS. Say "you might consider", "one approach worth trying", "your data suggests". NEVER say "you must", "you need to", "eat at least X".
3. NO ALARMING LANGUAGE. Be a calm, knowledgeable companion. NEVER say "starving", "crisis", "plummeted", "your body is under attack".
4. NO DIAGNOSES. You observe patterns, you don't diagnose conditions.
5. NO MEDICATION RECOMMENDATIONS. Never suggest specific supplements, medications, or dosages.
6. REFERENCE SPECIFIC DATA. Every claim in your finding must reference a specific number, date, or data point from your tool results.
7. BE HONEST ABOUT UNCERTAINTY. If you can't find a clear cause, say so. "I checked your sleep, food, and workouts but couldn't find a clear pattern — would you say anything was different yesterday?"
8. KEEP WHATSAPP MESSAGES UNDER 500 CHARACTERS. Warm, specific, actionable.

WHEN TO USE WHICH CHANNEL:
- WhatsApp: timely findings that the user can act on today (e.g., "your late dinner pattern is back — lighter dinner tonight?")
- Email: detailed analysis that needs more context (e.g., weekly pattern summary with multiple data points)
- If you can't acquire the message lock (another agent recently messaged), store your finding — it will be incorporated into the next morning brief.

ENDING THE INVESTIGATION:
When you've communicated your finding (or stored it if you couldn't message), respond with a final text message summarizing what you found and what you learned. This will be logged as the investigation conclusion.`;
}

// =====================================================================
// Core investigation loop
// =====================================================================

export async function investigate({ userId, eventId, eventType, eventData, severity }) {
  const startTime = Date.now();
  const investigationId = crypto.randomUUID();
  let totalCost = 0;
  let stepNumber = 0;

  console.log(`[INVESTIGATOR] Starting investigation ${investigationId} for user ${userId}, event: ${eventType}, severity: ${severity}`);

  // Fetch user profile
  const { data: userProfile } = await supabase
    .from('user_profiles')
    .select('conditions, diet, goal')
    .eq('user_id', userId)
    .single();

  // Check for pending messages from other agents
  const pendingMessages = await getPendingMessages(userId, 'health_investigator');

  // Mark any pending messages as read
  if (pendingMessages.length > 0) {
    const ids = pendingMessages.map(m => m.id);
    await supabase.from('agent_messages').update({ status: 'read', read_at: new Date().toISOString() }).in('id', ids);
  }

  // Build the system prompt
  const systemPrompt = buildSystemPrompt(userProfile, eventData, pendingMessages);

  // Initialize conversation history for the tool use loop
  const messages = [
    { role: 'user', content: `Investigate this ${severity}-severity ${eventType} event. Use your tools to gather evidence, form a conclusion, and communicate your finding to the user. Begin.` }
  ];

  // Update the investigation queue status
  if (eventId) {
    await supabase.from('investigation_queue')
      .update({ status: 'running', assigned_at: new Date().toISOString() })
      .eq('event_id', eventId)
      .eq('status', 'queued');
  }

  // Link event to investigation
  if (eventId) {
    await supabase.from('agent_events')
      .update({ investigation_id: investigationId })
      .eq('id', eventId);
  }

  let finalConclusion = null;

  try {
    // === THE PLANNING LOOP ===
    while (stepNumber < MAX_STEPS) {
      // Safety: cost check
      if (totalCost >= MAX_COST_USD) {
        console.log(`[INVESTIGATOR] Cost limit reached ($${totalCost.toFixed(3)}). Stopping.`);
        await logTrace(investigationId, userId, ++stepNumber, 'safety_stop', null, null, null, 'Cost limit reached: $' + totalCost.toFixed(3), 0, 0);
        break;
      }

      // Safety: time check
      if (Date.now() - startTime > MAX_TIME_MS) {
        console.log(`[INVESTIGATOR] Time limit reached (${((Date.now() - startTime) / 1000).toFixed(0)}s). Stopping.`);
        await logTrace(investigationId, userId, ++stepNumber, 'safety_stop', null, null, null, 'Time limit reached', 0, 0);
        break;
      }

      // Call Claude with tool use
      let response;
      try {
        response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            tools: TOOL_SCHEMAS,
            messages,
          },
          {
            headers: {
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: 30000,
          }
        );
      } catch (apiError) {
        console.error(`[INVESTIGATOR] Claude API error:`, apiError.response?.status, apiError.message);
        await logTrace(investigationId, userId, ++stepNumber, 'error', null, null, null, 'Claude API error: ' + (apiError.response?.status || apiError.message), 0, 0);
        break;
      }

      const usage = response.data.usage || {};
      const stepCost = computeCost(usage.input_tokens || 0, usage.output_tokens || 0);
      totalCost += stepCost;

      const content = response.data.content || [];
      const stopReason = response.data.stop_reason;

      // Process each content block
      let hasToolUse = false;
      const toolResults = [];

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          stepNumber++;
          console.log(`[INVESTIGATOR] Step ${stepNumber}: reasoning — ${block.text.substring(0, 100)}...`);

          await logTrace(investigationId, userId, stepNumber, 'reason', null, null, null, block.text, usage.input_tokens || 0, stepCost);

          // If stop_reason is 'end_turn', this is the final conclusion
          if (stopReason === 'end_turn') {
            finalConclusion = block.text;
          }
        }

        if (block.type === 'tool_use') {
          hasToolUse = true;
          stepNumber++;
          const toolName = block.name;
          const toolInput = block.input || {};
          const toolId = block.id;

          console.log(`[INVESTIGATOR] Step ${stepNumber}: tool call — ${toolName}(${JSON.stringify(toolInput).substring(0, 100)})`);

          // Execute the tool
          let toolResult;
          try {
            toolResult = await executeTool(toolName, userId, toolInput, investigationId, { bypassCooldown: eventType === 'user_question' });
          } catch (toolError) {
            toolResult = { error: 'Tool execution failed: ' + toolError.message };
          }

          await logTrace(investigationId, userId, stepNumber, 'tool_call', toolName, toolInput, toolResult, null, 0, 0);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolId,
            content: JSON.stringify(toolResult),
          });
        }
      }

      // If Claude made tool calls, send results back and continue the loop
      if (hasToolUse && toolResults.length > 0) {
        // Add Claude's response (with tool_use blocks) to history
        messages.push({ role: 'assistant', content });
        // Add tool results
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // If Claude's stop_reason is 'end_turn' with no tool calls, investigation is complete
      if (stopReason === 'end_turn') {
        console.log(`[INVESTIGATOR] Investigation complete. ${stepNumber} steps, $${totalCost.toFixed(3)}`);
        break;
      }

      // Safety: if we get here with no tool calls and no end_turn, break to prevent infinite loop
      console.log(`[INVESTIGATOR] Unexpected stop_reason: ${stopReason}. Breaking.`);
      break;
    }

    // Log the final conclusion
    if (finalConclusion) {
      await logTrace(investigationId, userId, ++stepNumber, 'conclude', null, null, null, finalConclusion, 0, 0);
    }

    // Post a summary to the agent message bus for other agents
    await postAgentMessage('health_investigator', userId, 'investigation_complete', {
      investigation_id: investigationId,
      event_type: eventType,
      severity,
      steps: stepNumber,
      cost_usd: totalCost,
      conclusion: finalConclusion ? finalConclusion.substring(0, 500) : 'No conclusion reached',
    });

    // Update investigation queue
    if (eventId) {
      await supabase.from('investigation_queue')
        .update({ status: 'complete', completed_at: new Date().toISOString() })
        .eq('event_id', eventId);
    }

    // Log to ai_outputs for eval framework compatibility
    try {
      await supabase.from('ai_outputs').insert({
        agent_name: 'health_investigator',
        user_id: userId,
        model: MODEL,
        input_data: { eventType, eventData, severity, investigationId },
        output_text: finalConclusion || 'Investigation incomplete',
      });
    } catch (e) {
      console.error('[INVESTIGATOR] Failed to log to ai_outputs:', e.message);
    }

    return {
      investigation_id: investigationId,
      user_id: userId,
      event_type: eventType,
      severity,
      steps: stepNumber,
      cost_usd: totalCost,
      duration_ms: Date.now() - startTime,
      conclusion: finalConclusion,
      status: finalConclusion ? 'complete' : 'incomplete',
    };

  } catch (err) {
    console.error(`[INVESTIGATOR] Fatal error in investigation ${investigationId}:`, err.message);

    // Update queue status to failed
    if (eventId) {
      await supabase.from('investigation_queue')
        .update({ status: 'failed', completed_at: new Date().toISOString() })
        .eq('event_id', eventId);
    }

    await logTrace(investigationId, userId, ++stepNumber, 'error', null, null, null, 'Fatal error: ' + err.message, 0, 0);

    return {
      investigation_id: investigationId,
      user_id: userId,
      event_type: eventType,
      severity,
      steps: stepNumber,
      cost_usd: totalCost,
      duration_ms: Date.now() - startTime,
      conclusion: null,
      status: 'error',
      error: err.message,
    };
  }
}

// =====================================================================
// Trace logging — every step recorded for observability
// =====================================================================

async function logTrace(investigationId, userId, stepNumber, action, toolName, toolInput, toolResult, reasoning, tokensUsed, costUsd) {
  try {
    await supabase.from('agent_traces').insert({
      investigation_id: investigationId,
      user_id: userId,
      step_number: stepNumber,
      action,
      tool_name: toolName || null,
      tool_input: toolInput || null,
      tool_result: toolResult ? (typeof toolResult === 'string' ? { raw: toolResult } : toolResult) : null,
      reasoning: reasoning || null,
      tokens_used: tokensUsed || 0,
      cost_usd: costUsd || 0,
    });
  } catch (e) {
    console.error('[INVESTIGATOR] Failed to log trace:', e.message);
  }
}

// =====================================================================
// Pattern storage — when the agent discovers something new
// =====================================================================

export async function storePattern(userId, patternType, description, confidence, investigationId) {
  // Check if this pattern already exists
  const { data: existing } = await supabase
    .from('agent_learnings')
    .select('id, evidence_count, confidence, investigation_ids')
    .eq('user_id', userId)
    .eq('pattern_type', patternType)
    .eq('status', 'active')
    .single();

  if (existing) {
    // Update existing pattern — increase evidence count and confidence
    const newEvidenceCount = (existing.evidence_count || 1) + 1;
    const newConfidence = Math.min(0.95, confidence * 0.4 + (existing.confidence || 0.5) * 0.6);
    const ids = existing.investigation_ids || [];
    ids.push(investigationId);

    await supabase.from('agent_learnings').update({
      evidence_count: newEvidenceCount,
      confidence: newConfidence,
      last_confirmed_at: new Date().toISOString(),
      investigation_ids: ids,
    }).eq('id', existing.id);

    return { action: 'updated', id: existing.id, evidence_count: newEvidenceCount, confidence: newConfidence };
  } else {
    // Insert new pattern
    const { data: inserted } = await supabase.from('agent_learnings').insert({
      user_id: userId,
      pattern_type: patternType,
      pattern_description: description,
      confidence,
      evidence_count: 1,
      source_agent: 'health_investigator',
      investigation_ids: [investigationId],
    }).select('id').single();

    // Post to agent message bus so other agents know
    await postAgentMessage('health_investigator', userId, 'pattern_discovered', {
      pattern_type: patternType,
      description,
      confidence,
      investigation_id: investigationId,
    });

    return { action: 'created', id: inserted?.id };
  }
}
