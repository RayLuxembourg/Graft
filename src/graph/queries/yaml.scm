; YAML (Helm values, k8s manifests, CI). tree-sitter-yaml node names verified with
; scripts/probe-grammar.mjs on sisense-helm-chart/.../ai-integration/values.yaml,
; 2026-09-16. Only the first two levels of keys become symbols: that is where a switch
; (`use_llm_gw: true`, `env.LLM_GATEWAY_URL`) lives, and indexing every nested key made
; the first fork build 251k "variable" nodes deep — the query latency tripled. The
; definition capture sits on the PAIR (each key gets its own span), not the document.

(document
  (block_node
    (block_mapping
      (block_mapping_pair
        key: (flow_node) @name) @definition.field)))

(document
  (block_node
    (block_mapping
      (block_mapping_pair
        value: (block_node
          (block_mapping
            (block_mapping_pair
              key: (flow_node) @name) @definition.field))))))
