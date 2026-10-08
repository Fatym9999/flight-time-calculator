(function () {
  "use strict";
  function valid(entries) {
    return Array.isArray(entries) && entries.length <= 10000 && entries.every(function (entry) {
      return entry && [entry.min, entry.appr, entry.land].every(function (n) {
        return Number.isInteger(n) && n >= 0 && n <= 1000000000;
      }) && typeof entry.label === "string" && Array.from(entry.label).length <= 40;
    });
  }
  window.validFlightEntries = valid;
  window.createCloudJournal = function (auth, userId) {
    var revision = 0, entries = [], busy = false, loaded = false;
    function accept(row, required) {
      if (required && !row) throw new Error("INVALID_JOURNAL");
      if (row && (!valid(row.entries) || !Number.isInteger(row.revision) || row.revision < 1)) {
        throw new Error("INVALID_JOURNAL");
      }
      entries = row ? row.entries : [];
      revision = row ? row.revision : 0;
      loaded = true;
      return entries;
    }
    return {
      read: async function () {
        if (busy) throw new Error("BUSY");
        busy = true;
        loaded = false;
        try { return accept(await auth.readJournal(userId)); }
        finally { busy = false; }
      },
      write: async function (next) {
        if (busy || !loaded) throw new Error("BUSY");
        if (!valid(next)) throw new Error("INVALID_ENTRIES");
        busy = true;
        var requestId = window.crypto.randomUUID();
        try {
          try {
            var saved = await auth.saveJournal(next, revision, requestId, userId);
            if (!saved || saved.mutation_id !== requestId) throw new Error("INVALID_JOURNAL");
            return accept(saved, true);
          }
          catch (error) {
            // No blind retry: reconcile whether this exact save reached the server.
            loaded = false;
            try {
              var row = await auth.readJournal(userId);
              if (row && row.mutation_id === requestId) return accept(row);
            } catch (readError) { /* Require a fresh read before another write. */ }
            throw error;
          }
        } finally { busy = false; }
      }
    };
  };
})();
