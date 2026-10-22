/**
 * Interview Extension — standalone structured clarifying questions for pi.
 *
 * Reimplements openplan's plan_question as a self-contained tool named
 * `interview`, with one fix: the answers are delivered via steer
 * (sendMessage triggerTurn: true) so they enter the LLM context in the
 * SAME turn. The original's triggerTurn: false deferred the answers to
 * agent.state.messages at turn_end, which the in-flight agent loop never
 * sees (it runs on a copied messages array) — the agent only received
 * "Answers recorded." and had to ask the user to repeat the answers.
 *
 * UI is based on the original (MIT, wilfredinni/pi-openplan):
 * keyboard-navigable overlay with tabs, single/multi select, custom text,
 * review tab, and a rendered markdown answer block in the transcript. It
 * adds mandatory question context and per-option pros/cons, shown inline in
 * the TUI and behind a details action in dialog mode.
 *
 * Mode support:
 *   - TUI: the full custom overlay (custom components are TUI-only).
 *   - RPC/IDE: select/input dialogs over the extension UI protocol,
 *     plus a details editor for the full context/comparison.
 *   - JSON/print: a text fallback asking the LLM to assume.
 *
 * Tool:
 *   interview — Ask structured clarifying questions (batch up to 4).
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionUIContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Constants ─────────────────────────────────────────────────────

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MIN_CONTEXT_LENGTH = 20;
const MAX_CONTEXT_LENGTH = 400;
const MIN_DESCRIPTION_LENGTH = 8;
const MAX_DESCRIPTION_LENGTH = 160;
const MIN_PRO_CON_LENGTH = 8;
const MAX_PRO_CON_LENGTH = 160;
const MAX_PRO_CON_ITEMS = 3;

/** Sentinel option that opens free-text input in dialog mode (RPC/IDE). */
const CUSTOM_CHOICE = "✎ Type your own answer…";
/** Sentinel option that submits a multi-select question in dialog mode. */
const DONE_CHOICE = "✓ Done selecting";
/** Sentinel option that opens the full context/comparison in dialog mode. */
const DETAILS_CHOICE = "ℹ Show context & comparison";
/** Sentinel option that aborts the dialog flow for renderers without dismiss support. */
const CANCEL_CHOICE = "✗ Cancel";

// ── Types ─────────────────────────────────────────────────────────

interface QuestionOption {
	label: string;
	/** What the option is, in one concrete sentence. */
	description: string;
	/** Concrete advantages (1-3). */
	pros: string[];
	/** Concrete disadvantages (1-3). */
	cons: string[];
	/** When this option is the right choice. */
	bestFor?: string;
}

interface PlanQuestion {
	/** Full question text to display */
	question: string;
	/** Short label for tab display (max 16 chars) */
	header: string;
	/** Why this question is asked, constraints, and what is at stake. */
	context: string;
	/** Why these options were chosen and what was ruled out. */
	rationale: string;
	/** 2-4 predefined options */
	options: QuestionOption[];
	/** Label of the recommended option, or "none". */
	recommended?: string;
	/** Why the recommended option is preferred. */
	recommendationReason?: string;
	/** Allow multiple selections (checkboxes). Default: false */
	multiSelect?: boolean;
	/** Allow free-text "Other" answer. Default: true */
	custom?: boolean;
}

interface PromptTheme {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
}

interface PlanQuestionInput {
	questions: PlanQuestion[];
}

/** answers[i] = selected label(s) for questions[i] */
type PlanQuestionOutput = string[][];

// ── Validation ────────────────────────────────────────────────────

/**
 * Trim a required string and fail with an actionable message when it is too
 * short. This is the real gate: provider schemas may carry minLength hints, but
 * the model can still omit or pad fields, and pi does not guarantee schema
 * enforcement for every provider.
 */
function requireText(value: string | undefined, field: string, minLength: number): string {
	const text = value?.trim() ?? "";
	if (text.length < minLength) {
		throw new Error(
			`Error: ${field} must be at least ${minLength} characters. Add concrete context so the user can understand the choice.`,
		);
	}
	return text;
}

