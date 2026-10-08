(function () {
  "use strict";
  // Main-site release: preserve the existing browser journal and its storage key.
  var KEY = "flight-time-entries-v2";
  window.createGuestJournal = function () {
    var baseline;
    function snapshot() {
      try {
        var raw = window.localStorage.getItem(KEY);
        var entries = raw ? JSON.parse(raw) : [];
        if (!window.validFlightEntries(entries)) throw new Error("INVALID_LOCAL_DATA");
        baseline = raw;
        return entries;
      } catch (error) {
        throw new Error("LOCAL_READ_FAILED");
      }
    }
    return {
      snapshot: snapshot,
      read: async function () { return snapshot(); },
      write: async function (entries) {
        if (!window.validFlightEntries(entries)) throw new Error("INVALID_ENTRIES");
        try {
          if (window.localStorage.getItem(KEY) !== baseline) {
            throw Object.assign(new Error("LOCAL_CONFLICT"), { code: "40001" });
          }
          var raw = JSON.stringify(entries);
          window.localStorage.setItem(KEY, raw);
          baseline = raw;
          return entries;
        } catch (error) {
          if (error.code === "40001") throw error;
          throw new Error("LOCAL_WRITE_FAILED");
        }
      }
    };
  };
})();
