declare global {
    namespace App {
        interface Platform {
            env: {
                /** Where the app embeds the compile and preview frame from (wrangler.jsonc `vars`). */
                CONTENT_ORIGIN: string;
                /** The GitHub App's OAuth client (`vars`) and secret (a Worker secret). */
                GITHUB_CLIENT_ID?: string;
                GITHUB_CLIENT_SECRET?: string;
                /** The GitHub App's slug, for its install page (`vars`). */
                GITHUB_APP_SLUG?: string;
                /** 32 random bytes, base64: the key that seals session cookies (a Worker secret). */
                SESSION_KEY?: string;
                /** The rooms (apps/room), one per branch. */
                ROOM?: RoomNamespace;
            };
        }
    }

    /** The part of a Durable Object namespace the app uses. */
    interface RoomNamespace {
        idFromName(name: string): unknown;
        get(id: unknown): { fetch(request: Request): Promise<Response> };
    }
}

export {};