/** Validate and normalize the tool input before showing anything. */
function validateQuestions(questions: PlanQuestion[]): void {
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) {
		throw new Error(
			`Error: provide 1-${MAX_QUESTIONS} questions.`,
		);
	}

	for (const q of questions) {
		q.question = requireText(q.question, "question text", 1);
		q.header = requireText(q.header, "header", 1);
		if (q.header.length > MAX_HEADER_LENGTH) {
			q.header = q.header.slice(0, MAX_HEADER_LENGTH);
		}
		q.context = requireText(
			q.context,
			`context for "${q.header}"`,
			MIN_CONTEXT_LENGTH,
		);
		q.rationale = requireText(
			q.rationale,
			`rationale for "${q.header}"`,
			MIN_CONTEXT_LENGTH,
		);
		if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
			throw new Error(
				`Error: question "${q.header}" needs ${MIN_OPTIONS}-${MAX_OPTIONS} options.`,
			);
		}

		const labels = new Set<string>();
		for (const [index, o] of q.options.entries()) {
			o.label = requireText(o.label, `option ${index + 1} label in "${q.header}"`, 1);
			if (labels.has(o.label)) {
				throw new Error(
					`Error: duplicate option label "${o.label}" in "${q.header}". Each label must be unique.`,
				);
			}
			labels.add(o.label);
			o.description = requireText(
				o.description,
				`description for option "${o.label}"`,
				MIN_DESCRIPTION_LENGTH,
			);
			if (!Array.isArray(o.pros) || o.pros.length === 0) {
				throw new Error(
					`Error: option "${o.label}" needs at least one pro. Add a concrete advantage.`,
				);
			}
			if (!Array.isArray(o.cons) || o.cons.length === 0) {
				throw new Error(
					`Error: option "${o.label}" needs at least one con. Add a concrete disadvantage.`,
				);
			}
			o.pros = o.pros.map((pro, i) =>
				requireText(pro, `pro ${i + 1} for option "${o.label}"`, MIN_PRO_CON_LENGTH),
			);
			o.cons = o.cons.map((con, i) =>
				requireText(con, `con ${i + 1} for option "${o.label}"`, MIN_PRO_CON_LENGTH),
			);
			if (o.bestFor !== undefined) {
				o.bestFor = requireText(o.bestFor, `bestFor for option "${o.label}"`, 1);
			}
		}

		if (q.recommended !== undefined) {
			const recommended = q.recommended?.trim() ?? "";
			if (recommended && recommended !== "none") {
				if (!labels.has(recommended)) {
					throw new Error(
						`Error: recommended must be one of the option labels or "none".`,
					);
				}
				q.recommended = recommended;
				q.recommendationReason = requireText(
					q.recommendationReason,
					`recommendationReason for "${q.header}"`,
					MIN_CONTEXT_LENGTH,
				);
			} else {
				q.recommended = undefined;
				q.recommendationReason = undefined;
			}
		}
	}
}

// ── TUI Component ─────────────────────────────────────────────────

class InterviewPrompt {
	private questions: PlanQuestion[];
	private done: (result: string[][] | null) => void;
	private theme: PromptTheme;

	// State
	private currentTab = 0;
	private answers: string[][] = [];
	private customTexts: string[] = [];
	private selectedIndex = 0;
	private editing = false;
	private inputBuffer = "";
	private detailsExpanded = false;
	private comparisonMode = false;

	constructor(
		questions: PlanQuestion[],
		theme: PromptTheme,
		done: (result: string[][] | null) => void,
	) {
		this.questions = questions;
		this.theme = theme;
		this.done = done;
		this.answers = questions.map(() => []);
		this.customTexts = questions.map(() => "");
	}

	// ── Derived state ──────────────────────────────────────────────

	/** Number of tabs: questions + review/confirm (if needed) */
	private get tabCount(): number {
		if (this.questions.length === 1 && !this.questions[0]?.multiSelect) {
			return 1; // single-select auto-submits, no review tab
		}
		return this.questions.length + 1; // +1 for review/confirm
	}

	private get currentQuestion(): PlanQuestion | undefined {
		return this.questions[this.currentTab];
	}

	private get totalOptions(): number {
		const q = this.currentQuestion;
		if (!q) return 0;
		return q.options.length + (q.custom !== false ? 1 : 0);
	}

	private get isReviewTab(): boolean {
		if (this.questions.length === 1 && !this.questions[0]?.multiSelect) {
			return false;
		}
		return this.currentTab >= this.questions.length;
	}

	private get isMultiSelect(): boolean {
		return this.currentQuestion?.multiSelect === true;
	}

	private get isCustomOption(): boolean {
		return (
			this.selectedIndex === this.totalOptions - 1 &&
			this.currentQuestion?.custom !== false
		);
	}

	// ── Input handling ─────────────────────────────────────────────

