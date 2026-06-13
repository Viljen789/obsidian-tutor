---
title: Memory Layout
subject: Low-Level Programming
tags: [memory, process, fundamentals]
---

# Memory Layout

Every running process sees a contiguous virtual address space carved into regions:
the text segment (code), initialized and uninitialized data, the heap growing
upward, and the stack growing downward.

Reasoning about layout requires comfort with [[Pointers]], since each region is
ultimately just a range of addresses you can point into.

The two regions programmers manage most directly are described in [[Stack vs Heap]].
The illusion that every process gets its own flat address space is provided by
[[Virtual Memory]].
