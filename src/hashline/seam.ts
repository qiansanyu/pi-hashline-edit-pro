import { clipLine, isBlankLine } from "../utils";
import { HASH_SEP } from "./hash";
import type { LineEnding } from "../normalize";
import type { RHEdit } from "./resolve";

const SEAM_MAX_ROWS = 3;

const COMMENT_DELIMITER_RE = /^\s*(?:\/\*+|\*+\/|'''|"""|<!--|-->)\s*$/;
const CLOSING_PUNCTUATION_RE = /^\s*[}\])]+[;,]?\s*$/;

export function isSeamCloser(line: string): boolean {
	return COMMENT_DELIMITER_RE.test(line) || CLOSING_PUNCTUATION_RE.test(line);
}

export interface SeamTrimResult {
	resolved: RHEdit;
	notice?: string;
}

function repeatedSuffixRows(
	lines: readonly string[],
	fileLines: readonly string[],
	end: number,
	budget: number,
): number {
	let run = 0;
	for (let length = 1; length <= budget; length += 1) {
		if (end + length > fileLines.length) break;
		let matches = true;
		for (let offset = 0; offset < length; offset += 1) {
			const payloadRow = lines[lines.length - length + offset]!;
			const fileRow = fileLines[end + offset]!;
			if (isBlankLine(payloadRow) || payloadRow !== fileRow) {
				matches = false;
				break;
			}
		}
		if (matches) run = length;
	}
	return run;
}

function repeatedPrefixRows(
	lines: readonly string[],
	fileLines: readonly string[],
	start: number,
	budget: number,
): number {
	let run = 0;
	for (let length = 1; length <= budget; length += 1) {
		if (start - 1 - length < 0) break;
		let matches = true;
		for (let offset = 0; offset < length; offset += 1) {
			const payloadRow = lines[offset]!;
			const fileRow = fileLines[start - length + offset - 1]!;
			if (isBlankLine(payloadRow) || payloadRow !== fileRow) {
				matches = false;
				break;
			}
		}
		if (matches) run = length;
	}
	return run;
}

function sliceSeparators(
	separators: (LineEnding | undefined)[],
	head: number,
	tail: number,
): (LineEnding | undefined)[] {
	return separators.slice(head, Math.max(head, separators.length - tail));
}

function seamSide(
	side: "above" | "below",
	duplicated: readonly string[],
	anchor: string,
): string {
	const rows = `${duplicated.length} repeated row${duplicated.length === 1 ? "" : "s"}`;
	const sample = JSON.stringify(clipLine(duplicated[0]!, 40));
	return `${rows} ${side} the range (${anchor}${HASH_SEP} ${sample})`;
}

function seamNotice(
	head: readonly string[],
	tail: readonly string[],
	headAnchor: string,
	tailAnchor: string,
): string {
	const parts: string[] = [];
	if (head.length > 0) parts.push(seamSide("above", head, headAnchor));
	if (tail.length > 0) parts.push(seamSide("below", tail, tailAnchor));
	const anchors = [head.length > 0 ? "remove_from" : undefined, tail.length > 0 ? "remove_to" : undefined]
		.filter((name): name is string => name !== undefined)
		.join("/");
	return `[W_SEAM_TRIMMED] Dropped ${parts.join(" and ")} from "text": the file already keeps ${head.length + tail.length === 1 ? "that row" : "those rows"}. A closing line your text writes must sit inside ${anchors} — widen the range if you meant to replace it.`;
}

export function trimSeamDuplicates(
	resolved: RHEdit,
	fileLines: readonly string[],
	fileHashes: readonly string[],
): SeamTrimResult {
	const lines = resolved.content_lines;
	if (lines.length < 2) return { resolved };
	const start = resolved.hash_bounds[0].line;
	const end = resolved.hash_bounds[1].line;
	const budget = Math.min(SEAM_MAX_ROWS, lines.length - 1);

	const head = repeatedPrefixRows(lines, fileLines, start, budget);
	const tail = repeatedSuffixRows(lines, fileLines, end, Math.min(SEAM_MAX_ROWS, lines.length - 1 - head));
	const headRows = lines.slice(0, head);
	const tailRows = tail > 0 ? lines.slice(lines.length - tail) : [];
	const keepHead = head > 0 && (head >= 2 || isSeamCloser(headRows[0]!)) ? head : 0;
	const keepTail = tail > 0 && (tail >= 2 || isSeamCloser(tailRows[0]!)) ? tail : 0;
	if (keepHead === 0 && keepTail === 0) return { resolved };

	return {
		resolved: {
			content_lines: lines.slice(keepHead, lines.length - keepTail),
			hash_bounds: resolved.hash_bounds,
			...(resolved.content_separators === undefined
				? {}
				: { content_separators: sliceSeparators(resolved.content_separators, keepHead, keepTail) }),
		},
		notice: seamNotice(
			headRows.slice(0, keepHead),
			tailRows.slice(tailRows.length - keepTail),
			fileHashes[start - 2]!,
			fileHashes[end]!,
		),
	};
}
