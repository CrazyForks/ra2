import { describe, expect, it } from 'vitest';
import { GUEST_CALLBACK_OWNERS, HYPERCALL_CALLBACK_DEPTH } from '../../../src/vm86/pe';
import { CLSID_DIRECTPLAY, guidBytes } from '../../../src/vm86/shim/dplayx';
import type { DplayTransportHandlers } from '../../../src/vm86/shim/dplayTransport';
import { callShim } from '../../helpers/guestMemory';
import { call32, finish, le32, PROGRAM, push32, withGuestMachine } from '../../helpers/guestMachine';

describe('DirectPlay enumeration in real v86', () => {
  it('keeps outer callback data stable through two nested enumerations and reclaims it after return', async () => {
    let transport!: DplayTransportHandlers;
    const instance = '11111111-1111-1111-1111-111111111111';
    const announce = (players: number) =>
      transport.onMessage({
        t: 'announce',
        i: instance,
        n: Uint8Array.from([65]),
        m: 8,
        c: players,
        g: '22222222-2222-2222-2222-222222222222',
        f: 0,
      });
    await withGuestMachine(
      async (m) => {
        const clsid = 0x300100,
          iid = 0x300120,
          out = 0x300140;
        const observed = 0x300160,
          savedStack = 0x300164;
        m.code(clsid, guidBytes(CLSID_DIRECTPLAY));
        m.code(iid, guidBytes('{133efe41-32dc-11d0-9cfb-00a0c90a43cb}'));
        expect(callShim(m.shim, 'OLE32.DLL!CoCreateInstance', [clsid, 0, 1, iid, out]).eax).toBe(0);
        const object = m.read(out);
        expect(callShim(m.shim, 'DPLAYX.COM!IDirectPlay3.InitializeConnection', [object, 0, 0]).eax).toBe(0);
        const baseline = m.shim.inspectHeapState().liveBytes;
        announce(1);
        const callback = PROGRAM + 0x1000;
        const enumerate = m.api('IDirectPlay3.EnumSessions', 24, undefined, 'DPLAYX.COM');
        const enumCall = (context: number) => [
          ...push32(0),
          ...push32(context),
          ...push32(callback),
          ...push32(0),
          ...push32(0),
          ...push32(object),
          ...call32(enumerate),
        ];
        const outerBody = [
          ...enumCall(1),
          ...enumCall(1),
          0x8b,
          0x43,
          44, // mov eax,[ebx+44]: original descriptor's dwCurrentPlayers
          0xa3,
          ...le32(observed),
        ];
        m.code(callback, [
          0x53, // preserve EBX, which keeps the outer descriptor across nested callbacks
          0x8b,
          0x5c,
          0x24,
          8, // mov ebx,[esp+8]: descriptor
          0x83,
          0x7c,
          0x24,
          20,
          0, // cmp [esp+20],0: only the outer context enumerates recursively
          0x75,
          outerBody.length,
          ...outerBody,
          0x5b,
          0xb8,
          1,
          0,
          0,
          0,
          0xc2,
          16,
          0, // pop ebx; return TRUE with stdcall cleanup
        ]);
        let enumerations = 0;
        m.afterCall = (call) => {
          if (call.imported.key !== 'DPLAYX.COM!IDirectPlay3.EnumSessions') return;
          enumerations++;
          // Incoming transport messages update discovery between guest calls without touching callback data.
          if (enumerations < 3) announce(enumerations + 1);
          else transport.onMessage({ t: 'sclose', i: instance });
        };
        m.code(PROGRAM, [
          0x89,
          0x25,
          ...le32(savedStack),
          ...enumCall(0),
          ...enumCall(0), // The final empty enumeration collects returned bridges' staging.
          0x89,
          0x25,
          ...le32(savedStack + 4),
          ...finish,
        ]);
        await m.run();
        expect(enumerations).toBe(4);
        expect(m.read(observed)).toBe(1);
        expect(m.read(savedStack + 4)).toBe(m.read(savedStack));
        expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(0);
        expect(m.read(GUEST_CALLBACK_OWNERS)).toBe(0);
        expect(m.shim.inspectHeapState().liveBytes).toBe(baseline);
      },
      {
        dplayTransportFactory: (handlers) => {
          transport = handlers;
          return { clientId: 'native-enumeration-test', send: () => true, close: () => {} };
        },
      },
    );
  });
});
