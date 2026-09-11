/**
 * fixtureProvider.js — a provider that answers every generation step, offline.
 *
 * Decides: what each step "returns" during a smoke run.
 *
 * Does NOT decide: anything about real Gemini behaviour. Where it diverges from
 * provider.js, provider.js is right and this is wrong by definition.
 *
 * HOW THIS DIFFERS FROM `fakeProvider.js`, AND WHY BOTH EXIST. The fake provider returns
 * CANNED data keyed by step — perfect for a unit test asserting "given this response,
 * the code does that". It cannot build a whole kit, because a kit is internally
 * referential: questions must cite requirement ids that extraction actually produced,
 * and `verifyEvidence` drops any requirement whose evidence is not literally in the job
 * description. Canned answers fail both. This one DERIVES its answers from the input it
 * is given, so the kit it produces hangs together and passes `validateKit` for any
 * posting, which is what an end-to-end smoke run needs.
 *
 * IT READS ONLY WHAT IS INSIDE THE FENCE. `safePrompt` wraps untrusted text in a labelled
 * block preceded by an instruction header telling the model not to obey it. Reading the
 * whole `contents` string treats that header as part of the document — the first version
 * of this file did exactly that and produced six requirements quoting the injection
 * warning, every one of which `verifyEvidence` then correctly threw away. Extracting the
 * fenced body is also the closest a stub can come to imitating a model that respects the
 * boundary.
 *
 * NOT A QUALITY MODEL. The questions it writes are structurally valid and deliberately
 * bland. Nothing about output quality can be concluded from a smoke run — that is what
 * the extraction eval and the real timed run are for.
 */

/** The markers `safePrompt` wraps untrusted text in. */
const FENCED = /<<<UNTRUSTED_DATA_BEGIN>>>\n([\s\S]*?)\n<<<UNTRUSTED_DATA_END>>>/g;

/** The document, without the instruction header wrapped around it. */
function fencedBody(contents) {
  const text = String(contents ?? '');
  const blocks = [...text.matchAll(FENCED)];
  return blocks.length > 0 ? blocks.map((match) => match[1]).join('\n') : text;
}

/**
 * Lines that read like requirements.
 *
 * Bullet markers are stripped but the text is otherwise left EXACTLY as written, because
 * it is returned as `evidence` and `verifyEvidence` checks it against the real job
 * description. Paraphrasing here would make the fixture provider look like a model that
 * fabricates, and every requirement would be dropped.
 */
function requirementLines(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^[\s>]*[-•*]\s*/, '').trim())
    .filter((line) => line.length > 12 && line.length < 200)
    .filter((line) => !/^(what you will do|requirements|nice to have|about us|we are)\b/i.test(line));
}

/** Requirement ids the prompt is carrying, so questions can cite ones that exist. */
function requirementIds(text) {
  return [...new Set([...text.matchAll(/\b(r\d+)\b/g)].map((match) => match[1]))];
}

/**
 * Create the provider.
 *
 * @param {{ onCall?: (step: string) => void }} [options]
 */
export function createFixtureProvider({ onCall = () => {} } = {}) {
  const calls = [];

  return {
    name: 'fixture',
    model: 'fixture-offline',
    calls,
    callCount: () => calls.length,

    async countTokens() {
      return 100;
    },

    async complete(request) {
      const step = request.step ?? '';
      calls.push({ step, request });
      onCall(step);

      const text = fencedBody(request.contents);

      if (step === 'extract-requirements') {
        const lines = requirementLines(text).slice(0, 6);
        const requirements = (lines.length > 0 ? lines : ['General engineering ability']).map(
          (line) => ({
            text: line,
            kind: /mentor|review|collaborat|communicat|pager|on-call/i.test(line)
              ? 'behavioural'
              : /logistics|healthcare|nhs|pharmacy|freight|warehouse|routing|robotics/i.test(line)
                ? 'domain'
                : 'technical',
            priority: /\b(plus|nice|bonus|desirable|familiarity)\b/i.test(line) ? 'nice' : 'must',
            // Verbatim, or the fabrication guard drops it — see `requirementLines`.
            evidence: line,
          })
        );
        return { data: { requirements }, raw: null, text: '' };
      }

      if (step === 'extract-role-profile') {
        const firstLine = (text.split('\n').find((line) => line.trim() !== '') ?? 'Engineer').trim();
        const [title, company] = firstLine.split('—').map((part) => (part ?? '').trim());
        return {
          data: {
            title: (title || 'Engineer').slice(0, 80),
            seniority: /\bsenior\b/i.test(text) ? 'senior' : /\bjunior\b/i.test(text) ? 'junior' : 'mid',
            company: (company ?? '').replace(/\(.*$/, '').trim(),
            location: (firstLine.match(/\(([^)]+)\)/) ?? [])[1] ?? '',
            responsibilities: requirementLines(text).slice(0, 3),
          },
          raw: null,
          text: '',
        };
      }

      if (step === 'company-brief') {
        // Ungrounded when there are no pages, so the "dead company URL" case produces an
        // honestly empty brief rather than an invented one.
        const grounded = text.trim().length > 80;
        return {
          data: {
            summary: grounded
              ? 'The company publishes pages describing its product and how it works.'
              : '',
            what_they_do: grounded ? 'Software for the operations this role supports.' : '',
            grounded: grounded ? 'yes' : 'no',
          },
          raw: null,
          text: '',
        };
      }

      if (step === 'hiring-page') {
        // Ranking is the crawler's job and it is deterministic; the model's part is only
        // to confirm. Declining keeps the smoke run's hiring-page result honest rather
        // than asserting a page this stub has not read.
        return {
          data: { url: '', confidence: 0, reason: 'Offline fixture provider does not select a page.' },
          raw: null,
          text: '',
        };
      }

      if (step === 'hiring-process') {
        return {
          data: {
            has_process: 'yes',
            stages: [
              { name: 'Intro call', kind: 'screen', order: 1, focus: 'Motivation and background.' },
              // 'technical-interview', not 'technical' — the enum is hyphenated, and the
              // first draft of this file used the short form and failed validation.
              { name: 'Technical interview', kind: 'technical-interview', order: 2, focus: 'Practical depth.' },
            ],
            assessed: ['Clear communication', 'Practical judgement'],
          },
          raw: null,
          text: '',
        };
      }

      if (step.startsWith('questions:') || step === 'gap-fill') {
        const ids = requirementIds(text);
        const questions = ids.flatMap((id, index) => [
          {
            requirement_id: id,
            prompt: `Tell me about a time this came up in your work (${id}).`,
            answer_outline: 'The context, the decision taken, the trade-off, and the measured outcome.',
            difficulty: (index % 3) + 1,
          },
          {
            requirement_id: id,
            prompt: `How would you approach this from first principles (${id})?`,
            answer_outline: 'Constraints named, an approach chosen, and why the alternatives lose.',
            difficulty: ((index + 1) % 3) + 1,
          },
        ]);
        return { data: { questions }, raw: null, text: '' };
      }

      if (step === 'flashcards') {
        const ids = requirementIds(text);
        return {
          data: {
            flashcards: ids.slice(0, 6).map((id) => ({
              requirement_id: id,
              front: `What is the thing most people get wrong about ${id}?`,
              back: 'The trade-off it hides, the failure mode, and how you would notice it.',
            })),
          },
          raw: null,
          text: '',
        };
      }

      // An unknown step gets an empty object rather than a throw: a new step should show
      // up as a recorded degradation in the smoke output, not as a crashed run.
      return { data: {}, raw: null, text: '' };
    },
  };
}
