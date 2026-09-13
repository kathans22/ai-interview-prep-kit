/**
 * scoreRoutes.js — score a typed answer against the question it answers.
 *
 * Decides: that scoring is a POST to this kit's question, which question and requirements
 * are sent, how the result is recorded, and that scoring costs quota so it is limited
 * alongside creation and regeneration.
 *
 * Does NOT decide: how an answer is judged (`scoreAnswer` in core decides — the prompt,
 * the fence around the user's text, the response schema and its validation), what a
 * practice entry means (`practiceRoutes.js`), or what the practice order becomes. This
 * route validates, calls core, and records the result.
 *
 * SCORING SPENDS QUOTA. One scoring call is one model call against the same daily ceiling
 * as a build step, so it shares the generation limiter and carries its own small budget —
 * one call, plus the one repair `completeStructured` may make. A user clicking "score"
 * twenty times must not cost a day of quota, but two calls is the ceiling a single score
 * can honestly need.
 *
 * THE SCORE IS RECORDED IN THE PRACTICE LOG, as a question rating: a scored answer is
 * practice (the person tried the question), the model's 1–5 score sits on the same scale
 * the question ratings already use, and the log is where the practice ordering already
 * reads. `missedRequirements` — the requirement ids behind the missed outline points —
 * rides along on the same entry, and is what the practice deck later pulls cards forward
 * for. A rating takes no revision: recording that you practised cannot conflict.
 */

import { scoreAnswer } from '@aipk/core/generation/scoreAnswer.js';
import { createBudget } from '@aipk/core/llm/budget.js';

import { route, ApiError } from './errors.js';
import { validateScoredAnswer } from './validate.js';
import { requireAuth, withOwnedKit } from '../auth/requireAuth.js';
import { MAX_RATINGS } from './practiceRoutes.js';

/**
 * The most model calls one scoring request may spend: the score, plus the one repair
 * attempt `completeStructured` is allowed. Smaller than a regeneration's budget on
 * purpose — a score is one judgement, not content.
 */
const SCORE_BUDGET = 2;

export function mountScoreRoutes(app, { rateLimit = (req, res, next) => next() } = {}) {
  /**
   * POST /api/kits/:id/questions/:questionId/score — { answer }
   */
  app.post(
    '/api/kits/:id/questions/:questionId/score',
    requireAuth,
    rateLimit,
    withOwnedKit(),
    route(async (request, response) => {
      const kitDoc = request.kit;
      const kitId = String(kitDoc.id ?? kitDoc._id);

      if (!kitDoc.kit) {
        throw new ApiError('KIT_NOT_READY', 'This kit has not finished building yet.');
      }

      const { answer } = validateScoredAnswer(request.body);
      const questionId = String(request.params?.questionId ?? '').trim();

      // The question must exist in THIS kit, and scoring runs only against what the kit
      // already holds — its own outline, and the text of the requirements it covers.
      const question = (kitDoc.kit.questions ?? []).find((item) => item.id === questionId);
      if (!question) {
        throw new ApiError('VALIDATION_FAILED', `No question with id "${questionId}" in this kit.`);
      }

      const requirementIds = Array.isArray(question.requirement_ids) ? question.requirement_ids : [];
      const requirements = (kitDoc.kit.role?.requirements ?? [])
        .filter((item) => requirementIds.includes(item.id))
        .map(({ id, text, priority }) => ({ id, text, priority }));

      // --- score (the only step that can fail expensively) -------------------
      const budget = createBudget(SCORE_BUDGET);
      let result;
      try {
        result = await scoreAnswer({
          provider: request.deps.provider,
          question,
          requirements,
          userAnswer: answer,
          spend: () => budget.spend('score-answer'),
        });
      } catch (error) {
        // The kit is untouched — scoring reads it and never writes content. Say what the
        // model could not do; the user's typed answer is theirs to retry with.
        throw new ApiError(
          error.code ?? 'GENERATION_UNAVAILABLE',
          `The answer could not be scored: ${error.message}`
        );
      }

      if ((kitDoc.practice ?? []).length >= MAX_RATINGS) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `This kit already holds ${MAX_RATINGS} practice entries, which is more than a person can have meant.`
        );
      }

      const entry = {
        questionId,
        confidence: result.score,
        note: 'Scored answer',
        missedRequirements: result.weakRequirementIds,
        at: new Date(),
      };

      // Appended beside the kit, like every practice entry — no revision check, because
      // recording that someone practised cannot conflict with an edit or a regeneration.
      const updated = await request.store.kits.write({
        kitId,
        push: { practice: entry },
      });

      response.status(201).json({
        recorded: entry,
        questionId,
        score: result.score,
        hits: result.hits,
        misses: result.misses,
        improvement: result.improvement,
        weakRequirementIds: result.weakRequirementIds,
        revision: updated.revision,
      });
    })
  );

  return app;
}
