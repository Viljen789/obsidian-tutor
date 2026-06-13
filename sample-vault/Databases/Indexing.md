---
title: Indexing
subject: Databases
tags: [performance, sql]
---

# Indexing

An index is an auxiliary data structure that lets the database find rows without a
full table scan. It trades extra storage and slower writes for much faster reads on
the indexed columns.

Indexing presupposes the [[Relational Model]] — you index attributes of relations.
The classic on-disk index structure is the [[B-Trees|B-tree]], which keeps lookups
logarithmic while staying friendly to block-based storage.

Good indexes are what make [[SQL Joins]] fast at scale.
