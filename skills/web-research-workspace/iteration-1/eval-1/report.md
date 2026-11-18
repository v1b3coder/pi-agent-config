# Distribuce Python CLI: PyInstaller vs Nuitka vs shiv/pex

## Answer

**PyInstaller v režimu `onedir`, build v CI matrix (Linux/macOS/Windows).** Pro zadaná kritéria
(rychlé buildy, žádné ladění platform-specific problémů) vyhrává, protože build je řádově sekundy,
nepotřebuje C toolchain a má největší ekosystém hooků. `--onefile` nepoužívat: extrahuje při
každém startu a na Windows přitahuje AV false positives.

Kdy volit jinak:
- **pex** (`--sh-boot`, případně `--scie`), pokud konzumenti mají vlastní Python (interní nástroje, CI, Docker). Build v sekundách a jediný multi-platform artefakt pro pure-Python.
- **Nuitka** jen s konkrétní měřenou potřebou rychlosti startu nebo hardeningu obsahu; platí se za to 5–17× delším buildem a C toolchainem na každé platformě.
- **shiv** nedoporučuji jako novou volbu: od 11/2024 bez vydání, Windows jen `py app.pyz`.

Cena, kterou žádná volba neodstraní: **žádný z nástrojů neumí cross-compile**, takže tři CI runnery
jsou nevyhnutelné. U PyInstalleru/Nuitky k tomu přistupuje podepisování: ~220 USD/rok a 2–4
inženýrské dny napoprvé, pokud se distribuuje přes DMG/MSI.

## Findings

### 1. Ani jeden nástroj neumí cross-compile — CI matrix je daň, ne volba
PyInstaller dokumentuje, že výstup je specifický pro OS a verzi Pythonu, na které se build spustil;
Nuitka totéž. pex umí `--platform`/`--complete-platform` rozřešit cizí platformu, ale jen pro
wheels; scie je nativní binárka pro jeden OS/arch. — confidence: high
Sources: pyinstaller.org/en/stable/operating-mode.html; docs.pex-tool.org/scie.html; docs.pex-tool.org (pex --platform)

### 2. PyInstaller onefile platí za každý start extrakcí do `_MEIxxxx`
Dokumentace: bootloader rozbalí support files do temp složky, po skončení je smaže, cache mezi běhy
neexistuje. Model dvou procesů znamená, že force-kill nechá `_MEI*` adresáře leakovat; `/tmp`
mountnutý `noexec` onefile úplně rozbije. Odsud „onefile je pomalý" — není to vlastnost PyInstalleru,
je to vlastnost režimu. — confidence: high
Sources: pyinstaller.org/en/stable/operating-mode.html; pyinstaller.org/en/stable/feature-notes.html

### 3. Nuitka je 5–17× pomalejší build a ccache to v CI nezachrání
Dva nezávislé macOS datapointy: 5,4× (16 jader, ccache off) a 17,2× (větší dep tree). onefile poměr
zužuje na 2,5–7,7×. Cross-machine ccache fungoval 0 % do Nuitka 4.4 (10/2026) a i pak chce pinovanou
instalaci a shared cache dir. Warm rebuild v téže session 386 → 202 s, tedy stále ~10× PyInstaller.
— confidence: high
Sources: runcell.dev/blog/pyinstaller-vs-nuitka-benchmark; github.com/Nuitka/Nuitka (issues, release notes 4.4)

### 4. Slované „18,5 s vs 0,24 s" je neplatné srovnání
Jde o onefile vs folder, ne Nuitka vs PyInstaller. Při srovnání stejných režimů je start folderu
0,02–0,27 s (Nuitka) vs 0,03–0,21 s (PyInstaller) — šum. Výjimka, která má váhu: PyInstaller
matplotlib hook přidává ~8 s na start. — confidence: high
Sources: runcell.dev/blog/pyinstaller-vs-nuitka-benchmark (tabulky build/start); github.com/pyinstaller/pyinstaller discussions

### 5. Nuitka je od 2026 AGPLv3 + Runtime Library Exception, a to se týká i vašeho closed-source CLI
Primary text `LICENSE-RUNTIME.txt`: exception „allow the compilation of non-AGPL (including
proprietary) Python programs … without the requirement that the resulting executable … be licensed
under the AGPLv3". Free tier tedy smí produkovat proprietární binárky; komerční tarif (250 €/rok)
prodává hardening (obfuskace konstant, traceback encryption, legacy Windows), ne právo
distribuovat. Zároveň relicense zavedla CLA — governance riziko pro závislé. — confidence: high
Sources: raw.githubusercontent.com/Nuitka/Nuitka/develop/LICENSE-RUNTIME.txt; nuitka.net/doc/commercial.html; nuitka.net/doc/commercial-license.html

