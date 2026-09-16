; Shell. tree-sitter-bash node names verified with scripts/probe-grammar.mjs, 2026-09-16.

(function_definition
  name: (word) @name) @definition.function

(variable_assignment
  name: (variable_name) @name) @definition.variable

(command
  name: (command_name (word) @name)) @reference.call
