import notifier from "node-notifier";

/**
 * Send a desktop notification
 */
export function notify(title: string, message: string): void {
	notifier.notify({
		title,
		message,
		sound: true,
	});
}

/**
 * Notify task completion
 */
export function notifyTaskComplete(task: string): void {
	notify("Milhouse", `Task completed: ${task}`);
}

/**
 * Notify all tasks complete
 */
export function notifyAllComplete(count: number): void {
	notify("Milhouse", `All ${count} tasks completed!`);
}

/**
 * Notify task failure
 */
export function notifyTaskFailed(task: string, error: string): void {
	notify("Milhouse - Error", `Task failed: ${task}\n${error}`);
}
