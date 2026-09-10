/**
 * Stand-in for @cloudflare/workers-oauth-provider inside the Node test bundle. The real package's first line is
 * `import { WorkerEntrypoint } from "cloudflare:workers"`, a module that only exists in the Workers runtime, so
 * bundling it here fails. src/auth.ts uses exactly one value from it, AuthorizationError, and only for `instanceof`.
 */
export class AuthorizationError extends Error {
  constructor(code, description) {
    super(description ?? code);
    this.code = code;
    this.description = description;
  }
}
export default {};
