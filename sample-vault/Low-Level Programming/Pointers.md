---
title: Pointers
subject: Low-Level Programming
tags: [memory, c, fundamentals]
---

# Pointers

A pointer is just a variable whose value is a memory address. In C:

```c
int x = 42;
int *p = &x;   // p holds the address of x
*p = 7;        // dereference: write through the pointer
```

Pointers are the most fundamental tool for working with memory directly. To use
them well you need a mental model of the program's [[Memory Layout]] — where a
given address actually lives.

Pointers show up everywhere downstream: they are how you walk the [[Stack vs Heap]],
how [[Virtual Memory]] translation is reasoned about, and how data structures link
their nodes together.
