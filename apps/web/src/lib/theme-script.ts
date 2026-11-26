import { THEME_BOOT } from '@yukibana/design/theme';

/** The design system's theme boot script as a `<script>` element, for the root layout's `<svelte:head>`: it applies the
 *  theme chosen on any Yukibana site before anything paints. It is a string here, not in the layout, because oxlint
 *  reads a `<script>` in a component's markup as the start of a script block. */
export const THEME_SCRIPT = `<script>${THEME_BOOT}</script>`;
