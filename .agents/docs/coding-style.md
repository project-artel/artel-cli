# User-Level Coding Style

## Coding Style

Prefer:
- explicit naming
- small functions
- single responsibility
- early return
- composable logic
- deterministic behavior

---

## Structure

Prefer:
- shallow nesting
- clear boundaries
- modular design
- immutable-oriented flow
- explicit dependencies

Avoid:
- giant classes
- god objects
- util dumping grounds
- hidden side effects
- deep inheritance

---

## Naming

Names should reveal intent immediately.

Avoid:
- Manager
- Helper
- Utils
- Temp
- Data
- Thing
- Misc

Prefer:
- domain-specific naming
- action-oriented function names
- explicit variable meaning

---

## Refactoring

Prefer:
- incremental refactoring
- localized changes
- preserving existing architecture

Avoid:
- unnecessary rewrites
- unrelated cleanup
- aesthetic-only refactors
- broad formatting churn

## Comments

Comments should explain constraints or non-obvious decisions. Do not repeat what
the code already states.

## Final Rule

Code should be:
- easy to reason about
- easy to modify
- easy to extend
- easy to debug
