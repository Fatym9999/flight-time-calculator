(function () {
  "use strict";
  var config = window.FLIGHT_AUTH_CONFIG || {};
  var client = null;
  var issue = "Вход пока не подключён. Настраиваем сервис отправки кодов. Калькулятор доступен без аккаунта.";
  var validConfig = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url || "") &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey || "");

  if (validConfig && config.emailOtpEnabled !== true) {
    issue = "Тестовый аккаунт подключён. Отправка кодов ещё настраивается; калькулятор доступен без входа.";
  }
  if (validConfig && config.emailOtpEnabled === true) {
    if (!/^https?:$/.test(window.location.protocol)) {
      issue = "Для входа откройте тестовую версию через HTTP или HTTPS, а не как файл. См. AUTH_SETUP.md.";
    } else if (!window.supabase) {
      issue = "Не удалось загрузить модуль входа. Обновите страницу.";
    } else {
      try {
        client = window.supabase.createClient(config.url, config.publishableKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storageKey: "flight-time-auth-test-" + new URL(config.url).hostname.split(".")[0] + "-v1"
          }
        });
        issue = "";
      } catch (error) {
        issue = "Не удалось запустить вход. Проверьте настройки тестового проекта.";
      }
    }
  }

  function requireClient() {
    if (!client) throw new Error(issue);
    return client;
  }
  function check(result) {
    if (result.error) throw result.error;
    return result.data;
  }
  function errorMessage(error) {
    var code = error && error.code;
    if (code === "otp_expired" || code === "otp_disabled" || code === "invalid_credentials") {
      return "Код неверный или срок его действия истёк. Проверьте письмо или запросите новый код.";
    }
    if ((error && error.status === 429) || code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
      return "Слишком много запросов. Подождите немного и попробуйте снова.";
    }
    if (code === "email_address_not_authorized") {
      return "Отправка на этот адрес пока недоступна: требуется настройка почты тестового сервиса.";
    }
    if (code === "email_address_invalid" || code === "validation_failed") {
      return "Проверьте адрес почты и введённый код.";
    }
    if (error && (error.name === "AuthRetryableFetchError" || error.name === "TypeError")) {
      return "Не удалось связаться с сервисом. Проверьте интернет и попробуйте снова.";
    }
    return "Не удалось выполнить запрос. Попробуйте ещё раз позже.";
  }

  window.FlightAuth = {
    ready: !!client,
    issue: issue,
    errorMessage: errorMessage,
    sendCode: async function (email) {
      check(await requireClient().auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }));
    },
    readJournal: async function (userId) {
      return check(await requireClient().from("flight_journals").select("entries,revision,mutation_id")
        .eq("user_id", userId).maybeSingle());
    },
    saveJournal: async function (entries, revision, mutationId, ownerId) {
      return check(await requireClient().rpc("save_flight_journal", {
        new_entries: entries, expected_revision: revision, request_id: mutationId, expected_owner: ownerId
      }));
    },
    verifyCode: async function (email, token) {
      var data = check(await requireClient().auth.verifyOtp({ email: email, token: token, type: "email" }));
      if (!data || !data.session || !data.user) throw new Error("Missing authenticated session");
      return data.user;
    },
    currentUser: async function () {
      var data = check(await requireClient().auth.getSession());
      if (!data.session) return null;
      // The saved session is not proof: ask the auth server to validate it.
      var result = await requireClient().auth.getUser();
      if (result.error && (result.error.status === 401 || result.error.status === 403 || result.error.code === "session_not_found")) return null;
      return check(result).user;
    },
    signOut: async function () {
      check(await requireClient().auth.signOut({ scope: "local" }));
    },
    onChange: function (callback) {
      return requireClient().auth.onAuthStateChange(function (event, session) {
        // Keep this callback synchronous: SDK auth methods must not be called here.
        callback(event, session && session.user);
      });
    }
  };
})();
