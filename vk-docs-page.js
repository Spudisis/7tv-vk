// VK7TV — мост в MAIN world для добавления документа в черновик ВК.
//
// Пикер живёт в изолированном мире контент-скрипта и не видит store
// мессенджера. Здесь принимаются только две команды: узнать текущий
// редактор и добавить в его черновик уже существующий документ. Токен
// и произвольные запросы через мост не проходят.
//
// Точка интеграции подтверждена на живом ВК: store лежит в
// window.MECommonContext (Promise) или window.reforgedME.fcContext,
// а штатный путь добавления вложения — dispatch
// UserChangedComposerDraft с kind "addAttaches".

(() => {
  if (window.__vk7tvDocsBridgePage) return;
  window.__vk7tvDocsBridgePage = true;

  const IMAGE_TYPES = new Set(['s', 'm', 'x', 'o', 'p', 'q', 'r', 'y', 'z', 'w']);
  const MAX_TITLE = 2000;
  const AUTH_CLIENT_ID = '6287487';
  const AUTH_REFRESH_URL = 'https://login.vk.ru/?act=web_token';
  let authRefreshPromise = null;

  function positive(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = new URL(value, location.href);
      return u.protocol === 'https:' ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(null);
      }, ms);
      Promise.resolve(promise).then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(null);
        }
      );
    });
  }

  async function findStore() {
    let ctx = window.MECommonContext;
    if (ctx && typeof ctx.then === 'function') {
      ctx = await withTimeout(ctx, 1500);
    }
    let store = ctx && ctx.store;
    if (!store) {
      const fc = window.reforgedME && window.reforgedME.fcContext;
      store = fc && fc.store;
    }
    if (
      !store ||
      typeof store.getState !== 'function' ||
      typeof store.dispatch !== 'function'
    ) {
      return null;
    }
    return store;
  }

  function activePeerId() {
    const m = location.pathname.match(/\/im\/convo\/(-?\d+)(?:\/|$)/);
    if (m) return m[1];
    // Старый маршрут ВК; новый мессенджер использует /im/convo.
    const sel = new URL(location.href).searchParams.get('sel');
    return sel && /^-?\d+$/.test(sel) ? sel : '';
  }

  function editorPresent() {
    return !!document.querySelector(
      '.ConvoComposer [data-testid="vkme_composer_input"] [contenteditable="true"], ' +
        '.ConvoComposer .ConvoComposer__input[contenteditable="true"], ' +
        '.ConvoComposer [data-testid="vkme_composer_input"][contenteditable="true"]'
    );
  }

  function draftOf(state, peerId) {
    const list = state && state.composerDrafts && state.composerDrafts[peerId];
    if (!Array.isArray(list) || !list.length) return null;
    return list[list.length - 1] || null;
  }

  function hasDraft(map, peerId) {
    const list = map && map[peerId];
    return Array.isArray(list) && list.length > 0;
  }

  function docId(doc) {
    const owner = Number(doc && doc.ownerId);
    const id = Number(doc && doc.id);
    if (!Number.isSafeInteger(owner) || !Number.isSafeInteger(id) || id <= 0) return '';
    return `${owner}:${id}`;
  }

  function hasDoc(draft, key) {
    const docs = draft && draft.attaches && draft.attaches.docs;
    if (!Array.isArray(docs)) return false;
    return docs.some((doc) => {
      const k = docId({ ownerId: doc && doc.ownerId, id: doc && doc.id });
      return k && k === key;
    });
  }

  function contextInfo(store, state) {
    const peerId = activePeerId();
    if (!peerId) return { ok: false, reason: 'no-peer' };

    const draft = draftOf(state, peerId);
    // Пустой черновик может ещё не лежать в store: он появляется после
    // первого изменения. Это не повод отказывать — dispatch создаст его.
    if (draft && draft.editing) return { ok: false, reason: 'editing' };
    if (hasDraft(state.composerPostponedDrafts, peerId)) {
      return { ok: false, reason: 'unsupported' };
    }
    if (hasDraft(state.channelComposerDrafts, peerId)) {
      return { ok: false, reason: 'unsupported' };
    }
    if (!editorPresent()) return { ok: false, reason: 'no-editor' };

    return {
      ok: true,
      peerId,
      userId: positive(state.viewer && state.viewer.id),
      docs: (draft && draft.attaches && Array.isArray(draft.attaches.docs)
        ? draft.attaches.docs
        : []
      )
        .map((doc) => docId({ ownerId: doc && doc.ownerId, id: doc && doc.id }))
        .filter(Boolean),
    };
  }

  function parseDoc(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ownerId = Number(raw.ownerId);
    const id = Number(raw.id);
    if (!Number.isSafeInteger(ownerId) || !Number.isSafeInteger(id) || id <= 0) return null;

    const title =
      typeof raw.title === 'string' && raw.title ? raw.title.slice(0, MAX_TITLE) : '';
    if (!title) return null;

    const ext = typeof raw.ext === 'string' ? raw.ext.toLowerCase() : '';
    // MP4 VK принимает как документ (type 6) и штатный dispatch добавляет
    // его в черновик. Оригинал по doc.url не воспроизводится, но это не
    // мешает прикреплению.
    if (!['gif', 'webp', 'png', 'jpg', 'jpeg', 'mp4'].includes(ext)) return null;

    const url = safeUrl(raw.url);
    if (!url) return null;

    let type = typeof raw.type === 'string' ? raw.type : 'default';
    if (!['gif', 'image', 'video', 'default'].includes(type)) {
      type = ext === 'gif' ? 'gif' : ext === 'mp4' ? 'video' : 'image';
    }

    const image = new Map();
    if (Array.isArray(raw.previewSizes)) {
      for (const size of raw.previewSizes.slice(0, 50)) {
        if (!size || typeof size !== 'object') continue;
        if (typeof size.type !== 'string' || !IMAGE_TYPES.has(size.type)) continue;
        const src = safeUrl(size.url);
        const width = positive(size.width);
        const height = positive(size.height);
        if (!src || !width || !height) continue;
        image.set(size.type, { url: src, width, height });
      }
    }

    const accessKey =
      typeof raw.accessKey === 'string' && raw.accessKey.length <= 512
        ? raw.accessKey
        : '';

    return {
      kind: 'Doc',
      id,
      ownerId,
      accessKey: accessKey || undefined,
      title,
      size: positive(raw.size) || 0,
      ext,
      type,
      date: positive(raw.date) || 0,
      url,
      isUnsafe: false,
      ...(image.size ? { image } : {}),
    };
  }

  function waitForDoc(store, peerId, key) {
    const deadline = Date.now() + 800;
    return new Promise((resolve) => {
      const tick = () => {
        try {
          const draft = draftOf(store.getState(), peerId);
          if (hasDoc(draft, key)) return resolve(true);
        } catch (e) {
          return resolve(false);
        }
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  async function getContext() {
    const store = await findStore();
    if (!store) return { ok: false, reason: 'no-fastchat' };
    try {
      return contextInfo(store, store.getState());
    } catch (e) {
      return { ok: false, reason: 'no-fastchat' };
    }
  }

  async function attach(payload) {
    const expectedPeerId = String((payload && payload.expectedPeerId) || '');
    const expectedUserId = positive(payload && payload.expectedUserId);
    const doc = parseDoc(payload && payload.doc);
    if (!doc) return { ok: false, reason: 'bad-doc' };

    const store = await findStore();
    if (!store) return { ok: false, reason: 'no-fastchat' };

    let state;
    try {
      state = store.getState();
    } catch (e) {
      return { ok: false, reason: 'no-fastchat' };
    }

    const info = contextInfo(store, state);
    if (!info.ok) return info;
    if (expectedPeerId && info.peerId !== expectedPeerId) {
      return { ok: false, reason: 'stale-context' };
    }
    if (expectedUserId && info.userId && info.userId !== expectedUserId) {
      return { ok: false, reason: 'stale-context' };
    }

    const peerId = Number(info.peerId);
    const draft = draftOf(state, info.peerId);
    const key = docId(doc);
    if (hasDoc(draft, key)) return { ok: true, status: 'already' };

    try {
      store.dispatch.call(store, {
        type: 'UserChangedComposerDraft',
        kind: 'addAttaches',
        attaches: { docs: [doc] },
        peerId,
        isPostponed: false,
      });
    } catch (e) {
      return { ok: false, reason: 'dispatch' };
    }

    // Редактор мог не принять вложение (лимит, пересоздание и т.п.):
    // успехом считаем только фактическое появление документа в черновике.
    const added = await waitForDoc(store, info.peerId, key);
    return added
      ? { ok: true, status: 'added' }
      : { ok: false, reason: 'not-added' };
  }

  // Единственная разрешённая сетевая операция моста: обновление web-токена
  // штатной страницей VK. Ни URL, ни тело запроса вызывающая сторона задать
  // не может. Новый токен не пишем в localStorage: страница VK остаётся
  // хозяином своей записи, а расширение использует его только в памяти.
  function refreshAuth() {
    if (authRefreshPromise) return authRefreshPromise;
    authRefreshPromise = (async () => {
      let res;
      try {
        res = await fetch(AUTH_REFRESH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body: `version=1&app_id=${AUTH_CLIENT_ID}`,
          credentials: 'include',
          cache: 'no-store',
        });
      } catch (e) {
        return { ok: false, reason: 'network' };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: res.status === 401 || res.status === 403 ? 'auth' : 'http',
          httpStatus: res.status,
        };
      }
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        return { ok: false, reason: 'response', httpStatus: res.status };
      }
      const payload = data && data.type === 'okay' && data.data ? data.data : null;
      if (!payload) return { ok: false, reason: 'response', httpStatus: res.status };
      const token =
        typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
      const userId = positive(payload.user_id);
      const expires = Number(payload.expires) || 0;
      if (!token || token.length > 4096 || !userId) {
        return { ok: false, reason: 'response', httpStatus: res.status };
      }
      return { ok: true, token, userId, expires, httpStatus: res.status };
    })().finally(() => {
      authRefreshPromise = null;
    });
    return authRefreshPromise;
  }

  function reply(id, result) {
    try {
      window.postMessage(
        { __vk7tvDocsBridge: 1, to: 'extension', id, result },
        location.origin
      );
    } catch (e) {
      // окно закрывается — отвечать уже некому
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.origin !== location.origin) return;
    const data = e.data;
    if (!data || data.__vk7tvDocsBridge !== 1 || data.to !== 'page') return;
    if (typeof data.id !== 'string' || data.id.length > 80) return;
    if (
      data.type !== 'get-context' &&
      data.type !== 'attach-doc' &&
      data.type !== 'refresh-auth'
    ) {
      return;
    }

    const job =
      data.type === 'get-context'
        ? getContext()
        : data.type === 'attach-doc'
          ? attach(data.payload)
          : refreshAuth();
    Promise.resolve(job)
      .then((result) => reply(data.id, result))
      .catch(() => reply(data.id, { ok: false, reason: 'error' }));
  });
})();
