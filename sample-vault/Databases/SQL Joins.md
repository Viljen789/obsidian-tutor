---
title: SQL Joins
subject: Databases
tags: [sql, querying]
---

# SQL Joins

A join combines rows from two or more relations based on a predicate, usually a
foreign-key match. Inner, left/right outer, and full outer joins differ in how they
treat non-matching rows.

Joins are meaningful only once you understand the [[Relational Model]] and why
[[Normalization]] split your data across tables in the first place.

On large tables, join performance depends heavily on [[Indexing|good indexes]].
