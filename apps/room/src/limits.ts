import type { SyncMode } from './protocol.ts';

/** A room's usage budget. Rooms are cheap while people type at human speed; these limits are for the rest: a script
 *  hammering a room, or a huge file pasted again and again. */
export interface Limits {
    /** Bytes of incoming changes per second, sustained, before the room asks clients to batch. */
    readonly bytesPerSecond: number;
    /** Burst allowance, in bytes, on top of the sustained rate. */
    readonly burstBytes: number;
    /** How often batched clients send, in ms. */
    readonly batchIntervalMs: number;
    /** Bytes of incoming changes per UTC day before the room pauses live sync until the next day. */
    readonly bytesPerDay: number;
    /** The largest single message, in bytes. */
    readonly maxMessageBytes: number;
    /** Each person's own rate, in bytes per second, on top of the room's: one person cannot use up everyone's budget. */
    readonly personBytesPerSecond: number;
    /** Each person's burst allowance; at least `maxMessageBytes`, so the largest message can always get through. */
    readonly personBurstBytes: number;
    /** Each person's share of the room's daily budget, in bytes. */
    readonly personBytesPerDay: number;
}

export const DEFAULT_LIMITS: Limits = {
    bytesPerSecond: 64 * 1024,
    burstBytes: 1024 * 1024,
    batchIntervalMs: 2000,
    bytesPerDay: 256 * 1024 * 1024,
    maxMessageBytes: 4 * 1024 * 1024,
    personBytesPerSecond: 32 * 1024,
    personBurstBytes: 8 * 1024 * 1024,
    personBytesPerDay: 64 * 1024 * 1024,
};

/** How long a connection lasts. Access is checked when its ticket is minted; closing a connection after this long makes
 *  the client reconnect with a fresh ticket, so someone who lost access is out within the hour (plus the alarm's tick). */
export const MAX_CONNECTION_MS = 60 * 60 * 1000;

/** Whether the connection whose WebSocket attachment is `attachment` (the identity's JSON with `since`, epoch ms) has
 *  lasted MAX_CONNECTION_MS at `now`. An attachment without `since` (a connection from before it was recorded) has. */
export function connectionExpired(attachment: unknown, now: number): boolean {
    let since = 0;
    if (typeof attachment === 'string') {
        try {
            const r: unknown = JSON.parse(attachment);
            if (typeof r === 'object' && r !== null && 'since' in r && typeof r.since === 'number') since = r.since;
        } catch {
            // Not JSON: unknown, so expired.
        }
    }
    return now - since >= MAX_CONNECTION_MS;
}

/** The start of the UTC day after `now`, in epoch ms. */
export function nextDay(now: number): number {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** The UTC day of `now` as `YYYY-MM-DD`: the key of the daily counter. */
export function dayOf(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

/** A token bucket for incoming bytes plus a daily counter, deciding the room's sync mode.
 *
 *  `take(bytes, now)` records an incoming change and says whether to accept it; `mode` is what the clients should do.
 *  A room goes `live` → `batched` when the bucket runs dry, back to `live` once it has refilled halfway, and `paused`
 *  for the rest of the UTC day once the daily budget is spent. Messages are refused only when paused or too large. */
export class UsageMeter {
    private tokens: number;
    private last: number;
    private batched = false;

    constructor(
        private readonly limits: Limits,
        /** Bytes already counted today, from storage. */
        private today: { day: string; bytes: number },
        now: number,
    ) {
        this.tokens = limits.burstBytes;
        this.last = now;
    }

    private refill(now: number): void {
        const dt = Math.max(0, now - this.last) / 1000;
        this.last = now;
        this.tokens = Math.min(this.limits.burstBytes, this.tokens + dt * this.limits.bytesPerSecond);
        const day = dayOf(now);
        if (day !== this.today.day) this.today = { day, bytes: 0 };
    }

    /** Records `bytes` arriving at `now`. Returns `ok`, or why the message is refused. */
    take(bytes: number, now: number): 'ok' | 'paused' | 'too-large' {
        this.refill(now);
        if (bytes > this.limits.maxMessageBytes) return 'too-large';
        if (this.today.bytes >= this.limits.bytesPerDay) return 'paused';
        this.today.bytes += bytes;
        this.tokens -= bytes;
        if (this.tokens <= 0) this.batched = true;
        else if (this.batched && this.tokens >= this.limits.burstBytes / 2) this.batched = false;
        return 'ok';
    }

    mode(now: number): SyncMode {
        this.refill(now);
        if (this.batched && this.tokens >= this.limits.burstBytes / 2) this.batched = false;
        if (this.today.bytes >= this.limits.bytesPerDay) return { mode: 'paused', until: nextDay(now) };
        if (this.batched) return { mode: 'batched', intervalMs: this.limits.batchIntervalMs };
        return { mode: 'live' };
    }

    /** Today's counter, to persist. */
    get counter(): { readonly day: string; readonly bytes: number } {
        return this.today;
    }
}

/** One person's budget in a room, across all their connections: a token bucket and a daily share. Kept in memory: a
 *  room that hibernates forgets it, which only gives people their allowance back sooner.
 *
 *  `take(bytes, now)` says whether to accept `bytes` from this person at `now`, and counts them only if so. */
export class PersonMeter {
    private tokens: number;
    private last: number;
    private today: { day: string; bytes: number };

    constructor(
        private readonly limits: Limits,
        now: number,
    ) {
        this.tokens = limits.personBurstBytes;
        this.last = now;
        this.today = { day: dayOf(now), bytes: 0 };
    }

    take(bytes: number, now: number): 'ok' | 'too-fast' | 'paused' {
        const dt = Math.max(0, now - this.last) / 1000;
        this.last = now;
        this.tokens = Math.min(this.limits.personBurstBytes, this.tokens + dt * this.limits.personBytesPerSecond);
        const day = dayOf(now);
        if (day !== this.today.day) this.today = { day, bytes: 0 };
        if (this.today.bytes + bytes > this.limits.personBytesPerDay) return 'paused';
        if (bytes > this.tokens) return 'too-fast';
        this.tokens -= bytes;
        this.today.bytes += bytes;
        return 'ok';
    }
}