	handleInput(data: string): void {
		// ── Custom text editing mode ──────────────────────────
		if (this.editing) {
			if (matchesKey(data, Key.escape)) {
				this.editing = false;
				this.inputBuffer = "";
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const text = this.inputBuffer.trim();
				if (text) {
					this.commitCustomAnswer(text);
				}
				this.editing = false;
				this.inputBuffer = "";
				this.tryAdvance();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				this.inputBuffer = this.inputBuffer.slice(0, -1);
				return;
			}
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
				return;
			}
			// Printable character
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.inputBuffer += data;
				return;
			}
			return;
		}

		// ── Comparison view ───────────────────────────────────
		if (this.comparisonMode) {
			if (matchesKey(data, Key.escape) || data === "c") {
				this.comparisonMode = false;
			}
			return;
		}

		// ── Tab navigation (multi-question / review) ───────────
		if (this.tabCount > 1) {
			if (
				matchesKey(data, Key.tab) ||
				matchesKey(data, Key.right) ||
				data === "l"
			) {
				this.currentTab = (this.currentTab + 1) % this.tabCount;
				this.selectedIndex = 0;
				this.detailsExpanded = false;
				return;
			}
			if (
				matchesKey(data, "shift+tab") ||
				matchesKey(data, Key.left) ||
				data === "h"
			) {
				this.currentTab = (this.currentTab - 1 + this.tabCount) % this.tabCount;
				this.selectedIndex = 0;
				this.detailsExpanded = false;
				return;
			}
		}

		// ── Review tab ─────────────────────────────────────────
		if (this.isReviewTab) {
			if (matchesKey(data, Key.enter)) {
				this.done(this.answers);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.done(null);
				return;
			}
			// Allow scrolling through review items
			if (matchesKey(data, Key.up) || data === "k") {
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
				}
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				if (this.selectedIndex < this.questions.length - 1) {
					this.selectedIndex++;
				}
				return;
			}
			return;
		}

		// ── Detail and comparison toggles ───────────────────────
		if (this.detailsExpanded && matchesKey(data, Key.escape)) {
			this.detailsExpanded = false;
			return;
		}
		if (data === "d") {
			this.detailsExpanded = !this.detailsExpanded;
			return;
		}
		if (data === "c") {
			this.comparisonMode = true;
			return;
		}

		// ── Question tab: option navigation ────────────────────
		const total = this.totalOptions;
		if (total === 0) return;

		// Number keys (1-9) for quick selection
		const digit = Number(data);
		if (!Number.isNaN(digit) && digit >= 1 && digit <= Math.min(total, 9)) {
			this.selectedIndex = digit - 1;
			this.selectCurrentOption();
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + total) % total;
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % total;
			return;
		}

		// Enter: pick / toggle / start editing
		if (matchesKey(data, Key.enter)) {
			this.selectCurrentOption();
			return;
		}

		// Escape: for multi-select, submit; for single-select, dismiss
		if (matchesKey(data, Key.escape)) {
			if (this.isMultiSelect) {
				// Submit current selections
				this.tryAdvance();
			} else {
				this.done(null);
			}
			return;
		}
	}

	/**
	 * Handle selection of the currently highlighted option.
	 */
	private selectCurrentOption(): void {
		const q = this.currentQuestion;
		if (!q) return;

		const isCustom = this.isCustomOption && q.custom !== false;

		if (isCustom) {
			// Start editing custom text
			this.editing = true;
			this.inputBuffer = this.customTexts[this.currentTab] || "";
			return;
		}

		const opt = q.options[this.selectedIndex];
		if (!opt) return;

		if (this.isMultiSelect) {
			this.toggleAnswer(opt.label);
			return;
		}

		// Single-select: pick and advance
		this.answers[this.currentTab] = [opt.label];
		this.tryAdvance();
	}

	/**
	 * Commit custom text answer and advance.
	 */
	private commitCustomAnswer(text: string): void {
		this.customTexts[this.currentTab] = text;
		// For multi-select, add to selected answers
		if (this.isMultiSelect) {
			const existing = this.answers[this.currentTab] ?? [];
			if (!existing.includes(text)) {
				this.answers[this.currentTab] = [...existing, text];
			}
		} else {
			this.answers[this.currentTab] = [text];
		}
	}

	/**
	 * Toggle a multi-select answer.
	 */
	private toggleAnswer(label: string): void {
		const existing = this.answers[this.currentTab] ?? [];
		const index = existing.indexOf(label);
		if (index === -1) {
			this.answers[this.currentTab] = [...existing, label];
		} else {
			this.answers[this.currentTab] = existing.filter((a) => a !== label);
		}
	}

	/**
	 * Advance to next tab or submit if on last question (multi-question mode only).
	 */
	private tryAdvance(): void {
		this.detailsExpanded = false;
		this.comparisonMode = false;
		if (this.tabCount <= 1) {
			// Single-select, auto-submit
			this.done(this.answers);
			return;
		}
		if (this.currentTab < this.questions.length - 1) {
			// Not the last question: advance to next
			this.currentTab++;
			this.selectedIndex = 0;
		} else {
			// Last question: advance to review
			this.currentTab = this.questions.length;
			this.selectedIndex = 0;
		}
	}

	/**
	 * Pad styled content to full line width, wrapped in │ ... │ border.
	 * Truncates if content exceeds the available width, pads with spaces
	 * if shorter — guaranteeing the right border │ always aligns at the
	 * same terminal column.
	 */
	private contentLine(content: string, width: number): string {
		const contentWidth = width - 4; // │ + space (2) + space + │ (2)
		const truncated = truncateToWidth(content, contentWidth);
		const visible = visibleWidth(truncated);
		const padding = " ".repeat(Math.max(0, contentWidth - visible));
		return `│ ${truncated}${padding} │`;
	}

	/** Full-width empty spacer line between sections. */
	private spacerLine(width: number): string {
		return `│${" ".repeat(Math.max(0, width - 2))}│`;
	}

	// ── Rendering ─────────────────────────────────────────────────

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];

		// Top border
		lines.push(t.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`));

		// ── Tab bar ─────────────────────────────────────────────
		if (this.tabCount > 1) {
			const tabParts: string[] = [];
			for (const [i, q] of this.questions.entries()) {
				const answered = (this.answers[i]?.length ?? 0) > 0;
				const isActive = i === this.currentTab;
				const label =
					q.header.length > MAX_HEADER_LENGTH
						? `${q.header.slice(0, MAX_HEADER_LENGTH - 2)}..`
						: q.header;

				if (isActive) {
					tabParts.push(t.fg("accent", `[${label}]`));
				} else if (answered) {
					tabParts.push(t.fg("success", `✓${label}`));
				} else {
					tabParts.push(t.fg("dim", ` ${label} `));
				}
			}
			// Review tab
			const reviewLabel = "Review";
			if (this.currentTab >= this.questions.length) {
				tabParts.push(t.fg("accent", `[${reviewLabel}]`));
			} else {
				const allAnswered = this.answers.every((a) => (a?.length ?? 0) > 0);
				tabParts.push(
					allAnswered
						? t.fg("success", `✓${reviewLabel}`)
						: t.fg("dim", ` ${reviewLabel} `),
				);
			}

			const tabLine = `  ${tabParts.join(" ")}`;
			lines.push(this.contentLine(tabLine, width));
			lines.push(this.spacerLine(width));
		}

		// ── Content ─────────────────────────────────────────────
		if (this.comparisonMode) {
			this.renderComparisonTab(lines, width);
		} else if (this.isReviewTab) {
			this.renderReviewTab(lines, width);
		} else {
			this.renderQuestionTab(lines, width);
		}

		// Bottom border
		lines.push(t.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`));

		return lines;
	}

	/**
	 * Render a single question tab (options list).
	 */
	private renderQuestionTab(lines: string[], width: number): void {
		const t = this.theme;
		const q = this.currentQuestion;
		if (!q) return;

		// ── Margin constants ────────────────────────────────────
		const MARGIN = 2;
		const NESTED_MARGIN = 4;
		const NUM_WIDTH = this.isMultiSelect ? 3 : 2;

		// Prefix for an option line (selected vs unselected)
		const optPrefix = (sel: boolean) => (sel ? "  > " : "    ");

		// Number/checkbox part
		const optNumber = (idx: number, picked: boolean) => {
			return this.isMultiSelect ? `[${picked ? "✓" : " "}]` : `${idx + 1}.`;
		};

		// Description indent: same column as where the label text starts
		const descIndent = " ".repeat(NESTED_MARGIN + NUM_WIDTH + 2);

		// ── Question text (wrapped) ─────────────────────────────
		const questionContent = `${t.fg("text", q.question)}${this.isMultiSelect ? t.fg("dim", " (select all that apply)") : ""}`;
		const innerWidth = Math.max(1, width - 4 - MARGIN);
		const wrappedLines = wrapTextWithAnsi(questionContent, innerWidth);
		for (const line of wrappedLines) {
			lines.push(this.contentLine(" ".repeat(MARGIN) + line, width));
		}

		// ── Question context ────────────────────────────────────
		this.pushWrappedText(
			lines,
			width,
			MARGIN,
			`Context: ${q.context}`,
			"muted",
		);
		lines.push(this.spacerLine(width));

		// ── Options ─────────────────────────────────────────────
		for (const [i, opt] of q.options.entries()) {
			const isSel = i === this.selectedIndex;
			const isPicked =
				this.answers[this.currentTab]?.includes(opt.label) ?? false;
			const isRecommended = q.recommended === opt.label;

			const number = optNumber(i, isPicked);
			const prefix = optPrefix(isSel);
			const star = isRecommended ? ` ${t.fg("success", "★")}` : "";
			// prefix + number + 2 spaces + label
			const labelContent = `${prefix}${number}  ${opt.label}${star}`;

			const styled = isSel
				? t.fg("accent", labelContent)
				: isPicked
					? t.fg("success", labelContent)
					: t.fg("text", labelContent);

			lines.push(this.contentLine(styled, width));

			// Description (indented to align with the label text)
			if (opt.description && !(isSel && this.detailsExpanded)) {
				const descContent = isSel
					? `${descIndent}${t.fg("accent", opt.description)}`
					: `${descIndent}${t.fg("muted", opt.description)}`;
				lines.push(this.contentLine(descContent, width));
			}

			// Detail pane: pros/cons/bestFor for the highlighted option.
			if (isSel && this.detailsExpanded) {
				this.renderOptionDetail(lines, width, opt, descIndent.length);
			}
		}

		// ── Custom "Type your own answer" option ────────────────
		if (q.custom !== false) {
			const customIdx = q.options.length;
			const isSel = this.selectedIndex === customIdx;
			const hasCustomText = !!this.customTexts[this.currentTab];
			const customText = this.customTexts[this.currentTab];

			const number = optNumber(customIdx, hasCustomText);
			const prefix = optPrefix(isSel);

			const customLabel = hasCustomText
				? `${prefix}${number}  ${customText}`
				: `${prefix}${number}  Type your own answer`;

			const styledLabel = isSel
				? t.fg("accent", customLabel)
				: hasCustomText
					? t.fg("success", customLabel)
					: t.fg("text", customLabel);

			lines.push(this.contentLine(styledLabel, width));

			// Custom text input area (when user is actively typing)
			if (this.editing && isSel) {
				const inputDisplay =
					this.inputBuffer || t.fg("dim", "Type your answer...");
				const inputPrefix = " ".repeat(NESTED_MARGIN);
				const inputContent = `${inputPrefix}${t.fg("accent", `> ${inputDisplay}${t.fg("accent", "▌")}`)}`;
				lines.push(this.contentLine(inputContent, width));
			} else if (hasCustomText && !isSel) {
				const inputPrefix = " ".repeat(NESTED_MARGIN);
				lines.push(
					this.contentLine(`${inputPrefix}${t.fg("muted", customText)}`, width),
				);
			}
		}

		// Spacer before help bar
		lines.push(this.spacerLine(width));

		// ── Help bar (inside border) ────────────────────────────
		const detailsHint = this.detailsExpanded ? "hide" : "details";
		let help = "";
		if (this.isMultiSelect) {
			help = `${t.fg("dim", "↑↓")} navigate  ${t.fg("dim", "enter")} toggle  ${t.fg("dim", "d")} ${detailsHint}  ${t.fg("dim", "c")} compare  ${t.fg("dim", "esc")} done`;
		} else if (this.tabCount > 1) {
			help = `${t.fg("dim", "⇆ tab")}  ${t.fg("dim", "↑↓")} select  ${t.fg("dim", "1-")}${Math.min(this.totalOptions, 9)}${t.fg("dim", "")} pick  ${t.fg("dim", "d")} ${detailsHint}  ${t.fg("dim", "c")} compare  ${t.fg("dim", "enter")} confirm`;
		} else {
			help = `${t.fg("dim", "↑↓")} select  ${t.fg("dim", "1-")}${Math.min(this.totalOptions, 9)}${t.fg("dim", "")} pick  ${t.fg("dim", "d")} ${detailsHint}  ${t.fg("dim", "c")} compare  ${t.fg("dim", "enter")} confirm  ${t.fg("dim", "esc")} dismiss`;
		}
		lines.push(this.contentLine(" ".repeat(MARGIN) + help, width));
	}

	/** Render one option's full context in the detail/comparison views. */
	private renderOptionDetail(
		lines: string[],
		width: number,
		opt: QuestionOption,
		indent: number,
	): void {
		this.pushWrappedText(lines, width, indent, opt.description, "text");
		for (const pro of opt.pros) {
			this.pushBullet(lines, width, indent, "+", pro, "success");
		}
		for (const con of opt.cons) {
			this.pushBullet(lines, width, indent, "−", con, "warning");
		}
		if (opt.bestFor) {
			this.pushWrappedText(
				lines,
				width,
				indent,
				`Best for: ${opt.bestFor}`,
				"muted",
			);
		}
	}

	/** Full comparison view: context, rationale, every option, recommendation. */
	private renderComparisonTab(lines: string[], width: number): void {
		const t = this.theme;
		const q = this.currentQuestion;
		if (!q) return;
		const MARGIN = 2;

		lines.push(
			this.contentLine(
				" ".repeat(MARGIN) + t.fg("text", "Comparison"),
				width,
			),
		);
		this.pushWrappedText(lines, width, MARGIN, `Context: ${q.context}`, "muted");
		this.pushWrappedText(
			lines,
			width,
			MARGIN,
			`Why these options: ${q.rationale}`,
			"muted",
		);
		lines.push(this.spacerLine(width));

		for (const [i, opt] of q.options.entries()) {
			const isRecommended = q.recommended === opt.label;
			const heading = `${i + 1}. ${opt.label}${isRecommended ? " ★ recommended" : ""}`;
			lines.push(
				this.contentLine(
					" ".repeat(MARGIN) +
						t.fg(isRecommended ? "success" : "accent", heading),
					width,
				),
			);
			this.renderOptionDetail(lines, width, opt, MARGIN + 2);
			lines.push(this.spacerLine(width));
		}

		if (q.recommended && q.recommended !== "none" && q.recommendationReason) {
			this.pushWrappedText(
				lines,
				width,
				MARGIN,
				`Recommended: ${q.recommended} — ${q.recommendationReason}`,
				"success",
			);
		}

		lines.push(this.spacerLine(width));
		lines.push(
			this.contentLine(
				" ".repeat(MARGIN) +
					`${t.fg("dim", "c")} back  ${t.fg("dim", "esc")} back`,
				width,
			),
		);
	}

	/** Wrap plain text to the inner width and render it at a fixed indent. */
	private pushWrappedText(
		lines: string[],
		width: number,
		indent: number,
		text: string,
		color: ThemeColor,
	): void {
		const prefix = " ".repeat(indent);
		const available = Math.max(1, width - 4 - indent);
		const wrapped = wrapTextWithAnsi(text, available);
		for (const line of wrapped) {
			lines.push(this.contentLine(prefix + this.theme.fg(color, line), width));
		}
	}

	/** Render a wrapped `+`/`−` bullet with a hanging indent. */
	private pushBullet(
		lines: string[],
		width: number,
		indent: number,
		marker: string,
		text: string,
		color: ThemeColor,
	): void {
		const indentText = " ".repeat(indent);
		const prefix = `${indentText}${this.theme.fg(color, marker)} `;
		const available = Math.max(1, width - 4 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [i, line] of wrapped.entries()) {
			const content =
				i === 0 ? `${prefix}${line}` : `${indentText}  ${line}`;
			lines.push(this.contentLine(content, width));
		}
	}

	/**
	 * Render the review tab showing all answers.
	 */
	private renderReviewTab(lines: string[], width: number): void {
		const t = this.theme;
		const MARGIN = 2;
		const NESTED_MARGIN = 4;

		lines.push(
			this.contentLine(
				" ".repeat(MARGIN) + t.fg("text", "Review your answers:"),
				width,
			),
		);
		lines.push(this.spacerLine(width));

		for (const [i, q] of this.questions.entries()) {
			const answer = this.answers[i] ?? [];
			const answered = answer.length > 0;
			const icon = answered ? "✓" : "✗";
			const iconColor = answered ? "success" : "warning";
			const answerText = answered ? answer.join(", ") : "(not answered)";
			const answerColor = answered ? "text" : "warning";

			const reviewLine =
				" ".repeat(NESTED_MARGIN) +
				t.fg(iconColor, icon) +
				" " +
				t.fg("muted", `${q.header}:`) +
				" " +
				t.fg(answerColor, answerText);
			lines.push(this.contentLine(reviewLine, width));
		}

		lines.push(this.spacerLine(width));

		// Help
		const help = `${t.fg("dim", "↑↓")} scroll  ${t.fg("dim", "enter")} submit  ${t.fg("dim", "esc")} cancel`;
		lines.push(this.contentLine(" ".repeat(MARGIN) + help, width));
	}
}

