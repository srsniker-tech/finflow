/* FinFlow — app.js (sem libs, offline-first, mobile-first)
   Arquitetura: utils, storage (IndexedDB + fallback), store (pub/sub), domain, ui, charts
*/

(() => {
  "use strict";

  // =========================
  // Utils
  // =========================
  const Utils = (() => {
    const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
    const uid = (prefix = "id") =>
      `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    const pad2 = (n) => String(n).padStart(2, "0");

    const nowISO = () => {
      const d = new Date();
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

    const parseISO = (s) => {
      const d = new Date(s);
      return isNaN(d.getTime()) ? new Date() : d;
    };

    const startOfMonth = (d, monthStartDay = 1) => {
      const date = new Date(d);
      const y = date.getFullYear();
      const m = date.getMonth();
      const start = new Date(y, m, monthStartDay, 0, 0, 0, 0);
      // Se hoje é antes do "início do mês" customizado, volta pro mês anterior
      if (date < start) {
        const prev = new Date(y, m - 1, monthStartDay, 0, 0, 0, 0);
        return prev;
      }
      return start;
    };

    const endOfMonthWindow = (d, monthStartDay = 1) => {
      const s = startOfMonth(d, monthStartDay);
      const e = new Date(s);
      e.setMonth(e.getMonth() + 1);
      return e;
    };

    const toBRL = (value, currency = "BRL") => {
      const v = Number(value) || 0;
      return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(v);
    };

    const parseMoneyBR = (s) => {
      if (typeof s !== "string") return NaN;
      const cleaned = s
        .replace(/\s/g, "")
        .replace(/[R$\u00A0]/g, "")
        .replace(/\./g, "")
        .replace(",", ".");
      const n = Number(cleaned);
      return isFinite(n) ? n : NaN;
    };

    const escapeHTML = (str) =>
      String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    const debounce = (fn, wait = 200) => {
      let t = null;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
      };
    };

    return {
      clamp,
      uid,
      nowISO,
      parseISO,
      startOfMonth,
      endOfMonthWindow,
      toBRL,
      parseMoneyBR,
      escapeHTML,
      debounce,
    };
  })();

  // =========================
  // Storage (IndexedDB + fallback localStorage)
  // =========================
  const Storage = (() => {
    const DB_NAME = "finflow_db";
    const DB_VERSION = 1;

    const stores = {
      meta: "meta",            // { key, value }
      accounts: "accounts",    // { id, name, type, color, icon, initialBalance, balance, createdAt }
      transactions: "transactions", // { id, type, amount, datetime, accountFrom, accountTo, categoryId, note, tags, splits, attachmentId, createdAt, updatedAt }
      categories: "categories", // { id, name, color, icon, kind } kind: income|expense|both
      budgets: "budgets",       // { id, monthKey, categoryId, limit }
      goals: "goals",           // { id, name, target, deadline, saved, createdAt }
      boxes: "boxes",           // { id, accountId, name, saved, color, createdAt }
      rules: "rules",           // { id, contains, categoryId, priority, enabled }
      attachments: "attachments"// { id, mime, blob }
    };

    let idbOk = true;
    let dbPromise = null;

    function openDB() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
          idbOk = false;
          reject(new Error("IndexedDB não disponível"));
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (ev) => {
          const db = req.result;

          const ensure = (name, opts) => {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
          };

          ensure(stores.meta, { keyPath: "key" });
          ensure(stores.accounts, { keyPath: "id" });
          ensure(stores.transactions, { keyPath: "id" });
          ensure(stores.categories, { keyPath: "id" });
          ensure(stores.budgets, { keyPath: "id" });
          ensure(stores.goals, { keyPath: "id" });
          ensure(stores.boxes, { keyPath: "id" });
          ensure(stores.rules, { keyPath: "id" });
          ensure(stores.attachments, { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          idbOk = false;
          reject(req.error || new Error("Falha ao abrir IndexedDB"));
        };
      });
      return dbPromise;
    }

    function withTx(storeName, mode, fn) {
      return openDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const res = fn(store, tx);
        tx.oncomplete = () => resolve(res);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transação abortada"));
      }));
    }

    // Fallback localStorage (muito simples)
    const LS = {
      key: (k) => `finflow_${k}`,
      getAll: (storeName) => {
        const raw = localStorage.getItem(LS.key(storeName));
        if (!raw) return [];
        try {
          const v = JSON.parse(raw);
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      },
      setAll: (storeName, arr) => {
        localStorage.setItem(LS.key(storeName), JSON.stringify(arr));
      },
      getMeta: (key) => {
        const raw = localStorage.getItem(LS.key(`meta_${key}`));
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
      },
      setMeta: (key, value) => {
        localStorage.setItem(LS.key(`meta_${key}`), JSON.stringify(value));
      }
    };

    async function getMeta(key) {
      if (!idbOk) return LS.getMeta(key);
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(stores.meta, "readonly");
          const st = tx.objectStore(stores.meta);
          const req = st.get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => reject(req.error);
        });
      } catch {
        idbOk = false;
        return LS.getMeta(key);
      }
    }

    async function setMeta(key, value) {
      if (!idbOk) return LS.setMeta(key, value);
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(stores.meta, "readwrite");
          const st = tx.objectStore(stores.meta);
          const req = st.put({ key, value });
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      } catch {
        idbOk = false;
        return LS.setMeta(key, value);
      }
    }

    async function getAll(storeName) {
      if (!idbOk) return LS.getAll(storeName);
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const st = tx.objectStore(storeName);
          const req = st.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      } catch {
        idbOk = false;
        return LS.getAll(storeName);
      }
    }

    async function put(storeName, obj) {
      if (!idbOk) {
        const all = LS.getAll(storeName);
        const idx = all.findIndex((x) => x.id === obj.id || x.key === obj.key);
        if (idx >= 0) all[idx] = obj; else all.push(obj);
        LS.setAll(storeName, all);
        return obj;
      }
      try {
        await withTx(storeName, "readwrite", (st) => st.put(obj));
        return obj;
      } catch {
        idbOk = false;
        return put(storeName, obj);
      }
    }

    async function remove(storeName, id) {
      if (!idbOk) {
        const all = LS.getAll(storeName).filter((x) => x.id !== id);
        LS.setAll(storeName, all);
        return true;
      }
      try {
        await withTx(storeName, "readwrite", (st) => st.delete(id));
        return true;
      } catch {
        idbOk = false;
        return remove(storeName, id);
      }
    }

    async function clearAll() {
      if (!idbOk) {
        Object.values(stores).forEach((s) => {
          if (s === stores.meta) return;
          localStorage.removeItem(LS.key(s));
        });
        // meta keys
        Object.keys(localStorage).forEach((k) => {
          if (k.startsWith("finflow_meta_")) localStorage.removeItem(k);
        });
        return true;
      }
      const db = await openDB();
      await Promise.all(Object.values(stores).map((name) => new Promise((resolve, reject) => {
        const tx = db.transaction(name, "readwrite");
        const st = tx.objectStore(name);
        const req = st.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      })));
      return true;
    }

    // Blob attachments
    async function putAttachment(mime, blob) {
      const id = Utils.uid("att");
      await put(stores.attachments, { id, mime, blob });
      return id;
    }

    async function getAttachment(id) {
      if (!id) return null;
      if (!idbOk) return null; // localStorage não comporta Blob com segurança
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(stores.attachments, "readonly");
          const st = tx.objectStore(stores.attachments);
          const req = st.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return null;
      }
    }

    return {
      stores,
      openDB,
      getMeta,
      setMeta,
      getAll,
      put,
      remove,
      clearAll,
      putAttachment,
      getAttachment,
      status: () => ({ idbOk }),
    };
  })();

  // =========================
  // Store (estado central + pub/sub)
  // =========================
  const Store = (() => {
    const listeners = new Map();
    const state = {
      ready: false,
      settings: {
        currency: "BRL",
        monthStartDay: 1,
        theme: "system", // system | dark | light
        reduceMotion: false,
        pinHash: null, // hash simples (não criptografia forte; é proteção local)
      },
      data: {
        accounts: [],
        transactions: [],
        categories: [],
        budgets: [],
        goals: [],
        boxes: [],
        rules: [],
      },
      ui: {
        screen: "dashboard",
        filters: {
          q: "",
          types: new Set(), // income, expense, transfer, card
          monthOnly: true,
        }
      },
      undo: null, // { label, doUndo: fn, expiresAt }
    };

    function emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      set.forEach((fn) => {
        try { fn(payload); } catch (e) { console.error(e); }
      });
    }

    function on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    }

    function set(partial) {
      Object.assign(state, partial);
      emit("state", state);
    }

    function patch(path, value) {
      // path ex: "settings.theme"
      const keys = path.split(".");
      let cur = state;
      for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
      cur[keys[keys.length - 1]] = value;
      emit("state", state);
    }

    return { state, on, emit, set, patch };
  })();

  // =========================
  // Domain (regras, validação, cálculos)
  // =========================
  const Domain = (() => {
    const DEFAULT_CATEGORIES = [
      { id: "cat_salary", name: "Salário", color: "#38bdf8", icon: "💼", kind: "income" },
      { id: "cat_sales", name: "Vendas", color: "#22c55e", icon: "🧾", kind: "income" },
      { id: "cat_food", name: "Alimentação", color: "#f59e0b", icon: "🍽️", kind: "expense" },
      { id: "cat_rent", name: "Moradia", color: "#a78bfa", icon: "🏠", kind: "expense" },
      { id: "cat_transport", name: "Transporte", color: "#60a5fa", icon: "🚌", kind: "expense" },
      { id: "cat_health", name: "Saúde", color: "#fb7185", icon: "🩺", kind: "expense" },
      { id: "cat_leisure", name: "Lazer", color: "#34d399", icon: "🎮", kind: "expense" },
      { id: "cat_bills", name: "Contas", color: "#f97316", icon: "🧾", kind: "expense" },
      { id: "cat_other", name: "Outros", color: "#94a3b8", icon: "•", kind: "both" },
    ];

    function normalizeTags(raw) {
      if (!raw) return [];
      return raw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);
    }

    function validateAccount(payload) {
      const name = String(payload.name || "").trim();
      if (name.length < 2) return { ok: false, msg: "Nome da conta é obrigatório." };
      const type = payload.type;
      if (!["wallet", "bank", "investment", "card"].includes(type)) return { ok: false, msg: "Tipo de conta inválido." };
      const initial = Number(payload.initialBalance);
      if (!isFinite(initial)) return { ok: false, msg: "Saldo inicial inválido." };
      return { ok: true };
    }

    function validateTx(tx) {
      const type = tx.type;
      if (!["income", "expense", "transfer", "card"].includes(type)) return { ok: false, msg: "Tipo de transação inválido." };

      const amount = Number(tx.amount);
      if (!isFinite(amount) || amount <= 0) return { ok: false, msg: "Valor precisa ser maior que zero." };

      const dt = new Date(tx.datetime);
      if (isNaN(dt.getTime())) return { ok: false, msg: "Data/hora inválida." };

      if (type === "income" || type === "expense") {
        if (!tx.accountFrom) return { ok: false, msg: "Selecione a conta." };
      }

      if (type === "transfer") {
        if (!tx.accountFrom || !tx.accountTo) return { ok: false, msg: "Selecione origem e destino." };
        if (tx.accountFrom === tx.accountTo) return { ok: false, msg: "Origem e destino não podem ser iguais." };
      }

      if (type === "card") {
        if (!tx.accountFrom) return { ok: false, msg: "Selecione o cartão." };
      }

      if (!tx.categoryId) return { ok: false, msg: "Categoria é obrigatória." };

      return { ok: true };
    }

    function monthKey(d, monthStartDay = 1) {
      const s = Utils.startOfMonth(d, monthStartDay);
      return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}`;
    }

    function applyRulesToTx(tx, rules) {
      if (!tx.note) return tx;
      const note = String(tx.note).toLowerCase();
      const ordered = [...rules].filter(r => r.enabled !== false).sort((a, b) => (b.priority || 0) - (a.priority || 0));
      for (const r of ordered) {
        if (!r.contains) continue;
        if (note.includes(String(r.contains).toLowerCase())) {
          return { ...tx, categoryId: r.categoryId };
        }
      }
      return tx;
    }

    function recalcBalances(accounts, transactions) {
      const map = new Map(accounts.map(a => [a.id, { ...a, balance: Number(a.initialBalance) || 0, cardBill: 0 }]));
      const sorted = [...transactions].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
      for (const t of sorted) {
        const amt = Number(t.amount) || 0;
        if (t.type === "income") {
          const acc = map.get(t.accountFrom);
          if (acc) acc.balance += amt;
        } else if (t.type === "expense") {
          const acc = map.get(t.accountFrom);
          if (acc) acc.balance -= amt;
        } else if (t.type === "transfer") {
          const from = map.get(t.accountFrom);
          const to = map.get(t.accountTo);
          if (from) from.balance -= amt;
          if (to) to.balance += amt;
        } else if (t.type === "card") {
          const card = map.get(t.accountFrom);
          if (card) card.cardBill += amt;
        }
      }
      // para cartões, mostramos "saldo" como disponível (initial + entradas/saídas) e fatura separada
      return [...map.values()];
    }

    return {
      DEFAULT_CATEGORIES,
      normalizeTags,
      validateAccount,
      validateTx,
      monthKey,
      applyRulesToTx,
      recalcBalances
    };
  })();

  // =========================
  // Charts (Canvas API)
  // =========================
  const Charts = (() => {
    function clear(canvas) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function drawDonut(canvas, items, totalLabel) {
      // items: [{label, value, color}]
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      clear(canvas);

      const cx = w / 2, cy = h / 2 + 6;
      const r = Math.min(w, h) * 0.34;
      const r2 = r * 0.62;

      const total = items.reduce((s, it) => s + it.value, 0);
      const start = -Math.PI / 2;

      // fundo
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = r - r2;
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (total <= 0) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#999";
        ctx.font = "600 12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Sem dados", cx, cy);
        return;
      }

      let ang = start;
      items.forEach((it) => {
        const slice = (it.value / total) * (Math.PI * 2);
        ctx.beginPath();
        ctx.arc(cx, cy, r, ang, ang + slice);
        ctx.strokeStyle = it.color || "#7c5cff";
        ctx.lineWidth = r - r2;
        ctx.lineCap = "round";
        ctx.stroke();
        ang += slice;
      });

      // centro
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#fff";
      ctx.font = "800 16px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(totalLabel || "Total", cx, cy - 6);
      ctx.font = "800 18px system-ui";
      ctx.fillText(Utils.toBRL(total, Store.state.settings.currency), cx, cy + 18);
    }

    function drawLine(canvas, points, labelLeft, labelRight) {
      // points: [{x:0..n-1, y:number}]
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      clear(canvas);

      const padding = 22;
      const innerW = w - padding * 2;
      const innerH = h - padding * 2;

      if (!points || points.length < 2) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#999";
        ctx.font = "600 12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Sem dados", w / 2, h / 2);
        return;
      }

      const ys = points.map(p => p.y);
      let minY = Math.min(...ys);
      let maxY = Math.max(...ys);
      if (minY === maxY) { minY -= 1; maxY += 1; }

      const toX = (i) => padding + (i / (points.length - 1)) * innerW;
      const toY = (y) => padding + (1 - (y - minY) / (maxY - minY)) * innerH;

      // grade leve
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {
        const y = padding + (i / 3) * innerH;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(w - padding, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // linha
      ctx.lineWidth = 3;
      ctx.lineJoin = "round"
      ctx.lineCap = "round";
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--primary-2").trim() || "#38bdf8";

      ctx.beginPath();
      ctx.moveTo(toX(0), toY(points[0].y));
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(toX(i), toY(points[i].y));
      }
      ctx.stroke();

      // labels
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#aab1c5";
      ctx.font = "700 12px system-ui";
      ctx.textAlign = "left";
      ctx.fillText(labelLeft || Utils.toBRL(minY, Store.state.settings.currency), padding, 14);
      ctx.textAlign = "right";
      ctx.fillText(labelRight || Utils.toBRL(maxY, Store.state.settings.currency), w - padding, 14);
    }

    function drawBars(canvas, bars) {
      // bars: [{label, value, color}]
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      clear(canvas);

      const padding = 22;
      const innerW = w - padding * 2;
      const innerH = h - padding * 2;

      if (!bars || bars.length === 0) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#999";
        ctx.font = "600 12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Sem dados", w / 2, h / 2);
        return;
      }

      const maxV = Math.max(...bars.map(b => b.value), 1);
      const gap = 10;
      const bw = (innerW - gap * (bars.length - 1)) / bars.length;

      bars.forEach((b, i) => {
        const x = padding + i * (bw + gap);
        const hh = (b.value / maxV) * innerH;
        const y = padding + (innerH - hh);

        ctx.fillStyle = b.color || getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#7c5cff";
        ctx.globalAlpha = 0.9;
        roundRect(ctx, x, y, bw, hh, 10);
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#aab1c5";
        ctx.font = "700 11px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(b.label, x + bw / 2, h - 8);
      });
    }

    function roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    return { drawDonut, drawLine, drawBars };
  })();
  
  // =========================
  // UI Helpers: modal, toast, focus, navigation
  // =========================
  const UI = (() => {
    const el = (id) => document.getElementById(id);

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const modal = el("modal");
    const modalBackdrop = el("modalBackdrop");
    const modalTitle = el("modalTitle");
    const modalBody = el("modalBody");
    const modalFooter = el("modalFooter");

    function setSubtitle(text) {
      const s = el("subtitle");
      if (s) s.textContent = text;
    }

    function toast(message, opts = {}) {
      const stack = el("toasts");
      const node = document.createElement("div");
      node.className = `toast ${opts.kind || ""}`.trim();
      node.role = "status";
      node.innerHTML = `
        <div class="toast__msg">${Utils.escapeHTML(message)}</div>
        ${opts.action ? `<button class="toast__btn" type="button">${Utils.escapeHTML(opts.action.label)}</button>` : ""}
      `;
      stack.appendChild(node);

      const btn = node.querySelector(".toast__btn");
      if (btn && opts.action?.onClick) btn.addEventListener("click", () => opts.action.onClick());

      const ttl = typeof opts.ttl === "number" ? opts.ttl : 3800;
      const t = setTimeout(() => {
        node.classList.add("is-leaving");
        setTimeout(() => node.remove(), 220);
      }, ttl);

      node.addEventListener("click", () => {
        clearTimeout(t);
        node.classList.add("is-leaving");
        setTimeout(() => node.remove(), 220);
      });
    }

    function openModal({ title, bodyHTML, footerHTML, onOpen } = {}) {
      modalTitle.textContent = title || "Janela";
      modalBody.innerHTML = bodyHTML || "";
      modalFooter.innerHTML = footerHTML || "";

      modalBackdrop.hidden = false;
      modal.showModal();

      // close on backdrop click
      modalBackdrop.onclick = () => closeModal();
if (typeof onOpen === "function") onOpen(modal);
    }

    function closeModal() {
      try { modal.close(); } catch {}
      modalBackdrop.hidden = true;
      modalBackdrop.onclick = null;
    }

    function switchScreen(name) {
      Store.patch("ui.screen", name);
      $$(".screen").forEach((s) => s.classList.toggle("is-active", s.dataset.screen === name));
      $$(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.go === name));
      // acessibilidade
      const main = el("appMain");
      main.focus({ preventScroll: true });
    }

    function bindNavigation() {
      $$(".nav-item").forEach((btn) => {
        btn.addEventListener("click", () => switchScreen(btn.dataset.go));
      });
    }

    function setTheme(themeSetting) {
      // themeSetting: system|dark|light
      const root = document.documentElement;
      const systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      let applied = themeSetting;
      if (themeSetting === "system") applied = systemDark ? "dark" : "light";
      root.dataset.theme = applied;

      const icon = el("themeIcon");
      if (icon) icon.textContent = applied === "dark" ? "◐" : "◑";
    }

    function applyReduceMotion(enabled) {
      document.documentElement.dataset.reduceMotion = enabled ? "1" : "0";
    }

    function bindShortcuts() {
      document.addEventListener("keydown", (e) => {
        // não roubar teclas em inputs
        const tag = (e.target && e.target.tagName) || "";
        const inField = tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable;

        if (!inField && e.key === "n" || (!inField && e.key === "N")) {
          e.preventDefault();
          Actions.openTxModal();
        }
        if (!inField && e.key === "/") {
          e.preventDefault();
          Actions.openSearch();
        }
        if (e.key === "Escape" && modal.open) {
          e.preventDefault();
          closeModal();
        }
      });
    }

    return {
      el, $, $$,
      setSubtitle,
      toast,
      openModal,
      closeModal,
      switchScreen,
      bindNavigation,
      setTheme,
      applyReduceMotion,
      bindShortcuts
    };
  })();

  // CSS extra (toasts + modal polish) injetado aqui pra você não precisar editar styles agora
  const injectExtraCSS = () => {
    const css = `
      .toast-stack{
        position: fixed;
        left: 10px;
        right: 10px;
        bottom: calc(74px + env(safe-area-inset-bottom) + 10px);
        display: grid;
        gap: 10px;
        z-index: 50;
        pointer-events: none;
      }
      .toast{
        pointer-events: auto;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 12px 12px;
        box-shadow: var(--shadow);
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        animation: toastIn .16s ease;
      }
      @keyframes toastIn{ from{ transform: translateY(8px); opacity: 0 } to{ transform: translateY(0); opacity: 1 } }
      .toast.is-leaving{ animation: toastOut .18s ease forwards; }
      @keyframes toastOut{ to{ transform: translateY(8px); opacity: 0 } }
      .toast__msg{ font-weight: 650; font-size: 13px; color: var(--text); }
      .toast__btn{
        border: 1px solid var(--border);
        background: rgba(255,255,255,.03);
        color: var(--primary-2);
        border-radius: 12px;
        padding: 10px 12px;
        font-weight: 800;
        min-height: 40px;
      }

      .modal-backdrop{
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.55);
        z-index: 60;
      }
      dialog.modal{
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 0;
        width: min(520px, calc(100vw - 24px));
        background: var(--panel);
        color: var(--text);
        box-shadow: var(--shadow);
        z-index: 61;
      }
      dialog::backdrop{ background: transparent; }
      .modal__inner{ margin: 0; padding: 0; }
      .modal__header{
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 14px 14px 10px;
        border-bottom: 1px solid var(--border);
      }
      .modal__title{ margin: 0; font-size: 15px; }
      .modal__body{ padding: 12px 14px; display: grid; gap: 10px; }
      .modal__footer{ padding: 10px 14px 14px; display: flex; gap: 10px; justify-content: flex-end; }

      .field{ display: grid; gap: 6px; }
      .field label{ font-size: 12px; color: var(--muted); font-weight: 700; }
      .field input, .field select, .field textarea{
        border: 1px solid var(--border);
        background: rgba(255,255,255,.02);
        color: var(--text);
        border-radius: 14px;
        padding: 12px 12px;
        font-size: 14px;
        outline: none;
      }
      .field textarea{ min-height: 84px; resize: vertical; }
      .row{ display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .switch{
        display: inline-flex;
        align-items: center;
      }
      .switch input{ display:none; }
      .switch__ui{
        width: 52px;
        height: 30px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.04);
        position: relative;
      }
      .switch__ui:before{
        content:"";
        position: absolute;
        width: 24px;
        height: 24px;
        left: 3px;
        top: 2px;
        border-radius: 999px;
        background: var(--text);
        opacity: .9;
        transition: transform .16s ease;
      }
      .switch input:checked + .switch__ui:before{ transform: translateX(22px); }

      .bottom-nav{
        position: fixed;
        left: 0; right: 0; bottom: 0;
        height: calc(var(--navH) + env(safe-area-inset-bottom));
        padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
        background: var(--panel);
        border-top: 1px solid var(--border);
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 6px;
        z-index: 20;
      }
      .nav-item{
        border: 1px solid transparent;
        background: transparent;
        color: var(--muted);
        border-radius: 18px;
        display: grid;
        place-items: center;
        gap: 2px;
        padding: 6px 4px;
        min-height: 54px;
      }
      .nav-item.is-active{
        border-color: color-mix(in srgb, var(--primary) 35%, var(--border));
        color: var(--text);
        background: rgba(255,255,255,.03);
      }
      .nav-icon{ font-size: 18px; line-height: 1; }
      .nav-label{ font-size: 11px; font-weight: 800; letter-spacing: .1px; }

      .fab{
        position: fixed;
        right: 16px;
        bottom: calc(var(--navH) + env(safe-area-inset-bottom) + 16px);
        width: 56px;
        height: 56px;
        border-radius: 18px;
        border: none;
        color: #fff;
        font-size: 26px;
        font-weight: 900;
        background: linear-gradient(135deg, color-mix(in srgb, var(--primary) 85%, #000), color-mix(in srgb, var(--primary-2) 65%, #000));
        box-shadow: var(--shadow);
      }

      .tx-day{
        padding: 10px 12px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.02);
      }
      .tx-day__hdr{
        display:flex; justify-content: space-between; align-items:center; gap:10px;
        color: var(--muted);
        font-weight: 800;
        font-size: 12px;
        margin-bottom: 8px;
      }
      .tx{
        display:flex; justify-content: space-between; align-items:center; gap:10px;
        padding: 10px 10px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.02);
        margin-bottom: 8px;
      }
      .tx:last-child{ margin-bottom: 0; }
      .tx__left{ display:grid; gap:2px; min-width: 0; }
      .tx__title{ font-weight: 850; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tx__meta{ font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tx__amt{ font-weight: 900; font-size: 13px; }
      .amt-income{ color: #22c55e; }
      .amt-expense{ color: #fb7185; }
      .amt-transfer{ color: var(--primary-2); }
      .amt-card{ color: #f59e0b; }

      .account{
        display:flex; justify-content: space-between; align-items:center; gap:10px;
        padding: 10px 10px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.02);
        margin-bottom: 8px;
      }
      .account__left{ display:flex; align-items:center; gap:10px; min-width:0; }
      .badge{
        width: 38px; height: 38px; border-radius: 14px;
        display:grid; place-items:center;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.02);
        font-weight: 900;
      }
      .account__name{ font-weight: 900; font-size: 13px; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
      .account__sub{ color: var(--muted); font-size: 12px; }
      .account__right{ text-align:right; display:grid; gap:2px; }
      .account__bal{ font-weight: 950; font-size: 13px; }
      .account__bill{ color: var(--muted); font-size: 12px; }

      .focus-ring:focus, button:focus, input:focus, select:focus, textarea:focus{
        outline: 3px solid rgba(124,92,255,.22);
        outline-offset: 2px;
      }

      [data-reduce-motion="1"] *{
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    `;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  };

  // =========================
  // Actions (eventos do app)
  // =========================
  const Actions = (() => {
    async function initApp() {
      injectExtraCSS();

      // 1) carregar settings
      const settings = (await Storage.getMeta("settings")) || null;
      if (settings && typeof settings === "object") {
        Store.state.settings = { ...Store.state.settings, ...settings };
      } else {
        // respeitar prefers-color-scheme na primeira vez
        Store.state.settings.theme = "system";
      }
// 2) carregar dados
      const [accounts, transactions, categories, budgets, goals, boxes, rules] = await Promise.all([
        Storage.getAll(Storage.stores.accounts),
        Storage.getAll(Storage.stores.transactions),
        Storage.getAll(Storage.stores.categories),
        Storage.getAll(Storage.stores.budgets),
        Storage.getAll(Storage.stores.goals),
        Storage.getAll(Storage.stores.boxes),
        Storage.getAll(Storage.stores.rules),
      ]);

      // 3) seed categorias se vazio
      let cats = categories;
      if (!cats || cats.length === 0) {
        cats = Domain.DEFAULT_CATEGORIES.map(c => ({ ...c }));
        for (const c of cats) await Storage.put(Storage.stores.categories, c);
      }

      // 4) aplicar regras simples em novos lançamentos (não retroativo aqui; teremos botão depois)
      // 5) recalcular saldos
      const recalc = Domain.recalcBalances(accounts || [], transactions || []);
      // persistir balances recalculados para consistência
      for (const a of recalc) await Storage.put(Storage.stores.accounts, a);

      Store.state.data = {
        accounts: recalc,
        transactions: transactions || [],
        categories: cats,
        budgets: budgets || [],
        goals: goals || [],
        boxes: boxes || [],
        rules: rules || [],
      };

      Store.state.ready = true;
      await Storage.setMeta("settings", Store.state.settings);

      // UI initial
      UI.setTheme(Store.state.settings.theme);
      UI.applyReduceMotion(!!Store.state.settings.reduceMotion);
      const reduceMotion = UI.el("reduceMotion");
      if (reduceMotion) reduceMotion.checked = !!Store.state.settings.reduceMotion;

      bindUI();
      renderAll();

      // Onboarding real se não tiver contas
      if ((Store.state.data.accounts || []).length === 0) {
        openOnboarding();
      }

      // Service worker (se rodando via http/https)
      registerSW();

      UI.toast(Storage.status().idbOk ? "Armazenamento: IndexedDB ativo" : "Armazenamento: fallback local ativo");
    }

    function bindUI() {
      UI.bindNavigation();
      UI.bindShortcuts();

      UI.el("btnTheme")?.addEventListener("click", toggleTheme);
      UI.el("btnTheme2")?.addEventListener("click", toggleTheme);

      UI.el("btnNewAccount")?.addEventListener("click", openAccountModal);
      UI.el("btnManageAccounts")?.addEventListener("click", openAccountsManager);

      UI.el("btnNewTx")?.addEventListener("click", openTxModal);
      UI.el("fabNewTx")?.addEventListener("click", openTxModal);

      UI.el("btnSearch")?.addEventListener("click", openSearch);
      UI.el("btnClearSearch")?.addEventListener("click", () => {
        Store.state.ui.filters.q = "";
        UI.el("q").value = "";
        renderTransactions();
      });

      UI.el("q")?.addEventListener("input", Utils.debounce((e) => {
        Store.state.ui.filters.q = e.target.value || "";
        renderTransactions();
      }, 120));

      const chipMonth = UI.el("chipMonth");
      chipMonth?.addEventListener("click", () => {
        Store.state.ui.filters.monthOnly = !Store.state.ui.filters.monthOnly;
        chipMonth.classList.toggle("is-active", Store.state.ui.filters.monthOnly);
        renderTransactions();
      });
      chipMonth?.classList.toggle("is-active", Store.state.ui.filters.monthOnly);

      const toggleType = (key, btnId) => {
        const btn = UI.el(btnId);
        btn?.addEventListener("click", () => {
          const set = Store.state.ui.filters.types;
          if (set.has(key)) set.delete(key); else set.add(key);
          btn.classList.toggle("is-active", set.has(key));
          renderTransactions();
        });
      };
      toggleType("income", "chipIncome");
      toggleType("expense", "chipExpense");
      toggleType("transfer", "chipTransfer");

      UI.el("reduceMotion")?.addEventListener("change", async (e) => {
        Store.state.settings.reduceMotion = !!e.target.checked;
        await Storage.setMeta("settings", Store.state.settings);
        UI.applyReduceMotion(Store.state.settings.reduceMotion);
        UI.toast(Store.state.settings.reduceMotion ? "Animações reduzidas" : "Animações ativadas");
      });

      UI.el("btnExport")?.addEventListener("click", exportBackup);
      UI.el("importFile")?.addEventListener("change", importBackup);
      UI.el("btnPin")?.addEventListener("click", openPinModal);
      UI.el("btnReset")?.addEventListener("click", openResetModal);

      // Re-render on theme change (para redesenhar canvas)
      window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
        if (Store.state.settings.theme === "system") {
          UI.setTheme("system");
          renderCharts();
        }
      });
    }

    function openSearch() {
      UI.switchScreen("transactions");
      const q = UI.el("q");
      q?.focus();
    }

    async function toggleTheme() {
      const current = Store.state.settings.theme;
      const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
      Store.state.settings.theme = next;
      await Storage.setMeta("settings", Store.state.settings);
      UI.setTheme(next);
      renderCharts();
      UI.toast(next === "system" ? "Tema: Sistema" : next === "dark" ? "Tema: Escuro" : "Tema: Claro");
    }

    function openOnboarding() {
      UI.openModal({
        title: "Boas-vindas",
        bodyHTML: `
          <div class="field">
            <label>Moeda</label>
            <select id="obCurrency" aria-label="Moeda">
              <option value="BRL">BRL (R$)</option>
              <option value="USD">USD ($)</option>
              <option value="EUR">EUR (€)</option>
            </select>
          </div>
          <div class="field">
            <label>Início do mês (para orçamento/relatórios)</label>
            <select id="obMonthStart" aria-label="Início do mês">
              ${Array.from({length: 28}, (_,i)=> i+1).map(d => `<option value="${d}">Dia ${d}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Crie sua primeira conta</label>
            <input id="obAccName" type="text" inputmode="text" aria-label="Nome da conta" value="Banco" />
          </div>
          <div class="row">
            <div class="field" style="flex:1">
              <label>Tipo</label>
              <select id="obAccType" aria-label="Tipo">
                <option value="bank">Banco</option>
                <option value="wallet">Carteira</option>
                <option value="investment">Investimento</option>
                <option value="card">Cartão</option>
              </select>
            </div>
            <div class="field" style="flex:1">
              <label>Saldo inicial</label>
              <input id="obAccBal" type="text" inputmode="decimal" aria-label="Saldo inicial" value="0,00" />
            </div>
          </div>
        `,
        footerHTML: `
          <button class="btn" value="cancel">Agora não</button>
          <button class="btn primary" id="obGo" value="default">Começar</button>
        `,
        onOpen: () => {
          const cur = UI.el("obCurrency");
          const ms = UI.el("obMonthStart");
          cur.value = Store.state.settings.currency || "BRL";
          ms.value = String(Store.state.settings.monthStartDay || 1);

          UI.el("obGo").addEventListener("click", async (e) => {
            e.preventDefault();

            const currency = cur.value;
            const monthStartDay = Number(ms.value) || 1;

            Store.state.settings.currency = currency;
            Store.state.settings.monthStartDay = Utils.clamp(monthStartDay, 1, 28);

            await Storage.setMeta("settings", Store.state.settings);
            UI.setTheme(Store.state.settings.theme);

            const name = UI.el("obAccName").value.trim();
            const type = UI.el("obAccType").value;
            const bal = Utils.parseMoneyBR(UI.el("obAccBal").value);
            if (!name) {
              UI.toast("Informe um nome de conta.");
              return;
            }
            if (!isFinite(bal)) {
              UI.toast("Saldo inicial inválido.");
              return;
            }

            await createAccount({
              name,
              type,
              color: "#7c5cff",
              icon: type === "card" ? "💳" : type === "wallet" ? "👛" : type === "investment" ? "📈" : "🏦",
              initialBalance: bal,
            });

            UI.closeModal();
            renderAll();
            UI.toast("Pronto. Sua conta foi criada.");
          }, { once: true });
        }
      });
    }

    async function createAccount(payload) {
      const v = Domain.validateAccount(payload);
      if (!v.ok) throw new Error(v.msg);

      const acc = {
        id: Utils.uid("acc"),
        name: payload.name.trim(),
        type: payload.type,
        color: payload.color || "#7c5cff",
        icon: payload.icon || "•",
        initialBalance: Number(payload.initialBalance) || 0,
        balance: Number(payload.initialBalance) || 0,
        cardBill: 0,
        createdAt: new Date().toISOString()
      };
      await Storage.put(Storage.stores.accounts, acc);

      Store.state.data.accounts.push(acc);
      return acc;
    }

    function openAccountModal(existing = null) {
      const isEdit = !!existing;
      UI.openModal({
        title: isEdit ? "Editar conta" : "Nova conta",
        bodyHTML: `
          <div class="field">
            <label>Nome</label>
            <input id="accName" type="text" aria-label="Nome" value="${isEdit ? Utils.escapeHTML(existing.name) : ""}" />
          </div>
          <div class="row">
            <div class="field" style="flex:1">
              <label>Tipo</label>
              <select id="accType" aria-label="Tipo">
                <option value="wallet">Carteira</option>
                <option value="bank">Banco</option>
                <option value="investment">Investimento</option>
                <option value="card">Cartão</option>
              </select>
            </div>
            <div class="field" style="flex:1">
              <label>Ícone</label>
              <input id="accIcon" type="text" aria-label="Ícone" value="${isEdit ? Utils.escapeHTML(existing.icon || "") : "🏦"}" />
            </div>
          </div>
          <div class="row">
            <div class="field" style="flex:1">
              <label>Cor (hex)</label>
              <input id="accColor" type="text" aria-label="Cor" value="${isEdit ? Utils.escapeHTML(existing.color || "") : "#7c5cff"}" />
            </div>
            <div class="field" style="flex:1">
              <label>Saldo inicial</label>
              <input id="accInit" type="text" inputmode="decimal" aria-label="Saldo inicial" value="${isEdit ? String(existing.initialBalance).replace(".", ",") : "0,00"}" />
            </div>
          </div>
          ${isEdit ? `<div class="field"><label>Saldo atual</label><input id="accBal" type="text" inputmode="decimal" aria-label="Saldo atual" value="${String(existing.balance).replace(".", ",")}" /></div>` : ""}
          <div class="empty">
            <div class="empty__title">Dica</div>
            <div class="empty__desc">Cartões acumulam fatura por mês em “Relatórios”. Pagamento de fatura será habilitado em breve.</div>
          </div>
        `,
        footerHTML: `
          <button class="btn" value="cancel">Cancelar</button>
          ${isEdit ? `<button class="btn danger" id="accDelete" value="default">Excluir</button>` : ""}
          <button class="btn primary" id="accSave" value="default">${isEdit ? "Salvar" : "Criar"}</button>
        `,
        onOpen: () => {
          UI.el("accType").value = isEdit ? existing.type : "bank";

          UI.el("accSave").addEventListener("click", async (e) => {
            e.preventDefault();
            try {
              const name = UI.el("accName").value.trim();
              const type = UI.el("accType").value;
              const icon = UI.el("accIcon").value.trim() || "•";
              const color = UI.el("accColor").value.trim() || "#7c5cff";
              const init = Utils.parseMoneyBR(UI.el("accInit").value);
              if (!isFinite(init)) { UI.toast("Saldo inicial inválido."); return; }

              if (!isEdit) {
                await createAccount({ name, type, icon, color, initialBalance: init });
                UI.closeModal();
                renderAll();
                UI.toast("Conta criada.");
                return;
              }

              const bal = Utils.parseMoneyBR(UI.el("accBal").value);
              if (!isFinite(bal)) { UI.toast("Saldo atual inválido."); return; }

              const updated = { ...existing, name, type, icon, color, initialBalance: init, balance: bal };
              const v = Domain.validateAccount(updated);
              if (!v.ok) { UI.toast(v.msg); return; }

              await Storage.put(Storage.stores.accounts, updated);
              const idx = Store.state.data.accounts.findIndex(a => a.id === existing.id);
              if (idx >= 0) Store.state.data.accounts[idx] = updated;

              UI.closeModal();
              renderAll();
              UI.toast("Conta atualizada.");
            } catch (err) {
              console.error(err);
              UI.toast("Não foi possível salvar.");
            }
          }, { once: true });

          if (isEdit) {
            UI.el("accDelete").addEventListener("click", async (e) => {
              e.preventDefault();
              const hasTx = Store.state.data.transactions.some(t => t.accountFrom === existing.id || t.accountTo === existing.id);
              if (hasTx) {
                UI.toast("Esta conta tem transações. Exclua as transações antes.");
                return;
              }
              await Storage.remove(Storage.stores.accounts, existing.id);
              Store.state.data.accounts = Store.state.data.accounts.filter(a => a.id !== existing.id);
              UI.closeModal();
              renderAll();
              UI.toast("Conta excluída.");
            }, { once: true });
          }
        }
      });
    }

    function openAccountsManager() {
      UI.openModal({
        title: "Contas",
        bodyHTML: `
          <div id="accManagerList"></div>
          <div class="row">
            <button class="btn primary" id="accManagerNew" type="button">+ Nova conta</button>
          </div>
        `,
        footerHTML: `<button class="btn" value="cancel">Fechar</button>`,
        onOpen: () => {
          const render = () => {
            const wrap = UI.el("accManagerList");
            const arr = Store.state.data.accounts || [];
            if (arr.length === 0) {
              wrap.innerHTML = `<div class="empty"><div class="empty__title">Nenhuma conta</div><div class="empty__desc">Crie uma conta para começar.</div></div>`;
              return;
            }
            wrap.innerHTML = arr.map(a => `
              <div class="account" data-id="${a.id}">
                <div class="account__left">
                  <div class="badge" style="background:${a.color}22;border-color:${a.color}55">${Utils.escapeHTML(a.icon || "•")}</div>
                  <div style="min-width:0">
                    <div class="account__name">${Utils.escapeHTML(a.name)}</div>
                    <div class="account__sub">${a.type === "card" ? "Cartão" : a.type === "wallet" ? "Carteira" : a.type === "investment" ? "Investimento" : "Banco"}</div>
                  </div>
                </div>
                <div class="account__right">
                  <div class="account__bal">${Utils.toBRL(a.balance, Store.state.settings.currency)}</div>
                  ${a.type === "card" ? `<div class="account__bill">Fatura: ${Utils.toBRL(a.cardBill || 0, Store.state.settings.currency)}</div>` : `<div class="account__bill"> </div>`}
                </div>
              </div>
            `).join("");
            wrap.querySelectorAll(".account").forEach(node => {
              node.addEventListener("click", () => {
                const id = node.dataset.id;
                const acc = Store.state.data.accounts.find(x => x.id === id);
                if (acc) openAccountModal(acc);
              });
            });
          };
          render();
          UI.el("accManagerNew").addEventListener("click", () => openAccountModal(), { once: true });
        }
      });
    }

    function openTxModal(existing = null, duplicate = false) {
      const isEdit = !!existing && !duplicate;
      const currency = Store.state.settings.currency;
      const accounts = Store.state.data.accounts || [];
      const categories = Store.state.data.categories || [];

      if (accounts.length === 0) {
        UI.toast("Crie uma conta antes de registrar transações.");
        UI.switchScreen("dashboard");
        openAccountModal();
        return;
      }

      const defaultCat = categories.find(c => c.kind === "expense")?.id || categories[0]?.id;
      const typeDefault = existing ? existing.type : "expense";

      const dtDefault = existing ? existing.datetime : Utils.nowISO();
      const amtDefault = existing ? existing.amount : 0;
      const noteDefault = existing ? existing.note : "";
      const tagsDefault = existing ? (existing.tags || []).join(", ") : "";

      const accFromDefault = existing ? existing.accountFrom : accounts[0].id;
      const accToDefault = existing ? existing.accountTo : (accounts[1]?.id || accounts[0].id);

      const catDefault = existing ? existing.categoryId : defaultCat;

      UI.openModal({
        title: isEdit ? "Editar transação" : "Nova transação",
        bodyHTML: `
          <div class="row">
            <div class="field" style="flex:1">
              <label>Tipo</label>
              <select id="txType" aria-label="Tipo">
                <option value="expense">Saída</option>
                <option value="income">Entrada</option>
                <option value="transfer">Transferência</option>
                <option value="card">Cartão</option>
              </select>
            </div>
            <div class="field" style="flex:1">
              <label>Valor (${currency})</label>
              <input id="txAmount" type="text" inputmode="decimal" aria-label="Valor" value="${String(amtDefault).replace(".", ",")}" />
            </div>
          </div>

          <div class="field">
            <label>Data e hora</label>
            <input id="txDatetime" type="datetime-local" aria-label="Data e hora" value="${dtDefault}" />
          </div>

          <div class="row" id="rowAccounts">
            <div class="field" style="flex:1">
              <label id="lblFrom">Conta</label>
              <select id="txFrom" aria-label="Conta"></select>
            </div>
            <div class="field" style="flex:1" id="toWrap">
              <label>Destino</label>
              <select id="txTo" aria-label="Destino"></select>
            </div>
          </div>

          <div class="field">
            <label>Categoria</label>
            <select id="txCategory" aria-label="Categoria"></select>
          </div>

          <div class="field">
            <label>Descrição / Nota</label>
            <input id="txNote" type="text" aria-label="Nota" value="${Utils.escapeHTML(noteDefault)}" />
          </div>

          <div class="field">
            <label>Tags (separe por vírgula)</label>
            <input id="txTags" type="text" aria-label="Tags" value="${Utils.escapeHTML(tagsDefault)}" />
          </div>

          <div class="field">
            <label>Anexo (imagem)</label>
            <input id="txFile" type="file" accept="image/*" aria-label="Anexo" />
          </div>

          <div class="empty">
            <div class="empty__title">Atalhos</div>
            <div class="empty__desc">Você pode duplicar uma transação pela lista (toque e segure) — será habilitado em breve.</div>
          </div>
        `,
        footerHTML: `
          <button class="btn" value="cancel">Cancelar</button>
          ${isEdit ? `<button class="btn danger" id="txDelete" value="default">Excluir</button>` : ""}
          ${isEdit ? `<button class="btn" id="txDuplicate" value="default">Duplicar</button>` : ""}
          <button class="btn primary" id="txSave" value="default">${isEdit ? "Salvar" : "Adicionar"}</button>
        `,
        onOpen: () => {
          const selFrom = UI.el("txFrom");
          const selTo = UI.el("txTo");
          const selCat = UI.el("txCategory");

          // populate accounts
          selFrom.innerHTML = accounts.map(a => `<option value="${a.id}">${Utils.escapeHTML(a.icon || "•")} ${Utils.escapeHTML(a.name)}</option>`).join("");
          selTo.innerHTML = accounts.map(a => `<option value="${a.id}">${Utils.escapeHTML(a.icon || "•")} ${Utils.escapeHTML(a.name)}</option>`).join("");

          // populate categories
          selCat.innerHTML = categories.map(c => `<option value="${c.id}">${Utils.escapeHTML(c.icon || "•")} ${Utils.escapeHTML(c.name)}</option>`).join("");

          UI.el("txType").value = typeDefault;
          selFrom.value = accFromDefault;
          selTo.value = accToDefault;
          selCat.value = catDefault;

          const updateAccountFields = () => {
            const type = UI.el("txType").value;
            const toWrap = UI.el("toWrap");
            const lblFrom = UI.el("lblFrom");
            if (type === "transfer") {
              toWrap.style.display = "block";
              lblFrom.textContent = "Origem";
            } else if (type === "income") {
              toWrap.style.display = "none";
              lblFrom.textContent = "Conta";
            } else if (type === "expense") {
              toWrap.style.display = "none";
              lblFrom.textContent = "Conta";
            } else if (type === "card") {
              toWrap.style.display = "none";
              lblFrom.textContent = "Cartão";
            }
          };
          updateAccountFields();
          UI.el("txType").addEventListener("change", updateAccountFields);

          UI.el("txSave").addEventListener("click", async (e) => {
            e.preventDefault();
            try {
              const type = UI.el("txType").value;
              const amt = Utils.parseMoneyBR(UI.el("txAmount").value);
              const datetime = UI.el("txDatetime").value;
              const accountFrom = selFrom.value;
              const accountTo = selTo.value;
              const categoryId = selCat.value;
              const note = UI.el("txNote").value.trim();
              const tags = Domain.normalizeTags(UI.el("txTags").value);

              // anexo
              let attachmentId = existing?.attachmentId || null;
              const file = UI.el("txFile").files?.[0] || null;
              if (file) {
                const blob = file.slice(0, file.size, file.type);
                attachmentId = await Storage.putAttachment(file.type || "image/*", blob);
              }

              const baseTx = {
                id: isEdit ? existing.id : Utils.uid("tx"),
                type,
                amount: amt,
                datetime,
                accountFrom: (type === "transfer") ? accountFrom : accountFrom,
                accountTo: (type === "transfer") ? accountTo : null,
                categoryId,
                note,
                tags,
                splits: null,
                attachmentId,
                createdAt: isEdit ? existing.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
              };

              // aplicar regra automática por descrição (se existir)
              const txFinal = Domain.applyRulesToTx(baseTx, Store.state.data.rules || []);

              const val = Domain.validateTx(txFinal);
              if (!val.ok) { UI.toast(val.msg); return; }

              // se edição, precisamos recalcular saldos com segurança
              if (isEdit) {
                await Storage.put(Storage.stores.transactions, txFinal);
                const idx = Store.state.data.transactions.findIndex(t => t.id === existing.id);
                if (idx >= 0) Store.state.data.transactions[idx] = txFinal;

                await recalcAndPersistBalances();
                UI.closeModal();
                renderAll();
                UI.toast("Transação atualizada.");
                return;
              }

              // criação
              await Storage.put(Storage.stores.transactions, txFinal);
              Store.state.data.transactions.push(txFinal);

              await recalcAndPersistBalances();
              UI.closeModal();
              renderAll();
              UI.toast("Transação adicionada.");

            } catch (err) {
              console.error(err);
              UI.toast("Não foi possível salvar a transação.");
            }
          }, { once: true });

          if (isEdit) {
            UI.el("txDelete").addEventListener("click", async (e) => {
              e.preventDefault();
              const tx = existing;
              await Storage.remove(Storage.stores.transactions, tx.id);
              Store.state.data.transactions = Store.state.data.transactions.filter(t => t.id !== tx.id);

              await recalcAndPersistBalances();
              UI.closeModal();
              renderAll();

              // undo real
              Store.state.undo = {
                label: "Transação removida",
                expiresAt: Date.now() + 8000,
                doUndo: async () => {
                  await Storage.put(Storage.stores.transactions, tx);
                  Store.state.data.transactions.push(tx);
                  await recalcAndPersistBalances();
                  renderAll();
                  UI.toast("Desfazer concluído.");
                }
              };

              UI.toast("Transação excluída.", {
                action: {
                  label: "Desfazer",
                  onClick: async () => {
                    const u = Store.state.undo;
                    if (u && u.doUndo && Date.now() <= u.expiresAt) await u.doUndo();
                    Store.state.undo = null;
                  }
                },
                ttl: 7000
              });
            }, { once: true });

            UI.el("txDuplicate").addEventListener("click", (e) => {
              e.preventDefault();
              UI.closeModal();
              openTxModal(existing, true);
            }, { once: true });
          }
        }
      });
    }

    async function recalcAndPersistBalances() {
      const acc = Store.state.data.accounts || [];
      const txs = Store.state.data.transactions || [];
      const newAccs = Domain.recalcBalances(acc, txs);
      Store.state.data.accounts = newAccs;
      for (const a of newAccs) await Storage.put(Storage.stores.accounts, a);
    }

    function openPinModal() {
      const hasPin = !!Store.state.settings.pinHash;
      UI.openModal({
        title: "PIN local",
        bodyHTML: `
          <div class="empty">
            <div class="empty__title">${hasPin ? "PIN ativo" : "PIN desativado"}</div>
            <div class="empty__desc">Isso é proteção local (sem servidor). Se você esquecer, será necessário resetar o app.</div>
          </div>
          <div class="field">
            <label>${hasPin ? "Novo PIN (4 a 8 dígitos)" : "Criar PIN (4 a 8 dígitos)"}</label>
            <input id="pin1" type="password" inputmode="numeric" aria-label="PIN" />
          </div>
          <div class="field">
            <label>Confirmar PIN</label>
            <input id="pin2" type="password" inputmode="numeric" aria-label="Confirmar PIN" />
          </div>
          ${hasPin ? `
            <hr class="sep"/>
            <button class="btn danger" id="pinDisable" type="button">Desativar PIN</button>
          ` : ``}
        `,
        footerHTML: `
          <button class="btn" value="cancel">Cancelar</button>
          <button class="btn primary" id="pinSave" value="default">Salvar</button>
        `,
        onOpen: () => {
          UI.el("pinSave").addEventListener("click", async (e) => {
            e.preventDefault();
            const p1 = (UI.el("pin1").value || "").trim();
            const p2 = (UI.el("pin2").value || "").trim();
            if (p1.length < 4 || p1.length > 8 || !/^\d+$/.test(p1)) { UI.toast("PIN deve ter 4 a 8 dígitos."); return; }
            if (p1 !== p2) { UI.toast("PIN não confere."); return; }

            Store.state.settings.pinHash = simpleHash(p1);
            await Storage.setMeta("settings", Store.state.settings);
            UI.closeModal();
            UI.toast("PIN configurado.");
          }, { once: true });

          UI.el("pinDisable")?.addEventListener("click", async () => {
            Store.state.settings.pinHash = null;
            await Storage.setMeta("settings", Store.state.settings);
            UI.closeModal();
            UI.toast("PIN desativado.");
          }, { once: true });
        }
      });
    }

    function openResetModal() {
      UI.openModal({
        title: "Reset seguro",
        bodyHTML: `
          <div class="empty">
            <div class="empty__title">Atenção</div>
            <div class="empty__desc">Isso apaga todas as contas, transações, metas e configurações. Confirme duas vezes.</div>
          </div>
          <div class="field">
            <label>Digite RESET para confirmar</label>
            <input id="resetWord" type="text" aria-label="Digite RESET" />
          </div>
          <div class="field">
            <label>Digite seu PIN (se tiver)</label>
            <input id="resetPin" type="password" inputmode="numeric" aria-label="PIN" />
          </div>
        `,
        footerHTML: `
          <button class="btn" value="cancel">Cancelar</button>
          <button class="btn danger" id="doReset" value="default">Apagar tudo</button>
        `,
        onOpen: () => {
          UI.el("doReset").addEventListener("click", async (e) => {
            e.preventDefault();
            const w = (UI.el("resetWord").value || "").trim();
            if (w !== "RESET") { UI.toast("Confirmação inválida."); return; }

            const pinHash = Store.state.settings.pinHash;
            if (pinHash) {
              const p = (UI.el("resetPin").value || "").trim();
              if (simpleHash(p) !== pinHash) { UI.toast("PIN incorreto."); return; }
            }

            await Storage.clearAll();

            // reset state
            Store.state.settings = {
              currency: "BRL",
              monthStartDay: 1,
              theme: "system",
              reduceMotion: false,
              pinHash: null
            };
            await Storage.setMeta("settings", Store.state.settings);

            Store.state.data = {
              accounts: [],
              transactions: [],
              categories: [],
              budgets: [],
              goals: [],
              boxes: [],
              rules: [],
            };
            UI.closeModal();
            renderAll();
            openOnboarding();
            UI.toast("App resetado.");
          }, { once: true });
        }
      });
    }

    async function exportBackup() {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: Store.state.settings,
        data: Store.state.data,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `finflow-backup-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      UI.toast("Backup exportado.");
    }

    async function importBackup(e) {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;

      try {
        const text = await file.text();
        const json = JSON.parse(text);

        if (!json || typeof json !== "object" || json.version !== 1) {
          UI.toast("Backup inválido.");
          return;
        }

        UI.openModal({
          title: "Importar backup",
          bodyHTML: `
            <div class="empty">
              <div class="empty__title">Escolha o modo</div>
              <div class="empty__desc">Mesclar mantém dados atuais e adiciona do backup. Substituir apaga tudo e carrega o backup.</div>
            </div>
            <div class="row">
              <button class="btn" id="impMerge" type="button">Mesclar</button>
              <button class="btn danger" id="impOverwrite" type="button">Substituir</button>
            </div>
          `,
          footerHTML: `<button class="btn" value="cancel">Cancelar</button>`,
          onOpen: () => {
            UI.el("impMerge").addEventListener("click", async () => {
              await doImport(json, "merge");
              UI.closeModal();
            }, { once: true });

            UI.el("impOverwrite").addEventListener("click", async () => {
              await doImport(json, "overwrite");
              UI.closeModal();
            }, { once: true });
          }
        });

      } catch (err) {
        console.error(err);
        UI.toast("Falha ao importar.");
      }
    }

    async function doImport(json, mode) {
      const incoming = json.data || {};
      const incomingSettings = json.settings || {};

      if (mode === "overwrite") {
        await Storage.clearAll();
      }

      // settings
      Store.state.settings = { ...Store.state.settings, ...incomingSettings };
      await Storage.setMeta("settings", Store.state.settings);

      // merge helpers (por id)
      const mergeById = (cur, inc) => {
        const map = new Map((cur || []).map(x => [x.id, x]));
        (inc || []).forEach(x => map.set(x.id, x));
        return [...map.values()];
      };

      // carregar atuais do storage se overwrite limpou
      const current = {
        accounts: await Storage.getAll(Storage.stores.accounts),
        transactions: await Storage.getAll(Storage.stores.transactions),
        categories: await Storage.getAll(Storage.stores.categories),
        budgets: await Storage.getAll(Storage.stores.budgets),
        goals: await Storage.getAll(Storage.stores.goals),
        boxes: await Storage.getAll(Storage.stores.boxes),
        rules: await Storage.getAll(Storage.stores.rules),
      };

      const nextData = {
        accounts: mode === "merge" ? mergeById(current.accounts, incoming.accounts) : (incoming.accounts || []),
        transactions: mode === "merge" ? mergeById(current.transactions, incoming.transactions) : (incoming.transactions || []),
        categories: mode === "merge" ? mergeById(current.categories, incoming.categories) : (incoming.categories || []),
        budgets: mode === "merge" ? mergeById(current.budgets, incoming.budgets) : (incoming.budgets || []),
        goals: mode === "merge" ? mergeById(current.goals, incoming.goals) : (incoming.goals || []),
        boxes: mode === "merge" ? mergeById(current.boxes, incoming.boxes) : (incoming.boxes || []),
        rules: mode === "merge" ? mergeById(current.rules, incoming.rules) : (incoming.rules || []),
      };

      // persist
      for (const a of nextData.accounts) await Storage.put(Storage.stores.accounts, a);
      for (const t of nextData.transactions) await Storage.put(Storage.stores.transactions, t);
      for (const c of nextData.categories) await Storage.put(Storage.stores.categories, c);
      for (const b of nextData.budgets) await Storage.put(Storage.stores.budgets, b);
      for (const g of nextData.goals) await Storage.put(Storage.stores.goals, g);
      for (const x of nextData.boxes) await Storage.put(Storage.stores.boxes, x);
      for (const r of nextData.rules) await Storage.put(Storage.stores.rules, r);

      // recalc balances
      const accRecalc = Domain.recalcBalances(nextData.accounts, nextData.transactions);
      for (const a of accRecalc) await Storage.put(Storage.stores.accounts, a);

      Store.state.data = { ...nextData, accounts: accRecalc };
      UI.setTheme(Store.state.settings.theme);
      UI.applyReduceMotion(!!Store.state.settings.reduceMotion);
      renderAll();
      UI.toast("Importação concluída.");
    }

    function simpleHash(str) {
      // hash rápido (proteção local simples)
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    }

    function registerSW() {
      if (!("serviceWorker" in navigator)) return;
      if (location.protocol !== "https:" && location.hostname !== "localhost" && location.protocol !== "http:") return;
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }

    return {
      initApp,
      openTxModal,
      openSearch
    };
  })();

  // =========================
  // Renderers
  // =========================
  function renderAll() {
    renderDashboard();
    renderAccounts();
    renderTransactions();
    renderCharts();
  }

  function renderDashboard() {
    const { currency, monthStartDay } = Store.state.settings;
    const accounts = Store.state.data.accounts || [];
    const txs = Store.state.data.transactions || [];

    const total = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);

    const now = new Date();
    const s = Utils.startOfMonth(now, monthStartDay);
    const e = Utils.endOfMonthWindow(now, monthStartDay);

    let income = 0, expense = 0;
    for (const t of txs) {
      const d = new Date(t.datetime);
      if (d < s || d >= e) continue;
      if (t.type === "income") income += Number(t.amount) || 0;
      if (t.type === "expense") expense += Number(t.amount) || 0;
    }

    UI.el("dashTotal").textContent = Utils.toBRL(total, currency);
    UI.el("dashMeta").textContent = `Mês atual • Entradas: ${Utils.toBRL(income, currency)} • Saídas: ${Utils.toBRL(expense, currency)}`;

    // Insights simples (e reais)
    const insights = UI.el("insights");
    if (!insights) return;

    if (txs.length === 0) {
      insights.innerHTML = `
        <div class="empty">
          <div class="empty__title">Sem dados ainda</div>
          <div class="empty__desc">Adicione uma transação para ver insights automáticos.</div>
        </div>
      `;
      return;
    }

    // Top 3 categorias do mês (saídas)
    const cats = new Map(Store.state.data.categories.map(c => [c.id, c]));
    const byCat = new Map();
    for (const t of txs) {
      const d = new Date(t.datetime);
      if (d < s || d >= e) continue;
      if (t.type !== "expense" && t.type !== "card") continue;
      const id = t.categoryId || "cat_other";
      byCat.set(id, (byCat.get(id) || 0) + (Number(t.amount) || 0));
    }
    const top = [...byCat.entries()].sort((a,b) => b[1]-a[1]).slice(0, 3);

    const topHTML = top.length
      ? top.map(([id, val]) => {
          const c = cats.get(id) || { name: "Outros", icon: "•" };
          return `<div class="tx">
            <div class="tx__left">
              <div class="tx__title">${Utils.escapeHTML(c.icon)} ${Utils.escapeHTML(c.name)}</div>
              <div class="tx__meta">Gasto no mês</div>
            </div>
            <div class="tx__amt amt-expense">-${Utils.toBRL(val, Store.state.settings.currency)}</div>
          </div>`;
        }).join("")
      : `<div class="empty"><div class="empty__title">Sem gastos no mês</div><div class="empty__desc">Registre uma saída para começar a ver padrões.</div></div>`;

    insights.innerHTML = topHTML;
  }

  function renderAccounts() {
    const list = UI.el("accountsList");
    if (!list) return;
    const accounts = Store.state.data.accounts || [];
    const currency = Store.state.settings.currency;

    if (accounts.length === 0) {
      list.innerHTML = `
        <div class="empty">
          <div class="empty__title">Nenhuma conta</div>
          <div class="empty__desc">Crie Carteira, Banco ou Cartão para começar.</div>
        </div>
      `;
      return;
    }

    list.innerHTML = accounts.map(a => `
      <div class="account">
        <div class="account__left">
          <div class="badge" style="background:${a.color}22;border-color:${a.color}55">${Utils.escapeHTML(a.icon || "•")}</div>
          <div style="min-width:0">
            <div class="account__name">${Utils.escapeHTML(a.name)}</div>
            <div class="account__sub">${a.type === "card" ? "Cartão" : a.type === "wallet" ? "Carteira" : a.type === "investment" ? "Investimento" : "Banco"}</div>
          </div>
        </div>
        <div class="account__right">
          <div class="account__bal">${Utils.toBRL(a.balance, currency)}</div>
          ${a.type === "card" ? `<div class="account__bill">Fatura: ${Utils.toBRL(a.cardBill || 0, currency)}</div>` : `<div class="account__bill"></div>`}
        </div>
      </div>
    `).join("");
  }

  function renderTransactions() {
    const wrap = UI.el("txList");
    if (!wrap) return;

    const { monthStartDay } = Store.state.settings;
    const { q, types, monthOnly } = Store.state.ui.filters;

    const txs = [...(Store.state.data.transactions || [])].sort((a,b) => new Date(b.datetime) - new Date(a.datetime));
    const cats = new Map((Store.state.data.categories || []).map(c => [c.id, c]));
    const accs = new Map((Store.state.data.accounts || []).map(a => [a.id, a]));

    const now = new Date();
    const s = Utils.startOfMonth(now, monthStartDay);
    const e = Utils.endOfMonthWindow(now, monthStartDay);

    const ql = (q || "").trim().toLowerCase();

    const filtered = txs.filter(t => {
      const d = new Date(t.datetime);
      if (monthOnly && (d < s || d >= e)) return false;
      if (types.size > 0 && !types.has(t.type)) return false;

      if (ql) {
        const cat = cats.get(t.categoryId);
        const from = accs.get(t.accountFrom);
        const to = t.accountTo ? accs.get(t.accountTo) : null;
        const hay = [
          t.note || "",
          (t.tags || []).join(" "),
          cat?.name || "",
          from?.name || "",
          to?.name || "",
        ].join(" ").toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      wrap.innerHTML = `
        <div class="empty">
          <div class="empty__title">Nada encontrado</div>
          <div class="empty__desc">Ajuste filtros ou registre novas transações.</div>
        </div>
      `;
      return;
    }

    // agrupar por dia
    const groups = new Map();
    for (const t of filtered) {
      const d = Utils.parseISO(t.datetime);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const keys = [...groups.keys()].sort((a,b) => (a < b ? 1 : -1));

    wrap.innerHTML = keys.map(dayKey => {
      const items = groups.get(dayKey);
      const label = formatDayLabel(dayKey);
      const sum = items.reduce((s, t) => {
        if (t.type === "income") return s + t.amount;
        if (t.type === "expense") return s - t.amount;
        if (t.type === "transfer") return s;
        if (t.type === "card") return s - t.amount;
        return s;
      }, 0);

      return `
        <div class="tx-day">
          <div class="tx-day__hdr">
            <div>${label}</div>
            <div>${sum >= 0 ? Utils.toBRL(sum, Store.state.settings.currency) : "-" + Utils.toBRL(Math.abs(sum), Store.state.settings.currency)}</div>
          </div>
          ${items.map(t => {
            const cat = cats.get(t.categoryId) || { name: "Outros", icon: "•" };
            const from = accs.get(t.accountFrom);
            const to = t.accountTo ? accs.get(t.accountTo) : null;

            let meta = "";
            if (t.type === "transfer") meta = `${from?.name || "Origem"} → ${to?.name || "Destino"} • ${cat.name}`;
            else if (t.type === "card") meta = `${from?.name || "Cartão"} • ${cat.name}`;
            else meta = `${from?.name || "Conta"} • ${cat.name}`;

            const cls =
              t.type === "income" ? "amt-income" :
              t.type === "expense" ? "amt-expense" :
              t.type === "transfer" ? "amt-transfer" : "amt-card";

            const prefix =
              t.type === "income" ? "+" :
              t.type === "expense" ? "-" :
              t.type === "transfer" ? "↔" : "•";

            const title = t.note?.trim() ? t.note.trim() : `${cat.icon} ${cat.name}`;
            const amtText =
              t.type === "transfer"
                ? `${prefix}${Utils.toBRL(t.amount, Store.state.settings.currency)}`
                : `${prefix}${Utils.toBRL(t.amount, Store.state.settings.currency)}`;

            return `
              <div class="tx" data-id="${t.id}">
                <div class="tx__left">
                  <div class="tx__title">${Utils.escapeHTML(title)}</div>
                  <div class="tx__meta">${Utils.escapeHTML(meta)}${(t.tags && t.tags.length) ? " • #" + t.tags.map(Utils.escapeHTML).join(" #") : ""}</div>
                </div>
                <div class="tx__amt ${cls}">${amtText}</div>
              </div>
            `;
          }).join("")}
        </div>
      `;
    }).join("");

    // editar ao tocar
    wrap.querySelectorAll(".tx").forEach(node => {
      node.addEventListener("click", async () => {
        const id = node.dataset.id;
        const tx = Store.state.data.transactions.find(t => t.id === id);
        if (!tx) return;
        Actions.openTxModal(tx);
      });
    });

    function formatDayLabel(yyyyMmDd) {
      const [y,m,d] = yyyyMmDd.split("-").map(Number);
      const dt = new Date(y, m-1, d);
      const wd = dt.toLocaleDateString("pt-BR", { weekday: "short" });
      const dd = dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
      return `${wd} • ${dd}`;
    }
  }

  function renderCharts() {
    // Donut: gastos por categoria no mês (expense + card)
    const { monthStartDay, currency } = Store.state.settings;
    const txs = Store.state.data.transactions || [];
    const cats = new Map((Store.state.data.categories || []).map(c => [c.id, c]));
    const now = new Date();
    const s = Utils.startOfMonth(now, monthStartDay);
    const e = Utils.endOfMonthWindow(now, monthStartDay);

    const byCat = new Map();
    for (const t of txs) {
      const d = new Date(t.datetime);
      if (d < s || d >= e) continue;
      if (t.type !== "expense" && t.type !== "card") continue;
      const id = t.categoryId || "cat_other";
      byCat.set(id, (byCat.get(id) || 0) + (Number(t.amount) || 0));
    }

    const donutItems = [...byCat.entries()]
      .sort((a,b) => b[1]-a[1])
      .slice(0, 8)
      .map(([id, val]) => {
        const c = cats.get(id) || { name: "Outros", color: "#94a3b8" };
        return { label: c.name, value: val, color: c.color || "#7c5cff" };
      });

    const donut = UI.el("chartDonut");
    if (donut) Charts.drawDonut(donut, donutItems, "Gastos");

    // Line: saldo ao longo do tempo (últimos 30 dias)
    const line = UI.el("chartLine");
    if (line) {
      const accounts = Store.state.data.accounts || [];
      const totalNow = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);

// reconstruir saldo diário aproximado reverso (simples e estável)
      const days = 30;
      const points = [];
      let running = totalNow;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (days - 1));
      cutoff.setHours(0,0,0,0);

      const relevant = txs
        .filter(t => new Date(t.datetime) >= cutoff)
        .sort((a,b) => new Date(b.datetime) - new Date(a.datetime)); // desc

      // mapa por dia para desfazer
      const byDay = new Map();
      for (const t of relevant) {
        const d = new Date(t.datetime);
        const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(t);
      }

      // caminhar do dia atual para trás, desfazendo efeito
      const dayCursor = new Date();
      dayCursor.setHours(0,0,0,0);

      for (let i = 0; i < days; i++) {
        const k = `${dayCursor.getFullYear()}-${dayCursor.getMonth()}-${dayCursor.getDate()}`;
        points.unshift({ x: i, y: running });

        const arr = byDay.get(k) || [];
        // desfazer transações do dia para voltar ao saldo anterior
        for (const t of arr) {
          const amt = Number(t.amount) || 0;
          if (t.type === "income") running -= amt;
          else if (t.type === "expense") running += amt;
          else if (t.type === "card") running += amt;
          else if (t.type === "transfer") { /* total não muda */ }
        }

        dayCursor.setDate(dayCursor.getDate() - 1);
      }

      Charts.drawLine(line, points, "30 dias", Utils.toBRL(points[points.length-1].y, currency));
    }

    // Bars: entradas vs saídas dos últimos 4 meses (janela por mêsStartDay)
    const bars = UI.el("chartBars");
    if (bars) {
      const months = 4;
      const items = [];
      const base = Utils.startOfMonth(now, monthStartDay);

      for (let i = months - 1; i >= 0; i--) {
        const mStart = new Date(base);
        mStart.setMonth(mStart.getMonth() - i);
        const mEnd = new Date(mStart);
        mEnd.setMonth(mEnd.getMonth() + 1);

        let inc = 0, out = 0;
        for (const t of txs) {
          const d = new Date(t.datetime);
          if (d < mStart || d >= mEnd) continue;
          if (t.type === "income") inc += Number(t.amount) || 0;
          if (t.type === "expense" || t.type === "card") out += Number(t.amount) || 0;
        }
        const label = mStart.toLocaleDateString("pt-BR", { month: "short" });
        // aqui usamos "economia" como barra (inc - out)
        const net = inc - out;
        items.push({ label, value: Math.max(0, net), color: net >= 0 ? "#22c55e" : "#fb7185" });
      }

      Charts.drawBars(bars, items);
    }
  }

  // =========================
  // Boot
  // =========================
  document.addEventListener("DOMContentLoaded", () => {
    Actions.initApp().catch((e) => {
      console.error(e);
      // fallback visual mínimo
      alert("Falha ao iniciar. Verifique o Console.");
    });
  });

})();