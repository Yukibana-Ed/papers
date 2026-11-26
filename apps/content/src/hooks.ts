import type { Reroute } from '@sveltejs/kit/hooks';
import { stripAssetPrefix } from '#lib/asset-path.ts';

/** Asset URLs carry a revision prefix (`/r2/engine/...`); the routes do not. */
export const reroute: Reroute = ({ url }) => stripAssetPrefix(url.pathname);
