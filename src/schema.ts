/** The shape of an agent's answer: JSON Schema where every property is required and nothing else is allowed. */

export const object = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
	required: Object.keys(properties),
	additionalProperties: false,
});

export const arrayOf = (items: unknown) => ({ type: "array", items });
