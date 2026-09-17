; RA2 VM minimal firmware (custom v86 BIOS, 64 KB, reset vector at the end)
; Flow: reset (0xFFFF0) -> real-mode initialization -> protected mode (no paging, ring 0) -> IDT -> host-parsed PE entry
; Memory layout contract (see vm.ts):
;   0x00060000-0x00060FFF  = hypercall/exception shared page
;   0x00070000-0x00070FFF  = minimal TEB (FS segment base)
;   0x00080000-0x000BFFFF  = static Win32 import stubs
;   0x000C0000-0x000EFFFF  = dynamic DLL/COM/thread-exit stubs (first region)
;   0x000F0000-0x000FFFFF  = firmware, GDT, IDT; no dynamic allocation
;   0x00100000-0x001FFFFF  = dynamic stubs (second region)
;   0x00220000-0x0025FFFF  = 64 independent callback slots, 4 KB each
;   0x00073C00-0x00073CFF  = callback-slot owner table (0 = free, otherwise thread ID + 1)
;   0x00071000-0x00072FFF  = fast _lread handle table (only when enabled)
;   0x00400000+            = RA2/YR PE image
;   The host specifies the game stack top at 0x60058 (default 0x700000; movable for large PEs).
;   Stack top+            = shim heap (VirtualAlloc regions allocated independently)
BITS 16
ORG 0xF0000

start16:
    cli
    ; BIOS resides at physical address 0xF0000. Real mode reads the firmware GDTR with DS=0xF000.
    mov ax, 0xF000
    mov ds, ax
    xor ax, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    ; Remap 8259 IRQs to IDT 0x20/0x28 so IRQ0..7 do not overlap CPU exception vectors.
    mov al, 0x11
    out 0x20, al
    out 0xA0, al
    mov al, 0x20
    out 0x21, al
    mov al, 0x28
    out 0xA1, al
    mov al, 0x04
    out 0x21, al
    mov al, 0x02
    out 0xA1, al
    mov al, 0x01
    out 0x21, al
    out 0xA1, al
    mov al, 0xFF
    out 0x21, al
    out 0xA1, al
    ; Load GDT -> protected mode
    lgdt [gdtr - $$]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    ; The flat code segment has base 0, so the offset must be the full physical address 0xFxxxx.
    jmp dword 0x08:start32

BITS 32
start32:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov gs, ax
    mov ax, 0x18
    mov fs, ax
    lidt [idtr]
    ; Hypercall stubs wake from HLT through COM1 RX (IRQ4); IRQ0 provides 100 Hz Win32
    ; guest-thread preemption. All other IRQs remain masked.
    mov dx, 0x3F9
    mov al, 1
    out dx, al
    mov al, 0x34
    out 0x43, al
    mov ax, 11932                 ; 1.193182MHz / 11932 ≈ 100Hz
    out 0x40, al
    mov al, ah
    out 0x40, al
    mov al, 0xEE                  ; master PIC: unmask IRQ0 + IRQ4
    out 0x21, al
    ; The game stack defaults to 1 MB and grows downward. RA2's image reaches 0xB46000,
    ; so the host moves the stack top to 0xD00000; ordinary games still use 0x700000.
    mov esp, [0x60058]
    ; Minimal TEB: SEH chain terminator / stack top / TEB self pointer.
    mov dword [fs:0], -1
    mov [fs:4], esp
    mov dword [fs:0x18], 0x70000
    cli
    cld
    ; Jump to the entry parsed by the host from the PE optional header (such as WinMainCRTStartup).
    mov eax, [0x60044]
    call eax
hang:
    ; Halt after entry returns; publish a marker so the host recognizes game exit outside ExitProcess.
    mov dword [0x6004c], 1
    hlt
    jmp hang

; -- GDT: 0 = null, 1 = code (0x08), 2 = data (0x10); both 4 GB flat ring 0 --
align 16
gdt:
    dq 0
    dq 0x00CF9A000000FFFF
    dq 0x00CF92000000FFFF
    ; 0x18: TEB，base=0x70000, limit=0x0fff, 32-bit byte-granularity data segment
    dq 0x0040920700000FFF
gdtr: dw 31
      dd gdt

