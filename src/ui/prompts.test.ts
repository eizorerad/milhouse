import { describe, expect, it, spyOn } from "bun:test";
import { onCancel } from "./prompts";

describe("onCancel", () => {
	it("should call process.exit with code 130 (SIGINT convention)", () => {
		const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
		const logSpy = spyOn(console, "log").mockImplementation(() => {});

		onCancel();

		expect(exitSpy).toHaveBeenCalledWith(130);

		exitSpy.mockRestore();
		logSpy.mockRestore();
	});
});
