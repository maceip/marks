"use components";
export function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {

  const emptyFunc = () => {};

  let dv = new DataView(new ArrayBuffer());
  const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);

  function _isValidNumericPrimitive(ty, v) {
    if (v === undefined || v === null) { return false; }
    switch (ty) {
      case 'bool':
      return v === 0 || v === 1;
      break;
      case 'u8':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
      break;
      case 's8':
      return typeof v === 'number' && Number.isInteger(v) && v >= -128 && v <= 127;
      break;
      case 'u16':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
      break;
      case 's16':
      return typeof v === 'number' && Number.isInteger(v) && v >= -32768 && v <= 32767;
      case 'u32':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4_294_967_295;
      case 's32':
      return typeof v === 'number' && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
      case 'u64':
      return typeof v === 'bigint' && v >= 0 && v <= 18_446_744_073_709_551_615n;
      case 's64':
      return typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n;
      break;
      case 'f32':
      case 'f64': return typeof v === 'number';
      default:
      return false;
    }
    return true;
  }

  function _requireValidNumericPrimitive(ty, v) {
    if (v === undefined  || v === null || !_isValidNumericPrimitive(ty, v)) {
      throw new TypeError(`invalid ${ty} value [${v}]`);
    }
    return true;
  }

  function toUint64(val) {
    const converted = BigInt(val)
    _requireValidNumericPrimitive('u64', converted);
    return BigInt.asUintN(64, converted);
  }


  function toUint32(val) {
    _requireValidNumericPrimitive('u32', val);
    return val >>> 0;
  }

  const TEXT_DECODER_UTF8 = new TextDecoder();
  const T_FLAG = 1 << 30;

  function rscTableCreateOwn(table, rep) {
    const free = table[0] & ~T_FLAG;
    table._createdReps.add(rep);
    if (free === 0) {
      table.push(0);
      table.push(rep | T_FLAG);
      return (table.length >> 1) - 1;
    }
    table[0] = table[free << 1];
    table[free << 1] = 0;
    table[(free << 1) + 1] = rep | T_FLAG;
    return free;
  }


  function rscTableRemove(table, handle) {
    const scope = table[handle << 1];
    const val = table[(handle << 1) + 1];
    const own = (val & T_FLAG) !== 0;
    const rep = val & ~T_FLAG;
    if (val === 0 || (scope & T_FLAG) !== 0) {
      throw new TypeError("Invalid handle");
    }
    table[handle << 1] = table[0] | T_FLAG;
    table[0] = handle | T_FLAG;
    return { rep, scope, own };
  }

  const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
  const ASYNC_CURRENT_TASK_IDS = [];
  const ASYNC_CURRENT_COMPONENT_IDXS = [];

  const _debugLog = (...args) => {
    if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
    console.debug(...args);
  };

  function clearCurrentTask(componentIdx, taskID) {
    _debugLog('[clearCurrentTask()] args', { componentIdx, taskID });

    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while ending current task');
    }

    const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (!tasks || !Array.isArray(tasks)) {
      throw new Error('missing/invalid tasks for component instance while ending task');
    }
    if (tasks.length == 0) {
      throw new Error(`no current tasks for component instance [${componentIdx}] while ending task`);
    }

    if (taskID !== undefined) {
      const last = tasks[tasks.length - 1];
      if (last.id !== taskID) {
        // throw new Error('current task does not match expected task ID');
        return;
      }
    }

    ASYNC_CURRENT_TASK_IDS.pop();
    ASYNC_CURRENT_COMPONENT_IDXS.pop();

    const taskMeta = tasks.pop();
    return taskMeta.task;
  }
  const ASYNC_STATE = new Map();

  function promiseWithResolvers() {
    if (Promise.withResolvers) {
      return Promise.withResolvers();
    } else {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
  }

  class Waitable {
    #componentIdx;

    #pendingEventFn = null;

    #promise;
    #resolve;
    #reject;

    #waitableSet = null;

    #hasSyncWaiter = false;

    #idx = null; // to component-global waitables

    target;

    constructor(args) {
      const { componentIdx, target } = args;
      this.#componentIdx = componentIdx;
      this.target = args.target;
      this.#resetPromise();
    }

    componentIdx() { return this.#componentIdx; }
    isInSet() { return this.#waitableSet !== null; }

    idx() { return this.#idx; }
    setIdx(idx) {
      if (idx === 0) { throw new Error("waitable idx cannot be zero"); }
      this.#idx = idx;
    }

    setTarget(tgt) { this.target = tgt; }

    #resetPromise() {
      const { promise, resolve, reject } = promiseWithResolvers()
      this.#promise = promise;
      this.#resolve = resolve;
      this.#reject = reject;
    }

    resolve() { this.#resolve(); }
    reject(err) { this.#reject(err); }
    promise() { return this.#promise; }

    hasPendingEvent() {
      // _debugLog('[Waitable#hasPendingEvent()]', {
        //     componentIdx: this.#componentIdx,
        //     waitable: this,
        //     waitableSet: this.#waitableSet,
        //     hasPendingEvent: this.#pendingEventFn !== null,
        // });
        return this.#pendingEventFn !== null;
      }

      setPendingEvent(fn) {
        _debugLog('[Waitable#setPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
        });
        this.#pendingEventFn = fn;
      }

      getPendingEvent() {
        _debugLog('[Waitable#getPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
          hasPendingEvent: this.#pendingEventFn !== null,
        });
        if (this.#pendingEventFn === null) { return null; }
        const eventFn = this.#pendingEventFn;
        this.#pendingEventFn = null;
        const e = eventFn();
        this.#resetPromise();
        return e;
      }

      join(waitableSet) {
        _debugLog('[Waitable#join()] args', {
          waitable: this,
          waitableSet: waitableSet,
          isRemoval: waitableSet === null,
        });

        if (this.#waitableSet === undefined) {
          throw new TypeError('waitable set must be not be undefined');
        }

        if (this.#waitableSet) {
          this.#waitableSet.removeWaitable(this);
        }

        this.#waitableSet = waitableSet;

        if (waitableSet) {
          this.#waitableSet.addWaitable(this);
        }
      }

      drop() {
        _debugLog('[Waitable#drop()] args', {
          componentIdx: this.#componentIdx,
          waitable: this,
        });
        if (this.hasPendingEvent()) {
          throw new Error('waitables with pending events cannot be dropped');
        }
        this.join(null);
      }

      async waitForPendingEvent(args) {
        const { cstate } = args;
        if (!cstate) { throw new TypeError('missing component state'); }

        if (this.#waitableSet !== null || this.#hasSyncWaiter) {
          throw new Error("waitable is already in a set/has a sync waiter");
        }
        this.#hasSyncWaiter = true;
        await cstate.waitUntil({
          cancellable: false,
          readyFn: () => this.hasPendingEvent(),
        });
        this.#hasSyncWaiter = false;
      }

    }
    const INSTANCE_FLAGS = new Map();
    const STORE_TRAP = { error: null };
    const WebAssemblyRuntimeError = WebAssembly.RuntimeError;

    class RepTable {
      // Sentinel marking a freed slot; the freelist link for a freed slot
      // lives in the odd cell. This keeps get()/contains()/remove() on freed
      // reps well-defined (previously they returned/corrupted freelist links).
      static FREE = Symbol('RepTable.free');

      #data = [0, null];
      #size = 0;
      #target;

      constructor(args) {
        this.target = args?.target;
      }

      data() { return this.#data; }

      insert(val) {
        _debugLog('[RepTable#insert()] args', { val, target: this.target });
        const freeIdx = this.#data[0];
        if (freeIdx === 0) {
          this.#data.push(val);
          this.#data.push(null);
          const rep = (this.#data.length >> 1) - 1;
          _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep });
          this.#size += 1;
          return rep;
        }
        const placementIdx = freeIdx << 1;
        if (this.#data[placementIdx] !== RepTable.FREE) {
          throw new Error('corrupt rep table freelist: head does not point at a freed slot');
        }
        this.#data[0] = this.#data[placementIdx + 1];
        this.#data[placementIdx] = val;
        this.#data[placementIdx + 1] = null;
        _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep: freeIdx });
        this.#size += 1;
        return freeIdx;
      }

      get(rep) {
        _debugLog('[RepTable#get()] args', { rep, target: this.target });
        if (rep === 0) { throw new Error('invalid resource rep during get, (cannot be 0)'); }

        const baseIdx = rep << 1;
        const val = this.#data[baseIdx];
        if (val === RepTable.FREE) { return undefined; }
        return val;
      }

      contains(rep) {
        _debugLog('[RepTable#contains()] args', { rep, target: this.target });
        if (rep === 0) { throw new Error('invalid resource rep during contains, (cannot be 0)'); }

        const baseIdx = rep << 1;
        const val = this.#data[baseIdx];
        return val !== RepTable.FREE && !!val;
      }

      remove(rep) {
        _debugLog('[RepTable#remove()] args', { rep, target: this.target });
        if (rep === 0) { throw new Error('invalid resource rep during remove, (cannot be 0)'); }
        if (this.#data.length === 2) { throw new Error('invalid'); }

        const baseIdx = rep << 1;
        if (baseIdx >= this.#data.length) {
          throw new Error(`invalid rep [${rep}] during remove, out of range`);
        }
        const val = this.#data[baseIdx];
        if (val === RepTable.FREE) {
          throw new Error(`double removal of rep [${rep}] (already freed)`);
        }

        this.#data[baseIdx] = RepTable.FREE;
        this.#data[baseIdx + 1] = this.#data[0];
        this.#data[0] = rep;
        this.#size -= 1;

        return val;
      }

      size() { return this.#size; }

      clear() {
        _debugLog('[RepTable#clear()] args', { rep, target: this.target });
        this.#data = [0, null];
      }
    }

    class ComponentAsyncState {
      static EVENT_HANDLER_EVENTS = [ 'backpressure-change' ];

      static TickResult = {
        // no suspended tasks remain
        DONE: 'done',
        // a suspended task was resumed (more may be ready)
        RESUMED: 'resumed',
        // suspended tasks remain but none were ready
        IDLE: 'idle',
      };

      #componentIdx;
      #callingAsyncImport = false;
      #syncImportWait = promiseWithResolvers();
      #lockHolderTaskID = null;
      #lockWaiters = [];
      #lockHandoffScheduled = false;
      #parkedTasks = new Map();
      #suspendedTasksByTaskID = new Map();
      #suspendedTaskIDs = [];
      #errored = null;
      #backpressure = 0;
      #backpressureWaiters = 0n;

      #handlerMap = new Map();
      #nextHandlerID = 0n;

      #tickLoop = null;
      #tickLoopInterval = null;

      #onExclusiveReleaseHandlers = [];

      #mayLeave = true;

      handles;
      subtasks;

      constructor(args) {
        this.#componentIdx = args.componentIdx;
        this.handles = new RepTable({ target: `component [${this.#componentIdx}] handles (waitable objects)` });
        this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
      };

      componentIdx() { return this.#componentIdx; }

      get mayLeave() {
        const flags = INSTANCE_FLAGS.get(this.#componentIdx);
        return flags === undefined ? this.#mayLeave : flags.value === 1;
      }
      set mayLeave(value) {
        if (typeof value !== 'boolean') { throw new TypeError('mayLeave must be a boolean'); }
        this.#mayLeave = value;
        const flags = INSTANCE_FLAGS.get(this.#componentIdx);
        if (flags !== undefined) { flags.value = value ? 1 : 0; }
      }

      errored() { return this.#errored !== null; }
      setErrored(err) {
        _debugLog('[ComponentAsyncState#setErrored()] component errored', { err, componentIdx: this.#componentIdx });
        if (this.#errored) { return; }
        if (!err) {
          err = new Error('error elswehere (see other component instance error)')
          err.componentIdx = this.#componentIdx;
        }
        this.#errored = err;
      }

      markTrapped(err) {
        if (!(err instanceof WebAssemblyRuntimeError)) {
          return false;
        }
        _debugLog('[ComponentAsyncState#markTrapped()] component trapped', { err, componentIdx: this.#componentIdx });
        if (STORE_TRAP.error === null) { STORE_TRAP.error = err; }
        return true;
      }

      throwIfTrapped() {
        if (STORE_TRAP.error !== null) { throw STORE_TRAP.error; }
      }

      callingSyncImport(val) {
        if (val === undefined) { return this.#callingAsyncImport; }
        if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
        const prev = this.#callingAsyncImport;
        this.#callingAsyncImport = val;
        if (prev === true && this.#callingAsyncImport === false) {
          this.#notifySyncImportEnd();
        }
      }

      #notifySyncImportEnd() {
        const existing = this.#syncImportWait;
        this.#syncImportWait = promiseWithResolvers();
        existing.resolve();
      }

      async waitForSyncImportCallEnd() {
        await this.#syncImportWait.promise;
      }

      setBackpressure(v) {
        this.#backpressure = v;
        return this.#backpressure
      }
      getBackpressure() { return this.#backpressure; }

      incrementBackpressure() {
        const current = this.#backpressure;
        if (current < 0 || current > 2**16) {
          throw new Error(`invalid current backpressure value [${current}]`);
        }
        const newValue = this.getBackpressure() + 1;
        if (newValue >= 2**16) {
          throw new Error(`invalid new backpressure value [${newValue}], overflow`);
        }
        return this.setBackpressure(newValue);
      }

      decrementBackpressure() {
        const current = this.#backpressure;
        if (current < 0 || current > 2**16) {
          throw new Error(`invalid current backpressure value [${current}]`);
        }
        const newValue = Math.max(0, current - 1);
        if (newValue < 0) {
          throw new Error(`invalid new backpressure value [${newValue}], underflow`);
        }
        return this.setBackpressure(newValue);
      }
      hasBackpressure() { return this.#backpressure > 0; }

      waitForBackpressure() {
        let backpressureCleared = false;
        const cstate = this;
        cstate.addBackpressureWaiter();
        const handlerID = this.registerHandler({
          event: 'backpressure-change',
          fn: (bp) => {
            if (bp === 0) {
              cstate.removeHandler(handlerID);
              backpressureCleared = true;
            }
          }
        });
        return new Promise((resolve) => {
          const interval = setInterval(() => {
            if (backpressureCleared) { return; }
            clearInterval(interval);
            cstate.removeBackpressureWaiter();
            resolve(null);
          }, 0);
        });
      }

      registerHandler(args) {
        const { event, fn } = args;
        if (!event) { throw new Error("missing handler event"); }
        if (!fn) { throw new Error("missing handler fn"); }

        if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
          throw new Error(`unrecognized event handler [${event}]`);
        }

        const handlerID = this.#nextHandlerID++;
        let handlers = this.#handlerMap.get(event);
        if (!handlers) {
          handlers = [];
          this.#handlerMap.set(event, handlers)
        }

        handlers.push({ id: handlerID, fn, event });
        return handlerID;
      }

      removeHandler(args) {
        const { event, handlerID } = args;
        const registeredHandlers = this.#handlerMap.get(event);
        if (!registeredHandlers) { return; }
        const found = registeredHandlers.find(h => h.id === handlerID);
        if (!found) { return; }
        this.#handlerMap.set(event, this.#handlerMap.get(event).filter(h => h.id !== handlerID));
      }

      getBackpressureWaiters() { return this.#backpressureWaiters; }
      addBackpressureWaiter() { this.#backpressureWaiters++; }
      removeBackpressureWaiter() {
        this.#backpressureWaiters--;
        if (this.#backpressureWaiters < 0) {
          throw new Error("unexepctedly negative number of backpressure waiters");
        }
      }

      // The per-slice mutual-exclusion lock for guest execution in this
      // component instance. Guest slices (callback invocations and
      // sync-lifted bodies) must be atomic per component even across the
      // JSPI suspensions jco introduces for host imports: wit-bindgen's
      // executors publish per-task state in single linear-memory cells
      // (the wasip3-task pointer, context-local storage discipline) that
      // an interleaved slice of the same component corrupts
      //
      // The lock is *owned*: acquisition records the holder task and
      // release is a no-op for anyone else, so a task exiting can no
      // longer drop a hold it does not own (blind acquire/release-any
      // was the previous discipline). Contended acquisition queues
      // FIFO; release hands the lock to the next waiter directly.
      isExclusivelyLocked() { return this.#lockHolderTaskID !== null; }
      exclusivelyLockedBy(taskID) { return this.#lockHolderTaskID === taskID; }

      exclusiveLock(taskID) {
        _debugLog('[ComponentAsyncState#exclusiveLock()]', {
          holder: this.#lockHolderTaskID,
          requester: taskID,
          componentIdx: this.#componentIdx,
        });
        if (taskID === undefined || taskID === null) {
          throw new Error('exclusive lock requires the acquiring task id');
        }
        if (this.#lockHolderTaskID !== null) {
          throw new Error(`component [${this.#componentIdx}] exclusive lock held by task [${this.#lockHolderTaskID}], requested by [${taskID}]`);
        }
        this.#lockHolderTaskID = taskID;
      }

      // Awaitable acquisition: takes the lock immediately when free,
      // otherwise queues FIFO behind the current holder and earlier
      // waiters. The resolved promise implies ownership.
      async acquireExclusiveLock(taskID) {
        if (taskID === undefined || taskID === null) {
          throw new Error('exclusive lock requires the acquiring task id');
        }
        if (this.#lockHolderTaskID === null) {
          this.#lockHolderTaskID = taskID;
          _debugLog('[ComponentAsyncState#acquireExclusiveLock()] acquired', {
            holder: taskID,
            componentIdx: this.#componentIdx,
          });
          return;
        }
        if (this.#lockHolderTaskID === taskID) {
          throw new Error(`task [${taskID}] already holds the lock for component [${this.#componentIdx}]`);
        }
        _debugLog('[ComponentAsyncState#acquireExclusiveLock()] waiting', {
          holder: this.#lockHolderTaskID,
          requester: taskID,
          componentIdx: this.#componentIdx,
          queued: this.#lockWaiters.length,
        });
        await new Promise((resolve) => {
          this.#lockWaiters.push({ taskID, resolve });
        });
      }

      exclusiveRelease(taskID) {
        _debugLog('[ComponentAsyncState#exclusiveRelease()] args', {
          holder: this.#lockHolderTaskID,
          releaser: taskID,
          componentIdx: this.#componentIdx,
        });
        if (this.#lockHolderTaskID !== taskID) {
          // Ownerless releases were the historical behavior; a foreign
          // release now leaves the hold intact
          _debugLog('[ComponentAsyncState#exclusiveRelease()] ignoring foreign release', {
            holder: this.#lockHolderTaskID,
            releaser: taskID,
            componentIdx: this.#componentIdx,
          });
          return false;
        }

        // Make the release observable before handing the lock to the next
        // asynchronous guest slice.
        //
        // Release handlers may expose a lifted value whose consumer immediately
        // performs a synchronous call on the same component; that call must run
        // while the instance is genuinely unlocked, not via enterSync's
        // lock-free fallback code.
        this.#lockHolderTaskID = null;

        this.#onExclusiveReleaseHandlers = this.#onExclusiveReleaseHandlers.filter(v => !!v);
        for (const [idx, f] of this.#onExclusiveReleaseHandlers.entries()) {
          try {
            this.#onExclusiveReleaseHandlers[idx] = null;
            f();
          } catch (err) {
            _debugLog("error while executing handler for next exclusive release", err);
            throw err;
          }
        }
        this.#scheduleLockHandoff();
        return true;
      }

      #scheduleLockHandoff() {
        if (this.#lockHandoffScheduled || this.#lockWaiters.length === 0) { return; }
        this.#lockHandoffScheduled = true;
        queueMicrotask(() => {
          this.#lockHandoffScheduled = false;
          // A synchronous call triggered by a release handler gets the
          // first opportunity to use the unlocked component.
          //
          // Its release will leave this queued handoff in place.
          if (this.#lockHolderTaskID !== null) {
            this.#scheduleLockHandoff();
            return;
          }
          const next = this.#lockWaiters.shift();
          if (!next) { return; }
          this.#lockHolderTaskID = next.taskID;
          next.resolve();
        });
      }

      onNextExclusiveRelease(fn) {
        _debugLog('[ComponentAsyncState#()onNextExclusiveRelease] registering');
        this.#onExclusiveReleaseHandlers.push(fn);
      }

      async waitForExclusiveRelease() {
        while (this.isExclusivelyLocked()) {
          await new Promise(resolve => this.onNextExclusiveRelease(resolve));
        }
      }

      #getSuspendedTaskMeta(taskID) {
        return this.#suspendedTasksByTaskID.get(taskID);
      }

      #removeSuspendedTaskMeta(taskID) {
        _debugLog('[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task', {
          taskID,
          componentIdx: this.#componentIdx,
        });
        const idx = this.#suspendedTaskIDs.findIndex(t => t === taskID);
        const meta = this.#suspendedTasksByTaskID.get(taskID);
        this.#suspendedTaskIDs[idx] = null;
        this.#suspendedTasksByTaskID.delete(taskID);
        return meta;
      }

      #addSuspendedTaskMeta(meta) {
        if (!meta) { throw new Error('missing task meta'); }
        const taskID = meta.taskID;
        this.#suspendedTasksByTaskID.set(taskID, meta);
        this.#suspendedTaskIDs.push(taskID);
        if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
          this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter(t => t !== null);
        }
      }

      // TODO(threads): readyFn is normally on the thread
      suspendTask(args) {
        const { task, readyFn } = args;
        const taskID = task.id();
        const componentIdx = task.componentIdx();
        _debugLog('[ComponentAsyncState#suspendTask()]', {
          taskID,
          componentIdx: this.#componentIdx,
          taskEntryFnName: task.entryFnName(),
          subtask: task.getParentSubtask(),
        });

        if (componentIdx !== this.#componentIdx) {
          throw new Error('assert: task component idx should match async state');
        }

        if (this.#getSuspendedTaskMeta(taskID)) {
          throw new Error(`task [${taskID}] already suspended`);
        }

        const { promise, resolve, reject } = promiseWithResolvers();
        this.#addSuspendedTaskMeta({
          task,
          taskID,
          readyFn,
          resume: () => {
            _debugLog('[ComponentAsyncState] resuming suspended task', {
              taskID,
              componentIdx: this.#componentIdx,
            });
            // TODO(threads): it's thread cancellation we should be checking for below, not task
            resolve(!task.isCancelled());
          },
        });

        this.runTickLoop();

        return promise;
      }

      resumeTaskByID(taskID) {
        const meta = this.#removeSuspendedTaskMeta(taskID);
        if (!meta) { return; }
        if (meta.taskID !== taskID) { throw new Error('task ID does not match'); }
        meta.resume();
      }

      async runTickLoop() {
        if (this.#tickLoop !== null) { return; }
        this.#tickLoop = 1;
        setTimeout(async () => {
          let result = this.tick();
          while (result !== ComponentAsyncState.TickResult.DONE) {
            // After resuming a task, re-tick as soon as the resumed
            // slice's microtask continuations have drained (timeout 0)
            // so queued sibling resumptions aren't charged the idle
            // polling interval; otherwise poll at the idle cadence.
            const delay = result === ComponentAsyncState.TickResult.RESUMED ? 0 : 10;
            await new Promise((resolve) => setTimeout(resolve, delay));
            result = this.tick();
          }
          this.#tickLoop = null;
        }, 10);
      }

      tick() {
        // _debugLog('[ComponentAsyncState#tick()]', { suspendedTaskIDs: this.#suspendedTaskIDs });

        const resumableTasks = this.#suspendedTaskIDs.filter(t => t !== null);
        for (const taskID of resumableTasks) {
          const meta = this.#suspendedTasksByTaskID.get(taskID);
          if (!meta || !meta.readyFn) {
            throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
          }

          // If the task failed via any means, allow the task to resume because
          // it's been cancelled -- the callback should immediately exit as well
          if (meta.task.isRejected()) {
            _debugLog('[ComponentAsyncState#tick()] detected task rejection, leaving early', { meta });
            this.resumeTaskByID(taskID);
            return ComponentAsyncState.TickResult.RESUMED;
          }

          const isReady = meta.readyFn();
          if (!isReady) { continue; }

          _debugLog('[ComponentAsyncState#tick()] resuming task via tick', {
            taskID,
            componentIdx: this.#componentIdx,
          });
          this.resumeTaskByID(taskID);

          // NOTE: during single-flight resumption, we should resume at most one task per
          // tick so that the resumed slice (a microtask continuation)
          // runs -- and its current-task register window opens and
          // closes -- before any sibling task of this component is
          // resumed.
          //
          // Resuming multiple suspended tasks in one synchronous
          // cascade interleaves their register save/restore windows
          // ([restoreA, restoreB, resumeA, resumeB]), re-entering wasm
          // with the register naming the wrong task, and the
          // 'known residual' of the JSPI current-task register
          // fix); with concurrent task lifetimes per component this
          // corrupts guest context-local storage.
          return ComponentAsyncState.TickResult.RESUMED;
        }

        const idle = this.#suspendedTaskIDs.filter(t => t !== null).length > 0;
        return idle
        ? ComponentAsyncState.TickResult.IDLE
        : ComponentAsyncState.TickResult.DONE;
      }

      createWaitable(args) {
        return new Waitable({ target: args?.target, });
      }
    }

    function getOrCreateAsyncState(componentIdx, init) {
      if (!ASYNC_STATE.has(componentIdx)) {
        const newState = new ComponentAsyncState({ componentIdx });
        ASYNC_STATE.set(componentIdx, newState);
      }
      return ASYNC_STATE.get(componentIdx);
    }
    const GLOBAL_COMPONENT_MEMORY_MAP = new Map();

    function lookupMemoriesForComponent(args) {
      const { componentIdx } = args ?? {};
      if (args.componentIdx === undefined) { throw new TypeError("missing component idx"); }

      const metas = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
      if (!metas) { return []; }

      if (args.memoryIdx === undefined) {
        return Object.values(metas);
      }

      const meta = metas[args.memoryIdx];
      return meta?.memory;
    }

    class AsyncSubtask {
      static _ID = 0n;

      static State = {
        STARTING: 0,
        STARTED: 1,
        RETURNED: 2,
        CANCELLED_BEFORE_STARTED: 3,
        CANCELLED_BEFORE_RETURNED: 4,
      };

      #id;
      #state = AsyncSubtask.State.STARTING;
      #componentIdx;

      #parentTask;
      #childTask = null;

      #dropped = false;
      #cancelRequested = false;

      #memoryIdx = null;
      #lenders = null;

      #waitable = null;

      #callbackFn = null;
      #callbackFnName = null;

      #postReturnFn = null;
      #onProgressFn = null;
      #pendingEventFn = null;

      #callMetadata = {};

      #resolved = false;

      #onResolveHandlers = [];
      #onStartHandlers = [];

      #result = null;
      #resultSet = false;

      fnName;
      target;
      isAsync;
      isManualAsync;

      constructor(args) {
        if (typeof args.componentIdx !== 'number') {
          throw new Error('invalid componentIdx for subtask creation');
        }
        this.#componentIdx = args.componentIdx;

        this.#id = ++AsyncSubtask._ID;
        this.fnName = args.fnName;

        if (!args.parentTask) { throw new Error('missing parent task during subtask creation'); }
        this.#parentTask = args.parentTask;

        if (args.childTask) { this.#childTask = args.childTask; }

        if (args.memoryIdx) { this.#memoryIdx = args.memoryIdx; }

        if (!args.waitable) { throw new Error("missing/invalid waitable"); }
        this.#waitable = args.waitable;

        if (args.callMetadata) { this.#callMetadata = args.callMetadata; }

        this.#lenders = [];
        this.target = args.target;
        this.isAsync = args.isAsync;
        this.isManualAsync = args.isManualAsync;
      }

      id() { return this.#id; }
      parentTaskID() { return this.#parentTask?.id(); }
      childTaskID() { return this.#childTask?.id(); }
      state() { return this.#state; }

      waitable() { return this.#waitable; }
      waitableRep() { return this.#waitable.idx(); }

      join() { return this.#waitable.join(...arguments); }
      getPendingEvent() { return this.#waitable.getPendingEvent(...arguments); }
      hasPendingEvent() { return this.#waitable.hasPendingEvent(...arguments); }
      setPendingEvent() { return this.#waitable.setPendingEvent(...arguments); }

      setTarget(tgt) { this.target = tgt; }

      getResult() {
        if (!this.#resultSet) { throw new Error("subtask result has not been set") }
        return this.#result;
      }
      setResult(v) {
        if (this.#resultSet) { throw new Error("subtask result has already been set"); }
        this.#result = v;
        this.#resultSet = true;
      }

      componentIdx() { return this.#componentIdx; }

      setChildTask(t) {
        if (!t) { throw new Error('cannot set missing/invalid child task on subtask'); }
        if (this.#childTask) { throw new Error('child task is already set on subtask'); }
        if (this.#parentTask === t) { throw new Error("parent cannot be child"); }
        this.#childTask = t;
      }
      getChildTask(t) { return this.#childTask; }

      getParentTask() { return this.#parentTask; }

      setCallbackFn(f, name) {
        if (!f) { return; }
        if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
        this.#callbackFn = f;
        this.#callbackFnName = name;
      }

      getCallbackFnName() {
        if (!this.#callbackFn) { return undefined; }
        return this.#callbackFn.name;
      }

      setPostReturnFn(f) {
        if (!f) { return; }
        if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
        this.#postReturnFn = f;
      }

      setOnProgressFn(f) {
        if (this.#onProgressFn) { throw new Error('on progress fn can only be set once'); }
        this.#onProgressFn = f;
      }

      isNotStarted() {
        return this.#state == AsyncSubtask.State.STARTING;
      }

      cancellationRequested() { return this.#cancelRequested; }

      // Request cooperative cancellation of this subtask, on behalf of the
      // supertask (i.e. `canon subtask.cancel`).
      //
      // If the callee is another guest task, the request is delivered to it and
      // the callee confirms via `task.cancel` (or still resolves via `task.return`).
      //
      // If the callee is a host function there is (currently) no host-side
      // cancellation hook, so the pending call is treated as immediately
      // cancelled -- consistent with hosts being expected to resolve
      // cancellation promptly -- and any later host resolution is discarded
      // (see `AsyncTask#onResolve`).
      requestCancellation() {
        _debugLog('[AsyncSubtask#requestCancellation()] args', {
          componentIdx: this.#componentIdx,
          subtaskID: this.#id,
          state: this.#state,
          childTaskID: this.childTaskID(),
          fnName: this.fnName,
        });
        if (this.#cancelRequested) {
          throw new Error('cancellation has already been requested for this subtask');
        }
        this.#cancelRequested = true;

        if (this.#resolved) { return; }

        if (this.#childTask) {
          this.#childTask.requestCancellation();
          return;
        }

        this.onResolve(null);
      }

      registerOnStartHandler(f) {
        this.#onStartHandlers.push(f);
      }

      onStart(args) {
        _debugLog('[AsyncSubtask#onStart()] args', {
          componentIdx: this.#componentIdx,
          subtaskID: this.#id,
          parentTaskID: this.parentTaskID(),
          fnName: this.fnName,
          args,
        });

        if (this.#onProgressFn) { this.#onProgressFn(); }

        this.#state = AsyncSubtask.State.STARTED;

        let result;

        // If we have been provided a helper start function as a result of
        // component fusion performed by wasmtime tooling, then we can call that helper and lifts/lowers will
        // be performed for us.
        //
        // See also documentation on `HostIntrinsic::PrepareCall`
        //
        if (this.#callMetadata.startFn) {
          result = this.#callMetadata.startFn.apply(null, args?.startFnParams ?? []);
        }

        return result;
      }


      registerOnResolveHandler(f) {
        this.#onResolveHandlers.push(f);
      }

      reject(subtaskErr) {
        if (this.#resolved) { return; }

        if (this.#onProgressFn) { this.#onProgressFn(); }

        if (this.#state === AsyncSubtask.State.STARTING) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
        } else if (this.#state === AsyncSubtask.State.STARTED) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
        } else {
          throw new Error('cannot reject a completed subtask');
        }

        this.#resolved = true;
        this.#parentTask.removeSubtask(this);
        this.#parentTask.reject(subtaskErr);
      }

      onResolve(subtaskValue) {
        _debugLog('[AsyncSubtask#onResolve()] args', {
          componentIdx: this.#componentIdx,
          subtaskID: this.#id,
          isAsync: this.isAsync,
          childTaskID: this.childTaskID(),
          parentTaskID: this.parentTaskID(),
          parentTaskFnName: this.#parentTask?.entryFnName(),
          fnName: this.fnName,
        });

        if (this.#resolved) {
          throw new Error('subtask has already been resolved');
        }

        if (this.#onProgressFn) { this.#onProgressFn(); }

        if (subtaskValue === null && this.#cancelRequested) {
          if (this.#state === AsyncSubtask.State.STARTING) {
            this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
          } else {
            if (this.#state !== AsyncSubtask.State.STARTED) {
              throw new Error('resolved subtask must have been started before cancellation');
            }
            this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
          }
        } else {
          if (this.#state !== AsyncSubtask.State.STARTED) {
            throw new Error('resolved subtask must have been started before completion');
          }
          this.#state = AsyncSubtask.State.RETURNED;
        }

        this.setResult(subtaskValue);

        for (const f of this.#onResolveHandlers) {
          try {
            f(subtaskValue);
          } catch (err) {
            console.error("error during subtask resolve handler", err);
            throw err;
          }
        }

        const callMetadata = this.getCallMetadata();

        // TODO(fix): we should be able to easily have the caller's meomry
        // to lower into here, but it's not present in PrepareCall
        const memory = callMetadata.memory ?? this.#parentTask?.getReturnMemory() ?? lookupMemoriesForComponent({ componentIdx: this.#parentTask?.componentIdx() })[0];
        // NOTE: cancelled resolutions carry no value, so nothing is lowered
        const returned = this.#state === AsyncSubtask.State.RETURNED;
        if (returned && callMetadata && !callMetadata.returnFn && this.isAsync && callMetadata.resultPtr && memory) {
          const { resultPtr, realloc } = callMetadata;
          const lowers = callMetadata.lowers; // may have been updated in task.return of the child
          if (lowers && lowers.length > 0) {
            lowers[0]({
              componentIdx: this.#componentIdx,
              memory,
              realloc,
              vals: [subtaskValue],
              storagePtr: resultPtr,
              stringEncoding: callMetadata.stringEncoding,
            });
          }
        }

        this.#resolved = true;
        this.#parentTask.removeSubtask(this);

        if (!this.isAsync) {
          this.deliverResolve();
          const rep = this.waitableRep();
          if (rep) {
            try {
              const removed = this.#getComponentState().handles.remove(rep);
              if (removed !== this) {
                throw new Error("unexpectedly received non-self Subtask from handle removal");
              }
              this.drop();
            } catch (err) {
              _debugLog('[AsyncSubtask#onResolve()] failed to remove subtask after sync subtask completion', err);
            }
          }
        }
      }

      getStateNumber() { return this.#state; }
      isReturned() { return this.#state === AsyncSubtask.State.RETURNED; }

      getCallMetadata() { return this.#callMetadata; }

      isResolved() {
        if (this.#state === AsyncSubtask.State.STARTING
        || this.#state === AsyncSubtask.State.STARTED) {
          return false;
        }
        if (this.#state === AsyncSubtask.State.RETURNED
        || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_STARTED
        || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_RETURNED) {
          return true;
        }
        throw new Error('unrecognized internal Subtask state [' + this.#state + ']');
      }

      addLender(handle) {
        _debugLog('[AsyncSubtask#addLender()] args', { handle });
        if (!Number.isNumber(handle)) { throw new Error('missing/invalid lender handle [' + handle + ']'); }

        if (this.#lenders.length === 0 || this.isResolved()) {
          throw new Error('subtask has no lendors or has already been resolved');
        }

        handle.lends++;
        this.#lenders.push(handle);
      }

      deliverResolve() {
        _debugLog('[AsyncSubtask#deliverResolve()] args', {
          lenders: this.#lenders,
          parentTaskID: this.parentTaskID(),
          subtaskID: this.#id,
          childTaskID: this.childTaskID(),
          resolved: this.isResolved(),
          resolveDelivered: this.resolveDelivered(),
        });

        const cannotDeliverResolve = this.resolveDelivered() || !this.isResolved();
        if (cannotDeliverResolve) {
          throw new Error('subtask cannot deliver resolution twice, and the subtask must be resolved');
        }

        for (const lender of this.#lenders) {
          lender.lends--;
        }

        this.#lenders = null;
      }

      resolveDelivered() {
        _debugLog('[AsyncSubtask#resolveDelivered()] args', { });
        if (this.#lenders === null && !this.isResolved()) {
          throw new Error('invalid subtask state, lenders missing and subtask has not been resolved');
        }
        return this.#lenders === null;
      }

      drop() {
        _debugLog('[AsyncSubtask#drop()] args', {
          componentIdx: this.#componentIdx,
          parentTaskID: this.#parentTask?.id(),
          parentTaskFnName: this.#parentTask?.entryFnName(),
          childTaskID: this.#childTask?.id(),
          childTaskFnName: this.#childTask?.entryFnName(),
          subtaskFnName: this.fnName,
        });
        if (!this.#waitable) { throw new Error('missing/invalid inner waitable'); }
        if (!this.resolveDelivered()) {
          throw new Error('cannot drop subtask before resolve is delivered');
        }
        if (this.#waitable) { this.#waitable.drop() }
        this.#dropped = true;
      }

      #getComponentState() {
        const state = getOrCreateAsyncState(this.#componentIdx);
        if (!state) {
          throw new Error('invalid/missing async state for component [' + componentIdx + ']');
        }
        return state;
      }

      getWaitableHandleIdx() {
        _debugLog('[AsyncSubtask#getWaitableHandleIdx()] args', { });
        if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
        return this.waitableRep();
      }
    }

    class FutureValue {
      #start;
      #settled;
      #hideThen = 0;
      #thenFn;

      constructor(start) {
        if (typeof start !== 'function') {
          throw new TypeError('future start operation must be a function');
        }
        this.#start = start;
        this.#thenFn = this.#then.bind(this);
      }

      get then() {
        return this.#hideThen === 0 ? this.#thenFn : undefined;
      }

      #read() {
        if (!this.#settled) {
          // The start operation resolves to a non-thenable box so a
          // future-valued payload cannot be assimilated by this Promise.
          this.#settled = Promise.resolve().then(this.#start);
        }
        return this.#settled;
      }

      resolveAsValue(resolve) {
        this.#hideThen++;
        try {
          resolve(this);
        } finally {
          this.#hideThen--;
        }
      }

      #deliver(resolve, value) {
        if (value instanceof FutureValue) {
          // Promise resolution reads `then` synchronously. Hide it only
          // for that lookup so resolving this layer yields the inner
          // FutureValue instead of recursively awaiting it.
          value.resolveAsValue(resolve);
          return;
        }
        resolve(value);
      }

      #then(resolve, reject) {
        return this.#read().then(
        box => this.#deliver(resolve, box.value),
        reject,
        );
      }
    }
    const ASYNC_DETERMINISM = 'random';
    const _coinFlip = () => { return Math.random() > 0.5; };

    const ASYNC_EVENT_CODE = {
      NONE: 0,
      SUBTASK: 1,
      STREAM_READ: 2,
      STREAM_WRITE: 3,
      FUTURE_READ: 4,
      FUTURE_WRITE: 5,
      TASK_CANCELLED: 6,
    };
    const CURRENT_TASK_META = {};

    function _withGlobalCurrentTaskMeta(args) {
      _debugLog('[_withGlobalCurrentTaskMeta()] args', args);
      if (!args) { throw new TypeError('args missing'); }
      if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
      if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
      if (!args.fn) { throw new TypeError('missing fn'); }
      const { taskID, componentIdx, fn } = args;
      const previous = CURRENT_TASK_META[componentIdx] ?? null;

      try {
        CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
        return fn();
      } catch (err) {
        _debugLog("error while executing sync callee/callback", {
          ...args,
          err,
        });
        throw err;
      } finally {
        // Synchronous wrappers can nest without any intervening JS
        // scheduling. Restore the caller rather than clearing it so
        // helper core exports (for example fused return adapters) can
        // temporarily run under a different task of the same component.
        CURRENT_TASK_META[componentIdx] = previous;
      }
    }

    async function _withGlobalCurrentTaskMetaAsync(args) {
      _debugLog('[_withGlobalCurrentTaskMetaAsync()] args', args);
      if (!args) { throw new TypeError('args missing'); }
      if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
      if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
      if (!args.fn) { throw new TypeError('missing fn'); }

      const { taskID, componentIdx, fn } = args;

      try {
        CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
        return await fn();
      } catch (err) {
        _debugLog("error while executing async callee/callback", {
          ...args,
          err,
        });
        throw err;
      } finally {
        CURRENT_TASK_META[componentIdx] = null;
      }
    }

    class AsyncTask {
      static _ID = 0n;

      static State = {
        INITIAL: 'initial',
        CANCELLED: 'cancelled',
        CANCEL_PENDING: 'cancel-pending',
        CANCEL_DELIVERED: 'cancel-delivered',
        RESOLVED: 'resolved',
      }

      static BlockResult = {
        CANCELLED: 'block.cancelled',
        NOT_CANCELLED: 'block.not-cancelled',
      }

      #id;
      #componentIdx;
      #state;
      #isAsync;
      #isManualAsync;
      #callingWasmExport = true;
      #lockFreeEntry = false;
      #preserveFutureResult;
      #entryFnName = null;

      #onResolveHandlers = [];
      #completionPromise = null;
      #rejected = false;

      #exitPromise = null;
      #onExitHandlers = [];

      #memoryIdx = null;
      #memory = null;

      #callbackFn = null;
      #callbackFnName = null;

      #postReturnFn = null;

      #getCalleeParamsFn = null;

      #stringEncoding = null;

      #parentSubtask = null;

      #errHandling;

      #backpressurePromise;
      #backpressureWaiters = 0n;

      #returnLowerFns = null;

      #subtasks = [];

      #entered = false;
      #exited = false;
      #errored = null;

      cancelled = false;
      cancelRequested = false;
      alwaysTaskReturn = false;

      returnCalls =  0;
      storage = [0, 0];
      borrowedHandles = {};

      tmpRetI64HighBits = 0|0;

      constructor(opts) {
        this.#id = ++AsyncTask._ID;

        if (opts?.componentIdx === undefined) {
          throw new TypeError('missing component id during task creation');
        }
        this.#componentIdx = opts.componentIdx;

        this.#state = AsyncTask.State.INITIAL;
        this.#isAsync = opts?.isAsync ?? false;
        this.#isManualAsync = opts?.isManualAsync ?? false;
        this.#preserveFutureResult = opts?.preserveFutureResult ?? false;
        this.#entryFnName = opts.entryFnName;
        // Tasks that execute guest slices (export calls, fused
        // callees) default to true; import-handler tasks pass false
        // explicitly (they run host code nested inside the caller's
        // already-locked slice).
        this.#callingWasmExport = opts?.callingWasmExport !== false;

        const {
          promise: completionPromise,
          resolve: resolveCompletionPromise,
          reject: rejectCompletionPromise,
        } = promiseWithResolvers();
        this.#completionPromise = completionPromise;
        // A nested rejection can reach the root task while its Wasm
        // entrypoint is still suspended, before the export wrapper awaits
        // this promise. Mark it handled immediately while preserving the
        // original rejected promise for the eventual caller.
        completionPromise.catch(() => {});

        this.#onResolveHandlers.push((results) => {
          if (this.#parentSubtask !== null) { return; }
          if (!this.#isAsync) { return; }

          if (this.#errored !== null) {
            rejectCompletionPromise(this.#errored);
            return;
          } else if (this.#rejected) {
            rejectCompletionPromise(results);
            return;
          }

          if (this.#preserveFutureResult && results instanceof FutureValue) {
            results.resolveAsValue(resolveCompletionPromise);
          } else {
            resolveCompletionPromise(results);
          }
        });

        const {
          promise: exitPromise,
          resolve: resolveExitPromise,
          reject: rejectExitPromise,
        } = promiseWithResolvers();
        this.#exitPromise = exitPromise;

        this.#onExitHandlers.push(() => {
          resolveExitPromise();
        });

        if (opts.callbackFn) { this.#callbackFn = opts.callbackFn; }
        if (opts.callbackFnName) { this.#callbackFnName = opts.callbackFnName; }

        if (opts.getCalleeParamsFn) { this.#getCalleeParamsFn = opts.getCalleeParamsFn; }

        if (opts.stringEncoding) { this.#stringEncoding = opts.stringEncoding; }

        if (opts.parentSubtask) { this.#parentSubtask = opts.parentSubtask; }


        if (opts.errHandling) { this.#errHandling = opts.errHandling; }
      }

      taskState() { return this.#state; }
      id() { return this.#id; }
      componentIdx() { return this.#componentIdx; }
      entryFnName() { return this.#entryFnName; }

      completionPromise() { return this.#completionPromise; }
      exitPromise() { return this.#exitPromise; }

      isAsync() { return this.#isAsync; }
      isSync() { return !this.isAsync(); }

      getErrHandling() { return this.#errHandling; }

      hasCallback() { return this.#callbackFn !== null; }

      getReturnMemoryIdx() { return this.#memoryIdx; }
      setReturnMemoryIdx(idx) {
        if (idx === null) { return; }
        this.#memoryIdx = idx;
      }

      getReturnMemory() { return this.#memory; }
      setReturnMemory(m) {
        if (m === null) { return; }
        this.#memory = m;
      }

      setReturnLowerFns(fns) { this.#returnLowerFns = fns; }
      getReturnLowerFns() { return this.#returnLowerFns; }

      setParentSubtask(subtask) {
        if (!subtask || !(subtask instanceof AsyncSubtask)) { return }
        if (this.#parentSubtask) { throw new Error('parent subtask can only be set once'); }
        this.#parentSubtask = subtask;
      }

      getParentSubtask() { return this.#parentSubtask; }

      // TODO(threads): this is very inefficient, we can pass along a root task,
      // and ideally do not need this once thread support is in place
      getRootTask() {
        let currentSubtask = this.getParentSubtask();
        let task = this;
        while (currentSubtask) {
          task = currentSubtask.getParentTask();
          currentSubtask = task.getParentSubtask();
        }
        return task;
      }

      setPostReturnFn(f) {
        if (!f) { return; }
        if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
        this.#postReturnFn = f;
      }

      setCallbackFn(f, name) {
        if (!f) { return; }
        if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
        this.#callbackFn = f;
        this.#callbackFnName = name;
      }

      getCallbackFnName() {
        if (!this.#callbackFnName) { return undefined; }
        return this.#callbackFnName;
      }

      async runCallbackFn(...args) {
        if (!this.#callbackFn) { throw new Error('no callback function has been set for task'); }
        return _withGlobalCurrentTaskMetaAsync({
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          fn: () => { return this.#callbackFn.apply(null, args); }
        });
      }

      getCalleeParams() {
        if (!this.#getCalleeParamsFn) { throw new Error('missing/invalid getCalleeParamsFn'); }
        return this.#getCalleeParamsFn();
      }

      mayBlock() { return this.isAsync() || this.isResolvedState() }

      mayEnter(task) {
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        if (cstate.hasBackpressure()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
          return false;
        }
        if (!cstate.callingSyncImport()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
          return false;
        }
        const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
        if (!callingSyncExportWithSyncPending) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
          return false;
        }
        return true;
      }

      enterSync() {
        if (this.needsExclusiveLock()) {
          const cstate = getOrCreateAsyncState(this.#componentIdx);
          if (!cstate.isExclusivelyLocked()) {
            cstate.exclusiveLock(this.#id);
          } else {
            // A host-called sync export arriving while another
            // task's slice holds the lock: synchronous entry
            // cannot wait, and historically this entry silently
            // stole the hold. Run without the lock instead --
            // the holder's bookkeeping stays intact and its
            // release still pairs
            this.#lockFreeEntry = true;
            _debugLog('[AsyncTask#enterSync()] entering without exclusive lock', {
              taskID: this.#id,
              componentIdx: this.#componentIdx,
            });
          }
        }
        return true;
      }

      async enter(opts) {
        _debugLog('[AsyncTask#enter()] args', {
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          subtaskID: this.getParentSubtask()?.id(),
          args: opts,
          entryFnName: this.#entryFnName,
        });

        if (this.#entered) {
          throw new Error(`task with ID [${this.#id}] should not be entered twice`);
        }

        // If cancellation was requested before the task was entered, resolve
        // as cancelled without ever running guest code
        if (this.deliverPendingCancel({ cancellable: true })) {
          this.cancel();
          return false;
        }

        const cstate = getOrCreateAsyncState(this.#componentIdx);

        if (opts?.isHost) {
          this.#entered = true;
          return this.#entered;
        }

        // NOTE: concurrent task lifetimes within one component instance are
        // permitted by the Component Model: entry is governed by the
        // backpressure and exclusive-lock checks below (the lock is held per
        // execution slice, not for the task's lifetime).
        //
        // Serializing entire task lifetimes here (the former "execution slot" queue)
        // deadlocks pipelines where a parked long-lived task's progress depends on a
        // later entry into the same component.

        // If a task is synchronous then we can avoid component-relevant
        // tracking and immediately enter.
        if (this.isSync()) {
          this.#entered = true;

          // TODO(breaking): remove once manually-specifying async fns is removed
          // It is currently possible for an actually sync export to be specified
          // as async via JSPI
          if (this.#isManualAsync) {
            if (this.needsExclusiveLock()) { await cstate.acquireExclusiveLock(this.#id); }
          }

          return this.#entered;
        }

        // Perform intial backpressure check
        if (cstate.hasBackpressure()) {
          cstate.addBackpressureWaiter();

          const result = await this.waitUntil({
            readyFn: () => {
              return !cstate.hasBackpressure();
            },
            cancellable: true,
          });

          cstate.removeBackpressureWaiter();

          if (result === AsyncTask.BlockResult.CANCELLED) {
            this.cancel();
            return false;
          }
        }

        // Acquire the per-slice exclusive lock (FIFO-queued when
        // contended); the first slice runs under this hold and the
        // driver loop releases/re-acquires it per slice thereafter.
        if (this.needsExclusiveLock()) {
          await cstate.acquireExclusiveLock(this.#id);
        }

        this.#entered = true;
        return this.#entered;
      }

      isRunningState() { return this.#state !== AsyncTask.State.RESOLVED; }
      isResolvedState() { return this.#state === AsyncTask.State.RESOLVED; }
      isResolved() { return this.#state === AsyncTask.State.RESOLVED; }
      isExited() { return this.#exited; }

      async waitUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#waitUntil()] args', { taskID: this.#id, args: { cancellable } });

        // TODO(fix): check for cancel
        // TODO(fix): determinism
        // TODO(threads): add this thread to waiting list

        const keepGoing = await this.suspendUntil({
          readyFn,
          cancellable,
        });

        return keepGoing;
      }

      async yieldUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#yieldUntil()]', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });

        const keepGoing = await this.suspendUntil({ readyFn, cancellable });
        if (keepGoing) {
          return {
            code: ASYNC_EVENT_CODE.NONE,
            payload0: 0,
            payload1: 0,
          };
        }

        return {
          code: ASYNC_EVENT_CODE.TASK_CANCELLED,
          payload0: 0,
          payload1: 0,
        };
      }

      async suspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#suspendUntil()] args', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });

        const pendingCancelled = this.deliverPendingCancel({ cancellable });
        if (pendingCancelled) { return false; }

        const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
        return completed;
      }

      // TODO(threads): equivalent to thread.suspend_until()
      async immediateSuspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#immediateSuspendUntil()] args', {
          args: {
            cancellable,
            readyFn,
          },
          taskID: this.#id,
          componentIdx: this.#componentIdx,
        });

        const ready = readyFn();
        if (ready && ASYNC_DETERMINISM === 'random') {
          const coinFlip = _coinFlip();
          if (coinFlip) { return true }
        }

        const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
        return keepGoing;
      }

      async immediateSuspend(opts) { // NOTE: equivalent to thread.suspend()
      // TODO(threads): store readyFn on the thread
      const { cancellable, readyFn } = opts;
      _debugLog('[AsyncTask#immediateSuspend()] args', { cancellable, readyFn });

      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) { return false; }

      const cstate = getOrCreateAsyncState(this.#componentIdx);
      const keepGoing = await cstate.suspendTask({
        task: this,
        readyFn: () => {
          // A pending cancellation request wakes cancellable waits
          if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
            return true;
          }
          return readyFn();
        },
      });
      if (keepGoing && this.deliverPendingCancel({ cancellable })) { return false; }
      return keepGoing;
    }

    deliverPendingCancel(opts) {
      const { cancellable } = opts;
      _debugLog('[AsyncTask#deliverPendingCancel()]', {
        args: { cancellable },
        taskID: this.#id,
        componentIdx: this.#componentIdx,
      });

      if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
        this.#state = AsyncTask.State.CANCEL_DELIVERED;
        return true;
      }

      return false;
    }

    isCancelled() { return this.cancelled }

    // Request cooperative cancellation of this task, called on behalf of a
    // supertask performing `subtask.cancel` on the subtask this task backs.
    //
    // The request is delivered at this task's next cancellable wait
    // (see suspendUntil/immediateSuspend), at which point the task is
    // expected to acknowledge via `task.cancel` or still resolve via
    // `task.return`.
    requestCancellation() {
      _debugLog('[AsyncTask#requestCancellation()] args', {
        taskID: this.#id,
        componentIdx: this.#componentIdx,
        state: this.#state,
      });
      if (this.isResolvedState() || this.cancelRequested) { return; }
      this.cancelRequested = true;
      if (this.#state === AsyncTask.State.INITIAL) {
        this.#state = AsyncTask.State.CANCEL_PENDING;
      }
      // Nudge the component's tick loop so that any suspended cancellable
      // wait observes the pending cancellation promptly
      getOrCreateAsyncState(this.#componentIdx).runTickLoop();
    }

    cancel(args) {
      _debugLog('[AsyncTask#cancel()] args', { });
      if (this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] invalid task state [${this.taskState()}] for cancellation`);
      }
      if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
      this.cancelled = true;
      // Cancelled tasks resolve with no value (spec: `Task.cancel` calls
      // `on_resolve(None)`); an explicit error is only present on the
      // host-driven rejection path (see `reject()`).
      this.onResolve(args?.error ?? null);
      this.#state = AsyncTask.State.RESOLVED;
    }

    onResolve(taskValue) {
      const handlers = this.#onResolveHandlers;
      this.#onResolveHandlers = [];
      for (const f of handlers) {
        try {
          f(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }

      // Rejections are control-flow failures, not canonical ABI results.
      // Propagate them through the subtask chain without running return
      // lowering or post-return hooks for a successful result.
      if (this.#rejected) {
        this.#parentSubtask?.reject(taskValue);
        return;
      }

      // NOTE: if the parent subtask has already been resolved (e.g. it was
      // cancelled via `subtask.cancel` while this task was still pending),
      // this task's resolution must be discarded rather than delivered.
      const parentSubtaskPending = this.#parentSubtask && !this.#parentSubtask.isResolved();

      if (parentSubtaskPending) {
        const meta = this.#parentSubtask.getCallMetadata();
        // Run the rturn fn if it has not already been called -- this *should* have happened in
        // `task.return`, but some paths do not go through task.return (e.g. async lower of sync fn
        // which goes through prepare + async-start-call)
        if (meta.returnFn && !meta.returnFnCalled) {
          _debugLog('[AsyncTask#onResolve()] running returnFn', {
            componentIdx: this.#componentIdx,
            taskID: this.#id,
            subtaskID: this.#parentSubtask.id(),
          });
          const callerTask = this.#parentSubtask.getParentTask();
          _withGlobalCurrentTaskMeta({
            taskID: callerTask.id(),
            componentIdx: callerTask.componentIdx(),
            fn: () => meta.returnFn.apply(null, [taskValue, meta.resultPtr]),
          });
          meta.returnFnCalled = true;
        }
      }

      if (this.#postReturnFn) {
        _debugLog('[AsyncTask#onResolve()] running post return ', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
        });
        try {
          _withGlobalCurrentTaskMeta({
            taskID: this.#id,
            componentIdx: this.#componentIdx,
            fn: () => this.#postReturnFn(taskValue),
          });
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }

      if (parentSubtaskPending) {
        this.#parentSubtask.onResolve(taskValue);
      }
    }

    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }

    isRejected() { return this.#rejected; }

    isErrored() { return this.#errored; }
    setErrored(err) { this.#errored = err; }

    reject(taskErr) {
      _debugLog('[AsyncTask#reject()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        parentSubtask: this.#parentSubtask,
        parentSubtaskID: this.#parentSubtask?.id(),
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
        errMsg: taskErr.message,
      });

      if (this.isResolvedState() || this.#rejected) { return; }

      this.#rejected = true;
      this.cancelRequested = true;
      this.#state = AsyncTask.State.CANCEL_PENDING;
      const cancelled = this.deliverPendingCancel({ cancellable: true });

      // TODO: do cleanup here to reset the machinery so we can run again?

      this.cancel({ error: taskErr });
    }

    resolve(results) {
      _debugLog('[AsyncTask#resolve()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
      });

      if (this.#state === AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
      }

      if (this.borrowedHandles.length > 0) {
        throw new Error('task still has borrow handles');
      }

      this.#state = AsyncTask.State.RESOLVED;

      switch (results.length) {
        case 0:
        this.onResolve(undefined);
        break;
        case 1:
        this.onResolve(results[0]);
        break;
        default:
        _debugLog('[AsyncTask#resolve()] unexpected number of results', {
          componentIdx: this.#componentIdx,
          results,
          taskID: this.#id,
          subtaskID: this.#parentSubtask?.id(),
          entryFnName: this.#entryFnName,
          callbackFnName: this.#callbackFnName,
        });
        throw new Error('unexpected number of results');
      }
    }

    exit(args) {
      _debugLog('[AsyncTask#exit()]', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
      });

      if (this.#exited)  { throw new Error("task has already exited"); }

      if (this.#state !== AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
      }

      if (this.borrowedHandles > 0) {
        throw new Error('task [${this.#id}] exited without clearing borrowed handles');
      }

      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }

      // Exempt the host from exclusive lock check
      if (this.#componentIdx !== -1 && !args?.skipExclusiveLockCheck && !this.#lockFreeEntry) {
        if (this.needsExclusiveLock() && !state.exclusivelyLockedBy(this.#id)) {
          throw new Error(`task [${this.#id}] exit: component [${this.#componentIdx}] should have been exclusively locked by it`);
        }
      }

      // Ownership-checked: releases only this task's own hold (a
      // task exiting while another task's slice holds the lock no
      // longer clears the foreign hold).
      state.exclusiveRelease(this.#id);

      for (const f of this.#onExitHandlers) {
        try {
          f();
        } catch (err) {
          console.error("error during task exit handler", err);
          throw err;
        }
      }

      this.#exited = true;
      clearCurrentTask(this.#componentIdx, this.id());
    }

    needsExclusiveLock() {
      // Host (-1) tasks model host-side import handling: there is no
      // guest linear memory or executor state to protect, and host
      // calls from unrelated guest components would contend spuriously.
      if (this.#componentIdx === -1) { return false; }
      // Import-handler tasks (CallInterface) run host code nested
      // inside the calling guest slice, which already holds the
      // lock; only tasks that execute guest slices need it.
      if (!this.#callingWasmExport) { return false; }
      return !this.#isAsync || this.hasCallback();
    }

    createSubtask(args) {
      _debugLog('[AsyncTask#createSubtask()] args', args);
      const { componentIdx, childTask, callMetadata, fnName, isAsync, isManualAsync } = args;

      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (!cstate) {
        throw new Error(`invalid/missing async state for component idx [${componentIdx}]`);
      }

      const waitable = new Waitable({
        componentIdx: this.#componentIdx,
        target: `subtask (internal ID [${this.#id}])`,
      });

      const newSubtask = new AsyncSubtask({
        componentIdx,
        childTask,
        parentTask: this,
        callMetadata,
        isAsync,
        isManualAsync,
        fnName,
        waitable,
      });
      this.#subtasks.push(newSubtask);
      newSubtask.setTarget(`subtask (internal ID [${newSubtask.id()}], waitable [${waitable.idx()}], component [${componentIdx}])`);
      waitable.setIdx(cstate.handles.insert(newSubtask));
      waitable.setTarget(`waitable for subtask (waitable id [${waitable.idx()}], subtask internal ID [${newSubtask.id()}])`);
      return newSubtask;
    }

    getLatestSubtask() {
      return this.#subtasks.at(-1);
    }

    getSubtaskByWaitableRep(rep) {
      if (rep === undefined) { throw new TypeError('missing rep'); }
      return this.#subtasks.find(s => s.waitableRep() === rep);
    }

    currentSubtask() {
      _debugLog('[AsyncTask#currentSubtask()]');
      if (this.#subtasks.length === 0) { return undefined; }
      return this.#subtasks.at(-1);
    }

    removeSubtask(subtask) {
      if (this.#subtasks.length === 0) {
        throw new Error('cannot end current subtask: no current subtask');
      }
      this.#subtasks = this.#subtasks.filter(t => t !== subtask);
      return subtask;
    }
  }

  function createNewCurrentTask(args) {
    _debugLog('[createNewCurrentTask()] args', args);
    const {
      componentIdx,
      isAsync,
      isManualAsync,
      preserveFutureResult,
      entryFnName,
      parentSubtaskID,
      callbackFnName,
      getCallbackFn,
      getParamsFn,
      stringEncoding,
      errHandling,
      getCalleeParamsFn,
      resultPtr,
      callingWasmExport,
    } = args;
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while starting task');
    }
    let taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    const callbackFn = getCallbackFn ? getCallbackFn() : null;

    const newTask = new AsyncTask({
      componentIdx,
      isAsync,
      isManualAsync,
      preserveFutureResult,
      entryFnName,
      callbackFn,
      callbackFnName,
      stringEncoding,
      getCalleeParamsFn,
      resultPtr,
      errHandling,
      callingWasmExport,
    });

    const newTaskID = newTask.id();
    const newTaskMeta = { id: newTaskID, componentIdx, task: newTask };

    // NOTE: do not track host tasks
    ASYNC_CURRENT_TASK_IDS.push(newTaskID);
    ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);

    if (!taskMetas) {
      taskMetas = [newTaskMeta];
      ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
    } else {
      taskMetas.push(newTaskMeta);
    }

    return [newTask, newTaskID];
  }

  function _checkMayLeave(componentIdx) {
    if (INSTANCE_FLAGS.get(componentIdx)?.value !== 1) {
      throw new WebAssemblyRuntimeError('cannot leave component instance');
    }
  }

  function _guardMayLeave(componentIdx, fn) {
    return function (...args) {
      _checkMayLeave(componentIdx);
      return fn.apply(this, args);
    };
  }

  function clampGuest(i, min, max) {
    if (i < min || i > max) {
      throw new TypeError(`must be between ${min} and ${max}`);
    }
    return i;
  }


  const fetchCompile = url => fetch(url).then(WebAssembly.compileStreaming);

  const symbolRscHandle = Symbol('handle');
  const symbolDispose = Symbol.dispose || Symbol.for('dispose');

  const HANDLE_TABLES= [];


  function finalizationRegistryCreate (unregister) {
    if (typeof FinalizationRegistry === 'undefined') {
      return { unregister () {} };
    }
    return new FinalizationRegistry(unregister);
  }

  class ComponentError extends Error {
    constructor (value) {
      const enumerable = typeof value !== 'string';
      super(enumerable ? `${String(value)} (see error.payload)` : value);
      Object.defineProperty(this, 'payload', { value, enumerable });
    }
  }

  function throwInvalidBool() {
    throw new TypeError('invalid variant discriminant for bool');
  }


  if (!getCoreModule) getCoreModule = (name) => fetchCompile(new URL(`./${name}`, import.meta.url));
  const module0 = getCoreModule('esbt.core.wasm');
  const module1 = getCoreModule('esbt.core2.wasm');
  const module2 = getCoreModule('esbt.core3.wasm');

  let gen = (function* _initGenerator () {
    const instanceFlags0 = new WebAssembly.Global({ value: "i32", mutable: true }, 1);
    INSTANCE_FLAGS.set(0, instanceFlags0);
    let exports0;
    let exports1;
    let exports2;
    let memory0;
    let postReturn0;
    let postReturn0Async;
    let postReturn1;
    let postReturn1Async;
    let postReturn2;
    let postReturn2Async;
    let postReturn3;
    let postReturn3Async;
    let realloc0;
    let realloc0Async;
    let postReturn4;
    let postReturn4Async;
    let postReturn5;
    let postReturn5Async;
    let postReturn6;
    let postReturn6Async;
    let postReturn7;
    let postReturn7Async;

    const handleTable0 = [T_FLAG, 0];
    handleTable0._createdReps = new Set();
    const finalizationRegistry0 = finalizationRegistryCreate((handle) => {
      const { rep } = rscTableRemove(handleTable0, handle);
      exports0['0'](rep);
    });

    HANDLE_TABLES[0] = handleTable0;
    let engine100MethodDocumentSite;

    class Document{
      constructor () {
        throw new Error('"Document" resource does not define a constructor');
      }
    }

    Document.prototype.site = function site() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentSite',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.site"][Instruction::CallWasm] enter', {
              funcName: '[method]document.site',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentSite(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.site"][Instruction::Return]', {
              funcName: '[method]document.site',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([{
              low: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 0, true))),
              high: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 8, true))),
            }]);
            task.exit();
            return {
              low: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 0, true))),
              high: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 8, true))),
            };

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentLength;

    Document.prototype.length = function length() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentLength',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.length"][Instruction::CallWasm] enter', {
              funcName: '[method]document.length',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentLength(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.length"][Instruction::Return]', {
              funcName: '[method]document.length',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([ret >>> 0]);
            task.exit();
            return ret >>> 0;

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentText;

    Document.prototype.text = function text() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentText',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.text"][Instruction::CallWasm] enter', {
              funcName: '[method]document.text',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentText(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            var ptr2 = dataView(memory0).getUint32(ret + 0, true);
            var len2 = dataView(memory0).getUint32(ret + 4, true);
            if (ptr2 % 2 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 2`);
            var result2 = new Uint16Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 2));
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.text"][Instruction::Return]', {
              funcName: '[method]document.text',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            task.resolve([result2]);
            const retCopy = result2;

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn0(ret);
            cstate.mayLeave = true;
            task.exit();
            return retCopy;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentStateHash;

    Document.prototype.stateHash = function stateHash() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentStateHash',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.state-hash"][Instruction::CallWasm] enter', {
              funcName: '[method]document.state-hash',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentStateHash(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.state-hash"][Instruction::Return]', {
              funcName: '[method]document.state-hash',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([BigInt.asUintN(64, BigInt(ret))]);
            task.exit();
            return BigInt.asUintN(64, BigInt(ret));

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentPendingOperations;

    Document.prototype.pendingOperations = function pendingOperations() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentPendingOperations',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.pending-operations"][Instruction::CallWasm] enter', {
              funcName: '[method]document.pending-operations',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentPendingOperations(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.pending-operations"][Instruction::Return]', {
              funcName: '[method]document.pending-operations',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([ret >>> 0]);
            task.exit();
            return ret >>> 0;

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentRetainedOperations;

    Document.prototype.retainedOperations = function retainedOperations() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentRetainedOperations',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.retained-operations"][Instruction::CallWasm] enter', {
              funcName: '[method]document.retained-operations',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentRetainedOperations(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.retained-operations"][Instruction::Return]', {
              funcName: '[method]document.retained-operations',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([ret >>> 0]);
            task.exit();
            return ret >>> 0;

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentCurrentDmax;

    Document.prototype.currentDmax = function currentDmax() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentCurrentDmax',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.current-dmax"][Instruction::CallWasm] enter', {
              funcName: '[method]document.current-dmax',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentCurrentDmax(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.current-dmax"][Instruction::Return]', {
              funcName: '[method]document.current-dmax',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([ret >>> 0]);
            task.exit();
            return ret >>> 0;

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentVersion;

    Document.prototype.version = function version() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentVersion',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.version"][Instruction::CallWasm] enter', {
              funcName: '[method]document.version',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentVersion(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            var ptr2 = dataView(memory0).getUint32(ret + 0, true);
            var len2 = dataView(memory0).getUint32(ret + 4, true);
            if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
            var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.version"][Instruction::Return]', {
              funcName: '[method]document.version',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            task.resolve([result2]);
            const retCopy = result2;

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn1(ret);
            cstate.mayLeave = true;
            task.exit();
            return retCopy;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentHistoryFloor;

    Document.prototype.historyFloor = function historyFloor() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentHistoryFloor',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.history-floor"][Instruction::CallWasm] enter', {
              funcName: '[method]document.history-floor',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentHistoryFloor(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            var ptr2 = dataView(memory0).getUint32(ret + 0, true);
            var len2 = dataView(memory0).getUint32(ret + 4, true);
            if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
            var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.history-floor"][Instruction::Return]', {
              funcName: '[method]document.history-floor',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            task.resolve([result2]);
            const retCopy = result2;

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn1(ret);
            cstate.mayLeave = true;
            task.exit();
            return retCopy;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentBeginTransaction;

    Document.prototype.beginTransaction = function beginTransaction(arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentBeginTransaction',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var variant2 = arg1;
            let variant2_0;
            let variant2_1;
            if (variant2 === null || variant2=== undefined) {
              variant2_0 = 0;
              variant2_1 = 0n;
            } else {
              const e = variant2;
              variant2_0 = 1;
              variant2_1 = toUint64(e);
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.begin-transaction"][Instruction::CallWasm] enter', {
              funcName: '[method]document.begin-transaction',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentBeginTransaction(handle0, variant2_0, variant2_1);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant4;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                variant4= {
                  tag: 'ok',
                  val: undefined
                };
                break;
              }
              case 1: {
                var ptr3 = dataView(memory0).getUint32(ret + 8, true);
                var len3 = dataView(memory0).getUint32(ret + 12, true);
                var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
                variant4= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result3,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.begin-transaction"][Instruction::Return]', {
              funcName: '[method]document.begin-transaction',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant4;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentCommitTransaction;

    Document.prototype.commitTransaction = function commitTransaction() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentCommitTransaction',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.commit-transaction"][Instruction::CallWasm] enter', {
              funcName: '[method]document.commit-transaction',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentCommitTransaction(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant8;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let variant6;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    variant6 = undefined;
                    break;
                  }
                  case 1: {
                    var ptr2 = dataView(memory0).getUint32(ret + 8, true);
                    var len2 = dataView(memory0).getUint32(ret + 12, true);
                    if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
                    var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
                    var bool3 = dataView(memory0).getUint8(ret + 16, true);
                    var len5 = dataView(memory0).getUint32(ret + 24, true);
                    var base5 = dataView(memory0).getUint32(ret + 20, true);
                    if (base5 % 4 !== 0) throw new TypeError(`list pointer [${base5}] is not aligned to 4`);
                    var result5 = [];
                    for (let i = 0; i < len5; i++) {
                      const base = base5 + i * 16;
                      var ptr4 = dataView(memory0).getUint32(base + 8, true);
                      var len4 = dataView(memory0).getUint32(base + 12, true);
                      if (ptr4 % 2 !== 0) throw new TypeError(`list pointer [${ptr4}] is not aligned to 2`);
                      var result4 = new Uint16Array(memory0.buffer.slice(ptr4, ptr4 + len4 * 2));
                      result5.push({
                        from: dataView(memory0).getInt32(base + 0, true) >>> 0,
                        to: dataView(memory0).getInt32(base + 4, true) >>> 0,
                        inserted: result4,
                      });
                    }
                    variant6 = {
                      update: result2,
                      visibleChanged: bool3 == 0 ? false : (bool3 == 1 ? true : throwInvalidBool()),
                      visibleEdits: result5,
                    };
                    break;
                  }
                  default: {
                    throw new TypeError('invalid variant discriminant for option');
                  }
                }
                variant8= {
                  tag: 'ok',
                  val: variant6
                };
                break;
              }
              case 1: {
                var ptr7 = dataView(memory0).getUint32(ret + 8, true);
                var len7 = dataView(memory0).getUint32(ret + 12, true);
                var result7 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr7, len7));
                variant8= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result7,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.commit-transaction"][Instruction::Return]', {
              funcName: '[method]document.commit-transaction',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant8;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn3(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentAbortTransaction;

    Document.prototype.abortTransaction = function abortTransaction() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentAbortTransaction',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.abort-transaction"][Instruction::CallWasm] enter', {
              funcName: '[method]document.abort-transaction',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentAbortTransaction(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant3;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                variant3= {
                  tag: 'ok',
                  val: undefined
                };
                break;
              }
              case 1: {
                var ptr2 = dataView(memory0).getUint32(ret + 8, true);
                var len2 = dataView(memory0).getUint32(ret + 12, true);
                var result2 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr2, len2));
                variant3= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result2,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.abort-transaction"][Instruction::Return]', {
              funcName: '[method]document.abort-transaction',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant3;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentReplace;

    Document.prototype.replace = function replace(arg1, arg2, arg3, arg4) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentReplace',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg3;
            var len2 = val2.length;
            var ptr2 = realloc0(0, 0, 2, len2 * 2);

            let valData2;
            const valLenBytes2 = len2 * 2;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u16')(v);
                dv2.setUint16(ptr2+ offset, v, true);
                offset += 2;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            var variant3 = arg4;
            let variant3_0;
            let variant3_1;
            if (variant3 === null || variant3=== undefined) {
              variant3_0 = 0;
              variant3_1 = 0n;
            } else {
              const e = variant3;
              variant3_0 = 1;
              variant3_1 = toUint64(e);
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.replace"][Instruction::CallWasm] enter', {
              funcName: '[method]document.replace',
              paramCount: 7,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentReplace(handle0, toUint32(arg1), toUint32(arg2), ptr2, len2, variant3_0, variant3_1);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant10;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let variant8;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    variant8 = undefined;
                    break;
                  }
                  case 1: {
                    var ptr4 = dataView(memory0).getUint32(ret + 8, true);
                    var len4 = dataView(memory0).getUint32(ret + 12, true);
                    if (ptr4 % 1 !== 0) throw new TypeError(`list pointer [${ptr4}] is not aligned to 1`);
                    var result4 = new Uint8Array(memory0.buffer.slice(ptr4, ptr4 + len4 * 1));
                    var bool5 = dataView(memory0).getUint8(ret + 16, true);
                    var len7 = dataView(memory0).getUint32(ret + 24, true);
                    var base7 = dataView(memory0).getUint32(ret + 20, true);
                    if (base7 % 4 !== 0) throw new TypeError(`list pointer [${base7}] is not aligned to 4`);
                    var result7 = [];
                    for (let i = 0; i < len7; i++) {
                      const base = base7 + i * 16;
                      var ptr6 = dataView(memory0).getUint32(base + 8, true);
                      var len6 = dataView(memory0).getUint32(base + 12, true);
                      if (ptr6 % 2 !== 0) throw new TypeError(`list pointer [${ptr6}] is not aligned to 2`);
                      var result6 = new Uint16Array(memory0.buffer.slice(ptr6, ptr6 + len6 * 2));
                      result7.push({
                        from: dataView(memory0).getInt32(base + 0, true) >>> 0,
                        to: dataView(memory0).getInt32(base + 4, true) >>> 0,
                        inserted: result6,
                      });
                    }
                    variant8 = {
                      update: result4,
                      visibleChanged: bool5 == 0 ? false : (bool5 == 1 ? true : throwInvalidBool()),
                      visibleEdits: result7,
                    };
                    break;
                  }
                  default: {
                    throw new TypeError('invalid variant discriminant for option');
                  }
                }
                variant10= {
                  tag: 'ok',
                  val: variant8
                };
                break;
              }
              case 1: {
                var ptr9 = dataView(memory0).getUint32(ret + 8, true);
                var len9 = dataView(memory0).getUint32(ret + 12, true);
                var result9 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr9, len9));
                variant10= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result9,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.replace"][Instruction::Return]', {
              funcName: '[method]document.replace',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant10;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn3(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentInsertAtAnchor;

    Document.prototype.insertAtAnchor = function insertAtAnchor(arg1, arg2, arg3) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentInsertAtAnchor',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg1;
            var len2 = Array.isArray(val2) ? val2.length : val2.byteLength;
            var ptr2 = realloc0(0, 0, 1, len2 * 1);

            let valData2;
            const valLenBytes2 = len2 * 1;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv2.setUint8(ptr2+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            var val3 = arg2;
            var len3 = val3.length;
            var ptr3 = realloc0(0, 0, 2, len3 * 2);

            let valData3;
            const valLenBytes3 = len3 * 2;
            if (Array.isArray(val3)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv3 = new DataView(memory0.buffer);
              for (const v of val3) {
                _requireValidNumericPrimitive.bind(null, 'u16')(v);
                dv3.setUint16(ptr3+ offset, v, true);
                offset += 2;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
              const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
              out3.set(valData3);
            }

            var variant4 = arg3;
            let variant4_0;
            let variant4_1;
            if (variant4 === null || variant4=== undefined) {
              variant4_0 = 0;
              variant4_1 = 0n;
            } else {
              const e = variant4;
              variant4_0 = 1;
              variant4_1 = toUint64(e);
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.insert-at-anchor"][Instruction::CallWasm] enter', {
              funcName: '[method]document.insert-at-anchor',
              paramCount: 7,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentInsertAtAnchor(handle0, ptr2, len2, ptr3, len3, variant4_0, variant4_1);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant12;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let variant9;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    variant9 = undefined;
                    break;
                  }
                  case 1: {
                    var ptr5 = dataView(memory0).getUint32(ret + 8, true);
                    var len5 = dataView(memory0).getUint32(ret + 12, true);
                    if (ptr5 % 1 !== 0) throw new TypeError(`list pointer [${ptr5}] is not aligned to 1`);
                    var result5 = new Uint8Array(memory0.buffer.slice(ptr5, ptr5 + len5 * 1));
                    var bool6 = dataView(memory0).getUint8(ret + 16, true);
                    var len8 = dataView(memory0).getUint32(ret + 24, true);
                    var base8 = dataView(memory0).getUint32(ret + 20, true);
                    if (base8 % 4 !== 0) throw new TypeError(`list pointer [${base8}] is not aligned to 4`);
                    var result8 = [];
                    for (let i = 0; i < len8; i++) {
                      const base = base8 + i * 16;
                      var ptr7 = dataView(memory0).getUint32(base + 8, true);
                      var len7 = dataView(memory0).getUint32(base + 12, true);
                      if (ptr7 % 2 !== 0) throw new TypeError(`list pointer [${ptr7}] is not aligned to 2`);
                      var result7 = new Uint16Array(memory0.buffer.slice(ptr7, ptr7 + len7 * 2));
                      result8.push({
                        from: dataView(memory0).getInt32(base + 0, true) >>> 0,
                        to: dataView(memory0).getInt32(base + 4, true) >>> 0,
                        inserted: result7,
                      });
                    }
                    variant9 = {
                      update: result5,
                      visibleChanged: bool6 == 0 ? false : (bool6 == 1 ? true : throwInvalidBool()),
                      visibleEdits: result8,
                    };
                    break;
                  }
                  default: {
                    throw new TypeError('invalid variant discriminant for option');
                  }
                }
                var ptr10 = dataView(memory0).getUint32(ret + 28, true);
                var len10 = dataView(memory0).getUint32(ret + 32, true);
                if (ptr10 % 1 !== 0) throw new TypeError(`list pointer [${ptr10}] is not aligned to 1`);
                var result10 = new Uint8Array(memory0.buffer.slice(ptr10, ptr10 + len10 * 1));
                variant12= {
                  tag: 'ok',
                  val: {
                    change: variant9,
                    anchor: result10,
                  }
                };
                break;
              }
              case 1: {
                var ptr11 = dataView(memory0).getUint32(ret + 8, true);
                var len11 = dataView(memory0).getUint32(ret + 12, true);
                var result11 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr11, len11));
                variant12= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result11,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.insert-at-anchor"][Instruction::Return]', {
              funcName: '[method]document.insert-at-anchor',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant12;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn4(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentApplyUpdate;

    Document.prototype.applyUpdate = function applyUpdate(arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentApplyUpdate',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg1;
            var len2 = Array.isArray(val2) ? val2.length : val2.byteLength;
            var ptr2 = realloc0(0, 0, 1, len2 * 1);

            let valData2;
            const valLenBytes2 = len2 * 1;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv2.setUint8(ptr2+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.apply-update"][Instruction::CallWasm] enter', {
              funcName: '[method]document.apply-update',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentApplyUpdate(handle0, ptr2, len2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant15;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let enum3;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    enum3 = 'applied';
                    break;
                  }
                  case 1: {
                    enum3 = 'duplicate';
                    break;
                  }
                  case 2: {
                    enum3 = 'buffered';
                    break;
                  }
                  case 3: {
                    enum3 = 'mixed';
                    break;
                  }
                  case 4: {
                    enum3 = 'noop';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for ApplyOutcome');
                  }
                }
                var len4 = dataView(memory0).getUint32(ret + 12, true);
                var base4 = dataView(memory0).getUint32(ret + 8, true);
                if (base4 % 8 !== 0) throw new TypeError(`list pointer [${base4}] is not aligned to 8`);
                var result4 = [];
                for (let i = 0; i < len4; i++) {
                  const base = base4 + i * 24;
                  result4.push({
                    origin: {
                      low: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 0, true))),
                      high: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 8, true))),
                    },
                    sequence: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 16, true))),
                  });
                }
                var len5 = dataView(memory0).getUint32(ret + 20, true);
                var base5 = dataView(memory0).getUint32(ret + 16, true);
                if (base5 % 8 !== 0) throw new TypeError(`list pointer [${base5}] is not aligned to 8`);
                var result5 = [];
                for (let i = 0; i < len5; i++) {
                  const base = base5 + i * 24;
                  result5.push({
                    origin: {
                      low: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 0, true))),
                      high: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 8, true))),
                    },
                    sequence: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 16, true))),
                  });
                }
                var len6 = dataView(memory0).getUint32(ret + 28, true);
                var base6 = dataView(memory0).getUint32(ret + 24, true);
                if (base6 % 8 !== 0) throw new TypeError(`list pointer [${base6}] is not aligned to 8`);
                var result6 = [];
                for (let i = 0; i < len6; i++) {
                  const base = base6 + i * 24;
                  result6.push({
                    origin: {
                      low: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 0, true))),
                      high: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 8, true))),
                    },
                    sequence: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 16, true))),
                  });
                }
                var len7 = dataView(memory0).getUint32(ret + 36, true);
                var base7 = dataView(memory0).getUint32(ret + 32, true);
                if (base7 % 8 !== 0) throw new TypeError(`list pointer [${base7}] is not aligned to 8`);
                var result7 = [];
                for (let i = 0; i < len7; i++) {
                  const base = base7 + i * 24;
                  result7.push({
                    origin: {
                      low: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 0, true))),
                      high: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 8, true))),
                    },
                    sequence: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 16, true))),
                  });
                }
                var ptr8 = dataView(memory0).getUint32(ret + 40, true);
                var len8 = dataView(memory0).getUint32(ret + 44, true);
                if (ptr8 % 1 !== 0) throw new TypeError(`list pointer [${ptr8}] is not aligned to 1`);
                var result8 = new Uint8Array(memory0.buffer.slice(ptr8, ptr8 + len8 * 1));
                var bool9 = dataView(memory0).getUint8(ret + 48, true);
                var len11 = dataView(memory0).getUint32(ret + 56, true);
                var base11 = dataView(memory0).getUint32(ret + 52, true);
                if (base11 % 4 !== 0) throw new TypeError(`list pointer [${base11}] is not aligned to 4`);
                var result11 = [];
                for (let i = 0; i < len11; i++) {
                  const base = base11 + i * 16;
                  var ptr10 = dataView(memory0).getUint32(base + 8, true);
                  var len10 = dataView(memory0).getUint32(base + 12, true);
                  if (ptr10 % 2 !== 0) throw new TypeError(`list pointer [${ptr10}] is not aligned to 2`);
                  var result10 = new Uint16Array(memory0.buffer.slice(ptr10, ptr10 + len10 * 2));
                  result11.push({
                    from: dataView(memory0).getInt32(base + 0, true) >>> 0,
                    to: dataView(memory0).getInt32(base + 4, true) >>> 0,
                    inserted: result10,
                  });
                }
                let variant13;
                switch (dataView(memory0).getUint8(ret + 60, true)) {
                  case 0: {
                    variant13 = undefined;
                    break;
                  }
                  case 1: {
                    var ptr12 = dataView(memory0).getUint32(ret + 64, true);
                    var len12 = dataView(memory0).getUint32(ret + 68, true);
                    if (ptr12 % 1 !== 0) throw new TypeError(`list pointer [${ptr12}] is not aligned to 1`);
                    var result12 = new Uint8Array(memory0.buffer.slice(ptr12, ptr12 + len12 * 1));
                    variant13 = result12;
                    break;
                  }
                  default: {
                    throw new TypeError('invalid variant discriminant for option');
                  }
                }
                variant15= {
                  tag: 'ok',
                  val: {
                    outcome: enum3,
                    acceptedOperations: result4,
                    appliedOperations: result5,
                    bufferedOperations: result6,
                    newlyReadyOperations: result7,
                    version: result8,
                    visibleChanged: bool9 == 0 ? false : (bool9 == 1 ? true : throwInvalidBool()),
                    visibleEdits: result11,
                    journal: variant13,
                  }
                };
                break;
              }
              case 1: {
                var ptr14 = dataView(memory0).getUint32(ret + 8, true);
                var len14 = dataView(memory0).getUint32(ret + 12, true);
                var result14 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr14, len14));
                variant15= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result14,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.apply-update"][Instruction::Return]', {
              funcName: '[method]document.apply-update',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant15;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn5(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentExportUpdate;

    Document.prototype.exportUpdate = function exportUpdate(arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentExportUpdate',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg1;
            var len2 = Array.isArray(val2) ? val2.length : val2.byteLength;
            var ptr2 = realloc0(0, 0, 1, len2 * 1);

            let valData2;
            const valLenBytes2 = len2 * 1;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv2.setUint8(ptr2+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.export-update"][Instruction::CallWasm] enter', {
              funcName: '[method]document.export-update',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentExportUpdate(handle0, ptr2, len2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant5;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                var ptr3 = dataView(memory0).getUint32(ret + 4, true);
                var len3 = dataView(memory0).getUint32(ret + 8, true);
                if (ptr3 % 1 !== 0) throw new TypeError(`list pointer [${ptr3}] is not aligned to 1`);
                var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
                variant5= {
                  tag: 'ok',
                  val: result3
                };
                break;
              }
              case 1: {
                var ptr4 = dataView(memory0).getUint32(ret + 8, true);
                var len4 = dataView(memory0).getUint32(ret + 12, true);
                var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
                variant5= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result4,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.export-update"][Instruction::Return]', {
              funcName: '[method]document.export-update',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant5;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn6(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentExportCompactSnapshot;

    Document.prototype.exportCompactSnapshot = function exportCompactSnapshot() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentExportCompactSnapshot',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.export-compact-snapshot"][Instruction::CallWasm] enter', {
              funcName: '[method]document.export-compact-snapshot',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentExportCompactSnapshot(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant4;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                var ptr2 = dataView(memory0).getUint32(ret + 4, true);
                var len2 = dataView(memory0).getUint32(ret + 8, true);
                if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
                var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
                variant4= {
                  tag: 'ok',
                  val: result2
                };
                break;
              }
              case 1: {
                var ptr3 = dataView(memory0).getUint32(ret + 8, true);
                var len3 = dataView(memory0).getUint32(ret + 12, true);
                var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
                variant4= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result3,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.export-compact-snapshot"][Instruction::Return]', {
              funcName: '[method]document.export-compact-snapshot',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant4;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn6(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentExportFullSnapshot;

    Document.prototype.exportFullSnapshot = function exportFullSnapshot() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentExportFullSnapshot',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.export-full-snapshot"][Instruction::CallWasm] enter', {
              funcName: '[method]document.export-full-snapshot',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentExportFullSnapshot(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant4;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                var ptr2 = dataView(memory0).getUint32(ret + 4, true);
                var len2 = dataView(memory0).getUint32(ret + 8, true);
                if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
                var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
                variant4= {
                  tag: 'ok',
                  val: result2
                };
                break;
              }
              case 1: {
                var ptr3 = dataView(memory0).getUint32(ret + 8, true);
                var len3 = dataView(memory0).getUint32(ret + 12, true);
                var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
                variant4= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result3,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.export-full-snapshot"][Instruction::Return]', {
              funcName: '[method]document.export-full-snapshot',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant4;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn6(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentApplySnapshot;

    Document.prototype.applySnapshot = function applySnapshot(arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentApplySnapshot',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg1;
            var len2 = Array.isArray(val2) ? val2.length : val2.byteLength;
            var ptr2 = realloc0(0, 0, 1, len2 * 1);

            let valData2;
            const valLenBytes2 = len2 * 1;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv2.setUint8(ptr2+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.apply-snapshot"][Instruction::CallWasm] enter', {
              funcName: '[method]document.apply-snapshot',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentApplySnapshot(handle0, ptr2, len2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant10;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let enum3;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    enum3 = 'full';
                    break;
                  }
                  case 1: {
                    enum3 = 'compact';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for SnapshotKind');
                  }
                }
                var ptr4 = dataView(memory0).getUint32(ret + 8, true);
                var len4 = dataView(memory0).getUint32(ret + 12, true);
                if (ptr4 % 1 !== 0) throw new TypeError(`list pointer [${ptr4}] is not aligned to 1`);
                var result4 = new Uint8Array(memory0.buffer.slice(ptr4, ptr4 + len4 * 1));
                var bool5 = dataView(memory0).getUint8(ret + 16, true);
                var len7 = dataView(memory0).getUint32(ret + 24, true);
                var base7 = dataView(memory0).getUint32(ret + 20, true);
                if (base7 % 4 !== 0) throw new TypeError(`list pointer [${base7}] is not aligned to 4`);
                var result7 = [];
                for (let i = 0; i < len7; i++) {
                  const base = base7 + i * 16;
                  var ptr6 = dataView(memory0).getUint32(base + 8, true);
                  var len6 = dataView(memory0).getUint32(base + 12, true);
                  if (ptr6 % 2 !== 0) throw new TypeError(`list pointer [${ptr6}] is not aligned to 2`);
                  var result6 = new Uint16Array(memory0.buffer.slice(ptr6, ptr6 + len6 * 2));
                  result7.push({
                    from: dataView(memory0).getInt32(base + 0, true) >>> 0,
                    to: dataView(memory0).getInt32(base + 4, true) >>> 0,
                    inserted: result6,
                  });
                }
                let enum8;
                switch (dataView(memory0).getUint8(ret + 28, true)) {
                  case 0: {
                    enum8 = 'preserved';
                    break;
                  }
                  case 1: {
                    enum8 = 'partially-preserved';
                    break;
                  }
                  case 2: {
                    enum8 = 'cleared';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for UndoDisposition');
                  }
                }
                variant10= {
                  tag: 'ok',
                  val: {
                    kind: enum3,
                    version: result4,
                    visibleChanged: bool5 == 0 ? false : (bool5 == 1 ? true : throwInvalidBool()),
                    visibleEdits: result7,
                    undo: enum8,
                  }
                };
                break;
              }
              case 1: {
                var ptr9 = dataView(memory0).getUint32(ret + 8, true);
                var len9 = dataView(memory0).getUint32(ret + 12, true);
                var result9 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr9, len9));
                variant10= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result9,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.apply-snapshot"][Instruction::Return]', {
              funcName: '[method]document.apply-snapshot',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant10;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn7(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentAnchor;

    Document.prototype.anchor = function anchor(arg1, arg2) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentAnchor',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg2;
            let enum2;
            switch (val2) {
              case 'before': {
                enum2 = 0;
                break;
              }
              case 'after': {
                enum2 = 1;
                break;
              }
              default: {
                if ((arg2) instanceof Error) {
                  console.error(arg2);
                }

                throw new TypeError(`"${val2}" is not one of the cases of affinity`);
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.anchor"][Instruction::CallWasm] enter', {
              funcName: '[method]document.anchor',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentAnchor(handle0, toUint32(arg1), enum2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant5;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                var ptr3 = dataView(memory0).getUint32(ret + 4, true);
                var len3 = dataView(memory0).getUint32(ret + 8, true);
                if (ptr3 % 1 !== 0) throw new TypeError(`list pointer [${ptr3}] is not aligned to 1`);
                var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
                variant5= {
                  tag: 'ok',
                  val: result3
                };
                break;
              }
              case 1: {
                var ptr4 = dataView(memory0).getUint32(ret + 8, true);
                var len4 = dataView(memory0).getUint32(ret + 12, true);
                var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
                variant5= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result4,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.anchor"][Instruction::Return]', {
              funcName: '[method]document.anchor',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant5;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn6(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentResolveAnchor;

    Document.prototype.resolveAnchor = function resolveAnchor(arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentResolveAnchor',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg1;
            var len2 = Array.isArray(val2) ? val2.length : val2.byteLength;
            var ptr2 = realloc0(0, 0, 1, len2 * 1);

            let valData2;
            const valLenBytes2 = len2 * 1;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv2.setUint8(ptr2+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.resolve-anchor"][Instruction::CallWasm] enter', {
              funcName: '[method]document.resolve-anchor',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentResolveAnchor(handle0, ptr2, len2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant4;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                variant4= {
                  tag: 'ok',
                  val: dataView(memory0).getInt32(ret + 4, true) >>> 0
                };
                break;
              }
              case 1: {
                var ptr3 = dataView(memory0).getUint32(ret + 8, true);
                var len3 = dataView(memory0).getUint32(ret + 12, true);
                var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
                variant4= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result3,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.resolve-anchor"][Instruction::Return]', {
              funcName: '[method]document.resolve-anchor',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant4;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentCaptureCausalPosition;

    Document.prototype.captureCausalPosition = function captureCausalPosition(arg1, arg2) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentCaptureCausalPosition',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg2;
            let enum2;
            switch (val2) {
              case 'before': {
                enum2 = 0;
                break;
              }
              case 'after': {
                enum2 = 1;
                break;
              }
              default: {
                if ((arg2) instanceof Error) {
                  console.error(arg2);
                }

                throw new TypeError(`"${val2}" is not one of the cases of affinity`);
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.capture-causal-position"][Instruction::CallWasm] enter', {
              funcName: '[method]document.capture-causal-position',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentCaptureCausalPosition(handle0, toUint32(arg1), enum2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant5;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                var ptr3 = dataView(memory0).getUint32(ret + 4, true);
                var len3 = dataView(memory0).getUint32(ret + 8, true);
                if (ptr3 % 1 !== 0) throw new TypeError(`list pointer [${ptr3}] is not aligned to 1`);
                var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
                variant5= {
                  tag: 'ok',
                  val: result3
                };
                break;
              }
              case 1: {
                var ptr4 = dataView(memory0).getUint32(ret + 8, true);
                var len4 = dataView(memory0).getUint32(ret + 12, true);
                var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
                variant5= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result4,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.capture-causal-position"][Instruction::Return]', {
              funcName: '[method]document.capture-causal-position',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant5;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn6(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentResolveCausalPosition;

    Document.prototype.resolveCausalPosition = function resolveCausalPosition(arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentResolveCausalPosition',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg1;
            var len2 = Array.isArray(val2) ? val2.length : val2.byteLength;
            var ptr2 = realloc0(0, 0, 1, len2 * 1);

            let valData2;
            const valLenBytes2 = len2 * 1;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv2.setUint8(ptr2+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.resolve-causal-position"][Instruction::CallWasm] enter', {
              funcName: '[method]document.resolve-causal-position',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentResolveCausalPosition(handle0, ptr2, len2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant5;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let variant3;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    variant3 = undefined;
                    break;
                  }
                  case 1: {
                    variant3 = dataView(memory0).getInt32(ret + 8, true) >>> 0;
                    break;
                  }
                  default: {
                    throw new TypeError('invalid variant discriminant for option');
                  }
                }
                variant5= {
                  tag: 'ok',
                  val: variant3
                };
                break;
              }
              case 1: {
                var ptr4 = dataView(memory0).getUint32(ret + 8, true);
                var len4 = dataView(memory0).getUint32(ret + 12, true);
                var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
                variant5= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result4,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.resolve-causal-position"][Instruction::Return]', {
              funcName: '[method]document.resolve-causal-position',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant5;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentPruneHistoryThrough;

    Document.prototype.pruneHistoryThrough = function pruneHistoryThrough(arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentPruneHistoryThrough',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            var val2 = arg1;
            var len2 = Array.isArray(val2) ? val2.length : val2.byteLength;
            var ptr2 = realloc0(0, 0, 1, len2 * 1);

            let valData2;
            const valLenBytes2 = len2 * 1;
            if (Array.isArray(val2)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv2 = new DataView(memory0.buffer);
              for (const v of val2) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv2.setUint8(ptr2+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData2 = new Uint8Array(val2.buffer || val2, val2.byteOffset, valLenBytes2);
              const out2 = new Uint8Array(memory0.buffer, ptr2, valLenBytes2);
              out2.set(valData2);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.prune-history-through"][Instruction::CallWasm] enter', {
              funcName: '[method]document.prune-history-through',
              paramCount: 3,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentPruneHistoryThrough(handle0, ptr2, len2);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant4;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                variant4= {
                  tag: 'ok',
                  val: dataView(memory0).getInt32(ret + 4, true) >>> 0
                };
                break;
              }
              case 1: {
                var ptr3 = dataView(memory0).getUint32(ret + 8, true);
                var len3 = dataView(memory0).getUint32(ret + 12, true);
                var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
                variant4= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result3,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.prune-history-through"][Instruction::Return]', {
              funcName: '[method]document.prune-history-through',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant4;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentCanUndo;

    Document.prototype.canUndo = function canUndo() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentCanUndo',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.can-undo"][Instruction::CallWasm] enter', {
              funcName: '[method]document.can-undo',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentCanUndo(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            var bool2 = ret;
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.can-undo"][Instruction::Return]', {
              funcName: '[method]document.can-undo',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([bool2 == 0 ? false : (bool2 == 1 ? true : throwInvalidBool())]);
            task.exit();
            return bool2 == 0 ? false : (bool2 == 1 ? true : throwInvalidBool());

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentCanRedo;

    Document.prototype.canRedo = function canRedo() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentCanRedo',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.can-redo"][Instruction::CallWasm] enter', {
              funcName: '[method]document.can-redo',
              paramCount: 1,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentCanRedo(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            var bool2 = ret;
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.can-redo"][Instruction::Return]', {
              funcName: '[method]document.can-redo',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([bool2 == 0 ? false : (bool2 == 1 ? true : throwInvalidBool())]);
            task.exit();
            return bool2 == 0 ? false : (bool2 == 1 ? true : throwInvalidBool());

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentUndo;

    Document.prototype.undo = function undo() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentUndo',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.undo"][Instruction::CallWasm] enter', {
              funcName: '[method]document.undo',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentUndo(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant8;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let variant6;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    variant6 = undefined;
                    break;
                  }
                  case 1: {
                    var ptr2 = dataView(memory0).getUint32(ret + 8, true);
                    var len2 = dataView(memory0).getUint32(ret + 12, true);
                    if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
                    var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
                    var bool3 = dataView(memory0).getUint8(ret + 16, true);
                    var len5 = dataView(memory0).getUint32(ret + 24, true);
                    var base5 = dataView(memory0).getUint32(ret + 20, true);
                    if (base5 % 4 !== 0) throw new TypeError(`list pointer [${base5}] is not aligned to 4`);
                    var result5 = [];
                    for (let i = 0; i < len5; i++) {
                      const base = base5 + i * 16;
                      var ptr4 = dataView(memory0).getUint32(base + 8, true);
                      var len4 = dataView(memory0).getUint32(base + 12, true);
                      if (ptr4 % 2 !== 0) throw new TypeError(`list pointer [${ptr4}] is not aligned to 2`);
                      var result4 = new Uint16Array(memory0.buffer.slice(ptr4, ptr4 + len4 * 2));
                      result5.push({
                        from: dataView(memory0).getInt32(base + 0, true) >>> 0,
                        to: dataView(memory0).getInt32(base + 4, true) >>> 0,
                        inserted: result4,
                      });
                    }
                    variant6 = {
                      update: result2,
                      visibleChanged: bool3 == 0 ? false : (bool3 == 1 ? true : throwInvalidBool()),
                      visibleEdits: result5,
                    };
                    break;
                  }
                  default: {
                    throw new TypeError('invalid variant discriminant for option');
                  }
                }
                variant8= {
                  tag: 'ok',
                  val: variant6
                };
                break;
              }
              case 1: {
                var ptr7 = dataView(memory0).getUint32(ret + 8, true);
                var len7 = dataView(memory0).getUint32(ret + 12, true);
                var result7 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr7, len7));
                variant8= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result7,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.undo"][Instruction::Return]', {
              funcName: '[method]document.undo',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant8;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn3(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100MethodDocumentRedo;

    Document.prototype.redo = function redo() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100MethodDocumentRedo',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {


            var handle1 = this[symbolRscHandle];
            if (!handle1 || (handleTable0[(handle1 << 1) + 1] & T_FLAG) === 0) {
              throw new TypeError('Resource error: Not a valid \"Document\" resource.');
            }
            var handle0 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;

            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.redo"][Instruction::CallWasm] enter', {
              funcName: '[method]document.redo',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100MethodDocumentRedo(handle0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant8;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let variant6;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    variant6 = undefined;
                    break;
                  }
                  case 1: {
                    var ptr2 = dataView(memory0).getUint32(ret + 8, true);
                    var len2 = dataView(memory0).getUint32(ret + 12, true);
                    if (ptr2 % 1 !== 0) throw new TypeError(`list pointer [${ptr2}] is not aligned to 1`);
                    var result2 = new Uint8Array(memory0.buffer.slice(ptr2, ptr2 + len2 * 1));
                    var bool3 = dataView(memory0).getUint8(ret + 16, true);
                    var len5 = dataView(memory0).getUint32(ret + 24, true);
                    var base5 = dataView(memory0).getUint32(ret + 20, true);
                    if (base5 % 4 !== 0) throw new TypeError(`list pointer [${base5}] is not aligned to 4`);
                    var result5 = [];
                    for (let i = 0; i < len5; i++) {
                      const base = base5 + i * 16;
                      var ptr4 = dataView(memory0).getUint32(base + 8, true);
                      var len4 = dataView(memory0).getUint32(base + 12, true);
                      if (ptr4 % 2 !== 0) throw new TypeError(`list pointer [${ptr4}] is not aligned to 2`);
                      var result4 = new Uint16Array(memory0.buffer.slice(ptr4, ptr4 + len4 * 2));
                      result5.push({
                        from: dataView(memory0).getInt32(base + 0, true) >>> 0,
                        to: dataView(memory0).getInt32(base + 4, true) >>> 0,
                        inserted: result4,
                      });
                    }
                    variant6 = {
                      update: result2,
                      visibleChanged: bool3 == 0 ? false : (bool3 == 1 ? true : throwInvalidBool()),
                      visibleEdits: result5,
                    };
                    break;
                  }
                  default: {
                    throw new TypeError('invalid variant discriminant for option');
                  }
                }
                variant8= {
                  tag: 'ok',
                  val: variant6
                };
                break;
              }
              case 1: {
                var ptr7 = dataView(memory0).getUint32(ret + 8, true);
                var len7 = dataView(memory0).getUint32(ret + 12, true);
                var result7 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr7, len7));
                variant8= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result7,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="[method]document.redo"][Instruction::Return]', {
              funcName: '[method]document.redo',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant8;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn3(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    };
    let engine100DefaultConfig;

    function defaultConfig() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100DefaultConfig',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {

            _debugLog('[iface="esbt:document/engine@1.0.0", function="default-config"][Instruction::CallWasm] enter', {
              funcName: 'default-config',
              paramCount: 0,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100DefaultConfig();
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let enum0;
            switch (dataView(memory0).getUint8(ret + 12, true)) {
              case 0: {
                enum0 = 'midpoint';
                break;
              }
              case 1: {
                enum0 = 'boundary-low';
                break;
              }
              case 2: {
                enum0 = 'boundary-high';
                break;
              }
              case 3: {
                enum0 = 'alternating-by-depth';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for AllocationStrategyKind');
              }
            }
            let variant1;
            switch (dataView(memory0).getUint8(ret + 20, true)) {
              case 0: {
                variant1 = undefined;
                break;
              }
              case 1: {
                variant1 = {
                  floor: dataView(memory0).getInt32(ret + 24, true) >>> 0,
                  ceiling: dataView(memory0).getInt32(ret + 28, true) >>> 0,
                  window: dataView(memory0).getInt32(ret + 32, true) >>> 0,
                  holdoffWindows: dataView(memory0).getInt32(ret + 36, true) >>> 0,
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="default-config"][Instruction::Return]', {
              funcName: 'default-config',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([{
              dmax: dataView(memory0).getInt32(ret + 0, true) >>> 0,
              base: dataView(memory0).getInt32(ret + 4, true) >>> 0,
              depth: dataView(memory0).getInt32(ret + 8, true) >>> 0,
              strategy: {
                kind: enum0,
                boundary: dataView(memory0).getInt32(ret + 16, true) >>> 0,
              },
              adaptiveDmax: variant1,
              limits: {
                maxMessageBytes: dataView(memory0).getInt32(ret + 40, true) >>> 0,
                maxOperationsPerUpdate: dataView(memory0).getInt32(ret + 44, true) >>> 0,
                maxIdentifierDepth: dataView(memory0).getInt32(ret + 48, true) >>> 0,
                maxVersionSites: dataView(memory0).getInt32(ret + 52, true) >>> 0,
                maxSparseReceipts: dataView(memory0).getInt32(ret + 56, true) >>> 0,
                maxSnapshotItems: dataView(memory0).getInt32(ret + 60, true) >>> 0,
                maxPendingOperations: dataView(memory0).getInt32(ret + 64, true) >>> 0,
                maxDeferredDeletes: dataView(memory0).getInt32(ret + 68, true) >>> 0,
                maxDocumentUnits: dataView(memory0).getInt32(ret + 72, true) >>> 0,
                maxAllocationAttempts: dataView(memory0).getInt32(ret + 76, true) >>> 0,
                maxRetainedOperations: dataView(memory0).getInt32(ret + 80, true) >>> 0,
                maxUndoTransactions: dataView(memory0).getInt32(ret + 84, true) >>> 0,
              },
            }]);
            task.exit();
            return {
              dmax: dataView(memory0).getInt32(ret + 0, true) >>> 0,
              base: dataView(memory0).getInt32(ret + 4, true) >>> 0,
              depth: dataView(memory0).getInt32(ret + 8, true) >>> 0,
              strategy: {
                kind: enum0,
                boundary: dataView(memory0).getInt32(ret + 16, true) >>> 0,
              },
              adaptiveDmax: variant1,
              limits: {
                maxMessageBytes: dataView(memory0).getInt32(ret + 40, true) >>> 0,
                maxOperationsPerUpdate: dataView(memory0).getInt32(ret + 44, true) >>> 0,
                maxIdentifierDepth: dataView(memory0).getInt32(ret + 48, true) >>> 0,
                maxVersionSites: dataView(memory0).getInt32(ret + 52, true) >>> 0,
                maxSparseReceipts: dataView(memory0).getInt32(ret + 56, true) >>> 0,
                maxSnapshotItems: dataView(memory0).getInt32(ret + 60, true) >>> 0,
                maxPendingOperations: dataView(memory0).getInt32(ret + 64, true) >>> 0,
                maxDeferredDeletes: dataView(memory0).getInt32(ret + 68, true) >>> 0,
                maxDocumentUnits: dataView(memory0).getInt32(ret + 72, true) >>> 0,
                maxAllocationAttempts: dataView(memory0).getInt32(ret + 76, true) >>> 0,
                maxRetainedOperations: dataView(memory0).getInt32(ret + 80, true) >>> 0,
                maxUndoTransactions: dataView(memory0).getInt32(ret + 84, true) >>> 0,
              },
            };

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    }
    let engine100DefaultAdaptiveDmaxConfig;

    function defaultAdaptiveDmaxConfig() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100DefaultAdaptiveDmaxConfig',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {

            _debugLog('[iface="esbt:document/engine@1.0.0", function="default-adaptive-dmax-config"][Instruction::CallWasm] enter', {
              funcName: 'default-adaptive-dmax-config',
              paramCount: 0,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100DefaultAdaptiveDmaxConfig();
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="default-adaptive-dmax-config"][Instruction::Return]', {
              funcName: 'default-adaptive-dmax-config',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([{
              floor: dataView(memory0).getInt32(ret + 0, true) >>> 0,
              ceiling: dataView(memory0).getInt32(ret + 4, true) >>> 0,
              window: dataView(memory0).getInt32(ret + 8, true) >>> 0,
              holdoffWindows: dataView(memory0).getInt32(ret + 12, true) >>> 0,
            }]);
            task.exit();
            return {
              floor: dataView(memory0).getInt32(ret + 0, true) >>> 0,
              ceiling: dataView(memory0).getInt32(ret + 4, true) >>> 0,
              window: dataView(memory0).getInt32(ret + 8, true) >>> 0,
              holdoffWindows: dataView(memory0).getInt32(ret + 12, true) >>> 0,
            };

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    }
    let engine100Create;

    function create(arg0, arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100Create',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {

            var ptr0 = realloc0(0, 0, 8, 104);
            var {low: v1_0, high: v1_1 } = arg0;
            dataView(memory0).setBigInt64(ptr0 + 0, toUint64(v1_0), true);
            dataView(memory0).setBigInt64(ptr0 + 8, toUint64(v1_1), true);
            var {dmax: v2_0, base: v2_1, depth: v2_2, strategy: v2_3, adaptiveDmax: v2_4, limits: v2_5 } = arg1;
            dataView(memory0).setInt32(ptr0 + 16, toUint32(v2_0), true);
            dataView(memory0).setInt32(ptr0 + 20, toUint32(v2_1), true);
            dataView(memory0).setInt32(ptr0 + 24, toUint32(v2_2), true);
            var {kind: v3_0, boundary: v3_1 } = v2_3;
            var val4 = v3_0;
            let enum4;
            switch (val4) {
              case 'midpoint': {
                enum4 = 0;
                break;
              }
              case 'boundary-low': {
                enum4 = 1;
                break;
              }
              case 'boundary-high': {
                enum4 = 2;
                break;
              }
              case 'alternating-by-depth': {
                enum4 = 3;
                break;
              }
              default: {
                if ((v3_0) instanceof Error) {
                  console.error(v3_0);
                }

                throw new TypeError(`"${val4}" is not one of the cases of allocation-strategy-kind`);
              }
            }
            dataView(memory0).setInt8(ptr0 + 28, enum4, true);
            dataView(memory0).setInt32(ptr0 + 32, toUint32(v3_1), true);
            var variant6 = v2_4;
            if (variant6 === null || variant6=== undefined) {
              dataView(memory0).setInt8(ptr0 + 36, 0, true);
            } else {
              const e = variant6;
              dataView(memory0).setInt8(ptr0 + 36, 1, true);
              var {floor: v5_0, ceiling: v5_1, window: v5_2, holdoffWindows: v5_3 } = e;
              dataView(memory0).setInt32(ptr0 + 40, toUint32(v5_0), true);
              dataView(memory0).setInt32(ptr0 + 44, toUint32(v5_1), true);
              dataView(memory0).setInt32(ptr0 + 48, toUint32(v5_2), true);
              dataView(memory0).setInt32(ptr0 + 52, toUint32(v5_3), true);
            }
            var {maxMessageBytes: v7_0, maxOperationsPerUpdate: v7_1, maxIdentifierDepth: v7_2, maxVersionSites: v7_3, maxSparseReceipts: v7_4, maxSnapshotItems: v7_5, maxPendingOperations: v7_6, maxDeferredDeletes: v7_7, maxDocumentUnits: v7_8, maxAllocationAttempts: v7_9, maxRetainedOperations: v7_10, maxUndoTransactions: v7_11 } = v2_5;
            dataView(memory0).setInt32(ptr0 + 56, toUint32(v7_0), true);
            dataView(memory0).setInt32(ptr0 + 60, toUint32(v7_1), true);
            dataView(memory0).setInt32(ptr0 + 64, toUint32(v7_2), true);
            dataView(memory0).setInt32(ptr0 + 68, toUint32(v7_3), true);
            dataView(memory0).setInt32(ptr0 + 72, toUint32(v7_4), true);
            dataView(memory0).setInt32(ptr0 + 76, toUint32(v7_5), true);
            dataView(memory0).setInt32(ptr0 + 80, toUint32(v7_6), true);
            dataView(memory0).setInt32(ptr0 + 84, toUint32(v7_7), true);
            dataView(memory0).setInt32(ptr0 + 88, toUint32(v7_8), true);
            dataView(memory0).setInt32(ptr0 + 92, toUint32(v7_9), true);
            dataView(memory0).setInt32(ptr0 + 96, toUint32(v7_10), true);
            dataView(memory0).setInt32(ptr0 + 100, toUint32(v7_11), true);
            _debugLog('[iface="esbt:document/engine@1.0.0", function="create"][Instruction::CallWasm] enter', {
              funcName: 'create',
              paramCount: 1,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100Create(ptr0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant11;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                var handle9 = dataView(memory0).getInt32(ret + 4, true);
                var rsc8 = new.target === Document ? this : Object.create(Document.prototype);
                Object.defineProperty(rsc8, symbolRscHandle, { writable: true, value: handle9});
                finalizationRegistry0.register(rsc8, handle9, rsc8);
                Object.defineProperty(rsc8, symbolDispose, { writable: true, value: function () {
                  finalizationRegistry0.unregister(rsc8);
                  const handleEntry = rscTableRemove(handleTable0, handle9);
                  rsc8[symbolDispose] = emptyFunc;
                  rsc8[symbolRscHandle] = undefined;
                  exports0['0'](handleEntry.rep);
                }});
                variant11= {
                  tag: 'ok',
                  val: rsc8
                };
                break;
              }
              case 1: {
                var ptr10 = dataView(memory0).getUint32(ret + 8, true);
                var len10 = dataView(memory0).getUint32(ret + 12, true);
                var result10 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr10, len10));
                variant11= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result10,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="create"][Instruction::Return]', {
              funcName: 'create',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant11;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    }
    let engine100WireVersion;

    function wireVersion() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100WireVersion',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (null!== null) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(() => null());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {

            _debugLog('[iface="esbt:document/engine@1.0.0", function="wire-version"][Instruction::CallWasm] enter', {
              funcName: 'wire-version',
              paramCount: 0,
              async: false,
              postReturn: false,
            });

            let ret;

            try {
              ret =  engine100WireVersion();
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="wire-version"][Instruction::Return]', {
              funcName: 'wire-version',
              paramCount: 1,
              async: false,
              postReturn: false
            });
            task.resolve([clampGuest(ret, 0, 65535)]);
            task.exit();
            return clampGuest(ret, 0, 65535);

          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    }
    let engine100EmptyVersion;

    function emptyVersion() {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100EmptyVersion',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {

            _debugLog('[iface="esbt:document/engine@1.0.0", function="empty-version"][Instruction::CallWasm] enter', {
              funcName: 'empty-version',
              paramCount: 0,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100EmptyVersion();
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            var ptr0 = dataView(memory0).getUint32(ret + 0, true);
            var len0 = dataView(memory0).getUint32(ret + 4, true);
            if (ptr0 % 1 !== 0) throw new TypeError(`list pointer [${ptr0}] is not aligned to 1`);
            var result0 = new Uint8Array(memory0.buffer.slice(ptr0, ptr0 + len0 * 1));
            _debugLog('[iface="esbt:document/engine@1.0.0", function="empty-version"][Instruction::Return]', {
              funcName: 'empty-version',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            task.resolve([result0]);
            const retCopy = result0;

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn1(ret);
            cstate.mayLeave = true;
            task.exit();
            return retCopy;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    }
    let engine100ClassifyArtifact;

    function classifyArtifact(arg0) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100ClassifyArtifact',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {

            var val0 = arg0;
            var len0 = Array.isArray(val0) ? val0.length : val0.byteLength;
            var ptr0 = realloc0(0, 0, 1, len0 * 1);

            let valData0;
            const valLenBytes0 = len0 * 1;
            if (Array.isArray(val0)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv0 = new DataView(memory0.buffer);
              for (const v of val0) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv0.setUint8(ptr0+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData0 = new Uint8Array(val0.buffer || val0, val0.byteOffset, valLenBytes0);
              const out0 = new Uint8Array(memory0.buffer, ptr0, valLenBytes0);
              out0.set(valData0);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="classify-artifact"][Instruction::CallWasm] enter', {
              funcName: 'classify-artifact',
              paramCount: 2,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100ClassifyArtifact(ptr0, len0);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant3;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                let enum1;
                switch (dataView(memory0).getUint8(ret + 4, true)) {
                  case 0: {
                    enum1 = 'update';
                    break;
                  }
                  case 1: {
                    enum1 = 'compact-snapshot';
                    break;
                  }
                  case 2: {
                    enum1 = 'full-snapshot';
                    break;
                  }
                  case 3: {
                    enum1 = 'version';
                    break;
                  }
                  case 4: {
                    enum1 = 'anchor';
                    break;
                  }
                  case 5: {
                    enum1 = 'causal-position';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for ArtifactKind');
                  }
                }
                variant3= {
                  tag: 'ok',
                  val: enum1
                };
                break;
              }
              case 1: {
                var ptr2 = dataView(memory0).getUint32(ret + 8, true);
                var len2 = dataView(memory0).getUint32(ret + 12, true);
                var result2 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr2, len2));
                variant3= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result2,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="classify-artifact"][Instruction::Return]', {
              funcName: 'classify-artifact',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant3;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    }
    let engine100VersionCovers;

    function versionCovers(arg0, arg1) {

      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();

      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: 'engine100VersionCovers',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'throw-result-err',
        callingWasmExport: true,
      });

      const started = task.enterSync();

      if (0!== null) {
        task.setReturnMemoryIdx(0);
        task.setReturnMemory(() => memory0());
      }


      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {

            var val0 = arg0;
            var len0 = Array.isArray(val0) ? val0.length : val0.byteLength;
            var ptr0 = realloc0(0, 0, 1, len0 * 1);

            let valData0;
            const valLenBytes0 = len0 * 1;
            if (Array.isArray(val0)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv0 = new DataView(memory0.buffer);
              for (const v of val0) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv0.setUint8(ptr0+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData0 = new Uint8Array(val0.buffer || val0, val0.byteOffset, valLenBytes0);
              const out0 = new Uint8Array(memory0.buffer, ptr0, valLenBytes0);
              out0.set(valData0);
            }

            var val1 = arg1;
            var len1 = Array.isArray(val1) ? val1.length : val1.byteLength;
            var ptr1 = realloc0(0, 0, 1, len1 * 1);

            let valData1;
            const valLenBytes1 = len1 * 1;
            if (Array.isArray(val1)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv1 = new DataView(memory0.buffer);
              for (const v of val1) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv1.setUint8(ptr1+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData1 = new Uint8Array(val1.buffer || val1, val1.byteOffset, valLenBytes1);
              const out1 = new Uint8Array(memory0.buffer, ptr1, valLenBytes1);
              out1.set(valData1);
            }

            _debugLog('[iface="esbt:document/engine@1.0.0", function="version-covers"][Instruction::CallWasm] enter', {
              funcName: 'version-covers',
              paramCount: 4,
              async: false,
              postReturn: true,
            });

            let ret;

            try {
              ret =  engine100VersionCovers(ptr0, len0, ptr1, len1);
            } catch (err) {

              _debugLog('[Instruction::CallWasm] error during sync call', {
                taskID: task.id(),
                err,
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;

            }

            let variant4;
            switch (dataView(memory0).getUint8(ret + 0, true)) {
              case 0: {
                var bool2 = dataView(memory0).getUint8(ret + 4, true);
                variant4= {
                  tag: 'ok',
                  val: bool2 == 0 ? false : (bool2 == 1 ? true : throwInvalidBool())
                };
                break;
              }
              case 1: {
                var ptr3 = dataView(memory0).getUint32(ret + 8, true);
                var len3 = dataView(memory0).getUint32(ret + 12, true);
                var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
                variant4= {
                  tag: 'err',
                  val: {
                    code: dataView(memory0).getInt32(ret + 4, true) >>> 0,
                    message: result3,
                  }
                };
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for expected');
              }
            }
            _debugLog('[iface="esbt:document/engine@1.0.0", function="version-covers"][Instruction::Return]', {
              funcName: 'version-covers',
              paramCount: 1,
              async: false,
              postReturn: true
            });
            const retCopy = variant4;
            task.resolve([retCopy.val]);

            let cstate = getOrCreateAsyncState(0);
            cstate.mayLeave = false;
            postReturn2(ret);
            cstate.mayLeave = true;
            task.exit();



            if (typeof retCopy === 'object' && retCopy.tag === 'err') {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;


          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
            throw err;
          }
        },
      });

    }
    const trampoline0 = rscTableCreateOwn.bind(null, handleTable0);
    function trampoline1(handle) {
      const handleEntry = rscTableRemove(handleTable0, handle);
      if (handleEntry.own) {

        exports0['0'](handleEntry.rep);
      }
    }
    Promise.all([module0, module1, module2]).catch(() => {});
    ({ exports: exports0 } = yield instantiateCore(yield module1));
    ({ exports: exports1 } = yield instantiateCore(yield module0, {
      '[export]esbt:document/engine@1.0.0': {
        '[resource-drop]document': _guardMayLeave(0, trampoline1),
        '[resource-new]document': _guardMayLeave(0, trampoline0),
      },
    }));
    ({ exports: exports2 } = yield instantiateCore(yield module2, {
      '': {
        $imports: exports0.$imports,
        '0': exports1['esbt:document/engine@1.0.0#[dtor]document'],
      },
    }));
    memory0 = exports1.memory;
    postReturn0 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.text'];

    try {
      postReturn0Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.text']);
    } catch(err) {
      postReturn0Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.text'];
    }

    postReturn1 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.history-floor'];

    try {
      postReturn1Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.history-floor']);
    } catch(err) {
      postReturn1Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.history-floor'];
    }

    postReturn2 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.abort-transaction'];

    try {
      postReturn2Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.abort-transaction']);
    } catch(err) {
      postReturn2Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.abort-transaction'];
    }

    postReturn3 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.commit-transaction'];

    try {
      postReturn3Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.commit-transaction']);
    } catch(err) {
      postReturn3Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.commit-transaction'];
    }

    realloc0 = exports1.cabi_realloc;

    try {
      realloc0Async = WebAssembly.promising(exports1.cabi_realloc);
    } catch(err) {
      realloc0Async = exports1.cabi_realloc;
    }

    postReturn4 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.insert-at-anchor'];

    try {
      postReturn4Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.insert-at-anchor']);
    } catch(err) {
      postReturn4Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.insert-at-anchor'];
    }

    postReturn5 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.apply-update'];

    try {
      postReturn5Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.apply-update']);
    } catch(err) {
      postReturn5Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.apply-update'];
    }

    postReturn6 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.anchor'];

    try {
      postReturn6Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.anchor']);
    } catch(err) {
      postReturn6Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.anchor'];
    }

    postReturn7 = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.apply-snapshot'];

    try {
      postReturn7Async = WebAssembly.promising(exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.apply-snapshot']);
    } catch(err) {
      postReturn7Async = exports1['cabi_post_esbt:document/engine@1.0.0#[method]document.apply-snapshot'];
    }

    engine100MethodDocumentSite = exports1['esbt:document/engine@1.0.0#[method]document.site'];
    engine100MethodDocumentLength = exports1['esbt:document/engine@1.0.0#[method]document.length'];
    engine100MethodDocumentText = exports1['esbt:document/engine@1.0.0#[method]document.text'];
    engine100MethodDocumentStateHash = exports1['esbt:document/engine@1.0.0#[method]document.state-hash'];
    engine100MethodDocumentPendingOperations = exports1['esbt:document/engine@1.0.0#[method]document.pending-operations'];
    engine100MethodDocumentRetainedOperations = exports1['esbt:document/engine@1.0.0#[method]document.retained-operations'];
    engine100MethodDocumentCurrentDmax = exports1['esbt:document/engine@1.0.0#[method]document.current-dmax'];
    engine100MethodDocumentVersion = exports1['esbt:document/engine@1.0.0#[method]document.version'];
    engine100MethodDocumentHistoryFloor = exports1['esbt:document/engine@1.0.0#[method]document.history-floor'];
    engine100MethodDocumentBeginTransaction = exports1['esbt:document/engine@1.0.0#[method]document.begin-transaction'];
    engine100MethodDocumentCommitTransaction = exports1['esbt:document/engine@1.0.0#[method]document.commit-transaction'];
    engine100MethodDocumentAbortTransaction = exports1['esbt:document/engine@1.0.0#[method]document.abort-transaction'];
    engine100MethodDocumentReplace = exports1['esbt:document/engine@1.0.0#[method]document.replace'];
    engine100MethodDocumentInsertAtAnchor = exports1['esbt:document/engine@1.0.0#[method]document.insert-at-anchor'];
    engine100MethodDocumentApplyUpdate = exports1['esbt:document/engine@1.0.0#[method]document.apply-update'];
    engine100MethodDocumentExportUpdate = exports1['esbt:document/engine@1.0.0#[method]document.export-update'];
    engine100MethodDocumentExportCompactSnapshot = exports1['esbt:document/engine@1.0.0#[method]document.export-compact-snapshot'];
    engine100MethodDocumentExportFullSnapshot = exports1['esbt:document/engine@1.0.0#[method]document.export-full-snapshot'];
    engine100MethodDocumentApplySnapshot = exports1['esbt:document/engine@1.0.0#[method]document.apply-snapshot'];
    engine100MethodDocumentAnchor = exports1['esbt:document/engine@1.0.0#[method]document.anchor'];
    engine100MethodDocumentResolveAnchor = exports1['esbt:document/engine@1.0.0#[method]document.resolve-anchor'];
    engine100MethodDocumentCaptureCausalPosition = exports1['esbt:document/engine@1.0.0#[method]document.capture-causal-position'];
    engine100MethodDocumentResolveCausalPosition = exports1['esbt:document/engine@1.0.0#[method]document.resolve-causal-position'];
    engine100MethodDocumentPruneHistoryThrough = exports1['esbt:document/engine@1.0.0#[method]document.prune-history-through'];
    engine100MethodDocumentCanUndo = exports1['esbt:document/engine@1.0.0#[method]document.can-undo'];
    engine100MethodDocumentCanRedo = exports1['esbt:document/engine@1.0.0#[method]document.can-redo'];
    engine100MethodDocumentUndo = exports1['esbt:document/engine@1.0.0#[method]document.undo'];
    engine100MethodDocumentRedo = exports1['esbt:document/engine@1.0.0#[method]document.redo'];
    engine100DefaultConfig = exports1['esbt:document/engine@1.0.0#default-config'];
    engine100DefaultAdaptiveDmaxConfig = exports1['esbt:document/engine@1.0.0#default-adaptive-dmax-config'];
    engine100Create = exports1['esbt:document/engine@1.0.0#create'];
    engine100WireVersion = exports1['esbt:document/engine@1.0.0#wire-version'];
    engine100EmptyVersion = exports1['esbt:document/engine@1.0.0#empty-version'];
    engine100ClassifyArtifact = exports1['esbt:document/engine@1.0.0#classify-artifact'];
    engine100VersionCovers = exports1['esbt:document/engine@1.0.0#version-covers'];
    const engine100 = {
      Document: Document,
      classifyArtifact: classifyArtifact,
      create: create,
      defaultAdaptiveDmaxConfig: defaultAdaptiveDmaxConfig,
      defaultConfig: defaultConfig,
      emptyVersion: emptyVersion,
      versionCovers: versionCovers,
      wireVersion: wireVersion,

    };

    return { engine: engine100, 'esbt:document/engine@1.0.0': engine100,  };
  })();
  let promise, resolve, reject;
  function runNext (value) {
    try {
      let done;
      do {
        ({ value, done } = gen.next(value));
      } while (!(value instanceof Promise) && !done);
      if (done) {
        if (resolve) return resolve(value);
        else return value;
      }
      if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
      value.then(nextVal => done ? resolve() : runNext(nextVal), reject);
    }
    catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
  const maybeSyncReturn = runNext(null);
  return promise || maybeSyncReturn;
};

export const _util = {

}
