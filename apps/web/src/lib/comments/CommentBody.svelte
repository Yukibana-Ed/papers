<script lang="ts">
    import { DOMSerializer } from 'prosemirror-model';
    import { highlightIn } from './highlight.ts';
    import { parseMarkdown, schema } from './markdown.ts';

    /** A comment's Markdown, rendered through the comment schema: DOM nodes built from the parsed document, never HTML
     *  strings, so nothing in a comment can run. Code blocks with a language are highlighted once Shiki answers. */
    let { markdown }: { markdown: string } = $props();

    const serializer = DOMSerializer.fromSchema(schema);

    function render(el: HTMLElement): void {
        el.replaceChildren(serializer.serializeFragment(parseMarkdown(markdown).content, { document }));
        void highlightIn(el);
    }
</script>

<div class="cm-body" {@attach render}></div>
