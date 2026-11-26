<script lang="ts">
    import { DOMSerializer } from 'prosemirror-model';
    import { parseMarkdown, schema } from './markdown.ts';

    /** A comment's Markdown, rendered through the comment schema: DOM nodes built from the parsed document, never HTML
     *  strings, so nothing in a comment can run. */
    let { markdown }: { markdown: string } = $props();

    const serializer = DOMSerializer.fromSchema(schema);

    function render(el: HTMLElement): void {
        el.replaceChildren(serializer.serializeFragment(parseMarkdown(markdown).content, { document }));
    }
</script>

<div class="cm-body" {@attach render}></div>
