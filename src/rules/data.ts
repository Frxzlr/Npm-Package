import type { Rule } from '../types.js';
import { code } from '../util.js';
import { defineRule, finding, locate } from './helpers.js';

const HTML_AS_JSON =
  /Unexpected token '?<'?.*(?:JSON|<!DOCTYPE|<html)|"<!DOCTYPE|"<html|<!doctype/i;

function isJsonError(message: string): boolean {
  return /JSON|Unexpected end of JSON input/.test(message);
}

export const jsonParseHtml = defineRule({
  id: 'json-parse-html',
  summary:
    'JSON.parse()/res.json() received an HTML page (error page, login redirect, SPA fallback)',
  diagnose(error, ctx) {
    if (
      error.name !== 'SyntaxError' ||
      !isJsonError(error.message) ||
      !HTML_AS_JSON.test(error.message)
    ) {
      return undefined;
    }
    const viaFetch = error.frames.some(
      (f) => /undici|fetch/i.test(f.file) || /Response|Body/.test(f.fn ?? ''),
    );
    return finding({
      title: 'Expected JSON but received an HTML page',
      explanation:
        `The text starts with ${code('<')}: it's HTML, not JSON${viaFetch ? ' (from a fetch response)' : ''}. ` +
        "The server most likely returned an error page (404/500), a login page or redirect, or a dev server's index.html fallback for an unknown route.",
      fixes: [
        `Check ${code('res.ok')} and ${code("res.headers.get('content-type')")} before calling ${code('res.json()')}`,
        `Log the body to see the page: ${code('console.log(await res.text())')}`,
        'Double-check the URL (typos, missing /api prefix, wrong port, dev-proxy configuration)',
      ],
      location: locate(error, ctx),
    });
  },
});

export const jsonParseInvalid = defineRule({
  id: 'json-parse-invalid',
  summary: 'JSON.parse() got undefined, an object, an empty string, or malformed JSON',
  diagnose(error, ctx) {
    if (
      error.name !== 'SyntaxError' ||
      !isJsonError(error.message) ||
      HTML_AS_JSON.test(error.message)
    ) {
      return undefined;
    }
    const message = error.message;
    const location = locate(error, ctx);
    if (/"undefined" is not valid JSON|Unexpected token u in JSON at position 0/.test(message)) {
      return finding({
        title: `${code('JSON.parse()')} was given ${code('undefined')}`,
        explanation: `The value you parsed was ${code('undefined')}, which becomes the text "undefined" — not valid JSON. The variable was never set (a missing storage key, property, or environment variable).`,
        fixes: [
          `Check the value before parsing: ${code('value ? JSON.parse(value) : fallback')}`,
          'Find out why it is undefined — log it right before the parse',
        ],
        location,
      });
    }
    if (
      /"\[object Object\]" is not valid JSON|Unexpected token o in JSON at position 1/.test(message)
    ) {
      return finding({
        title: `${code('JSON.parse()')} was given an object, not a JSON string`,
        explanation: `The value is already a JavaScript object (turning it into a string produced "[object Object]"). It was probably parsed already — e.g. axios ${code('response.data')}, Express ${code('req.body')} after ${code('express.json()')}, or the result of ${code('res.json()')}.`,
        fixes: [
          `Use the object directly — remove the ${code('JSON.parse')} call`,
          `If you meant to store it as text, use ${code('JSON.stringify(value)')} when saving it`,
        ],
        location,
      });
    }
    if (/Unexpected end of JSON input/.test(message)) {
      return finding({
        title: `${code('JSON.parse()')} got empty or truncated input`,
        explanation:
          'The text ended before a complete JSON value. Usually it was an empty string: an empty response body (such as `204 No Content`), an empty file, or a response that was cut off.',
        fixes: [
          `Handle empty bodies: ${code('const text = await res.text(); const data = text ? JSON.parse(text) : null;')}`,
          `For fetch, check ${code('res.status')} — 204 responses have no body`,
        ],
        location,
      });
    }
    if (
      /in JSON at position|is not valid JSON|in JSON|Bad control character|Unterminated string/.test(
        message,
      )
    ) {
      const where = /\(line (\d+) column (\d+)\)/.exec(message);
      return finding({
        title: `Invalid JSON${where ? ` at line ${where[1]}, column ${where[2]}` : ''}`,
        explanation:
          'Common culprits are trailing commas, comments, single quotes and unquoted keys — JSON is stricter than JavaScript object syntax.',
        fixes: [
          'Validate the input with a JSON linter to find the exact problem',
          'If it is a config file people edit by hand, consider JSON5, JSONC or a .js config',
        ],
        location,
        confidence: 'medium',
      });
    }
    return undefined;
  },
});

const NETWORK_OBJECTS =
  /^(?:Socket|TLSSocket|IncomingMessage|ServerResponse|ClientRequest|HTTPParser|Agent|Server|Http2Session|TCP|ReadableState|WritableState)$/;