// ── Dialog flow (RPC / IDE) ────────────────────────────────────────

/** Result returned when the user dismisses the questions. */
function dismissedResult(): AgentToolResult<{ dismissed: true }> {
	return {
		content: [
			{
				type: "text",
				text: "Questions were dismissed by the user. Proceed with your best judgment based on what you know, or make reasonable assumptions.",
			},
		],
		details: { dismissed: true },
	};
}

/**
 * Deliver answers to the LLM in the same turn via steer, then return the tool
 * result. Shared by the TUI overlay and the dialog-based RPC flow.
 */
function deliverAnswers(
	pi: ExtensionAPI,
	questions: PlanQuestion[],
	answers: string[][],
): AgentToolResult<{ answers: string[][] }> {
	const lines = questions.map((q, i) => {
		const answerText = (answers[i] ?? []).join(", ") || "*(no preference)*";
		return `> ${q.question}\n→ **${answerText}**`;
	});
	const md = `## Q&A Complete\n\n${lines.join("\n\n")}`;

	// THE FIX (vs openplan plan_question): deliver via steer so the answers
	// enter the LLM context before the next assistant response in the same turn.
	// triggerTurn: false deferred them to turn_end, which the in-flight agent
	// loop (running on a copied messages array) never saw.
	pi.sendMessage(
		{
			customType: "interview-answers",
			content: md,
			display: true,
		},
		{ triggerTurn: true },
	);

	return {
		content: [{ type: "text", text: "Answers recorded." }],
		details: { answers },
	};
}

