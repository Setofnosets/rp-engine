/**
 * Discriminated union of all runtime lifecycle events emitted by {@link SessionRuntime}.
 */
export type SessionRuntimeEvent =
  | {
      readonly type: 'turn_started';
      readonly turn: number;
      readonly input: string;
    }
  | {
      readonly type: 'intent_parsed';
      readonly turn: number;
      readonly intentKind: string;
      readonly usedLlm: boolean;
    }
  | {
      readonly type: 'action_resolved';
      readonly turn: number;
      readonly changedPaths: readonly string[];
      readonly combatActive: boolean;
    }
  | {
      readonly type: 'clock_advanced';
      readonly turn: number;
      readonly day: number;
      readonly slot: string;
      readonly daysElapsed: number;
      readonly slotsElapsed: number;
      readonly expiredTimers: readonly string[];
    }
  | {
      readonly type: 'agendas_ticked';
      readonly turn: number;
      readonly daysElapsed: number;
      readonly rumors: readonly string[];
    }
  | {
      readonly type: 'beats_evaluated';
      readonly turn: number;
      readonly transitionCount: number;
      readonly triggeredScripts: readonly string[];
    }
  | {
      readonly type: 'route_locked';
      readonly turn: number;
      readonly routeId: string;
      readonly lockFlag: string;
      readonly announce?: string;
    }
  | {
      readonly type: 'ending_triggered';
      readonly turn: number;
      readonly endingId: string;
      readonly mark: string;
    }
  | {
      readonly type: 'prompt_compiled';
      readonly turn: number;
      readonly totalEstimatedTokens: number;
      readonly droppedItemsCount: number;
    }
  | {
      readonly type: 'narrator_chunk';
      readonly turn: number;
      readonly text: string;
      readonly done: boolean;
    }
  | {
      readonly type: 'narrator_completed';
      readonly turn: number;
      readonly messageId: string;
      readonly swipeIndex: number;
      readonly text: string;
    }
  | {
      readonly type: 'tracker_completed';
      readonly turn: number;
      readonly skippedByCadence: boolean;
      readonly appliedOpsCount: number;
    }
  | {
      readonly type: 'confirmations_queued';
      readonly turn: number;
      readonly count: number;
    }
  | {
      readonly type: 'swipe_rolled_back';
      readonly assistantMessageId: string;
      readonly restoredTurn: number;
    }
  | {
      readonly type: 'swipe_switched';
      readonly assistantMessageId: string;
      readonly swipeIndex: number;
      readonly restoredTurn: number;
    }
  | {
      readonly type: 'turn_saved';
      readonly turn: number;
      readonly saveDir: string;
    }
  | {
      readonly type: 'digest_published';
      readonly turn: number;
      readonly editionId: string;
      readonly day: number;
      readonly masthead: string;
      readonly headlineCount: number;
    }
  | {
      readonly type: 'auditor_completed';
      readonly turn: number;
      readonly findingsCount: number;
      readonly autoCorrectedCount: number;
      readonly skippedLlmByCadence: boolean;
    };

export type SessionRuntimeEventType = SessionRuntimeEvent['type'];

export type SessionEventListener = (event: SessionRuntimeEvent) => void;

/**
 * Lightweight synchronous event bus for session turn lifecycle notifications.
 */
export class SessionEventBus {
  private readonly listeners = new Set<SessionEventListener>();

  on(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  off(listener: SessionEventListener): void {
    this.listeners.delete(listener);
  }

  emit(event: SessionRuntimeEvent): void {
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      listener(event);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
