---
title: CPU Cache
subject: Low-Level Programming
tags: [cpu, performance, memory]
---

# CPU Cache

Caches are small, fast SRAM banks (L1/L2/L3) that hold recently used lines of main
memory so the CPU rarely waits on slow DRAM. Performance hinges on locality:
sequential, predictable access patterns hit the cache; random pointer-chasing
misses.

To reason about cache behavior you need the process [[Memory Layout]] and how
[[Virtual Memory]] maps addresses to the physical lines a cache indexes.

Cache-friendly code is ultimately about how your data sits behind your [[Pointers]].
