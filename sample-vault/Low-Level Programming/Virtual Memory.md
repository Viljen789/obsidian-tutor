---
title: Virtual Memory
subject: Low-Level Programming
tags: [memory, os, paging]
---

# Virtual Memory

Virtual memory gives each process the illusion of a private, contiguous address
space. The CPU's memory-management unit translates virtual addresses to physical
ones through page tables, paging rarely used pages out to disk.

It builds on the idea of a per-process [[Memory Layout]] and on understanding
[[Pointers]] as plain addresses that the hardware quietly remaps.

Virtual memory also explains why a [[CPU Cache]] keys on physical (or carefully
tagged virtual) addresses rather than raw program variables.
