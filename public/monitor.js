// Logika bersama modul Ping & PRTG: routing view, form tambah, editor posisi, dan layar tampilkan.
// Setiap modul mendaftarkan implementasinya lewat Monitor.register(...) (lihat ping.js / prtg.js).
(function () {
  "use strict";

  const VIEWS = ["menu", "tambah", "atur", "tampilkan"];
  const moduleName = document.body.dataset.module;
  const views = Array.from(document.querySelectorAll("[data-view]"));
  const toastElement = document.getElementById("toast");

  let impl = null;
  let items = [];
  let currentView = null;
  let enteredFullscreen = false;
  let toastTimer = null;
  let editingId = null;
  let settings = { slot_capacity: 12, rotate_seconds: 30 };
  let slideIndex = 0;
  let rotateTimer = null;

  // Kapasitas 14 dan 16 menggunakan grid 4x4; kapasitas lain mengikuti grid ringkas.
  const GRID_LAYOUT = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2], 10: [5, 2], 12: [4, 3], 14: [4, 4], 16: [4, 4] };

  function applyGridLayout(grid, capacity) {
    const [cols, rows] = GRID_LAYOUT[capacity] || GRID_LAYOUT[12];
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  }

  function toast(message, kind) {
    if (!toastElement) return;
    toastElement.textContent = message;
    toastElement.className = `toast show ${kind || "ok"}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastElement.className = "toast"; }, 3500);
  }

  async function api(path, options) {
    const settings = { credentials: "same-origin", ...(options || {}) };
    if (settings.body !== undefined) {
      settings.headers = { "Content-Type": "application/json" };
      settings.body = JSON.stringify(settings.body);
    }
    const response = await fetch(path, settings);
    let data = null;
    try { data = await response.json(); } catch { /* respons tanpa body JSON */ }
    if (response.status === 401) {
      window.location.replace("/");
      throw new Error("Sesi berakhir.");
    }
    if (!response.ok) throw new Error((data && data.error) || `Permintaan gagal (${response.status}).`);
    return data;
  }

  // impl.expand (opsional, dipakai ping.js) memecah item jadi unit-per-slot sebenarnya
  // ketika 1 item bisa memakai lebih dari 1 slot (mis. ping multi-tujuan per perangkat).
  function expandSlots(list) {
    return impl.expand ? impl.expand(list) : list;
  }

  function updateCounters() {
    const slots = expandSlots(items).length;
    const totalSlides = Math.max(1, Math.ceil(slots / settings.slot_capacity));
    const slideNote = totalSlides > 1 ? ` · ${totalSlides} slide @ ${settings.slot_capacity} slot` : "";
    const baseText = impl.counterText ? impl.counterText(items, slots) : `${items.length} ${impl.noun} terdaftar`;
    document.querySelectorAll("[data-counter]").forEach((element) => {
      element.textContent = `${baseText}${slideNote}`;
    });
  }

  async function loadItems() {
    items = await api(impl.endpoint);
    items.sort((a, b) => a.slot_order - b.slot_order);
    updateCounters();
  }

  async function loadSettings() {
    try {
      settings = await api(`/api/display-settings/${moduleName}`);
    } catch {
      settings = { slot_capacity: 12, rotate_seconds: 30 };
    }
    const capacityField = document.getElementById("f-capacity");
    const rotateField = document.getElementById("f-rotate");
    if (capacityField) capacityField.value = String(settings.slot_capacity);
    if (rotateField) rotateField.value = String(settings.rotate_seconds);
  }

  async function saveSettings() {
    const capacityField = document.getElementById("f-capacity");
    const rotateField = document.getElementById("f-rotate");
    if (!capacityField || !rotateField) return;
    try {
      settings = await api(`/api/display-settings/${moduleName}`, {
        method: "PUT",
        body: { slot_capacity: Number(capacityField.value), rotate_seconds: Number(rotateField.value) }
      });
      updateCounters();
      if (currentView === "atur") renderArrange();
      toast("Pengaturan tampilan tersimpan.");
    } catch (error) {
      toast(error.message, "err");
    }
  }

  /* ---------- Editor posisi (drag-and-drop) ---------- */
  const arrangeGrid = document.getElementById("arrange-grid");
  const saveButton = document.getElementById("save-layout");
  let dragged = null;

  function renumber() {
    Array.from(arrangeGrid.querySelectorAll(".arr-card")).forEach((card, index) => {
      card.querySelector(".arr-badge").textContent = `SLOT ${index + 1}`;
    });
  }

  function moveCard(card, direction) {
    const sibling = direction < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (!sibling || !sibling.classList.contains("arr-card")) return;
    arrangeGrid.insertBefore(card, direction < 0 ? sibling : sibling.nextElementSibling);
    renumber();
    card.focus();
  }

  async function deleteItem(unit) {
    const info = impl.cardInfo(unit);
    const confirmMessage = impl.confirmDelete
      ? impl.confirmDelete(unit, info)
      : `Hapus "${info.title}"? Data ini akan dihapus permanen dari MySQL.`;
    if (!window.confirm(confirmMessage)) return;
    try {
      const endpoint = impl.deleteEndpoint ? impl.deleteEndpoint(unit) : `${impl.endpoint}/${unit.id}`;
      await api(endpoint, { method: "DELETE" });
      toast("Data dihapus.");
      await loadItems();
      renderArrange();
    } catch (error) {
      toast(error.message, "err");
    }
  }

  function buildCard(item) {
    const info = impl.cardInfo(item);
    const card = document.createElement("div");
    card.className = "arr-card";
    card.draggable = true;
    card.tabIndex = 0;
    card.dataset.id = String(item.id);

    const badge = document.createElement("span");
    badge.className = "arr-badge";

    let titleNode;
    if (info.editableLabel !== undefined) {
      const wrap = document.createElement("div");
      wrap.className = "arr-label-wrap";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "arr-label-input";
      input.maxLength = 100;
      input.value = info.editableLabel;
      input.placeholder = info.defaultLabel || "Nama identitas kolom...";
      input.title = "Ubah nama identitas untuk kolom ping ini, lalu klik Simpan Layout (atau tekan Enter)";
      input.addEventListener("mousedown", (event) => {
        card.draggable = false;
        event.stopPropagation();
      });
      input.addEventListener("blur", () => { card.draggable = true; });
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          saveLayout();
        }
      });
      wrap.appendChild(input);
      titleNode = wrap;
    } else {
      const title = document.createElement("strong");
      title.textContent = info.title;
      titleNode = title;
    }

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = info.sub;

    const tools = document.createElement("div");
    tools.className = "arr-tools";
    [["◀", "Geser ke kiri", () => moveCard(card, -1)], ["▶", "Geser ke kanan", () => moveCard(card, 1)]].forEach(([label, aria, handler]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", aria);
      button.addEventListener("click", handler);
      tools.appendChild(button);
    });
    if (impl.populateForm) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEdit(item));
      tools.appendChild(edit);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "del";
    remove.textContent = "Hapus";
    remove.addEventListener("click", () => deleteItem(item));
    tools.appendChild(remove);

    card.append(badge, titleNode, sub, tools);

    card.addEventListener("dragstart", (event) => {
      dragged = card;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragged = null;
      renumber();
    });
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === card) return;
      const draggedIsBefore = dragged.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING;
      arrangeGrid.insertBefore(dragged, draggedIsBefore ? card.nextElementSibling : card);
      renumber();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveCard(card, -1); }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveCard(card, 1); }
    });
    return card;
  }

  function renderArrange() {
    applyGridLayout(arrangeGrid, settings.slot_capacity);
    arrangeGrid.replaceChildren();
    const units = expandSlots(items);
    saveButton.disabled = units.length === 0;
    if (!units.length) {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = `Belum ada ${impl.noun}. Gunakan menu TAMBAH terlebih dahulu.`;
      arrangeGrid.appendChild(note);
      return;
    }
    units.forEach((unit) => arrangeGrid.appendChild(buildCard(unit)));
    renumber();
  }

  async function saveLayout() {
    const order = Array.from(arrangeGrid.querySelectorAll(".arr-card")).map((card, index) => {
      const entry = {
        id: Number(card.dataset.id),
        slot_order: index + 1
      };
      const labelInput = card.querySelector(".arr-label-input");
      if (labelInput) {
        entry.label = labelInput.value.trim();
      }
      return entry;
    });
    saveButton.disabled = true;
    try {
      await api(`/api/reorder/${moduleName}`, { method: "POST", body: order });
      toast("Layout & nama kolom tersimpan.");
      await loadItems();
      if (currentView === "atur") renderArrange();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      saveButton.disabled = false;
    }
  }

  /* ---------- Mode edit (reuse form TAMBAH) ---------- */
  const tambahForm = document.getElementById("add-form");
  const tambahHeading = document.querySelector('[data-view="tambah"] h1');
  const tambahSubmit = tambahForm ? tambahForm.querySelector("[type=submit]") : null;
  const defaultHeading = tambahHeading ? tambahHeading.textContent : "";
  const defaultSubmitLabel = tambahSubmit ? tambahSubmit.textContent : "";

  function exitEditMode() {
    editingId = null;
    if (tambahHeading) tambahHeading.textContent = defaultHeading;
    if (tambahSubmit) tambahSubmit.textContent = defaultSubmitLabel;
    if (tambahForm) tambahForm.reset();
  }

  function startEdit(unit) {
    const item = unit && unit.device ? unit.device : unit;
    if (!impl.populateForm || !tambahForm) return;
    editingId = item.id;
    // Tidak panggil form.reset(): initForm (ping.js) menjadwalkan ulang preset command
    // lewat setTimeout saat "reset", yang akan menimpa nilai populateForm di bawah ini.
    impl.populateForm(tambahForm, item);
    if (tambahHeading) tambahHeading.textContent = `Edit ${impl.noun}`;
    if (tambahSubmit) tambahSubmit.textContent = "Simpan perubahan";
    window.location.hash = "#tambah";
  }

  /* ---------- Routing view ---------- */
  async function route() {
    const requested = window.location.hash.slice(1);
    const view = VIEWS.includes(requested) ? requested : "menu";

    if (currentView === "tampilkan" && view !== "tampilkan") {
      stopRotation();
      impl.stopDisplay();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      enteredFullscreen = false;
    }
    if (view !== "tambah" && editingId !== null) exitEditMode();

    currentView = view;
    views.forEach((element) => { element.hidden = element.dataset.view !== view; });
    document.body.classList.toggle("is-display", view === "tampilkan");
    window.scrollTo(0, 0);

    if (view === "tambah") return;
    try {
      if (view === "atur" || view === "tampilkan") await loadSettings();
      await loadItems();
    } catch (error) {
      toast(error.message, "err");
    }
    if (currentView !== view) return;

    if (view === "atur") renderArrange();
    if (view === "tampilkan") startRotation();
  }

  /* ---------- Rotasi slide (tampilan) ---------- */
  function activeItems() {
    return items.filter((item) => item.is_active);
  }

  function renderSlide() {
    const capacity = settings.slot_capacity;
    const units = expandSlots(activeItems());
    const totalSlides = Math.max(1, Math.ceil(units.length / capacity));
    slideIndex = slideIndex % totalSlides;
    const slideItems = units.slice(slideIndex * capacity, (slideIndex + 1) * capacity);
    const grid = document.getElementById("display-grid");
    applyGridLayout(grid, capacity);
    impl.stopDisplay();
    impl.startDisplay(grid, slideItems, capacity);
    return totalSlides;
  }

  function startRotation() {
    slideIndex = 0;
    const totalSlides = renderSlide();
    clearInterval(rotateTimer);
    rotateTimer = null;
    if (totalSlides > 1) {
      rotateTimer = setInterval(() => {
        slideIndex += 1;
        renderSlide();
      }, settings.rotate_seconds * 1000);
    }
  }

  function stopRotation() {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }

  function setupForm() {
    const form = document.getElementById("add-form");
    if (!form) return;
    const errorElement = form.querySelector("[data-form-error]");
    if (impl.initForm) impl.initForm(form);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorElement.textContent = "";
      const submit = form.querySelector("[type=submit]");
      submit.disabled = true;
      try {
        const isEdit = editingId !== null;
        const path = isEdit ? `${impl.endpoint}/${editingId}` : impl.endpoint;
        await api(path, { method: isEdit ? "PUT" : "POST", body: impl.buildPayload(form, isEdit) });
        exitEditMode();
        toast("Data tersimpan di MySQL.");
        window.location.hash = "#menu";
      } catch (error) {
        errorElement.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
  }

  function register(implementation) {
    impl = implementation;

    document.querySelectorAll("[data-go]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.go;
        if (target === "tampilkan" && document.documentElement.requestFullscreen) {
          // Harus dipanggil langsung dari klik pengguna agar browser mengizinkan fullscreen.
          document.documentElement.requestFullscreen().then(() => { enteredFullscreen = true; }).catch(() => {});
        }
        window.location.hash = `#${target}`;
      });
    });
    document.querySelectorAll("[data-exit-display]").forEach((button) => {
      button.addEventListener("click", () => { window.location.hash = "#menu"; });
    });
    saveButton.addEventListener("click", saveLayout);
    const saveSettingsButton = document.getElementById("save-settings");
    if (saveSettingsButton) saveSettingsButton.addEventListener("click", saveSettings);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && currentView === "tampilkan") window.location.hash = "#menu";
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && enteredFullscreen && currentView === "tampilkan") window.location.hash = "#menu";
    });
    window.addEventListener("hashchange", route);

    setupForm();
    route();
  }

  window.Monitor = { register, api, toast };
})();