/**
 * Format the full question context and option comparison for dialog mode.
 * The RPC select protocol only accepts strings, so the full comparison is shown
 * in a separate multi-line editor instead of being crammed into the option list.
 */
function formatComparison(q: PlanQuestion): string {
	const lines: string[] = [
		`Context: ${q.context}`,
		`Why these options: ${q.rationale}`,
	];

	for (const [i, opt] of q.options.entries()) {
		const recommended = q.recommended === opt.label ? " ★ recommended" : "";
		lines.push("");
		lines.push(`${i + 1}. ${opt.label}${recommended}`);
		lines.push(`   ${opt.description}`);
		for (const pro of opt.pros) lines.push(`   + ${pro}`);
		for (const con of opt.cons) lines.push(`   − ${con}`);
		if (opt.bestFor) lines.push(`   Best for: ${opt.bestFor}`);
	}

	if (q.recommended && q.recommended !== "none" && q.recommendationReason) {
		lines.push("");
		lines.push(`Recommended: ${q.recommended} — ${q.recommendationReason}`);
	}

	return lines.join("\n");
}

/** Show the full context/comparison in a multi-line editor. */
async function showDetails(ui: ExtensionUIContext, q: PlanQuestion): Promise<void> {
	await ui.editor(`Details: ${q.header} — Esc to close`, formatComparison(q));
}

