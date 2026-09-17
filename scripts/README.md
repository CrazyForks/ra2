# Developer tools

Use root `package.json` for everyday commands. Tests belong in `tests/`; this directory retains development and maintenance tools only.

| Directory      | Purpose                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `ci/`          | CI orchestration, process cleanup, trusted resource download/validation                                 |
| `resources/`   | Executable preparation, local ZIP archival, shared download modules                                     |
| `assets/`      | Extract icons/scrollbar sprites from original game assets, retaining provenance/pixel evidence          |
| `reverse/`     | Search PE addresses, imports, calls, and writes; requires supplied executables and reads originals only |
| `benchmarks/`  | Fixed-workload host microbenchmarks, not full-match FPS                                                 |
| `experiments/` | Offline model conversion/quality comparisons outside production and Basic CI                            |
| `deploy.sh`    | Explicitly invoked site deployment with caller-supplied configuration                                   |

Use Prettier directly: `pnpm run format` writes and `pnpm run format:check` verifies. Custom formatting scripts and game-package Blob-upload entries are no longer maintained. The frontend imports original packages directly; CI uses the same extractor. Historical trimming evidence remains in [Resource evidence](../docs/RESOURCE_PACKAGE_EVIDENCE.md).

Reverse-engineering tools accept executable paths and hexadecimal addresses:

```bash
pnpm exec tsx scripts/reverse/ra2Imports.mts "$GAME_EXE"
pnpm exec tsx scripts/reverse/ra2Dis.mts "$GAME_EXE" 400000 40
```

The second command outputs raw bytes, which callers may decode with NASM's ndisasm. Review matches against actual instruction boundaries; they do not justify directly patching unknown versions.

## Rendering and resource diagnostics

- `experiments/probeReShadeUi.mts` verifies real RA2 effect toggles and same-frame restoration. `experiments/probeReshadeRender.mts` requires supplied FX compilation output; see [ReShade adaptation](../docs/RESHADE_ADAPTATION.md).
- `experiments/captureSrBattle.mts` retains original campaign screenshot sampling. It requires supplied RA2 assets and defaults to `.tmp-sr-battle`; use `RA2_SR_OUTPUT` for a new directory. It depends on native menu layout/story progression and is outside public acceptance. Producing images does not establish battlefield acceptance.
- `ci/prepareGameProcess.mts <ra2|yr> <absolute-resource-directory>` is a standalone resource-preparation subprocess entry. With `ci/memory.ts` it records RSS, container memory, and OOM counts; it has not replaced CI's primary entry. Its module name differs from `ci/prepareGame.ts` so extension resolution cannot accidentally execute a CLI when importing a library.
