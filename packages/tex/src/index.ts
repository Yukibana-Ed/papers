/** What reads TeX's outputs, shared by the content frame (in the browser) and the local tools (in Node): no DOM, no
 *  Node APIs, plain text in and plain values out. Callers decompress (`.synctex.gz`) themselves. */
export * from './synctex.ts';
