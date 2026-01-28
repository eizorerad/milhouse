import mitt from "mitt";
import type { EventName, EventPayload, MilhouseEvents } from "./types";

// Create typed event bus
const emitter = mitt<MilhouseEvents>();

// Export typed helpers
export const bus = {
	emit: <E extends EventName>(event: E, payload: EventPayload<E>) => {
		emitter.emit(event, payload);
	},
	on: <E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void) => {
		emitter.on(event, handler);
		return () => emitter.off(event, handler);
	},
	off: <E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void) => {
		emitter.off(event, handler);
	},
	once: <E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void) => {
		const wrappedHandler = (payload: EventPayload<E>) => {
			handler(payload);
			emitter.off(event, wrappedHandler);
		};
		emitter.on(event, wrappedHandler);
	},
	clear: () => emitter.all.clear(),
};

export { emitter };
