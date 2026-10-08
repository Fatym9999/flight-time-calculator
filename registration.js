(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var auth = window.FlightAuth;
  var email = $("email"), code = $("code");
  var pendingEmail = "", busy = false, cooldownUntil = 0, timer = null;
  var controls = ["email", "code", "sendCode", "verifyCode", "changeEmail", "signOut"];
  function show(step, focus) {
    ["emailStep", "codeStep", "successStep"].forEach(function (id) { $(id).hidden = id !== step; });
    if (focus) $(focus).focus();
  }
  function updateResend() {
    var seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    $("resend").disabled = busy || seconds > 0 || !auth || !auth.ready;
    $("resend").textContent = seconds ? "Повторить через " + seconds + " с" : "Отправить код ещё раз";
    if (!seconds && timer) { clearInterval(timer); timer = null; }
  }
  function cooldown() {
    cooldownUntil = Date.now() + 60000;
    if (timer) clearInterval(timer);
    timer = setInterval(updateResend, 1000);
    updateResend();
  }
  function setBusy(value) {
    busy = value;
    controls.forEach(function (id) { $(id).disabled = value || !auth || !auth.ready; });
    $("emailForm").setAttribute("aria-busy", String(value));
    $("codeForm").setAttribute("aria-busy", String(value));
    updateResend();
  }
  function signedIn(user, focus) {
    pendingEmail = "";
    code.value = "";
    $("accountEmail").textContent = user.email || "Почта подтверждена";
    $("accountError").textContent = "";
    if (timer) { clearInterval(timer); timer = null; }
    show("successStep", focus ? "successTitle" : null);
  }
  function signedOut() {
    pendingEmail = "";
    code.value = "";
    $("accountEmail").textContent = "";
    $("accountError").textContent = "";
    show("emailStep", "email");
  }
  async function requestCode(resend) {
    if (busy || !auth || !auth.ready || (resend && Date.now() < cooldownUntil)) return;
    var errorId = resend ? "resendStatus" : "emailError";
    $(errorId).textContent = "";
    var destination = resend ? pendingEmail : email.value.trim();
    if (!resend) {
      email.value = destination;
      if (!email.validity.valid) {
        $("emailError").textContent = "Введите почту в формате name@example.com.";
        email.setAttribute("aria-invalid", "true"); email.focus(); return;
      }
    }
    if (!destination) return;
    setBusy(true);
    $("sendCode").textContent = "Отправляем…";
    var focusCode = false;
    try {
      await auth.sendCode(destination);
      $("setupNotice").hidden = true;
      pendingEmail = destination;
      $("emailDisplay").textContent = destination;
      code.value = "";
      $("codeError").textContent = "";
      code.removeAttribute("aria-invalid");
      $("resendStatus").textContent = resend ? "Новый код запрошен. Проверьте входящие и папку «Спам»." : "";
      cooldown();
      show("codeStep"); focusCode = true;
    } catch (error) {
      $(errorId).textContent = auth.errorMessage(error);
      if (error.status === 429 || error.code === "over_email_send_rate_limit") cooldown();
    } finally {
      setBusy(false); $("sendCode").textContent = "Получить код →";
      if (focusCode) code.focus();
    }
  }
  $("emailForm").addEventListener("submit", function (event) { event.preventDefault(); requestCode(false); });
  $("resend").addEventListener("click", function () { requestCode(true); });
  email.addEventListener("input", function () { $("emailError").textContent = ""; email.removeAttribute("aria-invalid"); });
  code.addEventListener("input", function () {
    code.value = code.value.replace(/[^0-9]/g, "").slice(0, 6);
    $("codeError").textContent = ""; code.removeAttribute("aria-invalid");
  });
  $("changeEmail").addEventListener("click", function () {
    if (busy) return;
    pendingEmail = ""; code.value = "";
    show("emailStep", "email");
  });
  $("codeForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    if (busy || !pendingEmail || !auth || !auth.ready) return;
    if (!/^[0-9]{6}$/.test(code.value)) {
      $("codeError").textContent = "Введите 6 цифр из письма.";
      code.setAttribute("aria-invalid", "true"); code.focus(); return;
    }
    setBusy(true); $("verifyCode").textContent = "Проверяем…";
    try {
      signedIn(await auth.verifyCode(pendingEmail, code.value), true);
    } catch (error) {
      $("codeError").textContent = auth.errorMessage(error);
      code.setAttribute("aria-invalid", "true");
    } finally { setBusy(false); $("verifyCode").textContent = "Войти"; }
  });
  $("signOut").addEventListener("click", async function () {
    if (busy || !auth || !auth.ready) return;
    setBusy(true); $("accountError").textContent = "";
    try { await auth.signOut(); signedOut(); }
    catch (error) { $("accountError").textContent = auth.errorMessage(error); }
    finally { setBusy(false); if (!$("emailStep").hidden) email.focus(); }
  });
  async function init() {
    if (!auth || !auth.ready) {
      $("setupNotice").textContent = auth ? auth.issue : "Модуль входа не загрузился. Обновите страницу.";
      $("setupNotice").hidden = false;
      setBusy(false); return;
    }
    setBusy(true);
    $("setupNotice").textContent = "Проверяем сохранённый вход…";
    $("setupNotice").hidden = false;
    try {
      var user = await auth.currentUser();
      if (user) signedIn(user, false);
      $("setupNotice").hidden = true;
    } catch (error) { $("setupNotice").textContent = auth.errorMessage(error); }
    finally { setBusy(false); }
    auth.onChange(function (event) {
      if (event === "SIGNED_OUT") signedOut();
    });
  }
  init();
})();
