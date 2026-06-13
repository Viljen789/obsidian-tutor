---
title: ACID
subject: Databases
tags: [concurrency, theory]
---

# ACID

ACID names the four guarantees a well-behaved transaction provides:

- **Atomicity** — all-or-nothing.
- **Consistency** — never leaves the database in an invalid state.
- **Isolation** — concurrent transactions don't observe each other's partial work.
- **Durability** — once committed, survives crashes.

ACID is the vocabulary used to reason about [[Transactions]]; you cannot evaluate a
transaction's correctness without it.