; -- IDT: CPU exceptions halt and publish context to the shared page; IRQs only EOI --
; Do not iret from exceptions as if they were IRQs: #GP/#PF and others push an extra error code.
; The old handler mistook it for EIP, causing a secondary "CS selector is invalid" fault.
%macro EXCEPTION_NO_ERROR 1
exception_%1:
    push dword 0
    push dword %1
    jmp exception_common
%endmacro

%macro EXCEPTION_WITH_ERROR 1
exception_%1:
    push dword %1
    jmp exception_common
%endmacro

EXCEPTION_NO_ERROR 0
EXCEPTION_NO_ERROR 1
EXCEPTION_NO_ERROR 2
EXCEPTION_NO_ERROR 3
EXCEPTION_NO_ERROR 4
EXCEPTION_NO_ERROR 5
EXCEPTION_NO_ERROR 6
EXCEPTION_NO_ERROR 7
EXCEPTION_WITH_ERROR 8
EXCEPTION_NO_ERROR 9
EXCEPTION_WITH_ERROR 10
EXCEPTION_WITH_ERROR 11
EXCEPTION_WITH_ERROR 12
EXCEPTION_WITH_ERROR 13
EXCEPTION_WITH_ERROR 14
EXCEPTION_NO_ERROR 15
EXCEPTION_NO_ERROR 16
EXCEPTION_WITH_ERROR 17
EXCEPTION_NO_ERROR 18
EXCEPTION_NO_ERROR 19
EXCEPTION_NO_ERROR 20
EXCEPTION_WITH_ERROR 21
EXCEPTION_NO_ERROR 22
EXCEPTION_NO_ERROR 23
EXCEPTION_NO_ERROR 24
EXCEPTION_NO_ERROR 25
EXCEPTION_NO_ERROR 26
EXCEPTION_NO_ERROR 27
EXCEPTION_NO_ERROR 28
EXCEPTION_WITH_ERROR 29
EXCEPTION_WITH_ERROR 30
EXCEPTION_NO_ERROR 31

exception_common:
    ; Stack: vector, error, EIP, CS, EFLAGS. Write status last as the publication signal.
    mov [0x60028], eax
    mov [0x6002C], ecx
    mov [0x60030], edx
    mov [0x60034], ebx
    mov [0x60038], ebp
    mov [0x6003C], esi
    mov [0x60040], edi
    mov eax, [esp + 4]
    mov [0x60014], eax
    mov eax, [esp + 8]
    mov [0x60018], eax
    mov eax, [esp + 12]
    mov [0x6001C], eax
    mov eax, [esp + 16]
    mov [0x60020], eax
    lea eax, [esp + 20]
    mov [0x60024], eax
    mov eax, [esp]
    inc eax
    mov [0x60010], eax
    cli
.halt:
    hlt
    jmp .halt

irq_common:
    push eax
    push dx
    ; Drain COM1 RX bytes. UART IRQ4 is level-triggered: if the guest stub does not promptly read
    ; the host wake byte, the IRQ line stays high and the 8259 retriggers after every EOI,
    ; trapping the CPU in this handler and freezing game interaction. Unconditionally drain RX
    ; so any leftover bytes cause only one harmless interrupt.
    ; 0x3F8 exceeds imm8 range; access it indirectly through DX and preserve DX.
    mov dx, 0x3F8
    in al, dx
    pop dx
    mov al, 0x20
    out 0xA0, al
    out 0x20, al
    pop eax
    iret

; 100 Hz PIT preemption point. The host writes each thread's run state at 0x73900:
; 0 = not runnable, 1 = runnable, >=2 = wake tick + 2. The common context frame is
; pushad + EFLAGS + continuation, interchangeable with import-stub cooperative switching.
; PIT and voluntary yielding share the context layout; software interrupts neither advance time nor send PIC EOI.
%macro SAVE_INTERRUPT_CONTEXT 0
    ; Rewrite the CPU EIP,CS,EFLAGS interrupt frame into an EFLAGS,EIP return frame,
    ; leaving final ESP identical to iretd by discarding the 4-byte CS slot.
    push eax
    push ecx
    mov eax, [esp + 8]            ; EIP
    mov ecx, [esp + 16]           ; EFLAGS
    mov [esp + 16], eax           ; Target continuation (original EFLAGS slot)
    mov [esp + 12], ecx           ; Target EFLAGS (original CS slot)
    pop ecx
    pop eax
    add esp, 4                    ; ESP now points to EFLAGS,EIP
    pushad

%endmacro

