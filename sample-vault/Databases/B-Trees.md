---
title: B-Trees
subject: Databases
tags: [data-structures, performance]
---

# B-Trees

A B-tree is a balanced, high-fanout search tree designed for block storage: each
node holds many keys and maps to a disk page, so even huge datasets are only a few
levels deep. B+ trees keep all values in the leaves and chain them for fast range
scans.

B-trees are the workhorse behind most database [[Indexing]] implementations.

Their logarithmic [[Transactions|transactional]] lookups are what make point and
range queries cheap.
