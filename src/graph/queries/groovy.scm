; Groovy (Jenkins shared libraries, Gradle). tree-sitter-groovy node names verified with
; scripts/probe-grammar.mjs on jenkins-pipeline-script/*.groovy, 2026-09-16.

(function_definition
  function: (identifier) @name) @definition.method

(class_definition
  name: (identifier) @name) @definition.class

(declaration
  name: (identifier) @name) @definition.variable

(function_call
  function: (identifier) @name) @reference.call

(juxt_function_call
  function: (identifier) @name) @reference.call
