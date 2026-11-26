/** The app's origin in development: its dev server. `VITE_APP_ORIGIN` overrides it (a test harness on another port). */
const DEV_APP_ORIGIN = 'http://localhost:5180';

/** The one origin allowed to frame this one and to talk to it.
 *
 *  In production and previews, the Worker's `APP_ORIGIN` var (wrangler.jsonc; a preview upload sets the app preview's).
 *  In development the platform proxy hands over wrangler.jsonc's production value, which a local app cannot have, so
 *  the dev server's origin is used instead. */
export function appOrigin(platform: App.Platform | undefined, dev: boolean): string {
    if (dev) {
        const override: unknown = import.meta.env['VITE_APP_ORIGIN'];
        return typeof override === 'string' && override !== '' ? override : DEV_APP_ORIGIN;
    }
    return platform?.env.APP_ORIGIN ?? DEV_APP_ORIGIN;
}
