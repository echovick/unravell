import type { ErrorCategory } from "../shared/types";

/**
 * Patterns that identify each of the 3 target error types.
 * Order matters — first match wins.
 */
const CLASSIFICATION_RULES: { category: ErrorCategory; patterns: RegExp[] }[] = [
  {
    category: "hydration-mismatch",
    patterns: [
      /text content does not match server-rendered html/i,
      /hydration failed because/i,
      /there was an error while hydrating/i,
      /entire root will switch to client rendering/i,
      /server html .* did not match/i,
      /expected server html to contain/i,
      /hydration mismatch/i,
      /minified react error #418/i,
      /minified react error #425/i,
      /minified react error #423/i,
    ],
  },
  {
    category: "undefined-property",
    patterns: [
      /cannot read propert(y|ies) of (undefined|null)/i,
      /is not a function/i,
      /undefined is not an object/i,
      /null is not an object/i,
      /cannot (access|destructure|use) .* before initialization/i,
      /is not defined/i,
      /cannot read '.*' of undefined/i,
      /typeerror:.*undefined/i,
    ],
  },
  {
    category: "unhandled-promise",
    patterns: [
      /unhandled promise rejection/i,
      /unhandled runtime error.*fetch/i,
      /failed to fetch/i,
      /network request failed/i,
      /api .* responded with/i,
      /ERR_CONNECTION_REFUSED/i,
      /ECONNREFUSED/i,
      /abort.*signal/i,
      /request.*timeout/i,
      /\.then is not a function/i,
      /load failed/i,
      /unexpected end of json/i,
      /unexpected token .* in json/i,
    ],
  },
];

/**
 * Classify an error based on its message and stack trace.
 */
export function classifyError(message: string, stack: string): ErrorCategory {
  const combined = `${message}\n${stack}`;

  for (const rule of CLASSIFICATION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(combined)) {
        return rule.category;
      }
    }
  }

  return "general";
}
