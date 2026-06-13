---
title: Transactions
subject: Databases
tags: [concurrency, reliability]
---

# Transactions

A transaction groups a set of reads and writes into a single logical unit that
either fully commits or fully rolls back. Transactions are how databases stay
correct under concurrency and partial failure.

They build on the [[Relational Model]] (the rows being changed) and are defined by
the guarantees summarized as [[ACID]].

Concurrency control often leans on the same [[Indexing]] structures to lock or
version the right rows.
