/**
 * pi-notify-extension
 *
 * Alerts you when pi waits for human interaction (agent_end event).
 *
 * Features:
 * - **Sound alert** via terminal bell + native audio player (paplay/pw-play/aplay)
 * - **Desktop notification** via OSC 777 / Kitty / Windows toast
 * - **Optional ntfy push notification** when you don't respond within a timeout
 *
 * Install:
 *   cp index.ts ~/.pi/agent/extensions/notify.ts
 * Then /reload or restart pi.
 *
 * Configuration via environment variables (all optional):
 *   PI_EXT_NOTIFY_SOUND    true/false       (default: true)
 *   PI_EXT_NTFY_ENABLED    true/false       (default: false)
 *   PI_EXT_NTFY_TOPIC      string           (default: "")
 *   PI_EXT_NTFY_SERVER     string           (default: https://ntfy.sh)
 *   PI_EXT_NTFY_PRIORITY   1-5              (default: 3)
 *   PI_EXT_NTFY_SOUND      string           (default: default)
 *   PI_EXT_NTFY_TAGS       comma-separated  (default: robot)
 *   PI_EXT_NTFY_TIMEOUT_MS milliseconds     (default: 30000 = 30s)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Configuration ───────────────────────────────────────────────────────────

interface Config {
	soundEnabled: boolean;
	ntfyEnabled: boolean;
	ntfyTopic: string;
	ntfyServer: string;
	ntfyPriority: number;
	ntfySound: string;
	ntfyTags: string[];
	ntfyTimeoutMs: number;
}

function loadConfig(): Config {
	const env = (name: string, fallback: string): string =>
		process.env[`PI_EXT_${name}`] ?? fallback;

	const envBool = (name: string, fallback: boolean): boolean => {
		const v = process.env[`PI_EXT_${name}`];
		if (v === undefined) return fallback;
		return v === "true" || v === "1" || v === "yes";
	};

	const envInt = (name: string, fallback: number): number => {
		const v = process.env[`PI_EXT_${name}`];
		if (v === undefined) return fallback;
		const n = parseInt(v, 10);
		return isNaN(n) ? fallback : Math.max(0, n);
	};

	return {
		soundEnabled: envBool("NOTIFY_SOUND", true),
		ntfyEnabled: envBool("NTFY_ENABLED", false),
		ntfyTopic: env("NTFY_TOPIC", ""),
		ntfyServer: env("NTFY_SERVER", "https://ntfy.sh"),
		ntfyPriority: Math.min(5, Math.max(1, envInt("NTFY_PRIORITY", 3))),
		ntfySound: env("NTFY_SOUND", "default"),
		ntfyTags: env("NTFY_TAGS", "robot").split(",").map((s) => s.trim()).filter(Boolean),
		ntfyTimeoutMs: envInt("NTFY_TIMEOUT_MS", 30000),
	};
}



// ─── Sound helpers ───────────────────────────────────────────────────────────

/** Terminal bell (BEL) - works everywhere */
function terminalBell(): void {
	process.stdout.write("\x07");
}

/**
 * OSC 777 notification (Ghostty, iTerm2, WezTerm, rxvt-unicode).
 * Most terminals play a sound for this.
 */
function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

/** Kitty OSC 99 notification */
function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99:i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99:i=1:p=body;${body}\x1b\\`);
}

/** Windows toast notification via PowerShell */
function notifyWindows(title: string, body: string): void {
	const script = `
