/** The content origin this app embeds: the Worker's `CONTENT_ORIGIN` var, or in development the content app's dev
 *  server (`VITE_CONTENT_ORIGIN` overrides the default port, for a second checkout running side by side). */
export function contentOrigin(platform: App.Platform | undefined): string {
    const dev: unknown = import.meta.env['VITE_CONTENT_ORIGIN'];
    return platform?.env.CONTENT_ORIGIN ?? (typeof dev === 'string' && dev ? dev : 'http://localhost:5185');
}
