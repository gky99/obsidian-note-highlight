/**
 * Typed errors for sidecar parsing. Distinct classes let callers (and tests)
 * branch on *why* a sidecar failed to parse rather than string-matching.
 */

/** Base class for every error this module throws. */
export class SidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarError';
    // Restore prototype chain across the TS target downlevel so `instanceof`
    // works for subclasses (a transpilation quirk when extending built-ins).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The sidecar's frontmatter `schema` is missing or names a version this build
 * does not understand (§5.3). Parsing is gated on the schema, so this is fatal.
 */
export class SidecarSchemaError extends SidecarError {
  /** The `schema` value we found (or `undefined` if absent). */
  readonly found: string | undefined;
  /** The schema version this build supports. */
  readonly expected: string;

  constructor(found: string | undefined, expected: string) {
    super(
      found === undefined
        ? `Sidecar frontmatter is missing a "schema" field; expected "${expected}".`
        : `Unsupported sidecar schema "${found}"; this build understands "${expected}".`,
    );
    this.name = 'SidecarSchemaError';
    this.found = found;
    this.expected = expected;
  }
}

/** The text is not a well-formed sidecar (bad frontmatter, malformed unit, …). */
export class SidecarParseError extends SidecarError {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarParseError';
  }
}
