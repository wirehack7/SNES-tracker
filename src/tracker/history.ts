/**
 * Undo/redo of song edits as snapshots (the song as JSON). Edits that come in
 * quick bursts, like dragging a slider or typing a row of notes, are grouped
 * by the caller into one step before `commit` is called.
 */
export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private bytes = 0;

  constructor(
    private current: string,
    /** Most steps kept. */
    readonly maxSteps = 200,
    /** Most characters kept in the undo stack (samples make songs large). */
    readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Start over with a new song (opening a file clears the history). */
  reset(snapshot: string) {
    this.current = snapshot;
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
  }

  /** Record the song after an edit. Returns false when nothing changed. */
  commit(snapshot: string): boolean {
    if (snapshot === this.current) return false;
    this.undoStack.push(this.current);
    this.bytes += this.current.length;
    this.current = snapshot;
    this.redoStack = [];
    while (this.undoStack.length > this.maxSteps || (this.bytes > this.maxBytes && this.undoStack.length > 1))
      this.bytes -= this.undoStack.shift()!.length;
    return true;
  }

  /** The song before the last edit, or null. */
  undo(): string | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.bytes -= prev.length;
    this.redoStack.push(this.current);
    this.current = prev;
    return prev;
  }

  /** The song after the last undone edit, or null. */
  redo(): string | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.current);
    this.bytes += this.current.length;
    this.current = next;
    return next;
  }
}
