; Protocol Buffers. tree-sitter-proto node names verified with scripts/probe-grammar.mjs
; on a proto3 sample (message / enum / service / rpc), 2026-09-16.

(message
  (message_name) @name) @definition.class

(enum
  (enum_name) @name) @definition.enum

(service
  (service_name) @name) @definition.interface

(rpc
  (rpc_name) @name) @definition.method
