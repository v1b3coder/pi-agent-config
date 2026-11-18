# Research plan — Python CLI distribuce: PyInstaller vs Nuitka vs shiv/pex

## Question
Který nástroj použít pro distribuci Python CLI jako binárky na Linux/macOS/Windows,
když tým chce rychlé buildy a nechce ladit platform-specific problémy?

## Decision it feeds
Volba build/distribuční pipeline (jeden tým, 3 platformy, CI-only buildy).

## Success criteria (co musí být v reportu)
- Reálný build time (cold/warm, onefile vs onedir) — primární zdroj nebo datovaný benchmark.
- Co nástroj skutečně produkuje: self-contained binary vs vyžaduje Python na cíli.
- Platform-specific failure modes: macOS codesign/notarizace, Windows AV false positives, glibc/musl.
- Cross-kompilace: možné/není, tedy kolik CI runnerů je potřeba.
- Start-up latence a velikost artefaktu.
- Údržba/aktivita projektu 2025–2026.
- Explicitní contra doporučení + kdy zvolit jinak.

## Known context
- Předchozí běh (blocked-run-1) selhal: researcher subagenti neměli web tools. Ověřit probe.
- Tým nechce ručně udržovat platformní build farmu nad rámec CI matrix.

## Angles (round 1)
- A: PyInstaller — build time, onefile/onedir, macOS notarizace, Windows Defender, hooks, údržba.
- B: Nuitka — compile time, onefile režim, licence (commercial edition), platformy, failure modes.
- C: shiv/pex/zipapp — co reálně dodá, Python na cíli, pex scies, determinismus, Windows.

## Round 1 result — settled
- PyInstaller: aktivní (6.22.3, 9/2026), žádná cross-kompilace, onefile extrahuje při každém startu, macOS podpis/notarizace na uživateli, AV false positives stále živé, glibc floor = build machine. [high]
- Nuitka: 4.3 (10/2026), ~5× pomalejší build, C toolchain, žádná cross-kompilace, onefile re-extract. Licence se v 2026 změnila na AGPLv3 + runtime exception. [high]
- shiv: .pyz, vyžaduje Python na cíli, od 11/2024 dormant. [high]
- pex: aktivní (2.107.1), scie = nativní exe s CPythonem (31 MB, 16 ms start), multi-platform pex přes --platform, Windows podpora čerstvá (7/2026). [high]

## Round 2–3 result
- G1 uzavřeno: AGPLv3 od 2.8 (11/2025), runtime exception výslovně dovoluje proprietární výstup; commercial €250/rok = hardening, ne licence. Riziko je politika firem, ne právo. [high]
- G2 uzavřeno: macOS $99/rok + Developer ID + notarytool (CLI průchodné); Windows OV $150–300/rok, EV už instant SmartScreen neznamená; unsigned projde jen do quarantine (Homebrew to zavřel 9/2026). [high]
- G3 uzavřeno: 5× je konzervativní, reálný CLI dep tree 17× (386 s vs 22,4 s); ccache cross-machine 0 %; onefile 18,5 s reprodukovatelně, ale macOS-specific. [high]
- pex scie: 31 MB, 16,3 ms, jeden exe; Windows build z Linuxu od 2.98.0 (7/2026), #2658 stále open, signing neřešen. [high/medium]
- Round 3: žádný první-ruční pex scie adopter; hook churn je hlavní provozní cena PyInstalleru, ne architektura.

## Decision
PyInstaller onedir + 3-OS CI matrix. pex jen když cíl má Python. Nuitka jen pro IP ochranu / cold start, s vědomím 5–17× build time.

## Open (nezavřeno)
- wall-clock 3-OS CI matice, hodiny/měsíc údržby, frekvence AV false positives, zda runtime exception kryje data files.