/** Short option line for the dialog select list. */
function formatOptionSummary(q: PlanQuestion, opt: QuestionOption, index: number): string {
	const recommended = q.recommended === opt.label ? " ★" : "";
	return `${index + 1}. ${opt.label}${recommended} — ${opt.description}`;
}

/**
 * Ask all questions through the extension UI dialog protocol
 * (`ui.select` / `ui.input`), which works in RPC/IDE mode where `ui.custom()`
 * is unavailable. Returns null when the user dismisses a question, mirroring
 * the TUI's Escape behavior.
 *
 * Every select dialog ends with explicit details and cancel items: some client
 * renderers never send the `cancelled: true` response, so a visible way out must
 * exist in the option list itself.
 */
async function askQuestionsViaDialogs(
	ui: ExtensionUIContext,
	questions: PlanQuestion[],
	signal: AbortSignal | undefined,
): Promise<string[][] | null> {
	const answers: string[][] = [];

	for (const q of questions) {
		const allowCustom = q.custom !== false;
		const title = q.multiSelect
			? `${q.question} (select all that apply)`
			: q.question;

		if (q.multiSelect) {
			const picked = new Set<string>();
			let customText = "";
			for (;;) {
				const options = q.options.map(
					(o, i) =>
						`${picked.has(o.label) ? "☑" : "☐"} ${formatOptionSummary(q, o, i)}`,
				);
				options.push(DONE_CHOICE);
				if (allowCustom) options.push(CUSTOM_CHOICE);
				options.push(DETAILS_CHOICE);
				options.push(CANCEL_CHOICE);

				const choice = await ui.select(title, options, { signal });
				if (choice === undefined || choice === CANCEL_CHOICE) return null;
				if (choice === DONE_CHOICE) break;
				if (choice === DETAILS_CHOICE) {
					await showDetails(ui, q);
					continue;
				}
				if (allowCustom && choice === CUSTOM_CHOICE) {
					const text = await ui.input(title, "Type your answer", { signal });
					if (text === undefined) continue; // back to the options
					customText = text.trim();
					continue;
				}

				const opt = q.options[options.indexOf(choice)];
				if (!opt) continue;
				if (picked.has(opt.label)) {
					picked.delete(opt.label);
				} else {
					picked.add(opt.label);
				}
			}
			answers.push([...picked, ...(customText ? [customText] : [])]);
			continue;
		}

		// Single-select: pick an option or type a custom answer.
		for (;;) {
			const options = q.options.map((o, i) => formatOptionSummary(q, o, i));
			if (allowCustom) options.push(CUSTOM_CHOICE);
			options.push(DETAILS_CHOICE);
			options.push(CANCEL_CHOICE);

			const choice = await ui.select(title, options, { signal });
			if (choice === undefined || choice === CANCEL_CHOICE) return null;
			if (choice === DETAILS_CHOICE) {
				await showDetails(ui, q);
				continue;
			}
			if (allowCustom && choice === CUSTOM_CHOICE) {
				const text = await ui.input(title, "Type your answer", { signal });
				if (text === undefined) continue; // back to the options
				answers.push(text.trim() ? [text.trim()] : []);
				break;
			}

			const opt = q.options[options.indexOf(choice)];
			if (!opt) continue;
			answers.push([opt.label]);
			break;
		}
	}

	return answers;
}

