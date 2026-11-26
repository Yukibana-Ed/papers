declare global {
    namespace App {
        interface Platform {
            env: {
                /** Where the app embeds the compile and preview frame from (wrangler.jsonc `vars`). */
                CONTENT_ORIGIN: string;
            };
        }
    }
}

export {};
