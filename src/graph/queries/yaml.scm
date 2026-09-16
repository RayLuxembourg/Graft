; YAML (Helm values, k8s manifests, CI). tree-sitter-yaml node names verified with
; scripts/probe-grammar.mjs on sisense-helm-chart/.../ai-integration/values.yaml,
; 2026-09-16. Every mapping key becomes a field symbol whose body is the pair, so
; `use_llm_gw: true` is findable by name and by value.

(block_mapping_pair
  key: (flow_node) @name) @definition.field
