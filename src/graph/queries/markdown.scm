; Markdown docs. tree-sitter-markdown (block grammar) node names verified with
; scripts/probe-grammar.mjs on ai-services/docs/agent/AGENT_GUIDE.md, 2026-09-16.
; Every heading becomes a symbol whose body is its section, so a switch or a term
; explained under a heading ("USE_LLM_GW", "primary backend") scores in `ask`.

(section
  (atx_heading
    heading_content: (inline) @name)) @definition.module

(section
  (setext_heading
    heading_content: (paragraph) @name)) @definition.module
