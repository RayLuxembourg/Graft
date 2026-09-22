; JSON — claimed ONLY for package.json (see GENERIC_LANGS: the "extension" is the whole
; basename). Its keys at the first two levels become symbols, so every dependency name
; (`dependencies."@sisense/sdk-ai-core"`) is a node: `graft grep "@sisense/sdk-ai-core"`
; lists every consumer's manifest, and a package-level blast radius needs no raw grep.
; Node names verified with scripts/probe-grammar.mjs on 2026-09-22. General JSON stays
; out of the index (volume without signal: lockfiles, fixtures, 16k files).

(document
  (object
    (pair
      key: (string (string_content) @name)) @definition.field))

(document
  (object
    (pair
      value: (object
        (pair
          key: (string (string_content) @name)) @definition.field))))
