(function () {
  "use strict";
  var link = document.getElementById("accountLink");
  var note = document.getElementById("accountNote");
  var auth = window.FlightAuth;
  if (!auth || !auth.ready) return;
  function display(user) {
    link.textContent = user ? "Мой аккаунт" : "Войти";
    note.hidden = !user;
  }
  auth.currentUser().then(display).catch(function () {
    link.textContent = "Проверить вход";
  });
  auth.onChange(function (event, user) {
    if (event === "SIGNED_OUT") display(null);
    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") display(user);
  });
})();
