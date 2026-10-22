/**
 * The one registry in API 1: time adapters, keyed on a namespaced id.
 *
 * The house pattern, inherited from Wadjet: registration returns an unregister function;
 * unregistering is IDENTITY-CHECKED, so an old unregister cannot remove an adapter that was
 * re-registered under the same id by someone else; the function runs at most once; and the
 * registry is cleared on unload, so consumers re-register on `geb:ready`. The built-in cannot be
 * replaced or removed: the default adapter is part of the surface's contract, not a plugin's.
 *
 * SNAPSHOTTED AT REGISTRATION. The registry keeps its own frozen record — id and name copied,
 * the functions bound to the consumer's object — and keys on that. A consumer that mutates its
 * object's `id` afterwards, or registers one object twice under two ids by mutating it in
 * between, changes nothing here: the entry it made is the entry its unregister removes.
 */
import { adapterProblem, GREGORIAN_YEAR, type TimeAdapter, type TimeAdapterInfo } from "../time/adapters";
import { codedError } from "./errors";

/** What the registry holds for a registered adapter: the consumer's functions, our record. */
function snapshot(a: TimeAdapter): TimeAdapter {
	const parse = a.parse.bind(a);
	const format = a.format.bind(a);
	const last = a.last === undefined ? undefined : a.last.bind(a);
	return Object.freeze({ id: a.id, name: a.name, parse, format, ...(last === undefined ? {} : { last }) });
}

export class TimeAdapterRegistry {
	private readonly adapters = new Map<string, TimeAdapter>([[GREGORIAN_YEAR.id, GREGORIAN_YEAR]]);

	/** The adapter for a calendar id; `undefined` is the default; an unknown id is null. */
	resolve(calendar: string | undefined): TimeAdapter | null {
		if (calendar === undefined) return GREGORIAN_YEAR;
		return this.adapters.get(calendar) ?? null;
	}

	list(): readonly TimeAdapterInfo[] {
		return [...this.adapters.values()].map((a) => ({ id: a.id, name: a.name }));
	}

	register(adapter: TimeAdapter): () => void {
		const why = adapterProblem(adapter);
		if (why !== null) throw codedError("geb-bad-adapter", why);
		const held = snapshot(adapter);
		if (this.adapters.has(held.id)) throw codedError("geb-duplicate-id", `A time adapter with id "${held.id}" is already registered.`);
		this.adapters.set(held.id, held);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			if (this.adapters.get(held.id) === held) this.adapters.delete(held.id);
		};
	}

	/** Everything but the built-in. */
	clear(): void {
		for (const id of [...this.adapters.keys()]) if (id !== GREGORIAN_YEAR.id) this.adapters.delete(id);
	}
}
