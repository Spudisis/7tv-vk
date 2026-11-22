// Run only the 5-second auth waits on a controllable clock. Other timers stay real.
(() => {
  const nativeTimeout = window.setTimeout.bind(window);
  const clock = window.VK7TV_AUTH_CLOCK = { delays: [], beforeTick: null, hold: false, pending: [] };
  window.setTimeout = (fn, ms, ...args) => {
    if (ms !== 5000) return nativeTimeout(fn, ms, ...args);
    clock.delays.push(ms);
    const tick = () => {
      if (clock.beforeTick) clock.beforeTick();
      fn(...args);
    };
    return nativeTimeout(() => {
      if (clock.hold) clock.pending.push(tick);
      else tick();
    }, 0);
  };
  clock.flush = () => { for (const tick of clock.pending.splice(0)) tick(); };
})();
