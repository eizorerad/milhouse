import type { ExecutionRequest, ExecutionResult } from "../../schemas/engine.schema";
import type { MiddlewareFn } from "../core/types";

/**
 * Compose multiple middleware functions into a single middleware.
 * Follows the Koa-style middleware pattern where each middleware
 * can perform actions before and after calling next().
 *
 * @param middlewares - Array of middleware functions to compose
 * @returns A single composed middleware function
 */
export function composeMiddleware(middlewares: MiddlewareFn[]): MiddlewareFn {
	// Validate all middlewares are functions
	for (const fn of middlewares) {
		if (typeof fn !== "function") {
			throw new TypeError("Middleware must be a function");
		}
	}

	return async (
		request: ExecutionRequest,
		finalHandler: () => Promise<ExecutionResult>,
	): Promise<ExecutionResult> => {
		let index = -1;

		const dispatch = async (i: number): Promise<ExecutionResult> => {
			// Prevent calling next() multiple times
			if (i <= index) {
				throw new Error("next() called multiple times in middleware");
			}
			index = i;

			// Get current middleware or fall through to final handler
			const middleware = middlewares[i];
			if (!middleware) {
				return finalHandler();
			}

			// Execute middleware with next function pointing to next middleware
			return middleware(request, () => dispatch(i + 1));
		};

		return dispatch(0);
	};
}

/**
 * MiddlewareChain provides a fluent builder pattern for constructing
 * middleware pipelines. Middleware is executed in the order added.
 *
 * @example
 * ```typescript
 * const chain = new MiddlewareChain()
 *   .use(loggingMiddleware)
 *   .use(timeoutMiddleware)
 *   .use(retryMiddleware);
 *
 * const composed = chain.compose();
 * ```
 */
export class MiddlewareChain {
	private readonly middlewares: MiddlewareFn[] = [];

	/**
	 * Add a middleware function to the chain.
	 * @param middleware - The middleware function to add
	 * @returns This chain instance for fluent chaining
	 */
	use(middleware: MiddlewareFn): this {
		if (typeof middleware !== "function") {
			throw new TypeError("Middleware must be a function");
		}
		this.middlewares.push(middleware);
		return this;
	}

	/**
	 * Add multiple middleware functions at once.
	 * @param middlewares - Array of middleware functions to add
	 * @returns This chain instance for fluent chaining
	 */
	useAll(middlewares: MiddlewareFn[]): this {
		for (const middleware of middlewares) {
			this.use(middleware);
		}
		return this;
	}

	/**
	 * Compose all middleware into a single function.
	 * @returns A composed middleware function
	 */
	compose(): MiddlewareFn {
		return composeMiddleware([...this.middlewares]);
	}

	/**
	 * Get the number of middleware in the chain.
	 */
	get length(): number {
		return this.middlewares.length;
	}

	/**
	 * Get a copy of the middleware array.
	 * @returns Copy of the middleware functions
	 */
	toArray(): MiddlewareFn[] {
		return [...this.middlewares];
	}

	/**
	 * Clear all middleware from the chain.
	 * @returns This chain instance for fluent chaining
	 */
	clear(): this {
		this.middlewares.length = 0;
		return this;
	}

	/**
	 * Insert middleware at a specific position.
	 * @param index - Position to insert at
	 * @param middleware - The middleware function to insert
	 * @returns This chain instance for fluent chaining
	 */
	insertAt(index: number, middleware: MiddlewareFn): this {
		if (typeof middleware !== "function") {
			throw new TypeError("Middleware must be a function");
		}
		this.middlewares.splice(index, 0, middleware);
		return this;
	}

	/**
	 * Remove middleware at a specific position.
	 * @param index - Position to remove from
	 * @returns The removed middleware function or undefined
	 */
	removeAt(index: number): MiddlewareFn | undefined {
		const [removed] = this.middlewares.splice(index, 1);
		return removed;
	}
}

/**
 * Create a no-op middleware that simply passes through to next.
 * Useful for conditional middleware or testing.
 */
export function createPassthroughMiddleware(): MiddlewareFn {
	return async (_request, next) => next();
}

/**
 * Create a conditional middleware that only executes if predicate returns true.
 * @param predicate - Function to determine if middleware should run
 * @param middleware - The middleware to conditionally execute
 * @returns A middleware that conditionally executes
 */
export function createConditionalMiddleware(
	predicate: (request: ExecutionRequest) => boolean,
	middleware: MiddlewareFn,
): MiddlewareFn {
	return async (request, next) => {
		if (predicate(request)) {
			return middleware(request, next);
		}
		return next();
	};
}
