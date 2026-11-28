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
                /** The TeX Live snapshot our pdfTeX runs on: the folder under `tl/` whose files `/tl-file/*` serves by
                 *  path, and whose LaTeX format the engine was made to dump (wrangler.jsonc `vars`). */
                PDFTEX_SNAPSHOT: string;
                /** The engine's files and the TeX Live store (wrangler.jsonc `r2_buckets`). */
                ASSETS_R2: AssetBucket;
                /** Browser tests only, never in wrangler.jsonc: an origin whose `/r2/…` assets stand in for those the
                 *  local bucket lacks (the deployed content origin), so tests run the real engine without uploading it. */
                ASSETS_FALLBACK?: string;
            };
        }
    }
}

export {};
