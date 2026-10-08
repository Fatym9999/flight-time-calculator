// Public browser configuration for the TEST project only.
// Use a publishable key (sb_publishable_...), never a secret/service_role key.
// SMTP and both OTP templates configured; real delivery still needs a user test.
window.FLIGHT_AUTH_CONFIG = Object.freeze({
  url: "https://bjkdfalvbvgjnhxspjxy.supabase.co",
  publishableKey: "sb_publishable_0Cs8SCdgmNPifIQtyytdvg_jqwmfp9N",
  emailOtpEnabled: true
});
