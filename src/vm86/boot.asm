; RA2 VM 迷你固件（v86 自定义 BIOS，64KB，复位向量在末尾）
; 流程：复位(0xFFFF0) → 实模式初始化 → 保护模式(无分页, ring0) → IDT → 跳入 host 解析的 PE 入口
; 内存布局约定（见 vm.ts）：
;   0x00060000-0x00060FFF  = hypercall/异常共享页
;   0x00070000-0x00070FFF  = 最小 TEB（FS 段基址）
;   0x00080000-0x000BFFFF  = 静态 Win32 import 桩
;   0x000C0000-0x000EFFFF  = 动态 DLL/COM/线程退出桩（第一段）
;   0x000F0000-0x000FFFFF  = 固件、GDT、IDT，禁止动态分配
;   0x00100000-0x001FFFFF  = 动态桩（第二段）
;   0x00220000-0x0025FFFF  = 64 个独立回调槽，每槽 4KB
;   0x00073C00-0x00073CFF  = 回调槽 owner 表（0=空闲，其他=线程 id+1）
;   0x00071000-0x00072FFF  = 高速 _lread 句柄表（仅启用时使用）
;   0x00400000+            = RA2/YR PE 映像
;   host 通过 0x60058 指定游戏栈顶（默认 0x700000；大 PE 可后移）
;   栈顶+                  = shim 堆（VirtualAlloc 区独立分配）
BITS 16
ORG 0xF0000

start16:
    cli
    ; BIOS 位于物理地址 0xF0000。实模式用 DS=0xF000 读取固件内的 GDTR。
    mov ax, 0xF000
    mov ds, ax
    xor ax, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    ; 把 8259 IRQ 重映射到 IDT 0x20/0x28，避免 IRQ0..7 与 CPU 异常向量重叠。
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
    ; 载入 GDT → 保护模式
    lgdt [gdtr - $$]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    ; 平坦代码段基址为 0，因此 offset 必须是完整物理地址 0xFxxxx。
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
    ; hypercall 桩用 COM1 RX(IRQ4) 从 HLT 中唤醒；IRQ0 提供 100Hz Win32
    ; 客体线程抢占节拍。其余 IRQ 保持屏蔽。
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
    ; 游戏栈默认 1MB、向下增长。RA2 映像延伸到 0xB46000，host 会把栈顶
    ; 后移到 0xD00000；普通游戏仍写入 0x700000。
    mov esp, [0x60058]
    ; 最小 TEB：SEH 链尾 / 栈顶 / TEB 自指针。
    mov dword [fs:0], -1
    mov [fs:4], esp
    mov dword [fs:0x18], 0x70000
    cli
    cld
    ; 跳入 host 从 PE optional header 解析的入口（WinMainCRTStartup 类）。
    mov eax, [0x60044]
    call eax
hang:
    ; 入口返回后停机：发布标记让 host 识别为「游戏已退出」（ExitProcess 之外的路径）。
    mov dword [0x6004c], 1
    hlt
    jmp hang

; ── GDT：0=null 1=代码(0x08) 2=数据(0x10)，均为 4GB 平坦 ring0 ──
align 16
gdt:
    dq 0
    dq 0x00CF9A000000FFFF
    dq 0x00CF92000000FFFF
    ; 0x18: TEB，base=0x70000, limit=0x0fff, 32-bit byte-granularity data segment
    dq 0x0040920700000FFF
gdtr: dw 31
      dd gdt

; ── IDT：CPU 异常停机并把现场发布到共享页；IRQ 仅 EOI ──
; 不能把异常当 IRQ 直接 iret：#GP/#PF 等会额外压入 error code，旧处理器
; 会把它误当 EIP，继而产生“CS selector is invalid”二次故障。
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
    ; 栈：vector, error, EIP, CS, EFLAGS。status 最后写，作为发布信号。
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
    ; 读走 COM1 RX 字节。UART 的 IRQ4 是电平触发：host 的唤醒字节只要没被
    ; 客体桩及时读走，IRQ 线就永久拉高，8259 每次 EOI 后重新触发中断，
    ; CPU 会被钉死在本处理函数里（表现为游戏无交互地卡死）。这里无条件
    ; 排空 RX，让任何残留字节都只产生一次无害的中断。
    ; 0x3F8 超出 imm8 范围，必须经 DX 间接访问并保存 DX。
    mov dx, 0x3F8
    in al, dx
    pop dx
    mov al, 0x20
    out 0xA0, al
    out 0x20, al
    pop eax
    iret

; 100Hz PIT 抢占点。host 在 0x73900 写每条线程的运行状态：
; 0=不可运行，1=可运行，>=2=(唤醒 tick + 2)。上下文帧统一为
; pushad + EFLAGS + continuation，因而和 import stub 的协作切换可互换。
; PIT 与主动让出共用上下文布局，软件中断不推进时钟或向 PIC 发送 EOI。
%macro SAVE_INTERRUPT_CONTEXT 0
    ; 把 CPU 的 EIP,CS,EFLAGS 中断帧改写成 EFLAGS,EIP 返回帧，并保持
    ; 最终 ESP 与 iretd 完全相同（丢弃 CS 的 4 字节槽）。
    push eax
    push ecx
    mov eax, [esp + 8]            ; EIP
    mov ecx, [esp + 16]           ; EFLAGS
    mov [esp + 16], eax           ; 目标 continuation（原 EFLAGS 槽）
    mov [esp + 12], ecx           ; 目标 EFLAGS（原 CS 槽）
    pop ecx
    pop eax
    add esp, 4                    ; ESP 现在指向 EFLAGS,EIP
    pushad

%endmacro

irq_timer:
    ; QPC 频率对外声明为 1000Hz。由 100Hz PIT 推进共享 64-bit 计数器，
    ; 快速 QPC 桩只读取它，避免忙循环按查询次数伪造时间流逝。
    add dword [0x6005C], 10
    adc dword [0x60060], 0
    ; import stub 正在使用全局 request/return 共享页时只能 EOI，不能切换到
    ; 另一线程发起第二个请求。host 会先清 request 再发 COM1 IRQ，因此不能
    ; 用 request=0 作为释放信号：IRQ4 iret 与桩内 cli 之间仍有一个指令窗。
    ; importActive 要等返回 EAX/EDX 进入线程上下文后才由桩清零。
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

; INT 0x30：Sleep(0) 主动让出；无其他就绪线程时直接恢复调用者。
; importActive 仍拥有共享返回页，不能在此窗口切换线程。
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
    dec esi                       ; 最多检查其余 count-1 条线程
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
    sub eax, edi                  ; 有符号差支持 uint32 tick 回绕
    js .miss
    mov dword [0x73900 + edx*4], 1
    jmp .switch
.miss:
    dec esi
    jnz .next
    jmp .restore

.switch:
    ; 保存当前线程的统一上下文、x87/MMX 状态和最小 TEB/LastError。
    ; 老版 Bink 解码器大量使用 MMX；MMX 与 x87 共用寄存器文件，若仅保存通用
    ; 寄存器，PIT 抢占后恢复另一线程会破坏解码器状态。
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
    IDT_GATE yield_thread         ; 0x30，非硬件 IRQ
%rep 207
    IDT_GATE irq_common
%endrep
idtr: dw 256*8 - 1
      dd idt

; ── 复位向量 ──
times 0xFFF0 - ($-$$) db 0
    ; 复位时默认 16-bit；显式写 16:16 far jump，避免 NASM 因 ORG 选成 16:32。
    db 0xEA
    dw start16 - $$
    dw 0xF000
times 0x10000 - ($-$$) db 0
