---
title: Normalization
subject: Databases
tags: [schema-design, theory]
---

# Normalization

Normalization is the process of structuring tables to reduce redundancy and avoid
update anomalies, progressing through normal forms (1NF, 2NF, 3NF, BCNF). Each form
removes a class of functional-dependency problem.

It only makes sense on top of the [[Relational Model]], whose keys and dependencies
are exactly what you reason about.

Normalized schemas typically have more tables, which means more [[SQL Joins]] at
query time.
