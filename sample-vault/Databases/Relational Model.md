---
title: Relational Model
subject: Databases
tags: [theory, fundamentals]
---

# Relational Model

The relational model represents data as **relations** (tables) of tuples (rows)
over named attributes (columns). Codd's model gives a clean, set-based foundation
for querying with relational algebra.

Almost everything else in databases assumes this model. Once you have tables you
can normalize them — see [[Normalization]] — and query them with [[SQL Joins]].

Keys defined here (primary and foreign) are also what an [[Indexing]] strategy is
built around.