### 6. Podepisování: macOS se dá obejít volbou kanálu, Windows ne
Apple Developer Program 99 USD/rok; Windows Azure Artifact Signing ~120 USD/rok (nebo OV cert
150–300 USD, pro OSS zdarma SignPath). Realistické minimum ~220 USD/rok, 2–4 dny práce napoprvé.
macOS Gatekeeper řeší jen quarantined kód, takže pip/uv/curl tarball podpis nepotřebuje (Homebrew
cask od 2026-09-01 ano). Windows SmartScreen reputace se váže na .exe bez ohledu na kanál a Smart
App Control nemá override. — confidence: medium (ceny high, odhady effortu low)
Sources: developer.apple.com/programs/enroll; learn.microsoft.com (Artifact Signing, 2026-11-10); github.com/Homebrew/brew#20755

### 7. shiv je v údržbovém režimu, pex naopak extrémně aktivní
shiv: poslední release 1.0.8 (11/2024), mezi 11/2024 a 11/2026 jen dva commity, otevřené PR z let
2021–2024 bez vydání, single maintainer. pex: 2.107.1 (11/2026), ~50 vydání za rok 2026, provenance
attestations; opačné riziko je churn, pinovat verzi. — confidence: high
Sources: github.com/linkedin/shiv (releases, commits); pypi.org/project/pex/#history

### 8. pex scie je produkční, ale jeden soubor = jedna platforma
scie = launcher + PEX zip + interpreter, 31 MB, start 16,3 ms vs 99,2 ms plain PEX a 17,6 ms
`--sh-boot`. Dokumentace bez varování, Pants to má jako first-class (`pex_binary(scie=...)`).
Pro trojplatformní distribuci to ale znamená tři scie buildy, ne jeden artefakt. — confidence: high
Sources: docs.pex-tool.org/scie.html; pex CHANGES.md 2.11.0

### 9. Nuitka neřeší třídu problémů, kvůli které se k němu lidé migrují
Týmová zkušenost: opakovaná bolest u PyInstalleru jsou churn third-party hooků a onefile temp-dir
bugy, ne prvotní setup; Nuitka hidden-import třídu neodstraňuje, jen přesouvá do compile-time.
AV whitelisting je průběžný proces na každý release, ne jednorázová oprava. — confidence: medium
Sources: github.com/pyinstaller/pyinstaller discussions; github.com/scito/extract_otp_secrets/issues/68

## Contradictions

- **„Nuitka je 5× pomalejší" vs „17× pomalejší"** — obojí reálné, závisí na velikosti dep tree a ccache. Report používá rozsah 5–17×, ne jedno číslo.
- **„Nuitka je pomalá na start" (18,5 s) vs „Nuitka je nejrychlejší" (0,24 s)** — obojí z téhož benchmarku, různé režimy. Rozhodnuto: srovnávat jen stejné režimy (finding 4).
- **„Nuitka vyžaduje komerční licenci pro closed source"** — vyvráceno primárním textem LICENSE-RUNTIME.txt (finding 5).
- **„pex nepodporuje Windows"** — historicky pravda (issue #259), dnes tracking #2658 stále otevřený, scie pro Windows jen od 7/2026. Formulace v reportu: „podporováno s ostrými hranami".

## What we could not establish

- **Žádné měření pro tento konkrétní projekt.** Všechna čísla jsou cizí benchmarky; build time a start si tým musí změřit sám (odhad: hodina práce).
- **CI wall-clock pro 3-OS matrix** — nikdo neměřil; odhad z build poměrů, ne z dat.
- **pex/scie na reálném dep tree** s compiled závislostmi — dokumentace mluví jasně, ale chybí nezávislé produkční potvrzení.
- **Nuitka + antivirové guidance** jako placená featura — v veřejných zdrojích nenalezeno, brief to tvrdil neověřeně.
- **Homebrew cask signing od 2026-09-01** — jediný zdroj (brew#20755), neověřeno proti oficiálnímu oznámení.

## Sources

- https://pyinstaller.org/en/stable/operating-mode.html
- https://pyinstaller.org/en/stable/feature-notes.html
- https://github.com/orgs/pyinstaller/discussions/7436 (build/startup datapoint)
- https://github.com/orgs/pyinstaller/discussions/7368 (build speed, maintainer)
- https://runcell.dev/blog/pyinstaller-vs-nuitka-benchmark (build/start tabulky)
- https://github.com/Nuitka/Nuitka — LICENSE-RUNTIME.txt, release notes 4.3/4.4
- https://nuitka.net/doc/commercial.html, /commercial-license.html, /commercial/purchase.html
- https://github.com/linkedin/shiv — releases, commits, issue #45
- https://pypi.org/project/pex/#history, https://docs.pex-tool.org/scie.html
- https://docs.pex-tool.org — `--platform`, `--complete-platform`
- https://developer.apple.com/programs/enroll
- https://learn.microsoft.com — Azure Artifact Signing (2026-11-10)
- https://github.com/Homebrew/brew/pull/20755
- https://github.com/scito/extract_otp_secrets/issues/68
