; SQL (DDL and views). tree-sitter-sql node names verified with scripts/probe-grammar.mjs
; on be-services build_db_schema.sql, 2026-09-16. A table/view is the "class" of a
; schema file; its columns are fields.

(create_table
  (object_reference
    name: (identifier) @name)) @definition.class

(create_view
  (object_reference
    name: (identifier) @name)) @definition.class

(create_function
  (object_reference
    name: (identifier) @name)) @definition.function

(column_definition
  name: (identifier) @name) @definition.field
