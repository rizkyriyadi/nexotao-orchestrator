import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  assertTransition,
  isTerminalStatus,
  LifecycleTransitionError,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type LifecycleKind,
} from "./state-machine.js";

const cases = [
  ["run", RUN_STATUSES, RUN_TRANSITIONS],
  ["task", TASK_STATUSES, TASK_TRANSITIONS],
  ["attempt", ATTEMPT_STATUSES, ATTEMPT_TRANSITIONS],
] as const;

for (const [kind, statuses, table] of cases) {
  test(`${kind} unit contract accepts every legal edge and rejects every other state pair`, () => {
    const transitions = table as Record<string, readonly string[]>;
    for (const from of statuses) {
      for (const to of statuses) {
        const legal = transitions[from].includes(to);
        if (legal) {
          assert.doesNotThrow(() => assertTransition(kind, "entity-1", from, to, "test_reason"), `${from} -> ${to}`);
          continue;
        }

        assert.throws(
          () => assertTransition(kind, "entity-1", from, to, "test_reason"),
          (error) => {
            assert(error instanceof LifecycleTransitionError);
            assert.equal(error.code, from === to ? "duplicate_transition" : "illegal_transition");
            return true;
          },
          `${from} -> ${to}`
        );
      }
    }
  });

  test(`${kind} unit contract requires a reason for every legal terminal edge`, () => {
    const transitions = table as Record<string, readonly string[]>;
    for (const from of statuses) {
      for (const to of transitions[from]) {
        if (!isTerminalStatus(kind as LifecycleKind, to)) continue;
        assert.throws(
          () => assertTransition(kind, "entity-1", from, to, null),
          (error) => error instanceof LifecycleTransitionError && error.code === "terminal_reason_required",
          `${from} -> ${to}`
        );
      }
    }
  });
}
