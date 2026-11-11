/** Tells open task tabs when the progress of their initiative changed (a tick on the initiative's tab). */
type Fn = (p: { done: number; total: number }) => void;
const subs = new Map<string, Set<Fn>>();

/** Call `fn` whenever progress of initiative `id` is announced; returns the unsubscribe function. */
export function onInitiativeProgress(id: string, fn: Fn): () => void {
  let set = subs.get(id);
  if (!set) subs.set(id, (set = new Set()));
  set.add(fn);
  return () => { set!.delete(fn); };
}
/** Announce the new progress of initiative `id`. */
export function emitInitiativeProgress(id: string, p: { done: number; total: number }): void {
  for (const fn of [...(subs.get(id) ?? [])]) fn(p);
}
