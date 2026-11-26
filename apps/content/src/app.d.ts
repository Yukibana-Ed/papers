import type { AssetBucket } from '#lib/r2.ts';

declare global {
    namespace App {
        interface Platform {
            env: {
                /** The one origin allowed to frame this one (wrangler.jsonc `vars`). */
                APP_ORIGIN: string;
                /** The engine's release, the folder under `engine/` in the bucket (wrangler.jsonc `vars`). */
                ENGINE_VERSION: string;
                /** The TeX Live snapshot, the folder under `tl/` in the bucket (wrangler.jsonc `vars`). */
                TL_SNAPSHOT: string;
                /** The engine's files and the TeX Live store (wrangler.jsonc `r2_buckets`). */
                ASSETS_R2: AssetBucket;
            };
        }
    }
}

export {};
