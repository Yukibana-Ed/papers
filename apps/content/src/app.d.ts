declare global {
    namespace App {
        interface Platform {
            env: {
                /** The one origin allowed to frame this one (wrangler.jsonc `vars`). */
                APP_ORIGIN: string;
            };
        }
    }
}

export {};
