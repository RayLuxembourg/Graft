; Terraform / HCL. tree-sitter-hcl node names verified with scripts/probe-grammar.mjs on
; cloudops-alerts/state/prod/main.tf, 2026-09-16. A block (`resource "aws_x" "name" {`)
; is a definition named by its first label; attributes inside are fields.

(block
  (identifier) @name) @definition.module

(attribute
  (identifier) @name) @definition.field
