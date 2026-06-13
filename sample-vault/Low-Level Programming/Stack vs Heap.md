---
title: Stack vs Heap
subject: Low-Level Programming
tags: [memory, allocation]
---

# Stack vs Heap

The **stack** holds function call frames: local variables, return addresses, saved
registers. It is fast (just bump a pointer) and automatically reclaimed when a
function returns. The **heap** is for dynamic allocations whose lifetime you manage
explicitly (`malloc`/`free`).

This distinction only clicks once you understand the overall [[Memory Layout]] of a
process and are comfortable with [[Pointers]], since heap allocations are always
handed back to you as pointers.

Stack frames are also exactly what you manipulate when reading [[Assembly Basics]]
and watching `rsp` move.
