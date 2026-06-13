---
title: Assembly Basics
subject: Low-Level Programming
tags: [assembly, cpu]
---

# Assembly Basics

Assembly language is a thin, human-readable layer over the raw machine code a CPU
executes. Each instruction maps almost one-to-one to an opcode the processor
understands.

To read assembly you first need to know what the [[Registers]] are, because almost
every instruction moves data between registers or between a register and memory:

```asm
mov rax, 1        ; load immediate 1 into rax
add rax, rbx      ; rax = rax + rbx
mov [rsp-8], rax  ; store rax onto the stack
```

That last `mov` writes to the stack, so assembly only makes sense once you also
understand [[Stack vs Heap]] and the broader [[Memory Layout]] of a process.