// ── Tool Registration ──────────────────────────────────────────────────

export default function interviewExtension(pi: ExtensionAPI): void {
	// Render the answer summary as a markdown block in the transcript
	pi.registerMessageRenderer("interview-answers", (message) => {
		const rawContent =
			typeof message.content === "string" ? message.content : "";
		return new Markdown(rawContent, 1, 0, getMarkdownTheme());
	});

	pi.registerTool({
		name: "interview",
		label: "Ask Questions",
		description:
			"Ask structured clarifying questions with mandatory context. Each question needs context and rationale; each option needs a description, pros, cons, and optional bestFor. Supports single-select, multi-select, and custom text. Batch up to 4 questions per call.",
		promptSnippet: "Ask structured clarifying questions",
		promptGuidelines: [
			"Use interview instead of asking inline. Batch up to 4 questions, 2-4 options each, headers ≤16 chars.",
			"Every question must include context (why it matters, constraints, what is at stake) and rationale (why these options, what was ruled out).",
			"Every option must include a concrete description, at least one pro and one con, and bestFor when it helps. No generic filler like 'good' or 'bad'.",
			"When you have a preference, set recommended to an option label (or 'none') and explain it in recommendationReason.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({
						description: "Question text",
					}),
					header: Type.String({
						description: "Tab label, ≤16 chars",
					}),
					context: Type.String({
						minLength: MIN_CONTEXT_LENGTH,
						maxLength: MAX_CONTEXT_LENGTH,
						description:
							"Why this question is asked, constraints, and what is at stake",
					}),
					rationale: Type.String({
						minLength: MIN_CONTEXT_LENGTH,
						maxLength: MAX_CONTEXT_LENGTH,
						description:
							"Why these options were chosen and what was ruled out",
					}),
					options: Type.Array(
						Type.Object({
							label: Type.String({
								description: "Option label",
							}),
							description: Type.String({
								minLength: MIN_DESCRIPTION_LENGTH,
								maxLength: MAX_DESCRIPTION_LENGTH,
								description:
									"What the option is, in one concrete sentence",
							}),
							pros: Type.Array(
								Type.String({
									minLength: MIN_PRO_CON_LENGTH,
									maxLength: MAX_PRO_CON_LENGTH,
								}),
								{
									minItems: 1,
									maxItems: MAX_PRO_CON_ITEMS,
									description: "Concrete advantages (1-3)",
								},
							),
							cons: Type.Array(
								Type.String({
									minLength: MIN_PRO_CON_LENGTH,
									maxLength: MAX_PRO_CON_LENGTH,
								}),
								{
									minItems: 1,
									maxItems: MAX_PRO_CON_ITEMS,
									description: "Concrete disadvantages (1-3)",
								},
							),
							bestFor: Type.Optional(
								Type.String({
									maxLength: MAX_DESCRIPTION_LENGTH,
									description: "When this option is the right choice",
								}),
							),
						}),
						{
							minItems: MIN_OPTIONS,
							maxItems: MAX_OPTIONS,
							description: "2-4 options",
						},
					),
					recommended: Type.Optional(
						Type.String({
							description: 'Label of the recommended option, or "none"',
						}),
					),
					recommendationReason: Type.Optional(
						Type.String({
							maxLength: MAX_CONTEXT_LENGTH,
							description: "Why the recommended option is preferred",
						}),
					),
					multiSelect: Type.Optional(
						Type.Boolean({
							description: "Allow multiple selections (default: false)",
						}),
					),
					custom: Type.Optional(
						Type.Boolean({
							description: "Allow free-text answer (default: true)",
						}),
					),
				}),
				{
					minItems: 1,
					maxItems: MAX_QUESTIONS,
					description: "1-4 questions",
				},
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as unknown as PlanQuestionInput;

			// Validate input — throw to signal errors (per pi docs: returning isError:true has no effect)
			validateQuestions(input.questions);

			// TUI: present the custom overlay. `custom()` is TUI-only — in RPC
			// mode it returns undefined — so guard by mode, not by hasUI.
			if (ctx.mode === "tui") {
				const result = await ctx.ui.custom<string[][] | null>(
					(tui, theme, _kb, done) => {
						const prompt = new InterviewPrompt(input.questions, theme, done);
						return {
							render: (w: number) => prompt.render(w),
							invalidate() {
								// Rendering is stateless — nothing to invalidate.
							},
							handleInput(data: string) {
								prompt.handleInput(data);
								tui.requestRender();
							},
						};
					},
				);

				// null = user dismissed; undefined = custom UI unavailable (defensive)
				if (result == null) return dismissedResult();
				return deliverAnswers(pi, input.questions, result);
			}

			// RPC / IDE: custom components are unavailable, but the client does
			// implement the extension UI dialog protocol, so ask with dialogs.
			if (ctx.hasUI) {
				const result = await askQuestionsViaDialogs(
					ctx.ui,
					input.questions,
					signal,
				);
				if (result === null) return dismissedResult();
				return deliverAnswers(pi, input.questions, result);
			}

			// Non-interactive mode (print / JSON): return questions as text
			const questionText = input.questions
				.map((q, i) => {
					const options = q.options
						.map((o, j) => {
							const recommended =
								q.recommended === o.label ? " ★ recommended" : "";
							const pros = o.pros.map((pro) => `      + ${pro}`).join("\n");
							const cons = o.cons.map((con) => `      − ${con}`).join("\n");
							const bestFor = o.bestFor ? `\n      Best for: ${o.bestFor}` : "";
							return `  ${j + 1}. ${o.label}${recommended} — ${o.description}\n${pros}\n${cons}${bestFor}`;
						})
						.join("\n");
					const recommendation =
						q.recommended &&
						q.recommended !== "none" &&
						q.recommendationReason
							? `\nRecommended: ${q.recommended} — ${q.recommendationReason}`
							: "";
					return `Question ${i + 1}: ${q.question}\nContext: ${q.context}\nWhy these options: ${q.rationale}\nOptions:\n${options}${recommendation}${q.custom !== false ? "\n  or type your own answer" : ""}`;
				})
				.join("\n\n");

			const nonInteractiveResponse = `This terminal does not support interactive questions. Make reasonable assumptions based on the context:\n\n${questionText}`;
			return {
				content: [
					{
						type: "text",
						text: nonInteractiveResponse,
					},
				],
				details: { nonInteractive: true },
			};
		},
	});
}
