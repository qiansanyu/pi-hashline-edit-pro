import { describe, expect, it } from "vitest";
import {
	applyEdit,
	isSeamCloser,
	lineHashes,
	resEdit,
	trimSeamDuplicates,
	type HEdit,
	type RHEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

async function runEdit(
	content: string,
	fromLine: number,
	toLine: number,
	text: string[],
	seamTrim = true,
) {
	const hashes = await lineHashes(content, home.testPath);
	const edit = resEdit({
		remove_from: hashes[fromLine - 1]!,
		remove_to: hashes[toLine - 1]!,
		text,
	});
	return applyEdit(content, edit, undefined, hashes, home.testPath, undefined, undefined, seamTrim);
}

describe("isSeamCloser", () => {
	it("recognizes closing lines and comment delimiters", () => {
		for (const line of ["}", "    }", "};", "});", ")", "  ]", " */", "  /**", '"""', "'''", "<!--", "-->"]) {
			expect(isSeamCloser(line), line).toBe(true);
		}
	});

	it("leaves ordinary content alone", () => {
		for (const line of ["", "end", "value", "  return x;", " * doc", "// note"]) {
			expect(isSeamCloser(line), line).toBe(false);
		}
	});
});

describe("trimSeamDuplicates", () => {
	it("drops a repeated closer below the range and keeps the surviving row's anchor", async () => {
		const content = [
			"            if (allowSupplement) {",
			"                Optional<Plan> matrixPlan = plan(t2);",
			"                return switchTo(matrixPlan);",
			"            }",
			"            nextStep();",
			"",
		].join("\n");
		const result = await runEdit(content, 1, 3, [
			"            if (allowSupplement) {",
			"                Optional<Plan> matrixPlan = plan(t2, view);",
			"                return switchTo(matrixPlan);",
			"            }",
		]);
		expect(result.content).toBe([
			"            if (allowSupplement) {",
			"                Optional<Plan> matrixPlan = plan(t2, view);",
			"                return switchTo(matrixPlan);",
			"            }",
			"            nextStep();",
			"",
		].join("\n"));
		expect(result.warnings?.join("\n")).toContain("[W_SEAM_TRIMMED]");
		expect(result.warnings?.join("\n")).toContain("below the range");
		expect(result.edit.content_lines).toHaveLength(3);
	});

	it("drops a repeated opener above the range", async () => {
		const content = ["  /**", "   * doc", "   */", "  void run() {", "  }", ""].join("\n");
		const result = await runEdit(content, 2, 3, ["  /**", "   * doc two", "   */"]);
		expect(result.content).toBe(["  /**", "   * doc two", "   */", "  void run() {", "  }", ""].join("\n"));
		expect(result.warnings?.join("\n")).toContain("above the range");
	});

	it("drops a repeated closer from a single-line range", async () => {
		const content = ["interface A {", "  undoRetentionDays?: number;", "}", ""].join("\n");
		const result = await runEdit(content, 2, 2, ["  undoRetentionDays?: number;", "  autoReadWrite?: WriteEchoMode;", "}"]);
		expect(result.content).toBe(
			["interface A {", "  undoRetentionDays?: number;", "  autoReadWrite?: WriteEchoMode;", "}", ""].join("\n"),
		);
		expect(result.warnings?.join("\n")).toContain("[W_SEAM_TRIMMED]");
	});

	it("drops repeated rows on both seams at once", async () => {
		const content = ["}", "x", "}", ""].join("\n");
		const result = await runEdit(content, 2, 2, ["}", "X", "}"]);
		expect(result.content).toBe(["}", "X", "}", ""].join("\n"));
		expect(result.warnings?.join("\n")).toContain("above the range");
		expect(result.warnings?.join("\n")).toContain("below the range");
	});

	it("drops a run of two repeated content rows", async () => {
		const content = ["a", "x", "p", "q", "z", ""].join("\n");
		const result = await runEdit(content, 2, 2, ["X", "p", "q"]);
		expect(result.content).toBe(["a", "X", "p", "q", "z", ""].join("\n"));
		expect(result.warnings?.join("\n")).toContain("2 repeated rows");
	});

	it("leaves a single repeated content row alone", async () => {
		const content = ["a", "x", "foo", "q", ""].join("\n");
		const result = await runEdit(content, 2, 2, ["foo"]);
		expect(result.content).toBe(["a", "foo", "foo", "q", ""].join("\n"));
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves ranges at the file edges alone", async () => {
		const head = await runEdit(["}", "x", "y", ""].join("\n"), 1, 1, ["X", "}"]);
		expect(head.warnings ?? []).toEqual([]);
		const tail = await runEdit(["a", "}", ""].join("\n"), 2, 2, ["X", "}"]);
		expect(tail.warnings ?? []).toEqual([]);
	});

	it("leaves repeated blank rows alone", async () => {
		const content = ["a", "x", "", "q", ""].join("\n");
		const result = await runEdit(content, 2, 2, ["X", ""]);
		expect(result.content).toBe(["a", "X", "", "", "q", ""].join("\n"));
		expect(result.warnings ?? []).toEqual([]);
	});

	it("keeps at least one row", async () => {
		const content = ["a", "p", "q", "b", ""].join("\n");
		const result = await runEdit(content, 2, 2, ["p", "q"]);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("does not trim unless asked", async () => {
		const content = ["a", "x", "}", "}", ""].join("\n");
		const result = await runEdit(content, 2, 2, ["X", "}"], false);
		expect(result.content).toBe(["a", "X", "}", "}", "}", ""].join("\n"));
	});

	it("trims line endings in step with the dropped rows", () => {
		const resolved: RHEdit = {
			content_lines: ["X", "}"],
			hash_bounds: [
				{ line: 1, hash: "aaaaa" },
				{ line: 1, hash: "aaaaa" },
			],
			content_separators: ["\n", "\r\n"],
		};
		const trimmed = trimSeamDuplicates(resolved, ["a", "}", "b"], ["aaaaa", "bbbbb", "ccccc"]);
		expect(trimmed.resolved.content_lines).toEqual(["X"]);
		expect(trimmed.resolved.content_separators).toEqual(["\n"]);
	});
});

describe("seam trim equals widening the range", () => {
	it("produces the same file as a correct range with the full text", async () => {
		const content = [
			"class A {",
			"  /**",
			"   * doc",
			"   */",
			"  void run() {",
			"",
		].join("\n");
		const text = ["  /**", "   * doc two", "   */"];

		const trimmed = await runEdit(content, 2, 3, text, true);
		const widened = await runEdit(content, 2, 4, text, false);

		expect(trimmed.content).toBe(widened.content);
		expect(trimmed.warnings?.join("\n")).toContain("[W_SEAM_TRIMMED]");
		expect(widened.warnings ?? []).toEqual([]);
	});

	it("matches a hand-widened edit in a java-shaped block", async () => {
		const content = ["    if (x) {", "        a();", "    }", "    b();", ""].join("\n");
		const text = ["    if (x) {", "        a2();", "    }"];
		const trimmed = await runEdit(content, 1, 2, text, true);
		const widened = await runEdit(content, 1, 3, text, false);
		expect(trimmed.content).toBe(widened.content);
	});
});

describe("seam trim and the applied edit", () => {
	it("reports the trimmed edit so callers keep separators and metrics in step", async () => {
		const content = ["}", "x", "}", ""].join("\n");
		const hashes = await lineHashes(content, home.testPath);
		const edit: HEdit = {
			content_lines: ["x2", "}"],
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
			content_separators: ["\n", "\r\n"],
		};
		const result = applyEdit(content, edit, undefined, hashes, home.testPath, undefined, undefined, true);
		expect(result.edit.content_lines).toEqual(["x2"]);
		expect(result.edit.content_separators).toEqual(["\n"]);
		expect(result.content).toBe(["}", "x2", "}", ""].join("\n"));
	});
});
