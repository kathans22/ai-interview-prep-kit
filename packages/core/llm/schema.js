/**
 * schema.js — builders for the response schemas every generation step declares.
 *
 * Decides: the shape vocabulary. Nothing else spells a schema type by hand.
 *
 * Does NOT decide: what any step asks for. Each generation module owns its own schema;
 * this only supplies the pieces.
 *
 * WHY THIS EXISTS. The schema dialect is an OpenAPI subset whose `type` field is an
 * ENUM — "STRING", "OBJECT", "ARRAY" in upper case — not a free string. Lowercase
 * `type: 'object'` looks right, passes every local test (the fake provider never reads
 * a schema) and is rejected by the API on the first real call. That is the worst kind
 * of bug for this project: it costs a request from a daily budget to discover, and it
 * discovers itself at the moment the run matters. Building schemas through these
 * helpers makes the casing impossible to get wrong.
 *
 * KEEP SCHEMAS FLAT. The dialect does not take unions or oneOf cleanly. Arrays of flat
 * objects are fine and are what every step here uses. A field that might be absent is
 * modelled as an empty string, not as a nullable union — "" is a value the model can
 * return and the code can check, where a union is a parse failure waiting to happen.
 */

import { Type } from '@google/genai';

/** The enum, re-exported so callers never import the SDK directly. */
export const SCHEMA_TYPES = Object.freeze({
  STRING: Type.STRING,
  INTEGER: Type.INTEGER,
  NUMBER: Type.NUMBER,
  BOOLEAN: Type.BOOLEAN,
  ARRAY: Type.ARRAY,
  OBJECT: Type.OBJECT,
});

/** A string field. `description` is instruction the model actually reads — use it. */
export function str(description, extra = {}) {
  return { type: SCHEMA_TYPES.STRING, description, ...extra };
}

/** A string constrained to a fixed set. Enum values must match the contract exactly. */
export function enumOf(values, description) {
  return { type: SCHEMA_TYPES.STRING, enum: [...values], description };
}

/** An integer field, optionally bounded in the description (the dialect ignores min/max). */
export function int(description, extra = {}) {
  return { type: SCHEMA_TYPES.INTEGER, description, ...extra };
}

export function bool(description) {
  return { type: SCHEMA_TYPES.BOOLEAN, description };
}

/** An array of `items`. */
export function arrayOf(items, description) {
  return { type: SCHEMA_TYPES.ARRAY, items, description };
}

/**
 * An object with required properties.
 *
 * Every property is listed as required by default: an optional field in this dialect
 * means the model may simply omit it, and a step that then reads `undefined` fails far
 * from the cause. Explicit empty strings are better than absent keys.
 */
export function object(properties, { required, description } = {}) {
  return {
    type: SCHEMA_TYPES.OBJECT,
    properties,
    required: required ?? Object.keys(properties),
    description,
  };
}

/**
 * Assert a schema uses only the shapes this dialect accepts.
 *
 * Called by the generation modules' own tests rather than at runtime — a malformed
 * schema is a coding error, and finding it in a test costs nothing while finding it in
 * a live call costs a request from the daily ceiling.
 *
 * @returns {string[]} problems, empty when the schema is usable
 */
export function checkSchema(schema, path = '$') {
  const problems = [];
  if (!schema || typeof schema !== 'object') {
    return [`${path}: not an object`];
  }

  const validTypes = Object.values(SCHEMA_TYPES);
  if (!validTypes.includes(schema.type)) {
    problems.push(
      `${path}: type must be one of ${validTypes.join(', ')} — got ${JSON.stringify(schema.type)}`
    );
  }

  for (const forbidden of ['oneOf', 'anyOf', 'allOf', 'not', '$ref']) {
    if (forbidden in schema) problems.push(`${path}: "${forbidden}" is not supported by this dialect`);
  }

  if (schema.type === SCHEMA_TYPES.OBJECT) {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      problems.push(`${path}: an object schema needs properties`);
    }
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      problems.push(...checkSchema(value, `${path}.${key}`));
    }
    for (const key of schema.required ?? []) {
      if (!(key in (schema.properties ?? {}))) {
        problems.push(`${path}: required lists "${key}", which is not a property`);
      }
    }
  }

  if (schema.type === SCHEMA_TYPES.ARRAY) {
    if (!schema.items) problems.push(`${path}: an array schema needs items`);
    else problems.push(...checkSchema(schema.items, `${path}[]`));
  }

  return problems;
}