irq_timer:
    ; QPC reports a 1000 Hz frequency. The 100 Hz PIT advances the shared 64-bit counter;
    ; fast QPC stubs only read it, preventing busy-loop queries from fabricating elapsed time.
    add dword [0x6005C], 10
    adc dword [0x60060], 0
    ; While an import stub uses the global request/return shared page, only EOI is allowed;
    ; switching threads could issue a second request. The host clears request before sending COM1 IRQ,
    ; so request=0 cannot signal release: one instruction window remains between IRQ4 iret and the stub's cli.
    ; The stub clears importActive only after returned EAX/EDX enter the thread context.
    cmp dword [0x6008C], 0
    jne .request_active
    SAVE_INTERRUPT_CONTEXT
    inc dword [0x73A00]
    mov al, 0x20
    out 0x20, al

    jmp schedule_thread
.request_active:
    push eax
    mov al, 0x20
    out 0x20, al
    pop eax
    iret

; INT 0x30: Sleep(0) voluntarily yields; resume the caller directly if no other thread is ready.
; importActive still owns the shared return page; do not switch threads in this window.
yield_thread:
    cmp dword [0x6008C], 0
    jne .return
    SAVE_INTERRUPT_CONTEXT
    jmp schedule_thread
.return:
    iret

schedule_thread:
    mov ebx, [0x60068]            ; current id
    mov ecx, [0x60074]            ; allocated thread count
    cmp ecx, 1
    jbe .restore
    mov edx, ebx
    mov esi, ecx
    dec esi                       ; Check at most the other count-1 threads
.next:
    inc edx
    cmp edx, ecx
    jb .candidate
    xor edx, edx
.candidate:
    mov edi, [0x73900 + edx*4]
    cmp edi, 1
    je .switch
    cmp edi, 2
    jb .miss
    sub edi, 2                    ; absolute wake tick
    mov eax, [0x73A00]
    sub eax, edi                  ; Signed difference handles uint32 tick wraparound
    js .miss
    mov dword [0x73900 + edx*4], 1
    jmp .switch
.miss:
    dec esi
    jnz .next
    jmp .restore

.switch:
    ; Save the current thread's common context, x87/MMX state, and minimal TEB/LastError.
    ; Legacy Bink decoders use MMX heavily. MMX shares the x87 register file, so preserving
    ; only general registers corrupts decoder state when PIT preemption resumes another thread.
    mov [0x73400 + ebx*4], esp
    shl ebx, 7
    fnsave [0x78000 + ebx]
    shr ebx, 7
    mov eax, [0x70000]
    mov [0x73500 + ebx*4], eax
    mov eax, [0x70004]
    mov [0x73600 + ebx*4], eax
    mov eax, [0x70008]
    mov [0x73700 + ebx*4], eax
    mov eax, [0x60064]
    mov [0x73800 + ebx*4], eax

    mov [0x60068], edx
    mov [0x6006C], edx
    mov esp, [0x73400 + edx*4]
    shl edx, 7
    frstor [0x78000 + edx]
    shr edx, 7
    mov eax, [0x73500 + edx*4]
    mov [0x70000], eax
    mov eax, [0x73600 + edx*4]
    mov [0x70004], eax
    mov eax, [0x73700 + edx*4]
    mov [0x70008], eax
    mov eax, [0x73800 + edx*4]
    mov [0x60064], eax
.restore:
    popad
    popfd
    ret

%macro IDT_GATE 1
    dw ((%1 - $$) + 0xF0000) & 0xFFFF
    dw 0x08
    db 0
    db 0x8E
    dw (((%1 - $$) + 0xF0000) >> 16) & 0xFFFF
%endmacro

align 8
idt:
%assign vector 0
%rep 32
    IDT_GATE exception_%+vector
%assign vector vector+1
%endrep
    IDT_GATE irq_timer
%rep 15
    IDT_GATE irq_common
%endrep
    IDT_GATE yield_thread         ; 0x30, not a hardware IRQ
%rep 207
    IDT_GATE irq_common
%endrep
idtr: dw 256*8 - 1
      dd idt

; -- Reset vector --
times 0xFFF0 - ($-$$) db 0
    ; Reset defaults to 16-bit mode; explicitly emit a 16:16 far jump so NASM does not choose 16:32 due to ORG.
    db 0xEA
    dw start16 - $$
    dw 0xF000
times 0x10000 - ($-$$) db 0
