---
title: CPU Registers
subject: Low-Level Programming
tags: [cpu, hardware, fundamentals]
---

# CPU Registers

Registers are the small, fast storage locations built directly into the CPU. They
hold the operands and intermediate results the processor is actively working on.
Because they sit on the CPU die, access is effectively free compared to main
memory.

A typical x86-64 core exposes general-purpose registers (`rax`, `rbx`, `rsp`,
`rbp`, ...), a program counter (`rip`), and a flags register. Understanding what
lives in a register is the first step before reading any [[Assembly Basics|assembly]].

There are only a handful of registers, so compilers and hand-written assembly must
constantly spill values to and from memory — which is why the [[Memory Layout]] of a
program matters so much.
