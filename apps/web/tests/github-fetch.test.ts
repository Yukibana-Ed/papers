import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubFetch, retryDelay } from '#lib/github/api.ts';

const res = (status: number, headers: Record<string, string> = {}): Response => new Response(status === 204 ? null : '{}', { status, headers });

afterEach(() => vi.unstubAllGlobals());

describe('retryDelay', () => {
    it("honours GitHub's rate limits, up to a point", () => {
        expect(retryDelay(res(429, { 'Retry-After': '3' }), 'POST', 0)).toBe(3000);
        expect(retryDelay(res(403, { 'Retry-After': '2' }), 'GET', 0)).toBe(2000);
        expect(retryDelay(res(403, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '105' }), 'GET', 0, 100_000)).toBe(5000);
        expect(retryDelay(res(429, { 'Retry-After': '3600' }), 'GET', 0)).toBeNull();
        expect(retryDelay(res(429), 'GET', 1)).toBe(2000);
    });

    it('waits on a gateway error of an idempotent request only, and never on an answer', () => {
        const d = retryDelay(res(503), 'GET', 1);
        expect(d).toBeGreaterThanOrEqual(500);
        expect(d).toBeLessThanOrEqual(1000);
        expect(retryDelay(res(503), 'POST', 0)).toBeNull();
        expect(retryDelay(res(403), 'GET', 0)).toBeNull();
        expect(retryDelay(res(404), 'GET', 0)).toBeNull();
        expect(retryDelay(res(422), 'PATCH', 0)).toBeNull();
    });
});

describe('githubFetch', () => {
    it('tries again as told, three times at most, and returns the last answer', async () => {
        const answers = [res(502), res(429, { 'Retry-After': '1' }), res(503)];
        const fetch = vi.fn(async () => answers.shift() ?? res(200));
        vi.stubGlobal('fetch', fetch);
        const waits: number[] = [];
        const r = await githubFetch('https://api.github.com/x', {}, async ms => void waits.push(ms));
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(r.status).toBe(503);
        expect(waits).toHaveLength(2);
        expect(waits[1]).toBe(1000);
    });

    it('tries a GET again after a network failure, but never a POST', async () => {
        const failing = vi.fn(async (): Promise<Response> => {
            throw new TypeError('network');
        });
        vi.stubGlobal('fetch', failing);
        await expect(githubFetch('https://api.github.com/x', { method: 'POST' }, async () => {})).rejects.toThrow('network');
        expect(failing).toHaveBeenCalledTimes(1);
        let n = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                if (n++ === 0) throw new TypeError('network');
                return res(200);
            }),
        );
        expect((await githubFetch('https://api.github.com/x', {}, async () => {})).status).toBe(200);
    });
});
