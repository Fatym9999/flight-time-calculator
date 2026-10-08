(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var auth = window.FlightAuth, store, ownerId, entries = [], busy = false, ready = false;
  var generation = 0, clearArmed = false, replaceArmed = false;
  var fields = [$("h"), $("m"), $("a"), $("l"), $("label")];
  function status(text, error) {
    $("syncStatus").textContent = text;
    $("syncStatus").className = "io-msg" + (error ? " err" : "");
    if (!ownerId && $("modeNote")) {
      $("modeNote").textContent = text;
      $("modeNote").className = "io-msg" + (error ? " err" : "");
    }
    if (error && $("syncPanel")) { $("syncPanel").hidden = false; $("syncPanel").open = true; }
  }
  function controls() {
    ["add", "impAdd", "impRep", "clear"].forEach(function (id) { $(id).disabled = busy || !ready; });
    $("refresh").disabled = busy || !store;
    // Typing is available during account checks and background reads.
    fields.forEach(function (field) { field.disabled = busy && writing; });
    document.querySelectorAll(".del").forEach(function (button) { button.disabled = busy || !ready; });
  }
  function disarm() {
    clearArmed = replaceArmed = false;
    $("clear").textContent = "Очистить всё";
    $("impRep").textContent = "Импорт: заменить";
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function render() {
    var totals = entries.reduce(function (sum, entry) {
      return [sum[0] + entry.min, sum[1] + entry.appr, sum[2] + entry.land];
    }, [0, 0, 0]);
    $("tH").textContent = Math.floor(totals[0] / 60);
    $("tM").textContent = pad(totals[0] % 60);
    $("dec").textContent = (totals[0] / 60).toFixed(2).replace(".", ",");
    $("cnt").textContent = entries.length;
    $("tA").textContent = totals[1]; $("tL").textContent = totals[2];
    $("list").innerHTML = "";
    entries.forEach(function (entry, index) {
      var li = document.createElement("li"), info = document.createElement("div");
      info.className = "info";
      var name = document.createElement("div"), meta = document.createElement("div");
      name.className = "name"; name.textContent = entry.label || "Задание " + (index + 1);
      meta.className = "meta"; meta.textContent = "Заходы: " + entry.appr + ", посадки: " + entry.land;
      info.appendChild(name); info.appendChild(meta);
      var time = document.createElement("div"), del = document.createElement("button");
      time.className = "time"; time.textContent = Math.floor(entry.min / 60) + ":" + pad(entry.min % 60);
      del.className = "del"; del.type = "button"; del.textContent = "×";
      del.setAttribute("aria-label", "Удалить: " + name.textContent);
      del.addEventListener("click", function () {
        persist(entries.filter(function (_, i) { return i !== index; }));
      });
      li.appendChild(info); li.appendChild(time); li.appendChild(del); $("list").appendChild(li);
    });
    $("empty").hidden = entries.length > 0;
    $("clear").hidden = entries.length === 0;
    disarm(); controls();
  }
  function failure(error, loading) {
    if (error && error.message === "LOCAL_READ_FAILED") return "Не удалось прочитать записи на устройстве. Данные не удалены. Проверьте доступ браузера к хранилищу и обновите страницу.";
    if (error && error.message === "LOCAL_WRITE_FAILED") return "Браузер не смог сохранить запись на устройстве. Введённые поля оставлены. Проверьте доступ к хранилищу и нажмите «Обновить журнал».";
    if (error && error.message === "INVALID_ENTRIES") return "Копия содержит некорректные записи или превышен лимит 10 000 заданий. Ничего не сохранено. Нажмите «Обновить журнал».";
    if (error && error.code === "40001") return "Журнал изменён на другом устройстве. Нажмите «Обновить журнал», затем повторите действие.";
    if (error && ["42P01", "42883", "PGRST202", "PGRST205"].includes(error.code)) {
      return "База журнала ещё не настроена. Выполните SQL из sync-setup.sql в тестовом Supabase.";
    }
    var code = error && error.code;
    var details = typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? " Код: " + code + "." : "";
    if (error && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) details += " HTTP " + error.status + ".";
    if (!details && error && ["TypeError", "AuthRetryableFetchError", "AbortError"].includes(error.name)) details = " Код: " + error.name + ".";
    if (loading) return "Не удалось загрузить журнал из аккаунта." + details + " Нажмите «Обновить журнал». Если ошибка повторяется, пришлите это сообщение.";
    return "Не удалось подтвердить сохранение." + details + " Нажмите «Обновить журнал» и проверьте список перед повтором. Введённые поля сохранены на странице.";
  }
  async function refresh() {
    if (busy || !store) return;
    busy = true; controls(); status("Обновляем журнал…");
    var turn = generation;
    try {
      var result = await store.read();
      if (turn !== generation) return;
      entries = result; ready = true; render();
      status(ownerId ? "Журнал загружен из аккаунта. Изменения сохраняются с интернетом." : "Без аккаунта: записи сохраняются на этом устройстве. Для синхронизации войдите.");
    } catch (error) {
      if (turn !== generation) return;
      ready = false; status(failure(error, true), true);
    } finally {
      if (turn === generation) { busy = false; controls(); }
    }
  }
  var writing = false;
  async function persist(next) {
    if (busy || !ready) return false;
    busy = true; writing = true; controls(); disarm(); status(ownerId ? "Сохраняем в аккаунт…" : "Сохраняем на устройстве…");
    var turn = generation;
    try {
      var result = await store.write(next);
      if (turn !== generation) return false;
      entries = result; render(); status(ownerId ? "Сохранено в аккаунте." : "Сохранено на этом устройстве. Для синхронизации войдите.");
      return true;
    } catch (error) {
      if (turn !== generation) return false;
      ready = false; status(failure(error), true);
      return false;
    } finally {
      if (turn === generation) { busy = false; writing = false; controls(); }
    }
  }
  async function add() {
    if (busy || !ready) return;
    var numbers = fields.slice(0, 4).map(function (field) { return Number(field.value.trim() || 0); });
    var minutes = numbers[0] * 60 + numbers[1];
    if (numbers.some(function (n) { return !Number.isInteger(n) || n < 0 || n > 1000000000; }) || minutes > 1000000000) {
      $("hint").textContent = "Введите целые неотрицательные числа (время — до 1 млрд минут)."; return;
    }
    if (numbers.every(function (n) { return n === 0; })) { $("hint").textContent = "Укажите время, заходы или посадки."; return; }
    $("hint").textContent = "";
    var next = entries.concat([{ min: minutes, appr: numbers[2], land: numbers[3], label: fields[4].value.trim().slice(0, 40) }]);
    if (await persist(next)) { fields.forEach(function (field) { field.value = ""; }); fields[0].focus(); }
  }
  $("add").addEventListener("click", add);
  fields.forEach(function (field, index) {
    field.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || busy || !ready) return;
      event.preventDefault();
      if (index < fields.length - 1) fields[index + 1].focus(); else add();
    });
    field.addEventListener("input", function () { $("hint").textContent = ""; });
  });
  $("clear").addEventListener("click", function () {
    if (clearArmed) { persist([]); return; }
    clearArmed = true; $("clear").textContent = ownerId ? "Удалить из аккаунта? Ещё раз" : "Удалить с устройства? Ещё раз";
    setTimeout(disarm, 3000);
  });
  $("exp").addEventListener("click", function () {
    $("io").value = JSON.stringify({ v: 2, entries: entries });
    $("io").focus(); $("io").select();
    $("ioMsg").textContent = "Текст выделен. Скопируйте и сохраните резервную копию.";
  });
  async function importEntries(replace) {
    if (busy || !ready) return;
    try {
      var parsed = JSON.parse($("io").value), list = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(list) || !list.length) throw new Error("empty");
      // A strict import never silently drops invalid records from a backup.
      var next = list.map(function (entry) {
        return { min: entry.min, appr: entry.appr, land: entry.land, label: entry.label };
      });
      if (await persist(replace ? next : entries.concat(next))) {
        $("io").value = ""; $("ioMsg").textContent = (ownerId ? "Импорт сохранён в аккаунте: " : "Импорт сохранён на устройстве: ") + next.length + " заданий.";
      }
    } catch (error) { $("ioMsg").textContent = "Не удалось прочитать копию. Вставьте полный текст экспорта."; }
  }
  $("impAdd").addEventListener("click", function () { disarm(); importEntries(false); });
  $("impRep").addEventListener("click", function () {
    if (replaceArmed) { disarm(); importEntries(true); return; }
    replaceArmed = true; $("impRep").textContent = ownerId ? "Заменить в аккаунте? Ещё раз" : "Заменить на устройстве? Ещё раз";
    setTimeout(disarm, 3000);
  });
  $("refresh").addEventListener("click", refresh);
  // Check on returning to the page; preserve input fields while refreshing the saved list.
  window.addEventListener("focus", function () { if (ready && !busy) refresh(); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && ready && !busy) refresh();
  });
  setInterval(function () { if (!document.hidden && ready && !busy) refresh(); }, 30000);
  window.addEventListener("storage", function (event) {
    if (!ownerId && event.key === "flight-time-entries-v2" && !busy) refresh();
  });
  function guestMode(clearFields) {
    generation++; ownerId = null; ready = false; busy = writing = false;
    store = window.createGuestJournal(); entries = [];
    if (clearFields) { fields.forEach(function (field) { field.value = ""; }); $("io").value = ""; }
    $("accountLink").textContent = "Войти";
    if ($("syncPanel")) $("syncPanel").hidden = true;
    if ($("modeNote")) $("modeNote").hidden = false;
    try { entries = store.snapshot(); ready = true; status("Без аккаунта: записи сохраняются на этом устройстве. Для синхронизации войдите."); }
    catch (error) { status(failure(error, true), true); }
    render();
  }
  function accountMode(user) {
    generation++; ownerId = user.id; busy = writing = false; ready = false; entries = [];
    $("io").value = "";
    $("accountLink").textContent = "Мой аккаунт";
    if ($("syncPanel")) $("syncPanel").hidden = false;
    if ($("modeNote")) $("modeNote").hidden = true;
    store = window.createCloudJournal(auth, ownerId); render(); refresh();
  }
  guestMode(false);
  if (!auth || !auth.ready) return;
  if (typeof auth.readJournal !== "function" || typeof auth.saveJournal !== "function") {
    status("Браузер загрузил старый модуль входа. Обновите страницу с очисткой кэша.", true); return;
  }
  auth.onChange(function (event, user) {
    if (event === "SIGNED_OUT") guestMode(true);
    if (event === "SIGNED_IN" && user && user.id !== ownerId) accountMode(user);
    if (ownerId && user && user.id !== ownerId && event !== "SIGNED_IN") guestMode(true);
  });
  var initialGeneration = generation;
  auth.currentUser().then(function (user) {
    if (initialGeneration !== generation) return;
    if (user) accountMode(user);
  }).catch(function () {
    if (initialGeneration === generation) status("Не удалось проверить вход. Сейчас записи сохраняются на устройстве. Чтобы открыть аккаунт, нажмите «Войти».");
  });
})();
