# Chess engine research for Sprint 2 (November 2026)

## Comparison

Strength is the CCRL 40/15 rating from the list computed on 9 Oct 2026. Sizes come from the official GitHub releases and from npm. Sizes marked "measured" were checked on disk.

| Engine | How it works | Strength | Download / size on disk | Hardware | Licence | Use from our app |
|---|---|---|---|---|---|---|
| **Stockfish 19** (native, Sep 2026) | Alpha-beta search + NNUE network (network built into the binary) | **#1, ~3650** | 80–82 MB archive; **105 MB binary** (macOS universal, measured) | Any 64-bit CPU (x86-64, ARM64, RISC-V). One universal binary per OS picks AVX2/AVX-512/NEON itself. RAM: hash 16 MB default, 64–256 MB is plenty for review. Faster with more cores. | GPL-3.0 | Run as a separate process and talk to it over UCI |
| Stockfish 19 WASM, full (npm `stockfish@19.0.1`) | Same engine compiled to WebAssembly | Same as native, but runs slower | 99 MB `.wasm` (measured) | CPU. Multithreading needs SharedArrayBuffer (COOP/COEP headers, which we control in Electron) | GPL-3.0 | Web Worker or Node; no native binaries |
| Stockfish 19 WASM, lite | WebAssembly with a small network | Noticeably weaker (per its README) | **1.7–1.8 MB** `.wasm` (measured) | Any CPU, single thread is fine | GPL-3.0 | Web Worker; good for a quick preview |
| Reckless 0.9 | Alpha-beta + NNUE | #2, ~3644 | ~65 MB binary | 64-bit CPU (AVX2/AVX-512/generic builds) | Open source | Separate process over UCI |
| PlentyChess 7/8 | Alpha-beta + NNUE | #3, ~3642 | ~54 MB binary | 64-bit CPU | Open source | Separate process over UCI |
| Torch v4 (chess.com) | Alpha-beta + NN | ~3639 | No download found | — | Proprietary | Not available |
| Obsidian 16 | Alpha-beta + NNUE | ~3637 (Sep snapshot) | ~32 MB binary | x86-64 CPU (AVX2/AVX-512 builds) | Open source | Separate process over UCI |
| Berserk 14 | Alpha-beta + NNUE | Not checked (top tier) | ~27 MB binary + 25 MB network | x86-64 CPU | Open source | Separate process over UCI |
| Leela Chess Zero 0.33 | Monte-Carlo tree search + large transformer network | Elite **on a GPU**; much weaker on CPU | Engine 5–40 MB (Windows CUDA bundle up to 590 MB) + **BT4 network 330–380 MB** | **NVIDIA GPU with ~4 GB VRAM** for the big networks; the CPU backend is slow | GPL-3.0 | Separate process over UCI; too heavy to bundle |
| Komodo Dragon 3.3 | Alpha-beta + NNUE | Strong, but last release was Oct 2023 | — | CPU | Commercial ($74.98) | Can't be redistributed |

Not measured: our own speed benchmark. Running the downloaded Stockfish binary was blocked in this session, so speed below is an estimate. Published NPS: M2 Max 12 threads ≈ 9 M nodes/s (Stockfish 16), M2 Ultra ≈ 28 M nodes/s. Estimate: reviewing a 46-move game (92 positions) at depth 18–20 on a 4–8 core laptop takes roughly 10–60 s natively, and several times longer with WASM.

## Conclusion

**Use Stockfish 19 as a native binary, run as a child process over UCI from Electron's main process.**

- **Strongest:** it is #1 on every list, and it is what chess.com and lichess use for their own analysis (chess.com's local analysis is Stockfish).
- **Runs on ordinary hardware:** it needs a CPU only, on every OS we target. Each OS has one universal binary, so there's no CPU-flavour matrix.
- **Size:** ~105 MB per platform. Each installer bundles only its own OS's binary, so the app grows by ~80 MB compressed.
- **Integration:** UCI over stdin/stdout from Node is ~100 lines. We get `MultiPV`, WDL output and per-move evals, which classification needs.
- **Settings for review:** `Threads = cores - 1`, `Hash = 128–256 MB`, depth 18–20 per position (chess.com Game Review appears to use about depth 18–20), and `MultiPV 2` so we can detect "only move" (Great) cases.
- **Licensing (GPL-3):** shipping Stockfish as a separate executable next to our app is fine. We must include its licence and a link to its source.

**Fallback / extra:** the 1.8 MB **Stockfish lite WASM** can give an instant rough eval while the full analysis runs, or be used if a platform binary is missing.

**Not recommended:**
- Leela: needs a GPU and a 330–380 MB network.
- Torch and Dragon: closed or commercial.
- Reckless and PlentyChess: almost as strong, but they add nothing over Stockfish here.

**Note:** the engine only supplies evaluations. The chess.com-style classification (best/excellent/good/inaccuracy/mistake/blunder) is our own layer on top. It converts each eval into win probability ("expected points") and grades the drop: 0, 0–0.02, 0.02–0.05, 0.05–0.10, 0.10–0.20, >0.20. Brilliant, great, miss, book and forced need extra rules.

## Sources

- CCRL 40/15 rating list: https://computerchess.org.uk/4040/index.html
- Rama Chess, best engines in 2026: https://ramachess.com/best-chess-engines/
- Stockfish 19 release: https://github.com/official-stockfish/Stockfish/releases/tag/sf_19
- stockfish.js (npm `stockfish`): https://github.com/nmrugg/stockfish.js
- Leela Chess Zero best networks: https://lczero.org/play/networks/bestnets
- Komodo Dragon 3.3: https://komodochess.com/dragon-3.3.htm
- Chess.com, how its engines work: https://support.chess.com/en/articles/9462780-how-do-the-chess-engines-on-chess-com-work
- Chess.com, how moves are classified: https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-and-etc
- Apple M2 Stockfish benchmarks: https://forums.macrumors.com/threads/big-favor-needed-for-the-chess-community.2417054 and https://openbenchmarking.org/test/pts/stockfish