export const circularJson = defineRule({
  id: 'circular-json',
  summary: 'JSON.stringify() hit a circular reference (often an Express req/res or HTTP response)',
  diagnose(error, ctx) {
    if (!/^Converting circular structure to JSON/.test(error.message)) return undefined;
    const constructors = [...error.message.matchAll(/constructor '([^']+)'/g)].map(
      (m) => m[1] ?? '',
    );
    const closing = /--- (?:property|index) '?([^'\s]+)'? closes the circle/.exec(
      error.message,
    )?.[1];
    const network = constructors.find((c) => NETWORK_OBJECTS.test(c));
    if (network) {
      return finding({
        title: "Can't JSON-serialize an HTTP request, response or socket",
        explanation: `The value contains a Node.js ${code(network)} — typically an Express ${code('req')}/${code('res')}, an axios or http response, or a socket. Those objects point at each other in cycles and can't become JSON.`,
        fixes: [
          `Serialize only the data you need: ${code('res.data')} (axios), ${code('await res.json()')} (fetch), ${code('req.body')} / ${code('req.query')} (Express)`,
          `To log it, use ${code('util.inspect(value, { depth: 2 })')} or your logger instead of ${code('JSON.stringify')}`,
        ],
        location: locate(error, ctx),
      });
    }
    return finding({
      title: "The value you're serializing contains a circular reference",
      explanation: `JSON can't represent cycles${closing ? `: the property ${code(closing)} leads back to an object that is already being serialized` : ''}.`,
      fixes: [
        `Serialize only the fields you need${closing ? `, or drop the back-reference ${code(closing)}` : ''}`,
        `Skip repeated objects with a replacer:\nconst seen = new WeakSet();\nJSON.stringify(value, (key, v) => {\n  if (typeof v === 'object' && v !== null) {\n    if (seen.has(v)) return '[Circular]';\n    seen.add(v);\n  }\n  return v;\n});`,
        `For logging, ${code('util.inspect(value)')} handles cycles`,
      ],
      location: locate(error, ctx),
    });
  },
});

export const bigintJson = defineRule({
  id: 'bigint-json',
  summary: 'JSON.stringify() cannot serialize BigInt values',
  diagnose(error, ctx) {
    if (!/Do not know how to serialize a BigInt/.test(error.message)) return undefined;
    return finding({
      title: `${code('JSON.stringify()')} can't serialize BigInt values`,
      explanation:
        'JSON has no BigInt type. BigInts usually come from database drivers or ORMs — e.g. Prisma `BigInt` fields or 64-bit integer columns.',
      fixes: [
        `Convert them with a replacer:\nJSON.stringify(data, (key, value) => (typeof value === 'bigint' ? value.toString() : value));`,
        `Or convert at the source (${code('Number(id)')} is safe when the value is below ${code('Number.MAX_SAFE_INTEGER')})`,
      ],
      location: locate(error, ctx),
    });
  },
});

export const invalidDate = defineRule({
  id: 'invalid-date',
  summary: 'A Date built from unparseable input was formatted (toISOString, Intl)',
  diagnose(error, ctx) {
    if (error.name !== 'RangeError' || !/^Invalid time value$/.test(error.message))
      return undefined;
    return finding({
      title: 'A date was created from input that could not be parsed',
      explanation: `${code('new Date(input)')} produced an Invalid Date, and ${code('toISOString()')} or a date formatter threw on it. Only ISO 8601 strings (${code('2024-12-31')}, ${code('2024-12-31T10:00:00Z')}) parse reliably — ${code("'31/12/2024'")}, ${code('undefined')} and empty strings don't.`,
      fixes: [
        `Validate before formatting: ${code('if (Number.isNaN(date.getTime())) { … }')}`,
        'Parse other formats explicitly (split the string, or use a date library with a format pattern)',
      ],
      location: locate(error, ctx),
    });
  },
});

export const structuredCloneFailed = defineRule({
  id: 'structured-clone-failed',
  summary: 'structuredClone()/postMessage() was given functions or other uncloneable values',
  diagnose(error, ctx) {
    if (error.name !== 'DataCloneError' && !/could not be cloned/.test(error.message))
      return undefined;
    const culprit = /^(.*?) could not be cloned/.exec(error.message)?.[1];
    return finding({
      title: "This value can't be copied with structuredClone() / postMessage()",
      explanation:
        `The structured clone algorithm copies plain data only: functions, class methods, symbols, DOM nodes and some host objects can't be cloned.` +
        (culprit
          ? ` The culprit is ${code(culprit.length > 60 ? `${culprit.slice(0, 57)}...` : culprit)}.`
          : ''),
      fixes: [
        'Clone only plain data — strip functions and class instances first',
        'For objects with methods, write an explicit copy or serialize them yourself',
      ],
      location: locate(error, ctx),
    });
  },
});

export const dataRules: Rule[] = [
  jsonParseHtml,
  jsonParseInvalid,
  circularJson,
  bigintJson,
  invalidDate,
  structuredCloneFailed,
];
