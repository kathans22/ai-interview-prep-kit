/**
 * scoreRoutes.js — score an answer a person typed to one of their own kit's questions.
 *
 * Decides: the order — own the kit, find the question, score, record — what is recorded,
 * and how many model calls one scoring request may spend.
 *
 * Does NOT decide: what an answer is judged against, or how. That is core's `scoreAnswer`,
 * the feature's separate module. Nor what a missed requirement does to practice.
 *
 * THE CALL HAPPENS HERE BECAUSE ONLY THE SERVER CAN MAKE IT. The provider is injected and
 * the limiter configured at boot; the browser has neither, and must never hold a key.
 *
 * SAME LIMITER, SAME KIND OF BUDGET, SAME RATE LIMIT AS EVERYTHING ELSE. The call goes
 * through `completeStructured` (the process-wide limiter, retry, repair accounting), is
 * charged to a per-request budget exactly as a regeneration is, and the route is mounted
 * behind the generation rate limit shared with kit creation and regeneration — because it
 * spends from the same daily quota.
 *
 * WHAT IS RECORDED IS THE VERDICT, NOT THE ANSWER. Per requirement: hit, missed or
 * unjudged. That is what practice needs to find weak areas; storing the person's typed
 * prose would buy nothing the feature uses.
 *
 * RECORDED ONLY WHEN SCORING SUCCEEDED. A failed call is not evidence of a weak area, and
 * recording it would push practice cards forward because Google was busy.
 *
 * BESIDE THE KIT, NOT IN IT, and taking no revision — for the reasons practice ratings do:
 * a verdict is not an edit, and a regeneration must never be able to delete it. The write
 * still bumps the revision, which the response returns, so the client's ledger follows it
 * and the person's next edit is not refused as stale.
 */

import { STEP, scoreAnswer } from '@aipk/core/scoring/scoreAnswer.js';
import { createBudget } from '@aipk/core/llm/budget.js';

import { route, ApiError } from './errors.js';
import { validateScoreAnswer } from './validate.js';
import { requireAuth, withOwnedKit } from '../auth/requireAuth.js';

/** One call and its one repair. A scoring request can never spend more. */
export const SCORE_BUDGET = 2;

/** Keep the record bounded; a kit is not an answer archive. */
const MAX_SCORES = 1000;

export function mountScoreRoutes(app, { rateLimit = (request, response, next) => next() } = {}) {
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
        throw new ApiError('KIT_NOT_READY', 'This kit has not finished building yet, so it has no questions to answer.');
      }

      const { answer } = validateScoreAnswer(request.body);

      const questionId = String(request.params.questionId ?? '');
      const question = (kitDoc.kit.questions ?? []).find((entry) => entry.id === questionId);
      if (!question) {
        throw new ApiError('NOT_FOUND', `No question with id "${questionId}" in this kit.`);
      }

      if ((kitDoc.scores ?? []).length >= MAX_SCORES) {
        throw new ApiError('VALIDATION_FAILED', `This kit already holds ${MAX_SCORES} scored answers.`);
      }

      const budget = createBudget(SCORE_BUDGET);
      let result;
      try {
        result = await scoreAnswer(
          { question, requirements: kitDoc.kit.role?.requirements ?? [], answer },
          { provider: request.deps.provider, spend: () => budget.spend(`${STEP}:${questionId}`) }
        );
      } catch (error) {
        // Re-raised with its code and a readable message only. A generation error carries
        // its underlying cause in `details`, and that belongs in the log, not a response.
        throw new ApiError(
          typeof error?.code === 'string' ? error.code : 'GENERATION_UNAVAILABLE',
          String(error?.message ?? 'The answer could not be scored.').replace(new RegExp(`^${STEP}:\\s*`), ''),
          error?.details?.reason ? { details: { reason: error.details.reason } } : {}
        );
      }

      const entry = {
        questionId,
        verdicts: result.requirements.map((requirement) => ({ requirementId: requirement.id, verdict: requirement.verdict })),
        hitRequirementIds: result.hitRequirementIds,
        missedRequirementIds: result.missedRequirementIds,
        at: new Date(),
      };

      const updated = await request.store.kits.write({ kitId, push: { scores: entry } });

      response.json({
        id: kitId,
        revision: updated.revision,
        result,
        budget: budget.report(),
      });
    })
  );

  return app;
}
