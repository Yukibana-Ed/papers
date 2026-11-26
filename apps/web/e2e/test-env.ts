/** Values the browser tests give the local app Worker so that it runs signed in: test values, used only by
 *  `wrangler dev` under Playwright, never by a deployed Worker (whose secrets are set in Cloudflare). */

/** A session key: 32 bytes, base64, a fixed test pattern. */
export const E2E_SESSION_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)));

/** Stands in for the GitHub App's client secret: the tests never reach GitHub's token endpoint. */
export const E2E_CLIENT_SECRET = 'e2e-not-a-secret';