$type = "Windows.UI.Notifications"
$mgr = "[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]"
$template = "[${type}.ToastTemplateType]::ToastText01"
${mgr} > $null
$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})
$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body.replace(/'/g, "''")}')) > $null
[${type}.ToastNotificationManager]::CreateToastNotifier('${title.replace(/'/g, "''")}').Show([${type}.ToastNotification]::new($xml))
`;
	execFile("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 5000 });
}

// ─── Native audio players ────────────────────────────────────────────────────

function execFileAsync(cmd: string, args: string[], options?: object): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, options as any, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout, stderr });
		});
	});
}

function execAsync(cmd: string, options?: object): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		exec(cmd, options as any, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout, stderr });
		});
	});
}

function spawnAsync(cmd: string, args: string[], options?: object): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, options as any);
		child.on("close", (code) => resolve(code));
		child.on("error", reject);
	});
}

/**
 * Try to play a sound using a system audio player (paplay, pw-play, aplay, afplay).
 * Returns true if the sound was played successfully.
 */
async function playNativeSound(): Promise<boolean> {
	const soundFile = findSoundFile();
	if (!soundFile) {
		// Fallback: generate a beep via speaker-test or direct PCM tone
		return playFallbackBeep();
	}

	const players: Array<{ cmd: string; args: string[] }> = [
		{ cmd: "paplay", args: [soundFile] },
		{ cmd: "pw-play", args: [soundFile] },
		{ cmd: "aplay", args: [soundFile] },
		{ cmd: "afplay", args: [soundFile] },
	];

	for (const { cmd, args } of players) {
		try {
			await execFileAsync(cmd, args, { stdio: "ignore", timeout: 3000 });
			return true;
		} catch {
			continue;
		}
	}

	return false;
}

/**
 * Look for bundled sound files (wav) next to this extension.
 * Order of preference: notification.wav > notify.wav > done.wav > bell.wav
 */
function findSoundFile(): string | null {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(__dirname, "notification.wav"),
		join(__dirname, "notify.wav"),
		join(__dirname, "done.wav"),
		join(__dirname, "bell.wav"),
	];
	for (const path of candidates) {
		if (existsSync(path)) return path;
	}

	return null;
}

/**
 * Fallback: generate an audible beep without requiring any sound files.
 * Uses speaker-test or generates a raw PCM sine wave piped to aplay.
 */
async function playFallbackBeep(): Promise<boolean> {
	// Try speaker-test for a quick sine wave beep
	try {
		const code = await spawnAsync("speaker-test", [
			"-t", "sine", "-f", "800", "-l", "1", "-p", "1", "-r", "48000",
		], {
			stdio: "ignore",
			timeout: 2000,
		});
		if (code !== null) return true;
	} catch {
		// fall through to aplay beep
	}

	// Try generating a PCM beep via aplay
	try {
		await execAsync(
			"perl -e 'for (0..8000) { print pack(\"v\", 32767 * sin($_ * 3.14159 * 800 / 48000)) }' | aplay -r 48000 -f S16_LE -c 1 -t raw 2>/dev/null",
			{ stdio: "ignore", timeout: 2000, shell: true },
		);
		return true;
	} catch {
		// No aplay or no audio device
	}

	return false;
}

async function playSoundAlert(): Promise<void> {
	terminalBell();

	// Try native audio player first — this is the primary sound mechanism on Linux
	const nativePlayed = await playNativeSound();

	// Terminal notifications for desktops with visual popups
	if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99("Pi", "Agent is waiting for your input");
	} else if (process.env.WT_SESSION) {
		notifyWindows("Pi", "Agent is waiting for your input");
	}

	// If no native player played, try OSC 777 as a last resort
	// (in Kitty/Windows we already sent a visual notification, but add OSC 777 too)
	if (!nativePlayed) {
		notifyOSC777("Pi", "Agent is waiting for your input");
	}
}

// ─── System idle detection ────────────────────────────────────────────────

/**
 * Get system idle time in milliseconds via xprintidle.
 * Returns null if xprintidle is not installed or fails.
 */
async function getUserIdleMs(): Promise<number | null> {
	try {
		const { stdout } = await execFileAsync("xprintidle", [], { timeout: 2000, encoding: "utf-8" });
		const ms = parseInt(stdout.trim(), 10);
		return isNaN(ms) ? null : ms;
	} catch {
		return null;
	}
}

// ─── ntfy ────────────────────────────────────────────────────────────────────

function getMessageText(msg: any): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join(" ");
	}
	return "";
}

async function sendNtfy(config: Config, lastMessageSnippet: string): Promise<void> {
	if (!config.ntfyTopic) {
		console.error("[pi-notify] ntfy topic not configured");
		return;
	}

	try {
		const url = `${config.ntfyServer.replace(/\/+$/, "")}/${config.ntfyTopic}`;

		// Compact format: hostname (folder): message
		const h = hostname();
		const cwd = process.cwd();
		const home = process.env.HOME ?? "";
		const shortCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
		const body = lastMessageSnippet
			? `${h} (${shortCwd}): ${lastMessageSnippet}`
			: `${h} (${shortCwd})`;

		// ntfy expects the POST body to be the plain text message.
		// Metadata (title, priority, tags, sound) is sent as HTTP headers.
		// See https://docs.ntfy.sh/publish/
		const headers: Record<string, string> = {
			"Title": "Pi needs your input",
			"Priority": String(config.ntfyPriority),
			"Tags": config.ntfyTags.join(","),
		};
		if (config.ntfySound !== "default") {
			headers["Sound"] = String(config.ntfySound);
		}

		const res = await fetch(url, {
			method: "POST",
			headers,
			body,
		});

		if (!res.ok) {
			console.error(`[pi-notify] ntfy push failed: HTTP ${res.status}`);
		}
	} catch (err) {
		console.error(`[pi-notify] ntfy push error:`, err instanceof Error ? err.message : String(err));
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Warn if ntfy is enabled but xprintidle is missing
	if (config.ntfyEnabled && config.ntfyTopic) {
		getUserIdleMs().then((idleMs) => {
			if (idleMs === null) {
				console.error("[pi-notify] ⚠️ xprintidle not found — idle detection won't work. Install it: sudo apt install xprintidle");
			}
		});
	}

	console.error(
		`[pi-notify] loaded (sound=${config.soundEnabled}, ntfy=${config.ntfyEnabled ? `✅ topic=${config.ntfyTopic}, timeout=${config.ntfyTimeoutMs}ms` : "❌"})`,
	);

	let userRespondedSinceEnd = false;
	let ntfyTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer(): void {
		if (ntfyTimer !== null) {
			clearTimeout(ntfyTimer);
			ntfyTimer = null;
		}
	}

	// ── agent_end: agent finished, waiting for user ──────────────────────
	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;

		userRespondedSinceEnd = false;

		// Skip sound if user cancelled the agent (e.g. by pressing Esc)
		const wasCancelled = ctx.signal?.aborted ?? false;

		// 1) Sound immediately (only if agent wasn't cancelled)
		if (config.soundEnabled && !wasCancelled) {
			await playSoundAlert();
		}

		// 2) Schedule ntfy: if no activity since the beep, send after timeout
		if (config.ntfyEnabled && config.ntfyTopic) {
			clearTimer();

			// Extract last assistant message snippet
			const lastAssistantMsg = event.messages?.filter((m: any) => m.role === "assistant").pop();
			const lastMessageSnippet = lastAssistantMsg ? getMessageText(lastAssistantMsg).slice(0, 30).trim() : "";

			ntfyTimer = setTimeout(async () => {
				if (!userRespondedSinceEnd) {
					const idleMs = await getUserIdleMs();
					// idle is monotonic: if no mouse/keyboard since beep, idleMs ≥ timeout
					if (idleMs === null || idleMs >= config.ntfyTimeoutMs) {
						await sendNtfy(config, lastMessageSnippet);
					}
					// idleMs < timeout → user touched something after beep → skip
				}
				ntfyTimer = null;
			}, config.ntfyTimeoutMs);
		}
	});

	// ── input: user typed something → cancel pending ntfy ────────────────
	pi.on("input", async (event, _ctx) => {
		if (event.source === "interactive") {
			userRespondedSinceEnd = true;
			clearTimer();
		}
		return { action: "continue" };
	});

	// ── Cleanup on shutdown ──────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		clearTimer();
	});
}
